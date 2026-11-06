import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  ConnectorAuthorizationDecisionSchema,
  ConnectorAuthorizationRequestSchema,
  ConnectorAuthorizationSchema,
  CreateConnectorAuthorizationSchema,
  createRenderedRequestDigest,
} from '@omnis/contracts/connector-authorization';
import { AgentProfileVersionSchema, ProjectSchema, TaskSchema } from '@omnis/contracts';
import { renderSyntheticConnectorRequest } from '@omnis/contracts/synthetic-connector-prompt';

type AuthorizerForwarder = <T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
) => Promise<T>;

type AuthorizationContext = {
  task: unknown;
  project: unknown;
  profile: unknown;
};
type ContextLoader = (binding: {
  taskId: string;
  projectId: string;
  agentId: string;
  profileVersion: number;
}) => Promise<AuthorizationContext | undefined>;

export function registerConnectorAuthorizationRoutes(
  app: FastifyInstance,
  guards: {
    requireOwner: preHandlerHookHandler;
    requireMutationProtection: preHandlerHookHandler;
    forward?: AuthorizerForwarder;
    loadContext?: ContextLoader;
  },
): void {
  const forward: AuthorizerForwarder =
    guards.forward ??
    ((path, init, parse) =>
      import('./authorizer-client.ts').then(({ authorizerRequest }) =>
        authorizerRequest(path, init, parse),
      ));
  const loadContext: ContextLoader =
    guards.loadContext ??
    (async (binding) => {
      const [{ workerRequest, parseTask, parseAgentVersion }, { authorizerRequest }] =
        await Promise.all([import('./worker-client.ts'), import('./authorizer-client.ts')]);
      const [task, project, profile] = await Promise.all([
        workerRequest(`/internal/v1/tasks/${encodeURIComponent(binding.taskId)}`, {}, parseTask),
        authorizerRequest(
          `/internal/v1/projects/${encodeURIComponent(binding.projectId)}`,
          {},
          (value) => ProjectSchema.parse(value),
        ),
        workerRequest(
          `/internal/v1/agents/${encodeURIComponent(binding.agentId)}/versions/${binding.profileVersion}`,
          {},
          parseAgentVersion,
        ),
      ]);
      return { task, project, profile: profile.version };
    });
  app.get<{ Params: { authorizationId: string } }>(
    '/api/v1/connector-authorizations/:authorizationId',
    { preHandler: guards.requireOwner },
    async (request, reply) => {
      if (!isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Connector authorization ID is invalid.' },
        });
      }
      return forward(
        `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}`,
        {},
        parseConnectorAuthorization,
      );
    },
  );

  app.post(
    '/api/v1/connector-authorizations',
    { preHandler: [guards.requireOwner, guards.requireMutationProtection] },
    async (request, reply) => {
      const parsed = CreateConnectorAuthorizationSchema.safeParse(request.body);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!parsed.success || typeof idempotencyKey !== 'string' || !isUuid(idempotencyKey)) {
        return reply.code(400).send({
          error: {
            code: 'invalid_input',
            message: 'Synthetic connector authorization request and Idempotency-Key are required.',
          },
        });
      }
      const { renderedRequest, ...binding } = parsed.data;
      const context = await loadContext(binding);
      const task = context ? TaskSchema.safeParse(context.task) : undefined;
      const project = context ? ProjectSchema.safeParse(context.project) : undefined;
      const profile = context ? AgentProfileVersionSchema.safeParse(context.profile) : undefined;
      if (
        !task?.success ||
        !project?.success ||
        !profile?.success ||
        task.data.status === 'completed' ||
        project.data.status !== 'active' ||
        task.data.projectId !== binding.projectId ||
        task.data.associationRevision !== binding.taskRevision ||
        project.data.revision !== binding.projectRevision ||
        profile.data.agentId !== binding.agentId ||
        profile.data.versionNo !== binding.profileVersion
      ) {
        return reply.code(409).send({
          error: {
            code: 'authorization_context_changed',
            message: 'The task, project, or immutable profile version no longer matches.',
          },
        });
      }
      let canonicalRequest: string;
      try {
        canonicalRequest = renderSyntheticConnectorRequest(task.data, profile.data);
      } catch {
        return reply.code(400).send({
          error: { code: 'invalid_rendered_request', message: 'The request cannot be rendered.' },
        });
      }
      if (renderedRequest !== canonicalRequest) {
        return reply.code(409).send({
          error: {
            code: 'request_binding_failed',
            message: 'The rendered request does not match the canonical task and profile.',
          },
        });
      }
      const authorizationRequest = ConnectorAuthorizationRequestSchema.parse({
        ...binding,
        promptDigest: createRenderedRequestDigest(canonicalRequest),
      });
      const authorization = await forward(
        '/internal/v1/connector-authorizations',
        {
          method: 'POST',
          headers: { 'idempotency-key': idempotencyKey },
          body: JSON.stringify(authorizationRequest),
        },
        parseConnectorAuthorization,
      );
      return reply.code(201).send(authorization);
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/api/v1/connector-authorizations/:authorizationId/decision',
    { preHandler: [guards.requireOwner, guards.requireMutationProtection] },
    async (request, reply) => {
      const parsed = ConnectorAuthorizationDecisionSchema.safeParse(request.body);
      if (!parsed.success || !isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Connector authorization decision is invalid.' },
        });
      }
      const authorization = await forward(
        `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}/decision`,
        { method: 'POST', body: JSON.stringify(parsed.data) },
        parseConnectorAuthorization,
      );
      return reply.send(authorization);
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/api/v1/connector-authorizations/:authorizationId/revoke',
    { preHandler: [guards.requireOwner, guards.requireMutationProtection] },
    async (request, reply) => {
      if (!isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Connector authorization ID is invalid.' },
        });
      }
      const authorization = await forward(
        `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}/revoke`,
        { method: 'POST' },
        parseConnectorAuthorization,
      );
      return reply.send(authorization);
    },
  );
}

function parseConnectorAuthorization(value: unknown) {
  return ConnectorAuthorizationSchema.parse(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

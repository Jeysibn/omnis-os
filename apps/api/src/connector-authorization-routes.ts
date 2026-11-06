import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  ConnectorAuthorizationDecisionSchema,
  ConnectorAuthorizationRequestSchema,
  ConnectorAuthorizationSchema,
  CreateConnectorAuthorizationSchema,
  createRenderedRequestDigest,
} from '@omnis/contracts/connector-authorization';

type AuthorizerForwarder = <T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
) => Promise<T>;

export function registerConnectorAuthorizationRoutes(
  app: FastifyInstance,
  guards: {
    requireOwner: preHandlerHookHandler;
    requireMutationProtection: preHandlerHookHandler;
    forward?: AuthorizerForwarder;
  },
): void {
  const forward: AuthorizerForwarder =
    guards.forward ??
    ((path, init, parse) =>
      import('./authorizer-client.ts').then(({ authorizerRequest }) =>
        authorizerRequest(path, init, parse),
      ));
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
      const authorizationRequest = ConnectorAuthorizationRequestSchema.parse({
        ...binding,
        promptDigest: createRenderedRequestDigest(renderedRequest),
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

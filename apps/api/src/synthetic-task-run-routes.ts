import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  ConnectorAuthorizationSchema,
  createRenderedRequestDigest,
} from '@omnis/contracts/connector-authorization';
import {
  SyntheticTaskRunCancellationResponseSchema,
  SyntheticTaskRunDetailSchema,
  SyntheticTaskRunRequestSchema,
  SyntheticTaskRunResponseSchema,
} from '@omnis/contracts/synthetic-task-run';

type Forwarder = <TResult>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => TResult,
) => Promise<TResult>;

export function registerSyntheticTaskRunRoutes(
  app: FastifyInstance,
  guards: {
    requireOwner: preHandlerHookHandler;
    requireMutationProtection: preHandlerHookHandler;
    enabled: boolean;
    forwardAuthorizer?: Forwarder;
    forwardWorker?: Forwarder;
  },
): void {
  if (!guards.enabled) return;
  const toAuthorizer: Forwarder =
    guards.forwardAuthorizer ??
    ((path, init, parse) =>
      import('./authorizer-client.ts').then(({ authorizerRequest }) =>
        authorizerRequest(path, init, parse),
      ));
  const toWorker: Forwarder =
    guards.forwardWorker ??
    ((path, init, parse) =>
      import('./worker-client.ts').then(({ workerRequest }) => workerRequest(path, init, parse)));

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/synthetic-runs',
    { preHandler: [guards.requireOwner, guards.requireMutationProtection] },
    async (request, reply) => {
      const taskId = request.params.taskId;
      const body = SyntheticTaskRunRequestSchema.safeParse({
        version: 'omnis.synthetic-task-run.v1',
        ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
        requestId: uuid(request.headers['idempotency-key']),
      });
      if (!body.success || body.data.request.taskId !== taskId) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Synthetic task run input is invalid.' },
        });
      }
      const { requestId, authorizationId, request: binding, renderedRequest } = body.data;
      if (createRenderedRequestDigest(renderedRequest) !== binding.promptDigest) {
        return reply.code(400).send({
          error: {
            code: 'request_binding_failed',
            message: 'The approved request digest does not match.',
          },
        });
      }
      const authorization = await toAuthorizer(
        `/internal/v1/connector-authorizations/${encodeURIComponent(authorizationId)}`,
        {},
        (value) => ConnectorAuthorizationSchema.parse(value),
      );
      if (!matchesApprovedTask(authorization, authorizationId, requestId, taskId, binding)) {
        return reply.code(409).send({
          error: {
            code: 'authorization_mismatch',
            message: 'An exact active owner-approved connector grant is required.',
          },
        });
      }
      if (authorization.consumedAt !== null) {
        return reply.code(409).send({
          error: {
            code: 'request_already_consumed',
            message: 'This authorization was already consumed. Read its durable execution status.',
          },
        });
      }
      let result: ReturnType<typeof SyntheticTaskRunResponseSchema.parse>;
      try {
        result = await toWorker(
          `/internal/v1/tasks/${encodeURIComponent(taskId)}/synthetic-runs`,
          {
            method: 'POST',
            headers: { 'idempotency-key': requestId },
            body: JSON.stringify(body.data),
          },
          (value) => SyntheticTaskRunResponseSchema.parse(value),
        );
      } catch {
        return reply.code(503).send({
          error: {
            code: 'synthetic_worker_outcome_unknown',
            message:
              'The worker did not confirm the execution outcome. Read the durable execution status before retrying.',
          },
        });
      }
      if (result.correlationId !== authorization.correlationId) {
        return reply.code(503).send({
          error: {
            code: 'synthetic_broker_correlation_unknown',
            message: 'The synthetic broker did not confirm the authorized run correlation.',
          },
        });
      }
      let execution: ReturnType<typeof SyntheticTaskRunDetailSchema.parse>;
      try {
        execution = await toAuthorizer(
          `/internal/v1/connector-authorizations/${encodeURIComponent(authorizationId)}/execution`,
          {},
          (value) => SyntheticTaskRunDetailSchema.parse(value),
        );
      } catch {
        return reply.code(503).send({
          error: {
            code: 'synthetic_execution_state_unknown',
            message:
              'The durable execution state could not be confirmed. Read the execution status before retrying.',
          },
        });
      }
      const attempt = execution.attempt;
      if (
        execution.taskId !== taskId ||
        attempt.authorizationId !== authorizationId ||
        attempt.requestId !== requestId ||
        attempt.id !== result.attemptId ||
        attempt.status !== result.status ||
        Boolean(attempt.submissionStartedAt) !== result.submitted ||
        (attempt.responseText ?? undefined) !== result.responseText
      ) {
        return reply.code(503).send({
          error: {
            code: 'synthetic_broker_state_mismatch',
            message:
              'The broker result did not match durable execution state. Read the execution status before retrying.',
          },
        });
      }
      return reply.send({ ...result, usage: execution.usage });
    },
  );

  app.post<{ Params: { taskId: string; authorizationId: string } }>(
    '/api/v1/tasks/:taskId/synthetic-runs/:authorizationId/cancel',
    { preHandler: [guards.requireOwner, guards.requireMutationProtection] },
    async (request, reply) => {
      const taskId = request.params.taskId;
      const authorization = await toAuthorizer(
        `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}`,
        {},
        (value) => ConnectorAuthorizationSchema.parse(value),
      );
      if (authorization.taskId !== request.params.taskId || authorization.status !== 'authorized') {
        return reply.code(409).send({
          error: {
            code: 'authorization_mismatch',
            message: 'The active connector grant does not belong to this task.',
          },
        });
      }
      await toAuthorizer(
        `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}/revoke`,
        { method: 'POST' },
        (value) => ConnectorAuthorizationSchema.parse(value),
      );
      return reply.send(
        SyntheticTaskRunCancellationResponseSchema.parse({
          requested: true,
          confirmed: false,
          authorizationId: authorization.id,
          taskId,
        }),
      );
    },
  );

  app.get<{ Params: { taskId: string; authorizationId: string } }>(
    '/api/v1/tasks/:taskId/synthetic-runs/:authorizationId',
    { preHandler: guards.requireOwner },
    async (request, reply) => {
      const authorization = await toAuthorizer(
        `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}`,
        {},
        (value) => ConnectorAuthorizationSchema.parse(value),
      );
      if (
        authorization.id !== request.params.authorizationId ||
        authorization.taskId !== request.params.taskId
      ) {
        return reply.code(404).send({
          error: { code: 'not_found', message: 'Synthetic task run was not found.' },
        });
      }
      return toAuthorizer(
        `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}/execution`,
        {},
        (value) => SyntheticTaskRunDetailSchema.parse(value),
      );
    },
  );
}

function matchesApprovedTask(
  value: unknown,
  authorizationId: string,
  requestId: string,
  taskId: string,
  binding: (typeof SyntheticTaskRunRequestSchema)['_output']['request'],
): boolean {
  const authorization = ConnectorAuthorizationSchema.safeParse(value);
  if (!authorization.success) return false;
  const grant = authorization.data;
  return (
    grant.id === authorizationId &&
    grant.status === 'authorized' &&
    (grant.consumedAt === null || grant.consumedRequestId === requestId) &&
    grant.expiresAt > new Date().toISOString() &&
    grant.taskId === taskId &&
    grant.projectId === binding.projectId &&
    grant.projectRevision === binding.projectRevision &&
    grant.taskRevision === binding.taskRevision &&
    grant.agentId === binding.agentId &&
    grant.profileVersion === binding.profileVersion &&
    grant.promptDigest === binding.promptDigest &&
    grant.connectorId === binding.connectorId &&
    grant.connectorVersion === binding.connectorVersion &&
    grant.providerId === binding.providerId &&
    grant.modelId === binding.modelId &&
    grant.operation === binding.operation &&
    grant.capabilities.length === 0 &&
    grant.limits.maxInputTokens === binding.limits.maxInputTokens &&
    grant.limits.maxOutputTokens === binding.limits.maxOutputTokens &&
    grant.limits.maxDurationSeconds === binding.limits.maxDurationSeconds &&
    grant.limits.maxConcurrentRuns === binding.limits.maxConcurrentRuns &&
    grant.limits.maxUsageUnits === binding.limits.maxUsageUnits &&
    grant.limits.maxCostMicrousd === binding.limits.maxCostMicrousd
  );
}

function uuid(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

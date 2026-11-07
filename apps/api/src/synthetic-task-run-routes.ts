import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { RunSchema } from '@omnis/contracts';
import {
  ConnectorAuthorizationSchema,
  createRenderedRequestDigest,
} from '@omnis/contracts/connector-authorization';
import {
  SyntheticTaskRunCancellationResponseSchema,
  SyntheticTaskRunDetailSchema,
  SyntheticTaskRunAdmissionResponseSchema,
  SyntheticTaskRunRequestSchema,
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
      if (authorization.consumedAt !== null && authorization.consumedRequestId !== requestId) {
        return reply.code(409).send({
          error: {
            code: 'request_already_consumed',
            message: 'This authorization was already consumed. Read its durable execution status.',
          },
        });
      }
      let result: ReturnType<typeof SyntheticTaskRunAdmissionResponseSchema.parse>;
      try {
        result = await toWorker(
          `/internal/v1/tasks/${encodeURIComponent(taskId)}/synthetic-runs`,
          {
            method: 'POST',
            headers: { 'idempotency-key': requestId },
            body: JSON.stringify({ ...body.data, correlationId: authorization.correlationId }),
          },
          (value) => SyntheticTaskRunAdmissionResponseSchema.parse(value),
        );
      } catch {
        return reply.code(503).send({
          error: {
            code: 'synthetic_run_admission_unknown',
            message:
              'The worker did not confirm durable Run admission. Retry only with the same request identity or read its status.',
          },
        });
      }
      if (result.run.id !== authorization.correlationId || result.run.taskId !== taskId) {
        return reply.code(503).send({
          error: {
            code: 'synthetic_run_binding_mismatch',
            message: 'The worker Run did not match the approved task correlation.',
          },
        });
      }
      return reply.code(result.created ? 202 : 200).send(result.run);
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
      const canCancel =
        authorization.status === 'authorized' ||
        authorization.status === 'revoked' ||
        (authorization.status === 'expired' && authorization.consumedAt !== null);
      if (authorization.taskId !== request.params.taskId || !canCancel) {
        return reply.code(409).send({
          error: {
            code: 'authorization_mismatch',
            message: 'The connector grant does not identify a cancellable run for this task.',
          },
        });
      }
      if (authorization.status === 'authorized') {
        await toAuthorizer(
          `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}/revoke`,
          { method: 'POST' },
          (value) => ConnectorAuthorizationSchema.parse(value),
        );
      } else if (authorization.status === 'expired' && authorization.consumedAt !== null) {
        const execution = await toAuthorizer(
          `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}/execution`,
          {},
          (value) => SyntheticTaskRunDetailSchema.parse(value),
        );
        if (hasActiveAttempt(execution)) {
          await toAuthorizer(
            `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}/revoke`,
            { method: 'POST' },
            (value) => ConnectorAuthorizationSchema.parse(value),
          );
        }
      }
      await toWorker(
        `/internal/v1/synthetic-runs/${encodeURIComponent(authorization.correlationId)}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({ taskId, authorizationId: authorization.id }),
        },
        () => undefined,
      ).catch(() => undefined);
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
      let execution: ReturnType<typeof SyntheticTaskRunDetailSchema.parse> | undefined;
      try {
        execution = await toAuthorizer(
          `/internal/v1/connector-authorizations/${encodeURIComponent(request.params.authorizationId)}/execution`,
          {},
          (value) => SyntheticTaskRunDetailSchema.parse(value),
        );
      } catch (error) {
        if (!isAuthorizerNotFound(error)) throw error;
      }
      let run: ReturnType<typeof RunSchema.parse> | undefined;
      let runLookupUnavailable = false;
      try {
        run = await toWorker(
          `/internal/v1/runs/${encodeURIComponent(authorization.correlationId)}`,
          {},
          (value) => RunSchema.parse(value),
        );
      } catch (error) {
        runLookupUnavailable = !isNotFound(error);
      }
      if (run && (run.id !== authorization.correlationId || run.taskId !== authorization.taskId)) {
        return reply.code(503).send({
          error: {
            code: 'synthetic_run_binding_mismatch',
            message: 'The persisted Run did not match the authorized task correlation.',
          },
        });
      }
      if (!execution && !run) {
        if (runLookupUnavailable) {
          return reply.code(503).send({
            error: {
              code: 'synthetic_run_status_unknown',
              message: 'The durable task Run status is temporarily unavailable.',
            },
          });
        }
        return reply.code(404).send({
          error: { code: 'not_found', message: 'Synthetic task run was not found.' },
        });
      }
      return SyntheticTaskRunDetailSchema.parse({
        version: 'omnis.synthetic-task-run.v1',
        taskId: authorization.taskId,
        ...(execution?.attempt ? { attempt: execution.attempt } : {}),
        usage: execution?.usage ?? {
          kind: 'unknown',
          reason: run?.status === 'unknown' ? 'submission_uncertain' : 'not_reported',
          billingExposure: 'unknown',
        },
        ...(run ? { run } : {}),
      });
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

function isAuthorizerNotFound(error: unknown): boolean {
  return isNotFound(error);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
  );
}

function hasActiveAttempt(value: ReturnType<typeof SyntheticTaskRunDetailSchema.parse>): boolean {
  return (
    value.attempt !== undefined &&
    ['admitted', 'submitting', 'accepted', 'running', 'unknown'].includes(value.attempt.status)
  );
}

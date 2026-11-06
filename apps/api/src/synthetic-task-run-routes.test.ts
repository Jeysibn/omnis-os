import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { describe, it } from 'node:test';
import {
  ConnectorAuthorizationSchema,
  createRenderedRequestDigest,
} from '@omnis/contracts/connector-authorization';
import { registerSyntheticTaskRunRoutes } from './synthetic-task-run-routes.ts';

const authorizationId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const taskId = 'task-0001';
const renderedRequest = 'Synthetic task request';
const binding = {
  projectId: `prj_${'a'.repeat(32)}`,
  projectRevision: 1,
  taskId,
  taskRevision: 1,
  agentId: 'fixture-agent',
  profileVersion: 1,
  connectorId: 'synthetic.codex.fixture' as const,
  connectorVersion: '0.0.0-synthetic.1' as const,
  providerId: 'synthetic' as const,
  modelId: 'synthetic-text-only-v1' as const,
  operation: 'connector.respond' as const,
  capabilities: [] as [],
  limits: {
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxDurationSeconds: 30,
    maxConcurrentRuns: 1 as const,
    maxUsageUnits: 100,
    maxCostMicrousd: 100,
  },
  promptDigest: createRenderedRequestDigest(renderedRequest),
};
const grant = ConnectorAuthorizationSchema.parse({
  id: authorizationId,
  requestId,
  correlationId: '33333333-3333-4333-8333-333333333333',
  requestingActor: 'owner',
  ...binding,
  status: 'authorized',
  policyVersion: 'r1p1-synthetic-connector-v1',
  createdAt: '2026-11-07T00:00:00.000Z',
  consentedAt: '2026-11-07T00:00:00.000Z',
  decidedAt: '2026-11-07T00:00:00.000Z',
  decidedBy: 'owner',
  revokedAt: null,
  revokedBy: null,
  revocationGeneration: 0,
  expiresAt: '2999-01-01T00:00:00.000Z',
  consumedAt: null,
  consumedRequestId: null,
  synthetic: true,
});

function createApp(input: {
  authorized?: boolean;
  enabled?: boolean;
  onWorker?: (body: unknown) => unknown;
  onRevoke?: () => void;
  ownerAllowed?: boolean;
  mutationAllowed?: boolean;
  consumed?: boolean;
  throwWorker?: boolean;
  executionOverride?: unknown;
}) {
  const app = Fastify();
  const calls: string[] = [];
  let revokeCount = 0;
  registerSyntheticTaskRunRoutes(app, {
    requireOwner: async (_request, reply) => {
      if (input.ownerAllowed === false) {
        return reply.code(401).send({ error: { code: 'owner_required' } });
      }
    },
    requireMutationProtection: async (_request, reply) => {
      if (input.mutationAllowed === false) {
        return reply.code(403).send({ error: { code: 'csrf_rejected' } });
      }
    },
    enabled: input.enabled ?? true,
    forwardAuthorizer: async <TResult>(path: string): Promise<TResult> => {
      calls.push(`authorizer:${path}`);
      if (path.endsWith('/revoke')) {
        revokeCount += 1;
        input.onRevoke?.();
        return { ...grant, status: 'revoked' } as TResult;
      }
      if (path.endsWith('/execution')) {
        return (input.executionOverride ?? {
          version: 'omnis.synthetic-task-run.v1',
          taskId,
          attempt: {
            id: '44444444-4444-4444-8444-444444444444',
            authorizationId,
            requestId,
            status: 'completed',
            synthetic: true,
            createdAt: '2026-11-07T00:00:00.000Z',
            submissionStartedAt: '2026-11-07T00:00:01.000Z',
            responseText: 'Synthetic response',
          },
          usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
        }) as TResult;
      }
      return (
        input.authorized === false
          ? { ...grant, status: 'revoked' }
          : input.consumed
            ? { ...grant, consumedAt: '2026-11-07T00:01:00.000Z', consumedRequestId: requestId }
            : grant
      ) as TResult;
    },
    forwardWorker: async <TResult>(_path: string, init: RequestInit): Promise<TResult> => {
      calls.push('worker');
      if (input.throwWorker) throw new Error('worker outcome unavailable');
      return (input.onWorker?.(JSON.parse(String(init.body))) ?? {
        version: 'omnis.synthetic-task-run.v1',
        taskId,
        authorizationId,
        requestId,
        correlationId: grant.correlationId,
        attemptId: '44444444-4444-4444-8444-444444444444',
        status: 'completed',
        submitted: true,
        usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
        responseText: 'Synthetic response',
      }) as TResult;
    },
  });
  return { app, calls, getRevokeCount: () => revokeCount };
}

describe('owner synthetic task run routes', () => {
  it('requires an owner session and mutation protection before forwarding', async () => {
    const unauthenticated = createApp({ ownerAllowed: false });
    const noOwner = await unauthenticated.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(noOwner.statusCode, 401);
    assert.deepEqual(unauthenticated.calls, []);
    await unauthenticated.app.close();

    const csrfRejected = createApp({ mutationAllowed: false });
    const noCsrf = await csrfRejected.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.deepEqual(csrfRejected.calls, []);
    await csrfRejected.app.close();
  });

  it('forwards a fully bound approved request and uses the same idempotency identity', async () => {
    let workerPayload: Record<string, unknown> | undefined;
    const { app, calls } = createApp({
      onWorker: (body) => {
        workerPayload = body as Record<string, unknown>;
        return {
          version: 'omnis.synthetic-task-run.v1',
          taskId,
          authorizationId,
          requestId,
          correlationId: grant.correlationId,
          attemptId: '44444444-4444-4444-8444-444444444444',
          status: 'completed',
          submitted: true,
          usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
          responseText: 'Synthetic response',
        };
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}`,
      'worker',
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}/execution`,
    ]);
    assert.equal(workerPayload?.requestId, requestId);
    assert.equal(workerPayload?.renderedRequest, renderedRequest);
    await app.close();
  });

  it('rejects prompt changes, task mismatches, and revoked grants before worker dispatch', async () => {
    const { app, calls } = createApp({ authorized: false });
    const changedDigest = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest: 'modified request' },
    });
    assert.equal(changedDigest.statusCode, 400);
    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(revoked.statusCode, 409);
    assert.equal(calls.includes('worker'), false);
    await app.close();
  });

  it('does not redispatch an already consumed request, even with the same idempotency key', async () => {
    const { app, calls } = createApp({ consumed: true });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'request_already_consumed');
    assert.equal(calls.includes('worker'), false);
    await app.close();
  });

  it('reports an uncertain worker outcome without retrying or inventing completion', async () => {
    const { app, calls } = createApp({ throwWorker: true });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'synthetic_worker_outcome_unknown');
    assert.deepEqual(calls, [
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}`,
      'worker',
    ]);
    await app.close();
  });

  it('fails closed when the broker response correlation differs from the approved grant', async () => {
    const { app } = createApp({
      onWorker: () => ({
        version: 'omnis.synthetic-task-run.v1',
        taskId,
        authorizationId,
        requestId,
        correlationId: '99999999-9999-4999-8999-999999999999',
        attemptId: '44444444-4444-4444-8444-444444444444',
        status: 'unknown',
        submitted: true,
        usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'synthetic_broker_correlation_unknown');
    await app.close();
  });

  it('does not return a broker result that disagrees with the durable authorizer attempt', async () => {
    const { app } = createApp({
      onWorker: () => ({
        version: 'omnis.synthetic-task-run.v1',
        taskId,
        authorizationId,
        requestId,
        correlationId: grant.correlationId,
        attemptId: '99999999-9999-4999-8999-999999999999',
        status: 'completed',
        submitted: true,
        usage: {
          kind: 'measured',
          source: 'synthetic-provider',
          inputUnits: 1,
          outputUnits: 1,
          billingExposure: 'synthetic-only',
        },
        responseText: 'forged completion',
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'synthetic_broker_state_mismatch');
    await app.close();
  });

  it('records cancellation as requested without claiming provider termination', async () => {
    let cancellationAudit = false;
    const { app, getRevokeCount } = createApp({
      onRevoke: () => {
        cancellationAudit = true;
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}/cancel`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      requested: true,
      confirmed: false,
      authorizationId,
      taskId,
    });
    assert.equal(cancellationAudit, true);
    assert.equal(getRevokeCount(), 1);
    await app.close();
  });

  it('reads durable attempt status only after verifying the grant task binding', async () => {
    const { app, calls } = createApp({});
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().attempt.status, 'completed');
    assert.deepEqual(calls, [
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}`,
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}/execution`,
    ]);
    await app.close();
  });

  it('does not expose the route unless the test-only switch is enabled', async () => {
    const { app } = createApp({ enabled: false });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 404);
    await app.close();
  });
});

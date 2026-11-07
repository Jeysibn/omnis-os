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
const correlationId = '33333333-3333-4333-8333-333333333333';
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
  correlationId,
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
const run = {
  id: correlationId,
  taskId,
  taskTitle: 'Synthetic task',
  status: 'queued' as const,
  runtimeKind: 'mock' as const,
  synthetic: true as const,
  usage: { quality: 'unknown' as const, inputTokens: null, outputTokens: null, cost: null },
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
};

function createApp(input: {
  authorized?: boolean;
  revoked?: boolean;
  enabled?: boolean;
  consumedBy?: string;
  ownerAllowed?: boolean;
  mutationAllowed?: boolean;
  throwWorker?: boolean;
  runOverride?: unknown;
  missingAttempt?: boolean;
  expiredConsumed?: boolean;
  activeAttempt?: boolean;
  eventsOverride?: unknown;
}) {
  const app = Fastify();
  const calls: string[] = [];
  let revokeCount = 0;
  let workerCancelCount = 0;
  registerSyntheticTaskRunRoutes(app, {
    requireOwner: async (_request, reply) => {
      if (input.ownerAllowed === false)
        return reply.code(401).send({ error: { code: 'owner_required' } });
    },
    requireMutationProtection: async (_request, reply) => {
      if (input.mutationAllowed === false)
        return reply.code(403).send({ error: { code: 'csrf_rejected' } });
    },
    enabled: input.enabled ?? true,
    forwardAuthorizer: async <TResult>(path: string): Promise<TResult> => {
      calls.push(`authorizer:${path}`);
      if (path.endsWith('/revoke')) {
        revokeCount += 1;
        return { ...grant, status: 'revoked' } as TResult;
      }
      if (path.endsWith('/execution')) {
        if (input.missingAttempt)
          throw Object.assign(new Error('No attempt yet.'), { statusCode: 404 });
        return {
          version: 'omnis.synthetic-task-run.v1',
          taskId,
          attempt: {
            id: '44444444-4444-4444-8444-444444444444',
            authorizationId,
            requestId,
            status: input.activeAttempt ? 'submitting' : 'completed',
            synthetic: true,
            createdAt: '2026-11-07T00:00:00.000Z',
            responseText: 'Synthetic response',
          },
          usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
        } as TResult;
      }
      if (path.includes('/events?')) {
        return (input.eventsOverride ?? {
          version: 'omnis.synthetic-task-run-events.v1',
          authorizationId,
          taskId,
          events: [
            {
              attemptId: '44444444-4444-4444-8444-444444444444',
              sequence: 3,
              eventType: 'connector.execution_completed',
              outcome: 'recorded',
              revocationGeneration: 0,
              occurredAt: '2026-11-07T00:00:03.000Z',
            },
          ],
          page: { nextAfter: null },
        }) as TResult;
      }
      return (
        input.revoked
          ? { ...grant, status: 'revoked' }
          : input.authorized === false
            ? { ...grant, status: 'revoked' }
            : input.expiredConsumed
              ? {
                  ...grant,
                  status: 'expired',
                  expiresAt: '2020-01-01T00:00:00.000Z',
                  consumedAt: '2026-11-07T00:01:00.000Z',
                  consumedRequestId: requestId,
                }
              : input.consumedBy
                ? {
                    ...grant,
                    consumedAt: '2026-11-07T00:01:00.000Z',
                    consumedRequestId: input.consumedBy,
                  }
                : grant
      ) as TResult;
    },
    forwardWorker: async <TResult>(path: string, init: RequestInit): Promise<TResult> => {
      calls.push(`worker:${path}`);
      if (path.endsWith('/cancel')) {
        workerCancelCount += 1;
        return undefined as TResult;
      }
      if (input.throwWorker) throw new Error('worker admission unavailable');
      if (path.startsWith('/internal/v1/runs/')) return (input.runOverride ?? run) as TResult;
      const body: unknown = JSON.parse(String(init.body));
      assert.equal((body as { correlationId?: string }).correlationId, correlationId);
      assert.equal((body as { renderedRequest?: string }).renderedRequest, renderedRequest);
      return {
        version: 'omnis.synthetic-task-run.v1',
        created: true,
        run: input.runOverride ?? run,
      } as TResult;
    },
  });
  return { app, calls, revokeCount: () => revokeCount, workerCancelCount: () => workerCancelCount };
}

describe('owner synthetic task run routes', () => {
  it('requires an owner session and CSRF protection before forwarding', async () => {
    for (const [options, status] of [
      [{ ownerAllowed: false }, 401],
      [{ mutationAllowed: false }, 403],
    ] as const) {
      const fixture = createApp(options);
      const response = await fixture.app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/synthetic-runs`,
        headers: { 'idempotency-key': requestId },
        payload: { authorizationId, request: binding, renderedRequest },
      });
      assert.equal(response.statusCode, status);
      assert.deepEqual(fixture.calls, []);
      await fixture.app.close();
    }
  });

  it('queues a canonical Run with the grant correlation and stable idempotency identity', async () => {
    const fixture = createApp({});
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().id, correlationId);
    assert.equal(response.json().status, 'queued');
    assert.deepEqual(fixture.calls, [
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}`,
      'worker:/internal/v1/tasks/task-0001/synthetic-runs',
    ]);
    await fixture.app.close();
  });

  it('denies changed prompt, unauthorized grant and replay under a different request ID', async () => {
    const fixture = createApp({ authorized: false });
    const changedDigest = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest: 'modified request' },
    });
    assert.equal(changedDigest.statusCode, 400);
    const revoked = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(revoked.statusCode, 409);
    await fixture.app.close();

    const replay = createApp({ consumedBy: '99999999-9999-4999-8999-999999999999' });
    const denied = await replay.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(denied.statusCode, 409);
    assert.equal(
      replay.calls.includes('worker:/internal/v1/tasks/task-0001/synthetic-runs'),
      false,
    );
    await replay.app.close();
  });

  it('allows same-key admission recovery without authorizing a second execution', async () => {
    const fixture = createApp({ consumedBy: requestId });
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 202);
    await fixture.app.close();
  });

  it('reports uncertain admission and never invents provider completion', async () => {
    const fixture = createApp({ throwWorker: true });
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'synthetic_run_admission_unknown');
    await fixture.app.close();
  });

  it('requests cancellation through grant revocation without claiming termination', async () => {
    const fixture = createApp({});
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}/cancel`,
      headers: { origin: 'http://localhost' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      requested: true,
      confirmed: false,
      authorizationId,
      taskId,
    });
    assert.equal(fixture.revokeCount(), 1);
    assert.equal(fixture.workerCancelCount(), 1);
    await fixture.app.close();
  });

  it('retries worker cancellation for an already revoked grant without revoking twice', async () => {
    const fixture = createApp({ revoked: true });
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}/cancel`,
      headers: { origin: 'http://localhost' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.revokeCount(), 0);
    assert.equal(fixture.workerCancelCount(), 1);
    await fixture.app.close();
  });

  it('revokes an expired grant when its durable attempt is still active', async () => {
    const fixture = createApp({ expiredConsumed: true, activeAttempt: true });
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}/cancel`,
      headers: { origin: 'http://localhost' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.revokeCount(), 1);
    assert.equal(fixture.workerCancelCount(), 1);
    await fixture.app.close();
  });

  it('returns authoritative attempt usage alongside the canonical Run projection', async () => {
    const fixture = createApp({});
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().run.id, correlationId);
    assert.equal(response.json().attempt.status, 'completed');
    assert.deepEqual(response.json().usage, {
      kind: 'unknown',
      reason: 'not_reported',
      billingExposure: 'unknown',
    });
    await fixture.app.close();
  });

  it('returns a durable Run when no authorizer attempt exists without inventing usage', async () => {
    const fixture = createApp({
      missingAttempt: true,
      runOverride: { ...run, status: 'unknown' },
    });
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().run.status, 'unknown');
    assert.equal(response.json().attempt, undefined);
    assert.deepEqual(response.json().usage, {
      kind: 'unknown',
      reason: 'submission_uncertain',
      billingExposure: 'unknown',
    });
    await fixture.app.close();
  });

  it('does not turn an unavailable Run store into a not-found response', async () => {
    const fixture = createApp({ missingAttempt: true, throwWorker: true });
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}`,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'synthetic_run_status_unknown');
    await fixture.app.close();
  });

  it('reads paginated task-run events only after verifying the owner task binding', async () => {
    const fixture = createApp({});
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}/events?after=2&limit=10`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().events[0].attemptId, '44444444-4444-4444-8444-444444444444');
    assert.equal(response.json().events[0].eventType, 'connector.execution_completed');
    assert.deepEqual(fixture.calls, [
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}`,
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}/events?after=2&limit=10`,
    ]);
    await fixture.app.close();
  });

  it('does not expose event history for a grant bound to another task', async () => {
    const fixture = createApp({});
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/task-other/synthetic-runs/${authorizationId}/events`,
    });
    assert.equal(response.statusCode, 404);
    assert.equal(fixture.calls.length, 1);
    await fixture.app.close();
  });

  it('rejects malformed event cursors and page sizes', async () => {
    const fixture = createApp({});
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/synthetic-runs/${authorizationId}/events?after=-1&limit=1000`,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(fixture.calls.length, 0);
    await fixture.app.close();
  });

  it('does not expose the route unless the test-only switch is enabled', async () => {
    const fixture = createApp({ enabled: false });
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { authorizationId, request: binding, renderedRequest },
    });
    assert.equal(response.statusCode, 404);
    await fixture.app.close();
  });
});

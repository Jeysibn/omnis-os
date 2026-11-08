import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ConnectorAuthorizationSchema } from '@omnis/contracts/connector-authorization';
import { RunSchema } from '@omnis/contracts';
import { stopSyntheticRunBeforeStandardStop } from './synthetic-run-stop.ts';

const runId = randomUUID();
const taskId = 'task-0001';
const authorizationId = randomUUID();
const requestId = randomUUID();
const authorization = ConnectorAuthorizationSchema.parse({
  id: authorizationId,
  requestId,
  correlationId: runId,
  requestingActor: 'owner',
  projectId: `prj_${'a'.repeat(32)}`,
  projectRevision: 1,
  taskId,
  taskRevision: 1,
  agentId: 'fixture-agent',
  profileVersion: 1,
  promptDigest: `sha256:${'a'.repeat(64)}`,
  connectorId: 'synthetic.codex.fixture',
  connectorVersion: '0.0.0-synthetic.1',
  providerId: 'synthetic',
  modelId: 'synthetic-text-only-v1',
  operation: 'connector.respond',
  capabilities: [],
  limits: {
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxDurationSeconds: 30,
    maxConcurrentRuns: 1,
    maxUsageUnits: 200,
    maxCostMicrousd: 1,
  },
  status: 'authorized',
  policyVersion: 'r1p1-synthetic-connector-v1',
  createdAt: '2026-01-01T00:00:00.000Z',
  consentedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  decidedAt: '2026-01-01T00:00:00.000Z',
  decidedBy: 'owner',
  consumedAt: null,
  consumedRequestId: null,
  revokedAt: null,
  revokedBy: null,
  revocationGeneration: 0,
  synthetic: true,
});

const run = RunSchema.parse({
  id: runId,
  taskId,
  taskTitle: 'Test task',
  status: 'stopping',
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

test('standard run stop revokes the bound connector grant before marking the synthetic Run stopping', async () => {
  const calls: string[] = [];
  const result = await stopSyntheticRunBeforeStandardStop(runId, {
    forwardWorker: async (path, init, parse) => {
      calls.push(`worker:${path}`);
      if (path.endsWith('/synthetic-binding')) {
        return parse({
          version: 'omnis.synthetic-task-run.v1',
          runId,
          taskId,
          authorizationId,
        });
      }
      if (path.endsWith('/cancel')) return parse(undefined);
      if (path === `/internal/v1/runs/${runId}`) return parse(run);
      throw new Error(`Unexpected worker request: ${path}`);
    },
    forwardAuthorizer: async (path, init, parse) => {
      calls.push(`authorizer:${path}`);
      if (path === `/internal/v1/connector-authorizations/${authorizationId}`)
        return parse(authorization);
      if (path.endsWith('/revoke')) return parse({ ...authorization, status: 'revoked' });
      throw new Error(`Unexpected authorizer request: ${path}`);
    },
  });

  assert.deepEqual(result, run);
  assert.deepEqual(calls, [
    `worker:/internal/v1/runs/${runId}/synthetic-binding`,
    `authorizer:/internal/v1/connector-authorizations/${authorizationId}`,
    `authorizer:/internal/v1/connector-authorizations/${authorizationId}/revoke`,
    `worker:/internal/v1/synthetic-runs/${runId}/cancel`,
    `worker:/internal/v1/runs/${runId}`,
  ]);
});

test('standard run stop rejects a synthetic binding that does not match its owner grant', async () => {
  await assert.rejects(
    stopSyntheticRunBeforeStandardStop(runId, {
      forwardWorker: async (path, _init, parse) => {
        if (path.endsWith('/synthetic-binding'))
          return parse({
            version: 'omnis.synthetic-task-run.v1',
            runId,
            taskId,
            authorizationId,
          });
        throw new Error('A mismatch must stop before worker cancellation.');
      },
      forwardAuthorizer: async (_path, _init, parse) =>
        parse({ ...authorization, correlationId: randomUUID() }),
    }),
    /does not match the persisted Run binding/,
  );
});

test('standard run stop leaves ordinary Runs on the existing mock cancellation path', async () => {
  const result = await stopSyntheticRunBeforeStandardStop(runId, {
    forwardWorker: async (path) => {
      const error = Object.assign(new Error('not a synthetic Run'), {
        statusCode: 404,
        body: { error: { code: 'not_found', message: 'Run was not found.' } },
      });
      if (path.endsWith('/synthetic-binding')) throw error;
      throw new Error('Expected the caller to use the existing mock stop path.');
    },
    forwardAuthorizer: async () => {
      throw new Error('Ordinary Runs must not contact the authorizer.');
    },
  });

  assert.equal(result, undefined);
});

test('standard run stop fails closed when revocation is unavailable', async () => {
  let workerCancelCalled = false;
  await assert.rejects(
    stopSyntheticRunBeforeStandardStop(runId, {
      forwardWorker: async (path, _init, parse) => {
        if (path.endsWith('/synthetic-binding'))
          return parse({ version: 'omnis.synthetic-task-run.v1', runId, taskId, authorizationId });
        if (path.endsWith('/cancel')) workerCancelCalled = true;
        return parse(run);
      },
      forwardAuthorizer: async () => {
        throw new Error('authorizer unavailable');
      },
    }),
    /authorizer unavailable/,
  );
  assert.equal(workerCancelCalled, false);
});

test('standard run stop requests cancellation of an active attempt even after grant expiry', async () => {
  const expired = ConnectorAuthorizationSchema.parse({
    ...authorization,
    status: 'expired',
    expiresAt: '2020-01-01T00:00:00.000Z',
    consumedAt: '2020-01-01T00:00:00.000Z',
    consumedRequestId: requestId,
  });
  const calls: string[] = [];
  const result = await stopSyntheticRunBeforeStandardStop(runId, {
    forwardWorker: async (path, _init, parse) => {
      calls.push(`worker:${path}`);
      if (path.endsWith('/synthetic-binding'))
        return parse({ version: 'omnis.synthetic-task-run.v1', runId, taskId, authorizationId });
      if (path.endsWith('/cancel')) return parse(undefined);
      return parse(run);
    },
    forwardAuthorizer: async (path, _init, parse) => {
      calls.push(`authorizer:${path}`);
      if (path.endsWith('/execution'))
        return parse({
          version: 'omnis.synthetic-task-run.v1',
          taskId,
          usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
          attempt: {
            id: randomUUID(),
            authorizationId,
            requestId,
            status: 'submitting',
            brokerGeneration: 1,
            brokerLeaseExpiresAt: null,
            synthetic: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            submissionStartedAt: '2026-01-01T00:00:00.000Z',
          },
        });
      if (path.endsWith('/revoke')) return parse({ ...expired, status: 'revoked' });
      return parse(expired);
    },
  });

  assert.deepEqual(result, run);
  assert.ok(
    calls.indexOf(`authorizer:/internal/v1/connector-authorizations/${authorizationId}/revoke`) <
      calls.indexOf(`worker:/internal/v1/synthetic-runs/${runId}/cancel`),
  );
});

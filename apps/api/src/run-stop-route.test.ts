import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { ConnectorAuthorizationSchema } from '@omnis/contracts/connector-authorization';
import { RunSchema } from '@omnis/contracts';
import { registerRunStopRoute } from './run-stop-route.ts';

const runId = randomUUID();
const taskId = 'task-0001';
const authorizationId = randomUUID();
const requestId = randomUUID();
const binding = {
  version: 'omnis.synthetic-task-run.v1',
  runId,
  taskId,
  authorizationId,
};
const grant = ConnectorAuthorizationSchema.parse({
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
  decidedAt: '2026-01-01T00:00:00.000Z',
  decidedBy: 'owner',
  revokedAt: null,
  revokedBy: null,
  revocationGeneration: 0,
  expiresAt: '2099-01-01T00:00:00.000Z',
  consumedAt: null,
  consumedRequestId: null,
  synthetic: true,
});
const run = RunSchema.parse({
  id: runId,
  taskId,
  taskTitle: 'Synthetic task',
  status: 'stopping',
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('standard owner Run stop route', () => {
  it('requires owner session and CSRF before looking up or revoking a synthetic grant', async () => {
    for (const denied of ['owner', 'csrf'] as const) {
      const app = Fastify();
      let forwarded = false;
      registerRunStopRoute(app, {
        requireOwner: async (_request, reply) => {
          if (denied === 'owner')
            return reply.code(401).send({ error: { code: 'owner_required' } });
        },
        requireMutationProtection: async (_request, reply) => {
          if (denied === 'csrf') return reply.code(403).send({ error: { code: 'csrf_rejected' } });
        },
        syntheticBrokerEnabled: true,
        forwardWorker: async <TResult>(
          _path: string,
          _init: RequestInit,
          parse: (value: unknown) => TResult,
        ) => {
          forwarded = true;
          return parse(run);
        },
        forwardAuthorizer: async <TResult>(
          _path: string,
          _init: RequestInit,
          parse: (value: unknown) => TResult,
        ) => {
          forwarded = true;
          return parse(grant);
        },
      });
      const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/stop` });
      assert.equal(response.statusCode, denied === 'owner' ? 401 : 403);
      assert.equal(forwarded, false);
      await app.close();
    }
  });

  it('routes the standard stop action through owner grant revocation and durable worker cancellation', async () => {
    const app = Fastify();
    const calls: string[] = [];
    registerRunStopRoute(app, {
      requireOwner: async () => {},
      requireMutationProtection: async () => {},
      syntheticBrokerEnabled: true,
      forwardWorker: async <TResult>(
        path: string,
        _init: RequestInit,
        parse: (value: unknown) => TResult,
      ) => {
        calls.push(`worker:${path}`);
        if (path.endsWith('/synthetic-binding')) return parse(binding);
        if (path.endsWith('/cancel')) return parse(undefined);
        return parse(run);
      },
      forwardAuthorizer: async <TResult>(
        path: string,
        _init: RequestInit,
        parse: (value: unknown) => TResult,
      ) => {
        calls.push(`authorizer:${path}`);
        return parse(path.endsWith('/revoke') ? { ...grant, status: 'revoked' } : grant);
      },
    });
    const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/stop` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'stopping');
    assert.deepEqual(calls, [
      `worker:/internal/v1/runs/${runId}/synthetic-binding`,
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}`,
      `authorizer:/internal/v1/connector-authorizations/${authorizationId}/revoke`,
      `worker:/internal/v1/synthetic-runs/${runId}/cancel`,
      `worker:/internal/v1/runs/${runId}`,
    ]);
    await app.close();
  });

  it('keeps the existing mock-only stop path when the worker reports no synthetic binding', async () => {
    const app = Fastify();
    const calls: string[] = [];
    registerRunStopRoute(app, {
      requireOwner: async () => {},
      requireMutationProtection: async () => {},
      syntheticBrokerEnabled: true,
      forwardWorker: async (path, _init, parse) => {
        calls.push(path);
        if (path.endsWith('/synthetic-binding')) {
          throw Object.assign(new Error('not found'), {
            statusCode: 404,
            body: { error: { code: 'not_found', message: 'No synthetic Run.' } },
          });
        }
        return parse(run);
      },
      forwardAuthorizer: async () => {
        throw new Error('Ordinary mock run must not reach the authorizer.');
      },
    });
    const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/stop` });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [
      `/internal/v1/runs/${runId}/synthetic-binding`,
      `/internal/v1/runs/${runId}/stop`,
    ]);
    await app.close();
  });

  it('does not probe synthetic authorization when the test-only integration is disabled', async () => {
    const app = Fastify();
    const calls: string[] = [];
    registerRunStopRoute(app, {
      requireOwner: async () => {},
      requireMutationProtection: async () => {},
      syntheticBrokerEnabled: false,
      forwardWorker: async <TResult>(
        path: string,
        _init: RequestInit,
        parse: (value: unknown) => TResult,
      ) => {
        calls.push(path);
        return parse(run);
      },
      forwardAuthorizer: async () => {
        throw new Error('Disabled synthetic integration must not contact the authorizer.');
      },
    });
    const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/stop` });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [`/internal/v1/runs/${runId}/stop`]);
    await app.close();
  });
});

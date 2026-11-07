import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { describe, it } from 'node:test';
import type { Task } from '@omnis/contracts';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { renderSyntheticConnectorRequest } from '@omnis/contracts/synthetic-connector-prompt';
import { registerSyntheticTaskRunRoute } from './synthetic-task-run-routes.ts';

const taskId = 'task-0001';
const requestId = '22222222-2222-4222-8222-222222222222';
const authorizationId = '11111111-1111-4111-8111-111111111111';
const correlationId = '55555555-5555-4555-8555-555555555555';
const task = {
  id: taskId,
  title: 'Synthetic task',
  detail: 'Return a synthetic response.',
  status: 'open',
  createdAt: '2026-11-06T00:00:00.000Z',
  projectId: `prj_${'a'.repeat(32)}`,
  associationRevision: 1,
};
const profile = {
  versionId: 'profile_version_1',
  agentId: 'fixture-agent',
  versionNo: 1,
  profession: 'Synthetic assistant',
  seniority: null,
  specialties: ['testing'],
  personality: { traits: ['careful'], tone: 'plain', principles: [] },
  behavior: { autonomy: 'No external actions.', escalation: null },
  instructions: 'Return only a synthetic answer.',
  createdBy: { id: 'owner', displayName: 'Owner' },
  createdAt: '2026-11-06T00:00:00.000Z',
};
const renderedRequest = renderSyntheticConnectorRequest(task, profile);
const input = {
  version: 'omnis.synthetic-task-run.v1',
  authorizationId,
  requestId,
  correlationId,
  request: {
    projectId: `prj_${'a'.repeat(32)}`,
    projectRevision: 1,
    taskId,
    taskRevision: 1,
    agentId: 'fixture-agent',
    profileVersion: 1,
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
      maxUsageUnits: 100,
      maxCostMicrousd: 100,
    },
    promptDigest: createRenderedRequestDigest(renderedRequest),
  },
  renderedRequest,
};

function createApp(
  options: {
    enabled?: boolean;
    taskExists?: boolean;
    throwAdmission?: boolean;
    authenticated?: boolean;
    profileVersion?: number;
    taskIdOverride?: string;
  } = {},
) {
  const app = Fastify();
  let called = 0;
  registerSyntheticTaskRunRoute(app, {
    authenticate: async (_request, reply) => {
      if (options.authenticated === false) {
        return reply.code(401).send({ error: { code: 'unauthorized_worker' } });
      }
    },
    enabled: options.enabled ?? true,
    store: {
      getTask: async () =>
        options.taskExists === false
          ? undefined
          : ({ ...task, id: options.taskIdOverride ?? task.id } as Task),
      getSyntheticBrokerRun: async (runId: string) =>
        runId === correlationId
          ? {
              run: { id: correlationId, taskId },
              authorizationId,
            }
          : undefined,
    } as never,
    profiles: {
      getVersion: async () =>
        ({
          agent: { id: profile.agentId },
          version: { ...profile, versionNo: options.profileVersion ?? profile.versionNo },
          isCurrent: true,
        }) as never,
    },
    admit: async (request) => {
      called += 1;
      if (options.throwAdmission) throw new Error('database unavailable');
      return {
        created: true,
        run: {
          id: request.correlationId,
          taskId,
          taskTitle: task.title,
          status: 'queued' as const,
          runtimeKind: 'mock' as const,
          synthetic: true as const,
          usage: { quality: 'unknown' as const, inputTokens: null, outputTokens: null, cost: null },
          createdAt: '2026-11-06T00:00:00.000Z',
          updatedAt: '2026-11-06T00:00:00.000Z',
        },
      };
    },
    cancel: async () => {},
  });
  return { app, getCalled: () => called };
}

describe('worker synthetic task run admission', () => {
  it('returns only the persisted synthetic Run binding to an authenticated internal caller', async () => {
    const { app } = createApp();
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/runs/${correlationId}/synthetic-binding`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      version: 'omnis.synthetic-task-run.v1',
      runId: correlationId,
      taskId,
      authorizationId,
    });
    const missing = await app.inject({
      method: 'GET',
      url: `/internal/v1/runs/${requestId}/synthetic-binding`,
    });
    assert.equal(missing.statusCode, 404);
    await app.close();
  });

  it('requires internal worker authentication to read the synthetic Run binding', async () => {
    const { app } = createApp({ authenticated: false });
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/runs/${correlationId}/synthetic-binding`,
    });
    assert.equal(response.statusCode, 401);
    await app.close();
  });

  it('requires the internal worker credential before admission', async () => {
    const { app, getCalled } = createApp({ authenticated: false });
    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(getCalled(), 0);
    await app.close();
  });

  it('admits a task-bound Run and returns the canonical correlation identity', async () => {
    const { app, getCalled } = createApp();
    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().run.id, correlationId);
    assert.equal(response.json().run.status, 'queued');
    assert.equal(getCalled(), 1);
    await app.close();
  });

  it('rejects wrong route task and idempotency identity before admission', async () => {
    const { app, getCalled } = createApp();
    const wrongTask = await app.inject({
      method: 'POST',
      url: '/internal/v1/tasks/task-0002/synthetic-runs',
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    const wrongKey = await app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': '33333333-3333-4333-8333-333333333333' },
      payload: input,
    });
    assert.equal(wrongTask.statusCode, 400);
    assert.equal(wrongKey.statusCode, 400);
    assert.equal(getCalled(), 0);
    await app.close();
  });

  it('does not admit nonexistent tasks and fails closed when durable admission is unavailable', async () => {
    const missing = createApp({ taskExists: false });
    const missingTask = await missing.app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(missingTask.statusCode, 404);
    await missing.app.close();

    const unavailable = createApp({ throwAdmission: true });
    const response = await unavailable.app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(unavailable.getCalled(), 1);
    await unavailable.app.close();
  });

  it('reconstructs the approved prompt before durable admission', async () => {
    const { app, getCalled } = createApp();
    const alteredPrompt = await app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: { ...input, renderedRequest: `${renderedRequest} altered` },
    });
    assert.equal(alteredPrompt.statusCode, 409);
    assert.equal(getCalled(), 0);

    const canonical = await app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(canonical.statusCode, 202);
    assert.equal(getCalled(), 1);
    await app.close();
  });

  it('rejects a changed immutable profile version before admission', async () => {
    const { app, getCalled } = createApp({ profileVersion: 2 });
    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(getCalled(), 0);
    await app.close();
  });

  it('rejects a persisted task with an unexpected identity before admission', async () => {
    const { app, getCalled } = createApp({ taskIdOverride: 'task-foreign' });
    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(getCalled(), 0);
    await app.close();
  });
});

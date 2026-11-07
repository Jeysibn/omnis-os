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
    throwBroker?: boolean;
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
    } as never,
    profiles: {
      getVersion: async () =>
        ({
          agent: { id: profile.agentId },
          version: { ...profile, versionNo: options.profileVersion ?? profile.versionNo },
          isCurrent: true,
        }) as never,
    },
    broker: {
      execute: async (_id, request) => {
        called += 1;
        if (options.throwBroker) throw new Error('broker unavailable');
        return {
          version: 'omnis.synthetic-task-run.v1',
          taskId,
          authorizationId: request.authorizationId,
          requestId: request.requestId,
          correlationId: '55555555-5555-4555-8555-555555555555',
          attemptId: '44444444-4444-4444-8444-444444444444',
          status: 'unknown',
          submitted: true,
          usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
        };
      },
    },
  });
  return { app, getCalled: () => called };
}

describe('worker synthetic task broker dispatch', () => {
  it('requires the internal worker credential before broker dispatch', async () => {
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

  it('dispatches a task-bound request once and preserves unknown outcome', async () => {
    const { app, getCalled } = createApp();
    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'unknown');
    assert.equal(response.json().usage.kind, 'unknown');
    assert.equal(getCalled(), 1);
    await app.close();
  });

  it('rejects wrong route task and idempotency identity before broker dispatch', async () => {
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

  it('does not dispatch nonexistent tasks or automatically retry uncertain broker failures', async () => {
    const missing = createApp({ taskExists: false });
    const missingTask = await missing.app.inject({
      method: 'POST',
      url: `/internal/v1/tasks/${taskId}/synthetic-runs`,
      headers: { 'idempotency-key': requestId },
      payload: input,
    });
    assert.equal(missingTask.statusCode, 404);
    await missing.app.close();

    const unavailable = createApp({ throwBroker: true });
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

  it('reconstructs the approved prompt from persisted task and immutable profile content', async () => {
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
    assert.equal(canonical.statusCode, 200);
    assert.equal(getCalled(), 1);
    await app.close();
  });

  it('rejects a changed immutable profile version before broker dispatch', async () => {
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

  it('rejects a persisted task with an unexpected identity before broker dispatch', async () => {
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

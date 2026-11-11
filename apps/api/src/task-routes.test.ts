import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'task-route-test-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'task-route-test-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'task-route-test-authorizer-token-'.padEnd(64, 'y');
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { registerTaskRoutes } = await import('./task-routes.ts');
const task = {
  id: 'task-0001',
  title: 'Review project policy',
  detail: 'Confirm the task project integration contract.',
  status: 'open',
  createdAt: '2026-11-04T00:00:00.000Z',
  projectId: null,
  associationRevision: 1,
};
const projectId = `prj_${'1'.repeat(32)}`;
const idempotencyKey = 'b9d5fd0e-4681-4a41-90c0-50b120843aa5';
const runId = 'run-0001';
const acceptance = {
  runId,
  acceptedBy: 'owner',
  acceptedAt: '2026-11-12T00:00:00.000Z',
  requestId: idempotencyKey,
};

function createApp(owner: boolean, calls: Array<{ path: string; init?: RequestInit }>) {
  const app = Fastify();
  app.decorateRequest('omnisSession', undefined);
  app.addHook('onRequest', async (request) => {
    if (owner)
      request.omnisSession = {
        id: 'session',
        owner: true,
        csrfToken: 'csrf-token-123456',
        expiresAt: Date.now() + 1000,
      };
  });
  registerTaskRoutes(
    app,
    async <T>(path: string, init: RequestInit | undefined, parse: (value: unknown) => T) => {
      calls.push({ path, ...(init ? { init } : {}) });
      if (path === '/internal/v1/tasks' && !init?.method) return parse([task]);
      if (path.endsWith('/accept-result'))
        return parse({
          task: { ...task, status: 'completed', resultAcceptance: acceptance },
          acceptance,
          created: true,
        });
      return parse(task);
    },
  );
  return app;
}

const protectedHeaders = {
  origin: 'http://127.0.0.1:5173',
  'x-omnis-csrf': 'csrf-token-123456',
  'idempotency-key': idempotencyKey,
};

describe('owner task routes', () => {
  it('keeps the read contract and legacy unassigned task creation compatible', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const app = createApp(true, calls);
    try {
      const listed = await app.inject({ method: 'GET', url: '/api/v1/tasks' });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json()[0].projectId, null);
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: {
          origin: protectedHeaders.origin,
          'x-omnis-csrf': protectedHeaders['x-omnis-csrf'],
        },
        payload: { title: task.title, detail: task.detail },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(calls.at(-1)?.init?.headers, undefined);
    } finally {
      await app.close();
    }
  });

  it('requires an authenticated owner and idempotency key to accept an exact completed result', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const anonymous = createApp(false, calls);
    const owner = createApp(true, calls);
    try {
      const unauthorized = await anonymous.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/accept-result`,
        headers: protectedHeaders,
        payload: { runId },
      });
      assert.equal(unauthorized.statusCode, 401);
      const missingKey = await owner.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/accept-result`,
        headers: {
          origin: protectedHeaders.origin,
          'x-omnis-csrf': protectedHeaders['x-omnis-csrf'],
        },
        payload: { runId },
      });
      assert.equal(missingKey.statusCode, 400);
      const accepted = await owner.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/accept-result`,
        headers: protectedHeaders,
        payload: { runId },
      });
      assert.equal(accepted.statusCode, 200);
      assert.deepEqual(accepted.json().acceptance, acceptance);
      assert.equal(calls.at(-1)?.path, `/internal/v1/tasks/${task.id}/accept-result`);
      assert.equal(calls.at(-1)?.init?.method, 'POST');
      assert.deepEqual(calls.at(-1)?.init?.headers, { 'idempotency-key': idempotencyKey });
      assert.equal(calls.at(-1)?.init?.body, JSON.stringify({ runId }));
    } finally {
      await Promise.all([anonymous.close(), owner.close()]);
    }
  });

  it('requires owner session, CSRF, and an idempotency key for project association', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const anonymous = createApp(false, calls);
    const owner = createApp(true, calls);
    try {
      const payload = { projectId, expectedAssociationRevision: 1 };
      const unauthorized = await anonymous.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}/project`,
        headers: protectedHeaders,
        payload,
      });
      assert.equal(unauthorized.statusCode, 401);
      const csrfRejected = await owner.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}/project`,
        headers: { ...protectedHeaders, 'x-omnis-csrf': 'wrong' },
        payload,
      });
      assert.equal(csrfRejected.statusCode, 403);
      const invalid = await owner.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}/project`,
        headers: { ...protectedHeaders, 'idempotency-key': 'bad' },
        payload,
      });
      assert.equal(invalid.statusCode, 400);
      const assigned = await owner.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}/project`,
        headers: protectedHeaders,
        payload,
      });
      assert.equal(assigned.statusCode, 200);
      assert.equal(calls.at(-1)?.path, `/internal/v1/tasks/${task.id}/project`);
      assert.deepEqual(calls.at(-1)?.init?.headers, { 'idempotency-key': idempotencyKey });
    } finally {
      await Promise.all([anonymous.close(), owner.close()]);
    }
  });

  it('requires a key for project tasks and rejects malformed associations before forwarding', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const app = createApp(true, calls);
    try {
      const missingKey = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: {
          origin: protectedHeaders.origin,
          'x-omnis-csrf': protectedHeaders['x-omnis-csrf'],
        },
        payload: { title: task.title, detail: task.detail, projectId },
      });
      assert.equal(missingKey.statusCode, 400);
      const malformed = await app.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}/project`,
        headers: protectedHeaders,
        payload: { projectId: 'not-a-project', expectedAssociationRevision: 1 },
      });
      assert.equal(malformed.statusCode, 400);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('requires owner protection and a key for execution assignment, then forwards the exact request', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const anonymous = createApp(false, calls);
    const owner = createApp(true, calls);
    const payload = {
      agentId: 'agent-001',
      profileVersion: 2,
      runtimeId: 'mock',
      expectedAssignmentRevision: 1,
    };
    try {
      const unauthorized = await anonymous.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}/execution-assignment`,
        headers: protectedHeaders,
        payload,
      });
      assert.equal(unauthorized.statusCode, 401);
      const invalidRuntime = await owner.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}/execution-assignment`,
        headers: protectedHeaders,
        payload: { ...payload, runtimeId: 'codex' },
      });
      assert.equal(invalidRuntime.statusCode, 400);
      const assigned = await owner.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}/execution-assignment`,
        headers: protectedHeaders,
        payload,
      });
      assert.equal(assigned.statusCode, 200);
      assert.equal(calls.at(-1)?.path, `/internal/v1/tasks/${task.id}/execution-assignment`);
      assert.deepEqual(calls.at(-1)?.init?.headers, { 'idempotency-key': idempotencyKey });
      assert.equal(calls.at(-1)?.init?.body, JSON.stringify(payload));
    } finally {
      await Promise.all([anonymous.close(), owner.close()]);
    }
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'task-epic-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'task-epic-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'task-epic-authorizer-token-'.padEnd(64, 'y');
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { registerTaskEpicRoutes } = await import('./task-epic-routes.ts');

const projectId = 'prj_0123456789abcdef0123456789abcdef';
const epic = {
  id: 'epc_0123456789abcdef0123456789abcdef',
  projectId,
  title: 'Implement Epic association',
  description: null,
  status: 'planned',
  revision: 1,
  archivedAt: null,
  createdAt: '2026-11-05T00:00:00.000000Z',
  updatedAt: '2026-11-05T00:00:00.000000Z',
};
const association = {
  taskId: 'task-0001',
  projectId,
  epicId: epic.id,
  associationRevision: 2,
};
const key = 'b9d5fd0e-4681-4a41-90c0-50b120843aa5';

function makeApp(
  owner: boolean,
  calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }>,
) {
  const app = Fastify();
  app.decorateRequest('omnisSession', undefined);
  app.addHook('onRequest', async (request) => {
    if (owner)
      request.omnisSession = {
        id: 'session-id',
        owner: true,
        csrfToken: 'csrf-token-123456',
        expiresAt: Date.now() + 60_000,
      };
  });
  registerTaskEpicRoutes(
    app,
    async <T>(path: string, init: RequestInit | undefined, parse: (value: unknown) => T) => {
      calls.push({
        path,
        method: init?.method ?? 'GET',
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (path.endsWith('/epic') && (init?.method ?? 'GET') === 'GET')
        return parse({ taskId: 'task-0001', projectId, epic, associationRevision: 2 });
      const input = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return parse({
        ...association,
        epicId: input?.epicId ?? null,
        associationRevision: (input?.expectedAssociationRevision ?? 1) + 1,
      });
    },
  );
  return app;
}

const mutationHeaders = {
  origin: 'http://127.0.0.1:5173',
  'x-omnis-csrf': 'csrf-token-123456',
  'idempotency-key': key,
};

describe('owner task Epic routes', () => {
  it('requires owner authentication and session-bound CSRF for association writes', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const anonymous = makeApp(false, calls);
    const owner = makeApp(true, calls);
    try {
      const payload = { expectedAssociationRevision: 1, epicId: epic.id };
      const unauthorized = await anonymous.inject({
        method: 'PUT',
        url: '/api/v1/tasks/task-0001/epic',
        headers: mutationHeaders,
        payload,
      });
      assert.equal(unauthorized.statusCode, 401);
      const invalidCsrf = await owner.inject({
        method: 'PUT',
        url: '/api/v1/tasks/task-0001/epic',
        headers: { ...mutationHeaders, 'x-omnis-csrf': 'wrong' },
        payload,
      });
      assert.equal(invalidCsrf.statusCode, 403);
      const invalidInput = await owner.inject({
        method: 'PUT',
        url: '/api/v1/tasks/task-0001/epic',
        headers: mutationHeaders,
        payload: { expectedAssociationRevision: 0, epicId: epic.id },
      });
      assert.equal(invalidInput.statusCode, 422);
      assert.deepEqual(calls, []);
    } finally {
      await Promise.all([anonymous.close(), owner.close()]);
    }
  });

  it('reads the assigned Epic and forwards assignment, reassignment, and unlink requests', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const app = makeApp(true, calls);
    try {
      const read = await app.inject({ method: 'GET', url: '/api/v1/tasks/task-0001/epic' });
      assert.equal(read.statusCode, 200);
      assert.equal(read.json().epic.id, epic.id);

      const assigned = await app.inject({
        method: 'PUT',
        url: '/api/v1/tasks/task-0001/epic',
        headers: mutationHeaders,
        payload: { expectedAssociationRevision: 1, epicId: epic.id },
      });
      assert.equal(assigned.statusCode, 200);
      assert.equal(assigned.json().epicId, epic.id);
      assert.equal(calls.at(-1)?.method, 'PUT');
      assert.equal(
        calls.at(-1)?.body,
        JSON.stringify({ expectedAssociationRevision: 1, epicId: epic.id }),
      );
      assert.equal(new Headers(calls.at(-1)?.headers).get('idempotency-key'), key);

      const unlinked = await app.inject({
        method: 'PUT',
        url: '/api/v1/tasks/task-0001/epic',
        headers: mutationHeaders,
        payload: { expectedAssociationRevision: 2, epicId: null },
      });
      assert.equal(unlinked.statusCode, 200);
      assert.equal(unlinked.json().epicId, null);
    } finally {
      await app.close();
    }
  });
});

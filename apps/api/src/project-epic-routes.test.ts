import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'project-epic-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'project-epic-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'project-epic-authorizer-token-'.padEnd(64, 'y');
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { registerProjectEpicRoutes } = await import('./project-epic-routes.ts');

const projectId = 'prj_0123456789abcdef0123456789abcdef';
const epic = {
  id: 'epc_0123456789abcdef0123456789abcdef',
  projectId,
  title: 'Initial epic',
  description: null,
  status: 'planned',
  revision: 1,
  archivedAt: null,
  createdAt: '2026-11-05T00:00:00.000000Z',
  updatedAt: '2026-11-05T00:00:00.000000Z',
};

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
  registerProjectEpicRoutes(
    app,
    async <T>(path: string, init: RequestInit | undefined, parse: (value: unknown) => T) => {
      calls.push({
        path,
        method: init?.method ?? 'GET',
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if ((init?.method ?? 'GET') === 'GET' && path.includes('/epics?'))
        return parse({
          epics: [epic],
          page: { observedTotal: 1, complete: true, nextCursor: null },
        });
      if (path.endsWith('/archive'))
        return parse({
          ...epic,
          status: 'archived',
          revision: 2,
          archivedAt: epic.createdAt,
        });
      if (init?.method === 'PATCH') return parse({ ...epic, title: 'Updated', revision: 2 });
      return parse(epic);
    },
  );
  return app;
}

describe('owner project epic routes', () => {
  const mutationHeaders = {
    origin: 'http://127.0.0.1:5173',
    'x-omnis-csrf': 'csrf-token-123456',
    'idempotency-key': 'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
  };

  it('protects mutations with owner session and session-bound CSRF', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const anonymous = makeApp(false, calls);
    const owner = makeApp(true, calls);
    try {
      const denied = await anonymous.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/epics`,
        headers: mutationHeaders,
        payload: { title: 'Epic' },
      });
      assert.equal(denied.statusCode, 401);
      const csrf = await owner.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/epics`,
        headers: { ...mutationHeaders, 'x-omnis-csrf': 'wrong-token' },
        payload: { title: 'Epic' },
      });
      assert.equal(csrf.statusCode, 403);
      const invalid = await owner.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/epics`,
        headers: mutationHeaders,
        payload: { title: '   ' },
      });
      assert.equal(invalid.statusCode, 422);
      assert.deepEqual(calls, []);
    } finally {
      await Promise.all([anonymous.close(), owner.close()]);
    }
  });

  it('forwards bounded reads and idempotent edits to the project-scoped authorizer contract', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const app = makeApp(true, calls);
    try {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/epics?limit=20&cursor=opaque`,
      });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().epics[0].id, epic.id);
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/epics`,
        headers: mutationHeaders,
        payload: { title: 'Initial epic', description: 'Plan delivery.' },
      });
      assert.equal(created.statusCode, 201);
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/epics/${epic.id}`,
      });
      assert.equal(detail.statusCode, 200);
      const edited = await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}/epics/${epic.id}`,
        headers: mutationHeaders,
        payload: { expectedRevision: 1, title: 'Updated' },
      });
      assert.equal(edited.statusCode, 200);
      const archived = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/epics/${epic.id}/archive`,
        headers: mutationHeaders,
        payload: { expectedRevision: 2 },
      });
      assert.equal(archived.statusCode, 200);
      assert.deepEqual(
        calls.map(({ method, path }) => [method, path]),
        [
          ['GET', `/internal/v1/projects/${projectId}/epics?cursor=opaque&limit=20`],
          ['POST', `/internal/v1/projects/${projectId}/epics`],
          ['GET', `/internal/v1/projects/${projectId}/epics/${epic.id}`],
          ['PATCH', `/internal/v1/projects/${projectId}/epics/${epic.id}`],
          ['POST', `/internal/v1/projects/${projectId}/epics/${epic.id}/archive`],
        ],
      );
      assert.deepEqual(JSON.parse(calls[3]!.body!), { expectedRevision: 1, title: 'Updated' });
      assert.equal(
        new Headers(calls[4]!.headers).get('idempotency-key'),
        mutationHeaders['idempotency-key'],
      );
      assert.equal(new Headers(calls[4]!.headers).get('x-omnis-authorizer-token'), null);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed identifiers and invalid pagination before authorizer access', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const app = makeApp(true, calls);
    try {
      const badId = await app.inject({ method: 'GET', url: '/api/v1/projects/no/epics' });
      const badLimit = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/epics?limit=1000`,
      });
      assert.equal(badId.statusCode, 422);
      assert.equal(badLimit.statusCode, 422);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });
});

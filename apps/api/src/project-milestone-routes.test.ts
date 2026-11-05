import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'project-milestone-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'project-milestone-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'project-milestone-authorizer-token-'.padEnd(64, 'y');
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { registerProjectMilestoneRoutes } = await import('./project-milestone-routes.ts');

const projectId = 'prj_0123456789abcdef0123456789abcdef';
const milestone = {
  id: 'mil_0123456789abcdef0123456789abcdef',
  projectId,
  title: 'First release',
  description: null,
  status: 'planned',
  targetDate: null,
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
  registerProjectMilestoneRoutes(
    app,
    async <T>(path: string, init: RequestInit | undefined, parse: (value: unknown) => T) => {
      calls.push({
        path,
        method: init?.method ?? 'GET',
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if ((init?.method ?? 'GET') === 'GET' && path.includes('/milestones?'))
        return parse({
          milestones: [milestone],
          page: { observedTotal: 1, complete: true, nextCursor: null },
        });
      if (path.endsWith('/archive'))
        return parse({
          ...milestone,
          status: 'archived',
          revision: 2,
          archivedAt: milestone.createdAt,
        });
      if (init?.method === 'PATCH') return parse({ ...milestone, title: 'Updated', revision: 2 });
      return parse(milestone);
    },
  );
  return app;
}

describe('owner project milestone routes', () => {
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
        url: `/api/v1/projects/${projectId}/milestones`,
        headers: mutationHeaders,
        payload: { title: 'Release' },
      });
      assert.equal(denied.statusCode, 401);
      const csrf = await owner.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/milestones`,
        headers: { ...mutationHeaders, 'x-omnis-csrf': 'wrong-token' },
        payload: { title: 'Release' },
      });
      assert.equal(csrf.statusCode, 403);
      const invalid = await owner.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/milestones`,
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
        url: `/api/v1/projects/${projectId}/milestones?limit=20&cursor=opaque`,
      });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().milestones[0].id, milestone.id);
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/milestones`,
        headers: mutationHeaders,
        payload: { title: 'First release', targetDate: '2027-01-31' },
      });
      assert.equal(created.statusCode, 201);
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/milestones/${milestone.id}`,
      });
      assert.equal(detail.statusCode, 200);
      const edited = await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}/milestones/${milestone.id}`,
        headers: mutationHeaders,
        payload: { expectedRevision: 1, title: 'Updated' },
      });
      assert.equal(edited.statusCode, 200);
      const archived = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/milestones/${milestone.id}/archive`,
        headers: mutationHeaders,
        payload: { expectedRevision: 2 },
      });
      assert.equal(archived.statusCode, 200);
      assert.deepEqual(
        calls.map(({ method, path }) => [method, path]),
        [
          ['GET', `/internal/v1/projects/${projectId}/milestones?cursor=opaque&limit=20`],
          ['POST', `/internal/v1/projects/${projectId}/milestones`],
          ['GET', `/internal/v1/projects/${projectId}/milestones/${milestone.id}`],
          ['PATCH', `/internal/v1/projects/${projectId}/milestones/${milestone.id}`],
          ['POST', `/internal/v1/projects/${projectId}/milestones/${milestone.id}/archive`],
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
      const badId = await app.inject({ method: 'GET', url: '/api/v1/projects/no/milestones' });
      const badLimit = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/milestones?limit=1000`,
      });
      assert.equal(badId.statusCode, 422);
      assert.equal(badLimit.statusCode, 422);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'project-route-test-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'project-route-test-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'project-route-test-authorizer-token-'.padEnd(64, 'y');
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { registerProjectRoutes } = await import('./project-routes.ts');
const at = '2026-11-04T00:00:00.000Z';
const project = {
  id: 'prj_0123456789abcdef0123456789abcdef',
  ownerId: 'owner',
  key: 'OMNIS-OS',
  name: 'Omnis OS',
  objective: 'Deliver the project foundation.',
  status: 'proposed',
  priority: 'normal',
  revision: 1,
  createdAt: at,
  updatedAt: at,
};
const projectSummary = {
  id: project.id,
  ownerId: project.ownerId,
  key: project.key,
  name: project.name,
  status: project.status,
  priority: project.priority,
  revision: project.revision,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
};

function testApp(
  owner: boolean,
  calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }>,
) {
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
  registerProjectRoutes(
    app,
    async <T>(path: string, init: RequestInit | undefined, parse: (value: unknown) => T) => {
      calls.push({
        path,
        method: init?.method ?? 'GET',
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (path === '/internal/v1/projects') {
        return parse(
          init?.method === 'POST'
            ? project
            : { projects: [projectSummary], total: 1, complete: true },
        );
      }
      if (init?.method === 'PATCH') return parse({ ...project, name: 'Updated name', revision: 2 });
      if (path.endsWith('/archive')) return parse({ ...project, status: 'archived', revision: 2 });
      return parse(project);
    },
  );
  return app;
}

describe('owner project routes', () => {
  it('requires owner authentication and session-bound CSRF before creation', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const anonymous = testApp(false, calls);
    const owner = testApp(true, calls);
    const body = {
      key: 'OMNIS-OS',
      name: 'Omnis OS',
      objective: 'Deliver the project foundation.',
    };
    try {
      const unauthorized = await anonymous.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: body,
      });
      assert.equal(unauthorized.statusCode, 401);
      const csrfRejected = await owner.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: body,
        headers: {
          origin: 'http://127.0.0.1:5173',
          'idempotency-key': 'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
        },
      });
      assert.equal(csrfRejected.statusCode, 403);
      const invalid = await owner.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: { ...body, key: 'bad key' },
        headers: {
          origin: 'http://127.0.0.1:5173',
          'x-omnis-csrf': 'csrf-token-123456',
          'idempotency-key': 'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
        },
      });
      assert.equal(invalid.statusCode, 422);
      assert.deepEqual(calls, []);
    } finally {
      await Promise.all([anonymous.close(), owner.close()]);
    }
  });

  it('returns complete lists, creates with idempotency, and validates project identity', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const app = testApp(true, calls);
    const headers = {
      origin: 'http://127.0.0.1:5173',
      'x-omnis-csrf': 'csrf-token-123456',
      'idempotency-key': 'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
    };
    try {
      const list = await app.inject({ method: 'GET', url: '/api/v1/projects' });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json(), { projects: [projectSummary], total: 1, complete: true });
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers,
        payload: {
          key: 'OMNIS-OS',
          name: 'Omnis OS',
          objective: 'Deliver the project foundation.',
        },
      });
      assert.equal(created.statusCode, 201);
      assert.deepEqual(
        calls.map(({ path, method }) => [path, method]),
        [
          ['/internal/v1/projects', 'GET'],
          ['/internal/v1/projects', 'POST'],
        ],
      );
      const detail = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}` });
      assert.equal(detail.statusCode, 200);
      const malformed = await app.inject({ method: 'GET', url: '/api/v1/projects/not-a-project' });
      assert.equal(malformed.statusCode, 422);
    } finally {
      await app.close();
    }
  });

  it('returns definite generic errors for malformed or oversized project JSON before forwarding', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const app = testApp(true, calls);
    const headers = {
      origin: 'http://127.0.0.1:5173',
      'x-omnis-csrf': 'csrf-token-123456',
      'idempotency-key': 'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
      'content-type': 'application/json',
    };
    try {
      const malformed = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers,
        payload: '{',
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().error.code, 'invalid_input');
      const oversized = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers,
        payload: JSON.stringify({ key: 'SAFE', name: 'Safe', objective: 'x'.repeat(40_000) }),
      });
      assert.equal(oversized.statusCode, 413);
      assert.equal(oversized.json().error.code, 'payload_too_large');
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('updates permitted project metadata with session protection, revision, and idempotency', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const anonymous = testApp(false, calls);
    const owner = testApp(true, calls);
    const headers = {
      origin: 'http://127.0.0.1:5173',
      'x-omnis-csrf': 'csrf-token-123456',
      'idempotency-key': 'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
    };
    try {
      const anonymousPatch = await anonymous.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        headers,
        payload: { expectedRevision: 1, name: 'Updated name' },
      });
      assert.equal(anonymousPatch.statusCode, 401);
      const csrfRejected = await owner.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        headers: { ...headers, 'x-omnis-csrf': 'wrong-token' },
        payload: { expectedRevision: 1, name: 'Updated name' },
      });
      assert.equal(csrfRejected.statusCode, 403);
      const emptyPatch = await owner.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        headers,
        payload: { expectedRevision: 1 },
      });
      assert.equal(emptyPatch.statusCode, 422);
      const updated = await owner.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        headers,
        payload: { expectedRevision: 1, name: 'Updated name' },
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().revision, 2);
      assert.deepEqual(calls.at(-1), {
        path: `/internal/v1/projects/${project.id}`,
        method: 'PATCH',
        headers: { 'idempotency-key': headers['idempotency-key'] },
        body: JSON.stringify({ expectedRevision: 1, name: 'Updated name' }),
      });
    } finally {
      await Promise.all([anonymous.close(), owner.close()]);
    }
  });

  it('archives through the constrained route and rejects malformed project IDs', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit; body?: string }> = [];
    const app = testApp(true, calls);
    const headers = {
      origin: 'http://127.0.0.1:5173',
      'x-omnis-csrf': 'csrf-token-123456',
      'idempotency-key': 'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
    };
    try {
      const archived = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/archive`,
        headers,
        payload: { expectedRevision: 1 },
      });
      assert.equal(archived.statusCode, 200);
      assert.equal(archived.json().status, 'archived');
      const invalidId = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/not-a-project/archive',
        headers,
        payload: { expectedRevision: 1 },
      });
      assert.equal(invalidId.statusCode, 422);
      assert.deepEqual(calls, [
        {
          path: `/internal/v1/projects/${project.id}/archive`,
          method: 'POST',
          headers: { 'idempotency-key': headers['idempotency-key'] },
          body: JSON.stringify({ expectedRevision: 1 }),
        },
      ]);
    } finally {
      await app.close();
    }
  });
});

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
  createdAt: at,
  updatedAt: at,
};

function testApp(
  owner: boolean,
  calls: Array<{ path: string; method: string; headers?: HeadersInit }>,
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
      });
      if (path === '/internal/v1/projects') {
        return parse(
          init?.method === 'POST' ? project : { projects: [project], total: 1, complete: true },
        );
      }
      return parse(project);
    },
  );
  return app;
}

describe('owner project routes', () => {
  it('requires owner authentication and session-bound CSRF before creation', async () => {
    const calls: Array<{ path: string; method: string; headers?: HeadersInit }> = [];
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
    const calls: Array<{ path: string; method: string; headers?: HeadersInit }> = [];
    const app = testApp(true, calls);
    const headers = {
      origin: 'http://127.0.0.1:5173',
      'x-omnis-csrf': 'csrf-token-123456',
      'idempotency-key': 'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
    };
    try {
      const list = await app.inject({ method: 'GET', url: '/api/v1/projects' });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json(), { projects: [project], total: 1, complete: true });
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
});

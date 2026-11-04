import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'department-route-test-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'department-route-test-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'department-route-test-authorizer-token-'.padEnd(
  64,
  'y',
);
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { registerDepartmentRoutes } = await import('./department-routes.ts');

const at = '2026-11-04T00:00:00.000Z';
const department = {
  id: 'dep_engineering',
  slug: 'engineering',
  name: 'Engineering',
  archivedAt: null,
  createdAt: at,
  updatedAt: at,
};

function testApp(owner: boolean, calls: Array<{ path: string; method: string; body?: string }>) {
  const app = Fastify();
  app.decorateRequest('omnisSession', undefined);
  app.addHook('onRequest', async (request) => {
    if (owner) {
      request.omnisSession = {
        id: 'session',
        owner: true,
        csrfToken: 'csrf-token-123456',
        expiresAt: Date.now() + 1000,
      };
    }
  });
  registerDepartmentRoutes(
    app,
    async <T>(path: string, init: RequestInit | undefined, parse: (value: unknown) => T) => {
      const body = init?.body?.toString();
      calls.push({ path, method: init?.method ?? 'GET', ...(body === undefined ? {} : { body }) });
      if (path.includes('?')) return parse({ departments: [department], total: 1 });
      return parse(department);
    },
  );
  return app;
}

describe('owner department management routes', () => {
  it('requires an owner and validates requests before authorizer forwarding', async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    const app = testApp(false, calls);
    try {
      const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/departments' });
      assert.equal(unauthorized.statusCode, 401);

      const ownerApp = testApp(true, calls);
      try {
        const invalid = await ownerApp.inject({
          method: 'POST',
          url: '/api/v1/departments',
          payload: { slug: 'Engineering', name: 'Engineering' },
          headers: {
            origin: 'http://127.0.0.1:5173',
            'x-omnis-csrf': 'csrf-token-123456',
          },
        });
        assert.equal(invalid.statusCode, 422);
        const missingCsrf = await ownerApp.inject({
          method: 'POST',
          url: '/api/v1/departments',
          payload: { slug: 'engineering', name: 'Engineering' },
          headers: { origin: 'http://127.0.0.1:5173' },
        });
        assert.equal(missingCsrf.statusCode, 403);
        assert.deepEqual(calls, []);
      } finally {
        await ownerApp.close();
      }
    } finally {
      if (!app.server.listening) await app.close();
    }
  });

  it('forwards only validated management operations through the authorizer client', async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    const app = testApp(true, calls);
    const headers = {
      origin: 'http://127.0.0.1:5173',
      'x-omnis-csrf': 'csrf-token-123456',
    };
    try {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/departments?includeArchived=true',
      });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json(), { departments: [department], total: 1 });
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/departments',
        headers,
        payload: { slug: 'engineering', name: 'Engineering' },
      });
      assert.equal(created.statusCode, 201);
      const renamed = await app.inject({
        method: 'PATCH',
        url: '/api/v1/departments/dep_engineering',
        headers,
        payload: { slug: 'engineering', name: 'Engineering Team' },
      });
      assert.equal(renamed.statusCode, 200);
      const archived = await app.inject({
        method: 'POST',
        url: '/api/v1/departments/dep_engineering/archive',
        headers,
      });
      assert.equal(archived.statusCode, 200);
      assert.deepEqual(
        calls.map(({ path, method }) => [path, method]),
        [
          ['/internal/v1/departments?includeArchived=true', 'GET'],
          ['/internal/v1/departments', 'POST'],
          ['/internal/v1/departments/dep_engineering', 'PATCH'],
          ['/internal/v1/departments/dep_engineering/archive', 'POST'],
        ],
      );
    } finally {
      await app.close();
    }
  });
});

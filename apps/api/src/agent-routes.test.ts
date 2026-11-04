import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'agent-route-test-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'agent-route-test-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'agent-route-test-authorizer-token-'.padEnd(64, 'y');
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';

const { registerAgentReadRoutes } = await import('./agent-routes.ts');
const { WorkerRequestError } = await import('./worker-client.ts');

const at = '2026-11-03T00:00:00.000Z';
const directory = { agents: [], page: { total: 0, complete: true, nextCursor: null } };
const profile = {
  agent: {
    id: 'agt_atlas',
    name: 'Atlas',
    slug: 'atlas',
    department: null,
    lifecycle: 'draft',
    archivedAt: null,
    currentVersion: null,
    provenance: 'owner_created',
    createdAt: at,
    updatedAt: at,
  },
  currentVersion: null,
};
const history = {
  agent: profile.agent,
  versions: [],
  page: { total: 0, complete: true, nextCursor: null },
};

describe('owner-authenticated agent read routes', () => {
  it('requires owner authentication and rejects malformed parameters before contacting the worker', async () => {
    const calls: string[] = [];
    const app = Fastify();
    app.decorateRequest('omnisSession', undefined);
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-test-owner'] === 'yes') {
        request.omnisSession = {
          id: 'session',
          owner: true,
          csrfToken: 'csrf',
          expiresAt: Date.now() + 1000,
        };
      }
    });
    registerAgentReadRoutes(
      app,
      async <T>(path: string, _init: RequestInit | undefined, parse: (value: unknown) => T) => {
        calls.push(path);
        return parse(directory);
      },
    );
    try {
      const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      assert.equal(unauthorized.statusCode, 401);
      const invalid = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/invalid%20id/versions/01',
        headers: { 'x-test-owner': 'yes' },
      });
      assert.equal(invalid.statusCode, 422);
      const invalidQuery = await app.inject({
        method: 'GET',
        url: '/api/v1/agents?unexpected=true',
        headers: { 'x-test-owner': 'yes' },
      });
      assert.equal(invalidQuery.statusCode, 422);
      const invalidDetailQuery = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/agt_atlas?unexpected=true',
        headers: { 'x-test-owner': 'yes' },
      });
      assert.equal(invalidDetailQuery.statusCode, 422);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('returns validated empty directory data and forwards exact historical 404 responses', async () => {
    const calls: string[] = [];
    const app = Fastify();
    app.decorateRequest('omnisSession', undefined);
    app.addHook('onRequest', async (request) => {
      request.omnisSession = {
        id: 'session',
        owner: true,
        csrfToken: 'csrf',
        expiresAt: Date.now() + 1000,
      };
    });
    registerAgentReadRoutes(
      app,
      async <T>(path: string, _init: RequestInit | undefined, parse: (value: unknown) => T) => {
        calls.push(path);
        if (path.endsWith('/versions/99')) {
          throw new WorkerRequestError(404, {
            error: { code: 'not_found', message: 'Agent or profile version was not found.' },
          });
        }
        if (path.endsWith('/versions/98')) {
          throw new WorkerRequestError(422, {
            error: {
              code: 'disallowed_credential_material',
              message: 'Agent profile contains disallowed credential material.',
            },
          });
        }
        if (path.includes('/versions?')) return parse(history);
        return parse(path === '/internal/v1/agents' ? directory : profile);
      },
    );
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof WorkerRequestError) return reply.code(error.statusCode).send(error.body);
      return reply
        .code(500)
        .send({ error: { code: 'internal_error', message: 'Request failed.' } });
    });
    try {
      const result = await app.inject({ method: 'GET', url: '/api/v1/agents' });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json(), directory);
      const detail = await app.inject({ method: 'GET', url: '/api/v1/agents/agt_atlas' });
      assert.equal(detail.statusCode, 200);
      assert.deepEqual(detail.json(), profile);
      const versions = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/agt_atlas/versions?cursor=a%2Bb%2Fc%3D&limit=2',
      });
      assert.equal(versions.statusCode, 200);
      assert.deepEqual(versions.json(), history);
      const missing = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/agt_atlas/versions/99',
      });
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(missing.json(), {
        error: { code: 'not_found', message: 'Agent or profile version was not found.' },
      });
      const rejectedCredential = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/agt_atlas/versions/98',
      });
      assert.equal(rejectedCredential.statusCode, 422);
      assert.deepEqual(rejectedCredential.json(), {
        error: {
          code: 'disallowed_credential_material',
          message: 'Agent profile contains disallowed credential material.',
        },
      });
      assert.doesNotMatch(rejectedCredential.body, /synthetic-secret/);
      assert.deepEqual(calls, [
        '/internal/v1/agents',
        '/internal/v1/agents/agt_atlas',
        '/internal/v1/agents/agt_atlas/versions?cursor=a%2Bb%2Fc%3D&limit=2',
        '/internal/v1/agents/agt_atlas/versions/99',
        '/internal/v1/agents/agt_atlas/versions/98',
      ]);
    } finally {
      await app.close();
    }
  });
});

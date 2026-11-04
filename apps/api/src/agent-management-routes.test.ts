import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'agent-management-test-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'agent-management-test-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'agent-management-test-authorizer-token-'.padEnd(
  64,
  'y',
);
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { registerAgentManagementRoutes } = await import('./agent-management-routes.ts');

const at = '2026-11-04T00:00:00.000Z';
const profile = {
  profession: 'Systems Analyst',
  seniority: null,
  specialties: [],
  personality: { traits: [], tone: null, principles: [] },
  behavior: { autonomy: null, escalation: null },
  instructions: 'Use verified evidence.',
};
const draftState = {
  agentId: 'agt_atlas',
  draftRevision: 0,
  baseVersionNo: null,
  profile: null,
  updatedAt: null,
};
const receipt = {
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  operation: 'agent.created',
  agentId: 'agt_atlas',
  lifecycle: 'draft',
  versionId: null,
  versionNo: null,
  draftRevision: 0,
  occurredAt: at,
};

type Call = { path: string; method: string; body?: string; idempotencyKey?: string };

function testApp(owner: boolean, calls: Call[]) {
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
  registerAgentManagementRoutes(
    app,
    async <T>(path: string, init: RequestInit | undefined, parse: (value: unknown) => T) => {
      const headers = new Headers(init?.headers);
      const body = init?.body?.toString();
      calls.push({
        path,
        method: init?.method ?? 'GET',
        ...(body === undefined ? {} : { body }),
        ...(headers.get('idempotency-key') === null
          ? {}
          : { idempotencyKey: headers.get('idempotency-key')! }),
      });
      return parse((init?.method ?? 'GET') === 'GET' ? draftState : receipt);
    },
  );
  return app;
}

describe('owner agent lifecycle routes', () => {
  it('requires owner and CSRF protection and validates keys and bodies before forwarding', async () => {
    const calls: Call[] = [];
    const anonymous = testApp(false, calls);
    try {
      const result = await anonymous.inject({
        method: 'GET',
        url: '/api/v1/agents/agt_atlas/draft-profile',
      });
      assert.equal(result.statusCode, 401);
      const ownerApp = testApp(true, calls);
      try {
        const missingCsrf = await ownerApp.inject({
          method: 'POST',
          url: '/api/v1/agents',
          payload: { name: 'Atlas', slug: 'atlas', departmentId: null },
          headers: { origin: 'http://127.0.0.1:5173', 'idempotency-key': receipt.requestId },
        });
        assert.equal(missingCsrf.statusCode, 403);
        const missingKey = await ownerApp.inject({
          method: 'POST',
          url: '/api/v1/agents',
          payload: { name: 'Atlas', slug: 'atlas', departmentId: null },
          headers: {
            origin: 'http://127.0.0.1:5173',
            'x-omnis-csrf': 'csrf-token-123456',
          },
        });
        assert.equal(missingKey.statusCode, 422);
        const invalidBody = await ownerApp.inject({
          method: 'POST',
          url: '/api/v1/agents',
          payload: { name: 'Atlas', slug: 'Atlas', departmentId: null },
          headers: {
            origin: 'http://127.0.0.1:5173',
            'x-omnis-csrf': 'csrf-token-123456',
            'idempotency-key': receipt.requestId,
          },
        });
        assert.equal(invalidBody.statusCode, 422);
        const oversized = await ownerApp.inject({
          method: 'PUT',
          url: '/api/v1/agents/agt_atlas/draft-profile',
          headers: {
            origin: 'http://127.0.0.1:5173',
            'x-omnis-csrf': 'csrf-token-123456',
            'idempotency-key': receipt.requestId,
          },
          payload: {
            expectedDraftRevision: 0,
            baseVersionNo: null,
            profile: { ...profile, instructions: 'x'.repeat(70_000) },
          },
        });
        assert.equal(oversized.statusCode, 413);
        assert.deepEqual(calls, []);
      } finally {
        await ownerApp.close();
      }
    } finally {
      await anonymous.close();
    }
  });

  it('uses the canonical draft, publish, create, and archive contracts', async () => {
    const calls: Call[] = [];
    const app = testApp(true, calls);
    const headers = {
      origin: 'http://127.0.0.1:5173',
      'x-omnis-csrf': 'csrf-token-123456',
      'idempotency-key': receipt.requestId,
    };
    try {
      const draft = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/agt_atlas/draft-profile',
      });
      assert.equal(draft.statusCode, 200);
      assert.deepEqual(draft.json(), draftState);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        headers,
        payload: { name: 'Atlas', slug: 'atlas', departmentId: null },
      });
      assert.equal(created.statusCode, 201);
      assert.deepEqual(created.json(), receipt);

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/v1/agents/agt_atlas/draft-profile',
        headers,
        payload: { expectedDraftRevision: 0, baseVersionNo: null, profile },
      });
      assert.equal(saved.statusCode, 200);

      const published = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/agt_atlas/publish',
        headers,
        payload: { expectedVersionNo: null, expectedDraftRevision: 1 },
      });
      assert.equal(published.statusCode, 201);

      const archived = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/agt_atlas/archive',
        headers,
      });
      assert.equal(archived.statusCode, 200);

      assert.deepEqual(
        calls.map(({ path, method }) => [path, method]),
        [
          ['/internal/v1/agents/agt_atlas/draft-profile', 'GET'],
          ['/internal/v1/agents', 'POST'],
          ['/internal/v1/agents/agt_atlas/draft-profile', 'PUT'],
          ['/internal/v1/agents/agt_atlas/publish', 'POST'],
          ['/internal/v1/agents/agt_atlas/archive', 'POST'],
        ],
      );
      assert.equal(calls[1]?.idempotencyKey, receipt.requestId);
      assert.deepEqual(JSON.parse(calls[2]!.body!), {
        expectedDraftRevision: 0,
        baseVersionNo: null,
        profile,
      });
    } finally {
      await app.close();
    }
  });
});

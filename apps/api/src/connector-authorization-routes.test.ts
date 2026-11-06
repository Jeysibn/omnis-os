import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { registerConnectorAuthorizationRoutes } from './connector-authorization-routes.ts';

const ownerId = 'prj_0123456789abcdef0123456789abcdef';
const input = {
  projectId: ownerId,
  projectRevision: 2,
  taskId: 'task-0001',
  taskRevision: 3,
  agentId: 'agent_0001',
  profileVersion: 4,
  connectorId: 'synthetic.codex.fixture',
  connectorVersion: '0.0.0-synthetic.1',
  providerId: 'synthetic',
  modelId: 'synthetic-text-only-v1',
  operation: 'connector.respond',
  capabilities: [],
  limits: {
    maxInputTokens: 4_000,
    maxOutputTokens: 1_000,
    maxDurationSeconds: 120,
    maxConcurrentRuns: 1,
    maxUsageUnits: 10_000,
    maxCostMicrousd: 1_000_000,
  },
  renderedRequest: 'Synthetic rendered request for authorization test.',
};

function createTestApp(calls: Array<{ path: string; init: RequestInit }>) {
  const app = Fastify();
  registerConnectorAuthorizationRoutes(app, {
    requireOwner: async (request, reply) => {
      if (request.headers['x-test-owner'] !== 'yes') {
        await reply.code(401).send({ error: { code: 'unauthorized', message: 'Sign in.' } });
      }
    },
    requireMutationProtection: async (request, reply) => {
      if (request.headers['x-test-csrf'] !== 'yes') {
        await reply.code(403).send({ error: { code: 'csrf_rejected', message: 'Retry.' } });
      }
    },
    async forward<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
      calls.push({ path, init });
      const { renderedRequest, ...binding } = input;
      const response = {
        id: randomUUID(),
        requestId: new Headers(init.headers).get('idempotency-key') ?? randomUUID(),
        correlationId: randomUUID(),
        requestingActor: 'owner',
        ...binding,
        promptDigest: createRenderedRequestDigest(renderedRequest),
        status: 'pending',
        policyVersion: 'r1p1-synthetic-connector-v1',
        createdAt: '2026-11-06T00:00:00.000Z',
        consentedAt: null,
        decidedAt: null,
        decidedBy: null,
        revokedAt: null,
        revokedBy: null,
        revocationGeneration: 0,
        expiresAt: '2026-11-06T00:10:00.000Z',
        consumedAt: null,
        consumedRequestId: null,
        synthetic: true,
      };
      return parse(response);
    },
  });
  return app;
}

const ownerHeaders = { 'x-test-owner': 'yes', 'x-test-csrf': 'yes' };

describe('connector authorization API routes', () => {
  it('forwards only a digest of the exact rendered request to the independent authorizer', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const app = createTestApp(calls);
    const requestId = randomUUID();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/connector-authorizations',
        headers: { ...ownerHeaders, 'idempotency-key': requestId },
        payload: input,
      });
      assert.equal(response.statusCode, 201);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.path, '/internal/v1/connector-authorizations');
      assert.equal(new Headers(calls[0]?.init.headers).get('idempotency-key'), requestId);
      const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
      assert.equal(body.promptDigest, createRenderedRequestDigest(input.renderedRequest));
      assert.equal('renderedRequest' in body, false);
      assert.equal('actor' in body, false);
    } finally {
      await app.close();
    }
  });

  it('requires owner session, CSRF protection, strict synthetic scope, and an idempotency key', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const app = createTestApp(calls);
    try {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/api/v1/connector-authorizations',
        payload: input,
      });
      assert.equal(unauthenticated.statusCode, 401);
      const csrfRejected = await app.inject({
        method: 'POST',
        url: '/api/v1/connector-authorizations',
        headers: { 'x-test-owner': 'yes' },
        payload: input,
      });
      assert.equal(csrfRejected.statusCode, 403);
      const missingIdempotency = await app.inject({
        method: 'POST',
        url: '/api/v1/connector-authorizations',
        headers: ownerHeaders,
        payload: input,
      });
      assert.equal(missingIdempotency.statusCode, 400);
      const liveProvider = await app.inject({
        method: 'POST',
        url: '/api/v1/connector-authorizations',
        headers: { ...ownerHeaders, 'idempotency-key': randomUUID() },
        payload: { ...input, providerId: 'openai' },
      });
      assert.equal(liveProvider.statusCode, 400);
      assert.equal(calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('requires explicit digest confirmation for approval and forwards revocation separately', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const app = createTestApp(calls);
    const authorizationId = randomUUID();
    try {
      const noConfirmation = await app.inject({
        method: 'POST',
        url: `/api/v1/connector-authorizations/${authorizationId}/decision`,
        headers: ownerHeaders,
        payload: { decision: 'approve' },
      });
      assert.equal(noConfirmation.statusCode, 400);
      const confirmation = `sha256:${'a'.repeat(64)}`;
      const decision = await app.inject({
        method: 'POST',
        url: `/api/v1/connector-authorizations/${authorizationId}/decision`,
        headers: ownerHeaders,
        payload: { decision: 'approve', promptDigestConfirmation: confirmation },
      });
      assert.equal(decision.statusCode, 200);
      assert.equal(
        calls[0]?.path,
        `/internal/v1/connector-authorizations/${authorizationId}/decision`,
      );
      assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
        decision: 'approve',
        promptDigestConfirmation: confirmation,
      });

      const revoked = await app.inject({
        method: 'POST',
        url: `/api/v1/connector-authorizations/${authorizationId}/revoke`,
        headers: ownerHeaders,
      });
      assert.equal(revoked.statusCode, 200);
      assert.equal(
        calls[1]?.path,
        `/internal/v1/connector-authorizations/${authorizationId}/revoke`,
      );
    } finally {
      await app.close();
    }
  });
});

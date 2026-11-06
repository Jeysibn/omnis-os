import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { renderSyntheticConnectorRequest } from '@omnis/contracts/synthetic-connector-prompt';
import { registerConnectorAuthorizationRoutes } from './connector-authorization-routes.ts';

const ownerId = 'prj_0123456789abcdef0123456789abcdef';
const task = {
  id: 'task-0001',
  title: 'Synthetic fixture task',
  detail: 'Return a concise synthetic result for this task.',
  status: 'open',
  createdAt: '2026-11-06T00:00:00.000Z',
  projectId: ownerId,
  associationRevision: 3,
};
const project = {
  id: ownerId,
  ownerId: 'owner',
  key: 'SYNTHETIC',
  name: 'Synthetic project',
  objective: 'Exercise the synthetic connector authorization path.',
  status: 'active',
  priority: 'normal',
  revision: 2,
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z',
};
const profile = {
  versionId: 'profile_version_0004',
  agentId: 'agent_0001',
  versionNo: 4,
  profession: 'Synthetic assistant',
  seniority: null,
  specialties: ['testing'],
  personality: { traits: ['careful'], tone: 'plain', principles: ['Do not invent facts.'] },
  behavior: { autonomy: 'No external actions.', escalation: null },
  instructions: 'Respond only with a synthetic result.',
  createdBy: { id: 'owner', displayName: 'Owner' },
  createdAt: '2026-11-06T00:00:00.000Z',
};
const renderedRequest = renderSyntheticConnectorRequest(task, profile);
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
  renderedRequest,
};

function createTestApp(
  calls: Array<{ path: string; init: RequestInit }>,
  context: { task: unknown; project: unknown; profile: unknown } | undefined = {
    task,
    project,
    profile,
  },
) {
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
    loadContext: async () => context,
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

  it('rejects a caller-rendered request that differs from persisted task and profile content', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const app = createTestApp(calls);
    const requestId = randomUUID();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/connector-authorizations',
        headers: { ...ownerHeaders, 'idempotency-key': requestId },
        payload: { ...input, renderedRequest: `${input.renderedRequest} altered` },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('fails closed when immutable authorization context no longer matches the request', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const app = createTestApp(calls, {
      task: { ...task, associationRevision: task.associationRevision + 1 },
      project,
      profile,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/connector-authorizations',
        headers: { ...ownerHeaders, 'idempotency-key': randomUUID() },
        payload: input,
      });
      assert.equal(response.statusCode, 409);
      assert.equal(calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('does not request a connector grant for a completed task or inactive project', async () => {
    for (const context of [
      { task: { ...task, status: 'completed' }, project, profile },
      { task, project: { ...project, status: 'archived' }, profile },
    ]) {
      const calls: Array<{ path: string; init: RequestInit }> = [];
      const app = createTestApp(calls, context);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/connector-authorizations',
          headers: { ...ownerHeaders, 'idempotency-key': randomUUID() },
          payload: input,
        });
        assert.equal(response.statusCode, 409);
        assert.equal(calls.length, 0);
      } finally {
        await app.close();
      }
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

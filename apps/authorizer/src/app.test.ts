import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Authorization } from '@omnis/contracts';
import { createAuthorizerApp, type AuthorizerStore } from './app.ts';

const serviceToken = 'synthetic-authorizer-service-token-'.padEnd(64, 'x');
const authorization: Authorization = {
  id: 'a7ad90d2-57d1-4cf0-9e42-a57e2f5a9f06',
  requestingActor: 'owner',
  runtimeId: 'mock',
  operation: 'execute_task',
  taskId: 'task-0001',
  capabilities: ['mock.execute'],
  scope: { kind: 'task', taskId: 'task-0001' },
  status: 'pending',
  policyVersion: 'r1g4-mock-v1',
  correlationId: '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2',
  expiresAt: '2026-11-03T12:00:00.000Z',
  createdAt: '2026-11-03T11:40:00.000Z',
  decidedAt: null,
  decidedBy: null,
  revokedAt: null,
  revokedBy: null,
  consumedAt: null,
  consumedRunId: null,
};

function makeStore() {
  const calls: Array<{ method: string; actor?: string; correlationId?: string }> = [];
  const store: AuthorizerStore = {
    async request(taskId, actor, correlationId) {
      calls.push({ method: 'request', actor, correlationId });
      return { ...authorization, taskId, scope: { kind: 'task', taskId } };
    },
    async decide(_id, actor, decision) {
      calls.push({ method: decision, actor });
      return { ...authorization, status: decision === 'approve' ? 'authorized' : 'denied' };
    },
    async revoke(_id, actor) {
      calls.push({ method: 'revoke', actor });
      return { ...authorization, status: 'revoked' };
    },
  };
  return { store, calls };
}

describe('independent authorizer service boundary', () => {
  it('rejects runtime and unauthenticated requests before calling the authorization store', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/authorizations',
        headers: { 'idempotency-key': authorization.correlationId },
        payload: { taskId: 'task-0001' },
      });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('derives the approval actor in the authorizer and rejects caller-supplied identity', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    try {
      const forged = await app.inject({
        method: 'POST',
        url: '/internal/v1/authorizations',
        headers: {
          'x-omnis-authorizer-token': serviceToken,
          'idempotency-key': authorization.correlationId,
        },
        payload: { taskId: 'task-0001', requestingActor: 'worker', actorId: 'owner' },
      });
      assert.equal(forged.statusCode, 400);
      assert.deepEqual(calls, []);

      const accepted = await app.inject({
        method: 'POST',
        url: '/internal/v1/authorizations',
        headers: {
          'x-omnis-authorizer-token': serviceToken,
          'idempotency-key': authorization.correlationId,
        },
        payload: { taskId: 'task-0001' },
      });
      assert.equal(accepted.statusCode, 201);
      assert.deepEqual(calls[0], {
        method: 'request',
        actor: 'owner',
        correlationId: authorization.correlationId,
      });
    } finally {
      await app.close();
    }
  });

  it('does not report health when the authorizer database is unavailable', async () => {
    const { store } = makeStore();
    const app = createAuthorizerApp({
      store,
      serviceToken,
      checkDatabase: async () => {
        throw new Error('synthetic database outage');
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/internal/v1/health' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'authorizer_unavailable');
    } finally {
      await app.close();
    }
  });
});

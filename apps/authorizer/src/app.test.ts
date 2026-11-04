import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Authorization, Department } from '@omnis/contracts';
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
const department: Department = {
  id: 'dep_engineering',
  slug: 'engineering',
  name: 'Engineering',
  archivedAt: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};

function makeStore() {
  const calls: Array<{
    method: string;
    actor?: string;
    correlationId?: string;
    requestId?: string;
  }> = [];
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
    async get() {
      return authorization;
    },
    async listDepartments() {
      calls.push({ method: 'listDepartments' });
      return { departments: [department], total: 1 };
    },
    async createDepartment(_input, requestId) {
      calls.push({ method: 'createDepartment', requestId });
      return department;
    },
    async updateDepartment(_id, _input, requestId) {
      calls.push({ method: 'updateDepartment', requestId });
      return department;
    },
    async archiveDepartment(_id, requestId) {
      calls.push({ method: 'archiveDepartment', requestId });
      return { ...department, archivedAt: '2026-11-04T01:00:00.000Z' };
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

  it('reports an unknown decision outcome when a mutation fails outside a confirmed rollback path', async () => {
    const { store } = makeStore();
    const failingStore: AuthorizerStore = {
      ...store,
      async request() {
        throw new Error('synthetic connection loss during commit');
      },
    };
    const app = createAuthorizerApp({
      store: failingStore,
      serviceToken,
      checkDatabase: async () => undefined,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/authorizations',
        headers: {
          'x-omnis-authorizer-token': serviceToken,
          'idempotency-key': authorization.correlationId,
        },
        payload: { taskId: 'task-0001' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'authorization_outcome_unknown');
      assert.match(response.json().error.message, /same idempotency key/i);
    } finally {
      await app.close();
    }
  });
});

describe('authorizer department management boundary', () => {
  it('requires the internal service token and validates department bodies', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    try {
      const unauthenticated = await app.inject({ method: 'GET', url: '/internal/v1/departments' });
      assert.equal(unauthenticated.statusCode, 401);
      const invalid = await app.inject({
        method: 'POST',
        url: '/internal/v1/departments',
        headers: { 'x-omnis-authorizer-token': serviceToken },
        payload: { slug: 'Engineering', name: 'Engineering', ownerId: 'attacker' },
      });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('serves exact directory data and derives owner operations internally', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    const headers = { 'x-omnis-authorizer-token': serviceToken };
    try {
      const listed = await app.inject({ method: 'GET', url: '/internal/v1/departments', headers });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json(), { departments: [department], total: 1 });
      const created = await app.inject({
        method: 'POST',
        url: '/internal/v1/departments',
        headers,
        payload: { slug: 'engineering', name: 'Engineering' },
      });
      assert.equal(created.statusCode, 201);
      const archived = await app.inject({
        method: 'POST',
        url: '/internal/v1/departments/dep_engineering/archive',
        headers,
      });
      assert.equal(archived.statusCode, 200);
      assert.equal(archived.json().archivedAt, '2026-11-04T01:00:00.000Z');
      assert.equal(
        calls.some((call) => call.method === 'createDepartment' && !!call.requestId),
        true,
      );
      assert.equal(
        calls.some((call) => call.method === 'archiveDepartment' && !!call.requestId),
        true,
      );
    } finally {
      await app.close();
    }
  });

  it('returns a generic uncertain-outcome response without error details on mutation failure', async () => {
    const { store } = makeStore();
    const failingStore: AuthorizerStore = {
      ...store,
      async createDepartment() {
        throw new Error('synthetic-secret-value-must-not-leak');
      },
    };
    const app = createAuthorizerApp({
      store: failingStore,
      serviceToken,
      checkDatabase: async () => undefined,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/departments',
        headers: { 'x-omnis-authorizer-token': serviceToken },
        payload: { slug: 'engineering', name: 'Engineering' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'department_outcome_unknown');
      assert.doesNotMatch(response.body, /synthetic-secret-value-must-not-leak/);
    } finally {
      await app.close();
    }
  });
});

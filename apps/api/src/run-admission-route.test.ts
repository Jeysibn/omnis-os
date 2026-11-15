import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import type { Run } from '@omnis/contracts';
import { registerRunAdmissionRoute } from './run-admission-route.ts';

const queuedRun = {
  id: 'run-0001',
  taskId: 'task-0001',
  taskTitle: 'Synthetic task',
  status: 'queued',
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
} as Run;

test('disabled API admission rejects before authorization probing or worker forwarding', async () => {
  const app = Fastify();
  let authorizationChecks = 0;
  let workerCalls = 0;
  registerRunAdmissionRoute(app, {
    requireOwner: async () => {},
    requireMutationProtection: async () => {},
    executionMode: 'disabled',
    authorizationAvailable: async () => {
      authorizationChecks += 1;
      return true;
    },
    workerRequest: async <T>() => {
      workerCalls += 1;
      return queuedRun as T;
    },
    parseRun: (value) => value as Run,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { 'idempotency-key': 'idempotency-key-0001' },
      payload: { taskId: 'task-0001', authorizationId: '11111111-1111-4111-8111-111111111111' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'execution_disabled');
    assert.equal(authorizationChecks, 0);
    assert.equal(workerCalls, 0);
  } finally {
    await app.close();
  }
});

test('mock API admission fails closed when the Authorizer health dependency is unavailable', async () => {
  const app = Fastify();
  let workerCalls = 0;
  registerRunAdmissionRoute(app, {
    requireOwner: async () => {},
    requireMutationProtection: async () => {},
    executionMode: 'mock',
    authorizationAvailable: async () => false,
    workerRequest: async <T>() => {
      workerCalls += 1;
      return queuedRun as T;
    },
    parseRun: (value) => value as Run,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { 'idempotency-key': 'idempotency-key-0001' },
      payload: { taskId: 'task-0001', authorizationId: '11111111-1111-4111-8111-111111111111' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'authorization_unavailable');
    assert.equal(workerCalls, 0);
  } finally {
    await app.close();
  }
});

test('mock API admission remains available when authorization is healthy', async () => {
  const app = Fastify();
  let forwarded = 0;
  registerRunAdmissionRoute(app, {
    requireOwner: async () => {},
    requireMutationProtection: async () => {},
    executionMode: 'mock',
    authorizationAvailable: async () => true,
    workerRequest: async <T>(path: string, init: RequestInit) => {
      forwarded += 1;
      assert.equal(path, '/internal/v1/runs');
      assert.equal(init.method, 'POST');
      return queuedRun as T;
    },
    parseRun: (value) => value as Run,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { 'idempotency-key': 'idempotency-key-0001' },
      payload: { taskId: 'task-0001', authorizationId: '11111111-1111-4111-8111-111111111111' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(forwarded, 1);
  } finally {
    await app.close();
  }
});

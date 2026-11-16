import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import type { PostgresRunStore } from '@omnis/db';
import { registerWorkerInternalAuthentication } from './internal-auth.ts';
import { registerRunExecutionRoutes } from './run-execution-routes.ts';
import { RunCoordinator } from './run-coordinator.ts';

const internalToken = 'worker-internal-test-token-'.padEnd(64, 'x');

describe('authenticated Worker Run routes while execution is disabled', () => {
  it('authenticates before returning disabled responses and performs no execution work', async (t) => {
    let authorizationReads = 0;
    let storeCalls = 0;
    let queueCalls = 0;
    const coordinator = new RunCoordinator(
      new Proxy(
        {},
        {
          get: () => async () => {
            storeCalls++;
            throw new Error('disabled routes must not access the store');
          },
        },
      ) as PostgresRunStore,
      {
        send: async () => {
          queueCalls++;
          throw new Error('disabled routes must not enqueue work');
        },
        findJobs: async () => {
          queueCalls++;
          throw new Error('disabled routes must not inspect the queue');
        },
      },
      undefined,
      {
        get: async () => {
          authorizationReads++;
          throw new Error('disabled routes must not read authorization');
        },
        getForRun: async () => {
          authorizationReads++;
          throw new Error('disabled routes must not read authorization');
        },
        recordEnforcementDenied: async () => {
          authorizationReads++;
          throw new Error('disabled routes must not write authorization');
        },
      },
      undefined,
      { executionEnabled: false },
    );
    const app = Fastify();
    t.after(() => app.close());
    registerWorkerInternalAuthentication(app, internalToken);
    registerRunExecutionRoutes(app, coordinator);

    const runPath = '/internal/v1/runs';
    const validRun = {
      taskId: 'task-0001',
      authorizationId: '11111111-1111-4111-8111-111111111111',
    };
    for (const headers of [{}, { 'x-omnis-internal-token': 'incorrect-token'.padEnd(64, 'x') }]) {
      const admission = await app.inject({
        method: 'POST',
        url: runPath,
        headers: { ...headers, 'idempotency-key': 'idempotency-key-0001' },
        payload: validRun,
      });
      const stop = await app.inject({
        method: 'POST',
        url: `${runPath}/run-0001/stop`,
        headers,
      });
      assert.equal(admission.statusCode, 401);
      assert.equal(stop.statusCode, 401);
    }

    const authenticatedHeaders = {
      'x-omnis-internal-token': internalToken,
      'idempotency-key': 'idempotency-key-0001',
    };
    const admission = await app.inject({
      method: 'POST',
      url: runPath,
      headers: authenticatedHeaders,
      payload: validRun,
    });
    const stop = await app.inject({
      method: 'POST',
      url: `${runPath}/run-0001/stop`,
      headers: { 'x-omnis-internal-token': internalToken },
    });

    assert.equal(admission.statusCode, 503);
    assert.equal(admission.json().error.code, 'execution_disabled');
    assert.equal(stop.statusCode, 503);
    assert.equal(stop.json().error.code, 'execution_disabled');
    assert.deepEqual(
      { authorizationReads, storeCalls, queueCalls },
      {
        authorizationReads: 0,
        storeCalls: 0,
        queueCalls: 0,
      },
    );
  });
});

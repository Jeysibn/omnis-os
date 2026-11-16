import assert from 'node:assert/strict';
import test from 'node:test';
import { startExecutionQueue } from './execution-queue-lifecycle.ts';

test('disabled mode leaves queue and Run state untouched', async () => {
  const calls: string[] = [];
  const started = await startExecutionQueue('disabled', {
    startQueue: async () => {
      calls.push('start');
    },
    createQueue: async () => {
      calls.push('create');
    },
    reconcileEnabled: async () => {
      calls.push('enabled-reconcile');
    },
    consume: async () => {
      calls.push('consume');
    },
  });
  assert.equal(started, false);
  assert.deepEqual(calls, []);
});

test('mock mode starts and reconciles the queue before registering its consumer', async () => {
  const calls: string[] = [];
  const started = await startExecutionQueue('mock', {
    startQueue: async () => {
      calls.push('start');
    },
    createQueue: async () => {
      calls.push('create');
    },
    reconcileEnabled: async () => {
      calls.push('reconcile');
    },
    consume: async () => {
      calls.push('consume');
    },
  });
  assert.equal(started, true);
  assert.deepEqual(calls, ['start', 'create', 'reconcile', 'consume']);
});

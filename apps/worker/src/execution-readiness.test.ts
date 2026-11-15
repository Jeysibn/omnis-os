import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkerExecutionStatus } from './execution-readiness.ts';

test('disabled readiness checks service persistence but never probes the launcher', async () => {
  let launcherChecks = 0;
  const result = await resolveWorkerExecutionStatus({
    executionMode: 'disabled',
    queueAvailability: 'not_required',
    checkDatabase: async () => {},
    checkLauncher: async () => {
      launcherChecks += 1;
      return false;
    },
  });
  assert.deepEqual(result, {
    version: 'omnis.worker-execution-status.v1',
    serviceAvailability: 'healthy',
    executionMode: 'disabled',
    queueAvailability: 'not_required',
    launcherAvailability: 'not_required',
  });
  assert.equal(launcherChecks, 0);
});

test('mock readiness distinguishes database and launcher availability', async () => {
  const result = await resolveWorkerExecutionStatus({
    executionMode: 'mock',
    queueAvailability: 'unavailable',
    checkDatabase: async () => {
      throw new Error('database unavailable');
    },
    checkLauncher: async () => true,
  });
  assert.deepEqual(result, {
    version: 'omnis.worker-execution-status.v1',
    serviceAvailability: 'unavailable',
    executionMode: 'mock',
    queueAvailability: 'unavailable',
    launcherAvailability: 'available',
  });
});

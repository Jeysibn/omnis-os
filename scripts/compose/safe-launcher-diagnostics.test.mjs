import assert from 'node:assert/strict';
import test from 'node:test';
import { safeLauncherFailureCodes } from './safe-launcher-diagnostics.mjs';

test('launcher diagnostics expose only known error codes from the expected event', () => {
  const secret = 'synthetic-secret-canary';
  const logs = [
    JSON.stringify({ msg: 'Mock sandbox execution failed.', sandboxErrorCode: 'unavailable' }),
    JSON.stringify({ msg: 'Mock sandbox execution failed.', sandboxErrorCode: 'launch_failed' }),
    JSON.stringify({ msg: 'Mock sandbox execution failed.', sandboxErrorCode: secret }),
    JSON.stringify({ msg: secret, sandboxErrorCode: 'crashed' }),
    `invalid json ${secret}`,
  ].join('\n');

  const diagnostics = safeLauncherFailureCodes(logs);
  assert.deepEqual(diagnostics, ['launch_failed', 'unavailable']);
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { safeLauncherFailureSignals } from './safe-launcher-diagnostics.mjs';

test('launcher diagnostics expose only known error codes from the expected event', () => {
  const secret = 'synthetic-secret-canary';
  const logs = [
    JSON.stringify({
      reqId: 'req-launch-1',
      req: {
        method: 'POST',
        url: '/internal/v1/mock-executions',
        body: secret,
        remoteAddress: secret,
      },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: 'req-other',
      req: { method: 'GET', url: '/other' },
      msg: 'incoming request',
    }),
    JSON.stringify({ reqId: 'req-launch-1', res: { statusCode: 409 }, msg: 'request completed' }),
    JSON.stringify({ reqId: 'req-other', res: { statusCode: 503 }, msg: 'request completed' }),
    JSON.stringify({ msg: 'Mock sandbox execution failed.', sandboxErrorCode: 'unavailable' }),
    JSON.stringify({ msg: 'Mock sandbox execution failed.', sandboxErrorCode: 'launch_failed' }),
    JSON.stringify({ msg: 'Mock sandbox execution failed.', sandboxErrorCode: secret }),
    JSON.stringify({ msg: secret, sandboxErrorCode: 'crashed' }),
    `invalid json ${secret}`,
  ].join('\n');

  const diagnostics = safeLauncherFailureSignals(logs);
  assert.deepEqual(diagnostics, {
    failureCodes: ['launch_failed', 'unavailable'],
    responseStatusCodes: [409],
  });
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
});

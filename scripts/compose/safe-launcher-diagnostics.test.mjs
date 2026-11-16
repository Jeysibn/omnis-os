import assert from 'node:assert/strict';
import test from 'node:test';
import { safeLauncherFailureSignals } from './safe-launcher-diagnostics.mjs';

test('launcher diagnostics bind safe signals to exact launcher requests and completions', () => {
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
    JSON.stringify({
      reqId: 'req-other',
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'crashed',
    }),
    JSON.stringify({ reqId: 'req-other', res: { statusCode: 503 }, msg: 'request completed' }),
    JSON.stringify({
      reqId: 'req-launch-1',
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'unavailable',
    }),
    JSON.stringify({ reqId: 'req-launch-1', res: { statusCode: 409 }, msg: 'request completed' }),
    JSON.stringify({
      reqId: 'req-launch-1',
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'crashed',
    }),
    JSON.stringify({
      reqId: 'req-launch-1',
      req: { method: 'POST', url: '/internal/v1/mock-executions' },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: 'req-launch-1',
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'launch_failed',
    }),
    JSON.stringify({ reqId: 'req-launch-1', res: { statusCode: 503 }, msg: 'request completed' }),
    JSON.stringify({
      reqId: 'req-launch-1',
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'crashed',
    }),
    JSON.stringify({
      reqId: 'req-launch-2',
      req: { method: 'POST', url: '/internal/v1/mock-executions' },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: 'req-launch-2',
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: secret,
    }),
    JSON.stringify({ reqId: 'req-launch-2', res: { statusCode: 200 }, msg: 'request completed' }),
    JSON.stringify({
      reqId: 'req-collision',
      req: { method: 'POST', url: '/internal/v1/mock-executions' },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: 'req-collision',
      req: { method: 'POST', url: '/internal/v1/mock-executions' },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: 'req-collision',
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'crashed',
    }),
    JSON.stringify({ reqId: 'req-collision', res: { statusCode: 503 }, msg: 'request completed' }),
    JSON.stringify({ msg: 'Mock sandbox execution failed.', sandboxErrorCode: 'unavailable' }),
    JSON.stringify({ reqId: 'req-launch-2', msg: secret, sandboxErrorCode: 'crashed' }),
    `invalid json ${secret}`,
  ].join('\n');

  const diagnostics = safeLauncherFailureSignals(logs);
  assert.deepEqual(diagnostics, {
    failureCodes: [],
    responseStatusCodes: [200],
  });
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
});

test('launcher diagnostics accept numeric request IDs and ignore any reused ID', () => {
  const logs = [
    JSON.stringify({
      reqId: 17,
      req: { method: 'POST', url: '/internal/v1/mock-executions' },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: 17,
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'crashed',
    }),
    JSON.stringify({ reqId: 17, res: { statusCode: 503 }, msg: 'request completed' }),
    JSON.stringify({
      reqId: 17,
      req: { method: 'POST', url: '/internal/v1/mock-executions' },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: 17,
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'launch_failed',
    }),
    JSON.stringify({ reqId: 17, res: { statusCode: 409 }, msg: 'request completed' }),
  ].join('\n');

  assert.deepEqual(safeLauncherFailureSignals(logs), {
    failureCodes: [],
    responseStatusCodes: [],
  });
});

test('launcher diagnostics emit allowlisted signals for distinct numeric and string IDs', () => {
  const logs = [
    JSON.stringify({
      reqId: 18,
      req: { method: 'POST', url: '/internal/v1/mock-executions' },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: 18,
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'crashed',
    }),
    JSON.stringify({ reqId: 18, res: { statusCode: 503 }, msg: 'request completed' }),
    JSON.stringify({
      reqId: '18',
      req: { method: 'POST', url: '/internal/v1/mock-executions' },
      msg: 'incoming request',
    }),
    JSON.stringify({
      reqId: '18',
      msg: 'Mock sandbox execution failed.',
      sandboxErrorCode: 'launch_failed',
    }),
    JSON.stringify({ reqId: '18', res: { statusCode: 409 }, msg: 'request completed' }),
  ].join('\n');

  assert.deepEqual(safeLauncherFailureSignals(logs), {
    failureCodes: ['crashed', 'launch_failed'],
    responseStatusCodes: [409, 503],
  });
});

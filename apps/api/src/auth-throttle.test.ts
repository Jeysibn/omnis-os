import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthThrottle } from './auth-throttle.ts';

describe('authentication throttle', () => {
  it('blocks repeated failures with bounded exponential backoff and does not let a valid password bypass it', () => {
    const throttle = new AuthThrottle(2, 10, 3);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const admission = throttle.begin('127.0.0.1', 1000 + attempt);
      assert.ok('release' in admission);
      admission.release();
      throttle.failed('127.0.0.1', 1000 + attempt);
    }
    assert.deepEqual(throttle.begin('127.0.0.1', 1003), { retryAfterSeconds: 1 });
    assert.deepEqual(throttle.begin('127.0.0.1', 1500), { retryAfterSeconds: 1 });
    const allowed = throttle.begin('127.0.0.1', 2003);
    assert.ok('release' in allowed);
    allowed.release();
  });

  it('limits simultaneous password derivations globally', () => {
    const throttle = new AuthThrottle(1, 10, 5);
    const first = throttle.begin('client-a', 1000);
    assert.ok('release' in first);
    assert.deepEqual(throttle.begin('client-b', 1000), { retryAfterSeconds: 1 });
    first.release();
    const second = throttle.begin('client-b', 1000);
    assert.ok('release' in second);
    second.release();
  });
});

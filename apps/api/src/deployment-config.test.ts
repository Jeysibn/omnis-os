import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateApiNetwork } from './deployment-config.ts';

describe('API network configuration', () => {
  it('keeps loopback as the default and permits only the private Compose service target', () => {
    assert.doesNotThrow(() => validateApiNetwork('127.0.0.1', '127.0.0.1', false));
    assert.doesNotThrow(() => validateApiNetwork('0.0.0.0', 'worker', true));
    assert.throws(() => validateApiNetwork('0.0.0.0', 'worker', false));
    assert.throws(() => validateApiNetwork('0.0.0.0', '192.0.2.10', true));
    assert.throws(() => validateApiNetwork('192.0.2.10', 'worker', true));
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAllowedUse } from './index.ts';

describe('allowed-use policy', () => {
  it('rejects disabled runtimes and scope escalation', () => {
    assert.deepEqual(evaluateAllowedUse('disabled', 'interactive'), {
      allowed: false,
      reason: 'runtime_disabled',
    });
    assert.deepEqual(evaluateAllowedUse('interactive', 'background'), {
      allowed: false,
      reason: 'use_not_authorized',
    });
  });

  it('allows only the configured use', () => {
    assert.deepEqual(evaluateAllowedUse('interactive', 'interactive'), { allowed: true });
    assert.deepEqual(evaluateAllowedUse('both', 'background'), { allowed: true });
  });
});

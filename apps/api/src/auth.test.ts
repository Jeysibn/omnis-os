import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csrfTokenMatches, isSameOrigin } from './auth-primitives.ts';

describe('single-owner auth boundary', () => {
  it('accepts only the configured application origin', () => {
    assert.equal(isSameOrigin('http://127.0.0.1:5173', 'http://127.0.0.1:5173'), true);
    assert.equal(isSameOrigin('https://attacker.invalid', 'http://127.0.0.1:5173'), false);
    assert.equal(isSameOrigin(undefined, 'http://127.0.0.1:5173'), false);
  });

  it('requires the session-bound CSRF token with a constant-time comparison', () => {
    assert.equal(csrfTokenMatches('csrf-token-123456', 'csrf-token-123456'), true);
    assert.equal(csrfTokenMatches('csrf-token-other', 'csrf-token-123456'), false);
    assert.equal(csrfTokenMatches(undefined, 'csrf-token-123456'), false);
  });
});

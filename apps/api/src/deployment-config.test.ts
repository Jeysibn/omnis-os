import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateApiAuthorizerConfiguration, validateApiNetwork } from './deployment-config.ts';

describe('API network configuration', () => {
  it('keeps loopback as the default and permits only the private Compose service target', () => {
    assert.doesNotThrow(() => validateApiNetwork('127.0.0.1', '127.0.0.1', false));
    assert.doesNotThrow(() => validateApiNetwork('0.0.0.0', 'worker', true));
    assert.throws(() => validateApiNetwork('0.0.0.0', 'worker', false));
    assert.throws(() => validateApiNetwork('0.0.0.0', '192.0.2.10', true));
    assert.throws(() => validateApiNetwork('192.0.2.10', 'worker', true));
  });
});

describe('API Authorizer configuration', () => {
  it('allows absent Authorizer settings only for the restricted development profile', () => {
    assert.doesNotThrow(() =>
      validateApiAuthorizerConfiguration({
        restrictedDevelopment: true,
        token: undefined,
        socket: undefined,
      }),
    );
    assert.throws(
      () =>
        validateApiAuthorizerConfiguration({
          restrictedDevelopment: false,
          token: undefined,
          socket: undefined,
        }),
      /OMNIS_API_AUTHORIZER_TOKEN/,
    );
  });

  it('rejects partial Authorizer settings in restricted mode and requires both settings otherwise', () => {
    assert.throws(
      () =>
        validateApiAuthorizerConfiguration({
          restrictedDevelopment: true,
          token: 'a'.repeat(64),
          socket: undefined,
        }),
      /must be omitted/,
    );
    assert.throws(
      () =>
        validateApiAuthorizerConfiguration({
          restrictedDevelopment: false,
          token: 'a'.repeat(64),
          socket: undefined,
        }),
      /socket/i,
    );
    assert.doesNotThrow(() =>
      validateApiAuthorizerConfiguration({
        restrictedDevelopment: false,
        token: 'a'.repeat(64),
        socket: '/run/omnis-authorizer/authorizer.sock',
      }),
    );
  });
});

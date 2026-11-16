import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executionModeFromEnvironment,
  restrictedDevelopmentFromEnvironment,
  validateExecutionConfiguration,
  validateRestrictedDevelopmentConfiguration,
} from './execution-mode.ts';

test('execution mode defaults to disabled and rejects unknown configuration', () => {
  assert.equal(executionModeFromEnvironment(undefined), 'disabled');
  assert.equal(executionModeFromEnvironment(''), 'disabled');
  assert.equal(executionModeFromEnvironment('mock'), 'mock');
  assert.throws(() => executionModeFromEnvironment('production'));
});

test('disabled mode does not require or validate a launcher socket', () => {
  assert.doesNotThrow(() => validateExecutionConfiguration('disabled', undefined));
  assert.doesNotThrow(() => validateExecutionConfiguration('disabled', 'relative.sock'));
});

test('mock mode requires an absolute launcher socket', () => {
  assert.throws(() => validateExecutionConfiguration('mock', undefined), /absolute/);
  assert.throws(() => validateExecutionConfiguration('mock', 'launcher.sock'), /absolute/);
  assert.doesNotThrow(() => validateExecutionConfiguration('mock', '/run/omnis/launcher.sock'));
});

test('restricted development requires an explicit disabled mode and no privileged endpoints', () => {
  assert.equal(restrictedDevelopmentFromEnvironment(undefined), false);
  assert.equal(restrictedDevelopmentFromEnvironment('false'), false);
  assert.equal(restrictedDevelopmentFromEnvironment('true'), true);
  assert.throws(() => restrictedDevelopmentFromEnvironment('yes'), /true or false/);

  assert.doesNotThrow(() =>
    validateRestrictedDevelopmentConfiguration({
      restrictedDevelopment: true,
      configuredMode: 'disabled',
      rawMode: 'disabled',
    }),
  );
  assert.throws(
    () =>
      validateRestrictedDevelopmentConfiguration({
        restrictedDevelopment: true,
        configuredMode: 'disabled',
        rawMode: undefined,
      }),
    /disabled explicitly/,
  );
  assert.throws(
    () =>
      validateRestrictedDevelopmentConfiguration({
        restrictedDevelopment: true,
        configuredMode: 'mock',
        rawMode: 'mock',
      }),
    /disabled explicitly/,
  );
  for (const privilegedEndpoint of [
    { launcherSocket: '/run/omnis/launcher.sock' },
    { authorizerToken: 'token' },
    { authorizerSocket: '/run/omnis/authorizer.sock' },
  ]) {
    assert.throws(
      () =>
        validateRestrictedDevelopmentConfiguration({
          restrictedDevelopment: true,
          configuredMode: 'disabled',
          rawMode: 'disabled',
          ...privilegedEndpoint,
        }),
      /must not configure/,
    );
  }
});

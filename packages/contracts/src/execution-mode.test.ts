import assert from 'node:assert/strict';
import test from 'node:test';
import { executionModeFromEnvironment, validateExecutionConfiguration } from './execution-mode.ts';

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

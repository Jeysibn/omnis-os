import assert from 'node:assert/strict';
import test from 'node:test';
import { canRemoveBrowserBridgeGuard } from './firewall-guard-policy.mjs';

test('browser bridge guard remains while any attached endpoint is running', () => {
  assert.equal(
    canRemoveBrowserBridgeGuard({
      networkExists: true,
      inspectionSucceeded: true,
      endpoints: [{ name: 'web', running: true }],
    }),
    false,
  );
});

test('browser bridge guard can be removed after all attached endpoints stop', () => {
  assert.equal(
    canRemoveBrowserBridgeGuard({
      networkExists: true,
      inspectionSucceeded: true,
      endpoints: [
        { name: 'web', running: false },
        { name: 'browser', running: false },
      ],
    }),
    true,
  );
});

test('browser bridge guard can be removed after its network is gone', () => {
  assert.equal(
    canRemoveBrowserBridgeGuard({
      networkExists: false,
      inspectionSucceeded: true,
      endpoints: [],
    }),
    true,
  );
});

test('browser bridge guard remains when network or endpoint state is uncertain', () => {
  assert.equal(
    canRemoveBrowserBridgeGuard({
      networkExists: true,
      inspectionSucceeded: false,
      endpoints: [],
    }),
    false,
  );
  assert.equal(
    canRemoveBrowserBridgeGuard({ networkExists: true, inspectionSucceeded: true }),
    false,
  );
  assert.equal(
    canRemoveBrowserBridgeGuard({
      networkExists: true,
      inspectionSucceeded: true,
      endpoints: [{ name: 'web', running: undefined }],
    }),
    false,
  );
});

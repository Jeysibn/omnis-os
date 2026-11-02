import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertBackupSafe } from './metrics.mjs';

const safeSnapshot = {
  migrations: ['0001_initial'],
  syntheticOnly: true,
  sequenceInvariants: true,
  applicationQueryWorks: true,
  unsafeRunStates: 0,
  leasedRuns: 0,
};

describe('database backup consistency policy', () => {
  it('accepts only settled, unleased snapshots', () => {
    assert.doesNotThrow(() => assertBackupSafe(safeSnapshot));
  });

  it('rejects snapshots with in-flight runs or dangling leases', () => {
    assert.throws(() => assertBackupSafe({ ...safeSnapshot, unsafeRunStates: 1 }));
    assert.throws(() => assertBackupSafe({ ...safeSnapshot, leasedRuns: 1 }));
  });
});

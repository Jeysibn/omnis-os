import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertBackupSafe, assertValidMetrics } from './metrics.mjs';

const safeSnapshot = {
  migrations: ['0001_initial'],
  syntheticOnly: true,
  sequenceInvariants: true,
  applicationQueryWorks: true,
  idSequences: {
    tasks: {
      lastValue: '1',
      isCalled: false,
      incrementBy: '1',
      maxIssued: '0',
      nextValue: '1',
      malformedIds: 0,
    },
    runs: {
      lastValue: '1',
      isCalled: false,
      incrementBy: '1',
      maxIssued: '0',
      nextValue: '1',
      malformedIds: 0,
    },
  },
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

  it('accepts empty tables with sequences not yet called', () => {
    assert.doesNotThrow(() => assertBackupSafe(safeSnapshot));
  });

  it('rejects a next identifier that collides with a restored task or run ID', () => {
    const staleTask = {
      ...safeSnapshot,
      idSequences: {
        ...safeSnapshot.idSequences,
        tasks: { ...safeSnapshot.idSequences.tasks, maxIssued: '1' },
      },
    };
    assert.throws(() => assertValidMetrics(staleTask), /task ID sequence is stale/i);

    const staleRun = {
      ...safeSnapshot,
      idSequences: {
        ...safeSnapshot.idSequences,
        runs: { ...safeSnapshot.idSequences.runs, maxIssued: '1' },
      },
    };
    assert.throws(() => assertValidMetrics(staleRun), /run ID sequence is stale/i);
  });

  it('uses the next value, accounting for is_called and sequence increments', () => {
    const called = {
      ...safeSnapshot,
      idSequences: {
        ...safeSnapshot.idSequences,
        tasks: {
          lastValue: '3',
          isCalled: true,
          incrementBy: '2',
          maxIssued: '4',
          nextValue: '5',
          malformedIds: 0,
        },
      },
    };
    assert.doesNotThrow(() => assertValidMetrics(called));
  });
});

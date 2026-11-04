import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertBackupSafe, assertValidMetrics, metricsMatch } from './metrics.mjs';

const safeSnapshot = {
  migrations: [
    '0001_initial',
    '0014_agent_profile_lifecycle',
    '0015_project_management',
    '0016_project_lifecycle',
    '0017_task_project_admission',
  ],
  agentManagementCounts: {
    departments: 0,
    agents: 0,
    publishedVersions: 0,
    draftProfiles: 0,
    managementAudits: 0,
    managementIdempotency: 0,
  },
  projectManagementCounts: { projects: 0, managementAudits: 0, managementIdempotency: 0 },
  taskProjectManagementCounts: { audits: 0, idempotency: 0 },
  recordFingerprints: {
    departments: 'd41d8cd98f00b204e9800998ecf8427e',
    agents: 'd41d8cd98f00b204e9800998ecf8427e',
    agentProfileVersions: 'd41d8cd98f00b204e9800998ecf8427e',
    agentProfileDrafts: 'd41d8cd98f00b204e9800998ecf8427e',
    agentManagementAudit: 'd41d8cd98f00b204e9800998ecf8427e',
    agentManagementIdempotency: 'd41d8cd98f00b204e9800998ecf8427e',
    projects: 'd41d8cd98f00b204e9800998ecf8427e',
    projectManagementAudit: 'd41d8cd98f00b204e9800998ecf8427e',
    projectManagementIdempotency: 'd41d8cd98f00b204e9800998ecf8427e',
    taskProjectManagementAudit: 'd41d8cd98f00b204e9800998ecf8427e',
    taskProjectManagementIdempotency: 'd41d8cd98f00b204e9800998ecf8427e',
  },
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

  it('requires lifecycle data fingerprints in recovery snapshots', () => {
    assert.throws(() => assertValidMetrics({ ...safeSnapshot, agentManagementCounts: undefined }));
    assert.throws(() =>
      assertValidMetrics({
        ...safeSnapshot,
        recordFingerprints: { ...safeSnapshot.recordFingerprints, agentProfileDrafts: 'bad' },
      }),
    );
  });

  it('detects changed agent lifecycle records after restore', () => {
    const source = {
      ...safeSnapshot,
      tasks: 0,
      runs: 0,
      events: 0,
      idempotencyRecords: 0,
      leasedRuns: 0,
      runStatuses: {},
      eventTypes: {},
      sequenceInvariants: true,
      syntheticOnly: true,
      applicationQueryWorks: true,
      unsafeRunStates: 0,
    };
    const restored = {
      ...source,
      agentManagementCounts: { ...source.agentManagementCounts, agents: 1 },
    };
    assert.equal(metricsMatch(source, restored), false);
  });
});

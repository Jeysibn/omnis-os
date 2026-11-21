import test from 'node:test';
import assert from 'node:assert/strict';
import { admitB2ResourceAction } from './b2-continuity-admission.mjs';

const grantFixture = () => ({
  contractRevision: 'omnis.ao107.b2-resource-identity.v1',
  authorizationId: 'auth-synthetic-1',
  runId: 'run-synthetic-1',
  attemptId: 'attempt-synthetic-1',
  ownerPrincipalId: 'owner-synthetic-1',
  ownerDecisionId: 'decision-synthetic-1',
  hostPrincipalId: 'host-synthetic-1',
  hostGeneration: 7,
  daemonRegistrationId: 'daemon-reg-synthetic-1',
  daemonRegistrationGeneration: 3,
  processRegistrationId: 'process-reg-synthetic-1',
  processGeneration: 12,
  resourceKind: 'container',
  resourceObjectId: 'object-synthetic-1',
  resourceFingerprint: 'sha256:synthetic-config-1',
  canonicalizationVersion: 'fixture-c14n-v1',
  hashAlgorithm: 'sha256',
  parentBindings: [
    {
      resourceKind: 'network',
      resourceObjectId: 'parent-synthetic-1',
      resourceFingerprint: 'sha256:synthetic-parent-1',
    },
  ],
  resourceLeaseId: 'lease-synthetic-1',
  resourceLeaseGeneration: 4,
  resourceLeaseExpiresAt: '2099-01-01T00:00:00.000Z',
  policyRevision: 'fixture-policy-1',
  authorizationRevocationGeneration: 5,
  actionId: 'action-synthetic-1',
  actionVerb: 'read-metadata',
  expiresAt: '2099-01-01T00:00:00.000Z',
});

function evidenceFor(grant) {
  return {
    binding: {
      hostPrincipalId: grant.hostPrincipalId,
      hostGeneration: grant.hostGeneration,
      daemonRegistrationId: grant.daemonRegistrationId,
      daemonRegistrationGeneration: grant.daemonRegistrationGeneration,
      processRegistrationId: grant.processRegistrationId,
      processGeneration: grant.processGeneration,
      resourceKind: grant.resourceKind,
      resourceObjectId: grant.resourceObjectId,
      resourceFingerprint: grant.resourceFingerprint,
      canonicalizationVersion: grant.canonicalizationVersion,
      hashAlgorithm: grant.hashAlgorithm,
      parentBindings: grant.parentBindings.map((parent) => ({ ...parent })),
      creationProvenance: {
        authorizationId: grant.authorizationId,
        runId: grant.runId,
        attemptId: grant.attemptId,
        resourceKind: grant.resourceKind,
        resourceObjectId: grant.resourceObjectId,
      },
      resourceLeaseId: grant.resourceLeaseId,
      resourceLeaseGeneration: grant.resourceLeaseGeneration,
      authorizationRevocationGeneration: grant.authorizationRevocationGeneration,
      actionId: grant.actionId,
      actionVerb: grant.actionVerb,
    },
    syntheticProof: 'test-fixture-only-not-attestation',
  };
}

function reservationFor(grant) {
  return {
    contractRevision: grant.contractRevision,
    reservationId: 'reservation-synthetic-1',
    authorizationId: grant.authorizationId,
    runId: grant.runId,
    attemptId: grant.attemptId,
    hostPrincipalId: grant.hostPrincipalId,
    hostGeneration: grant.hostGeneration,
    daemonRegistrationId: grant.daemonRegistrationId,
    daemonRegistrationGeneration: grant.daemonRegistrationGeneration,
    processRegistrationId: grant.processRegistrationId,
    processGeneration: grant.processGeneration,
    resourceKind: grant.resourceKind,
    resourceObjectId: grant.resourceObjectId,
    resourceFingerprint: grant.resourceFingerprint,
    resourceLeaseId: grant.resourceLeaseId,
    resourceLeaseGeneration: grant.resourceLeaseGeneration,
    resourceLeaseExpiresAt: grant.resourceLeaseExpiresAt,
    policyRevision: grant.policyRevision,
    actionId: grant.actionId,
    actionVerb: grant.actionVerb,
    authorizationRevocationGeneration: grant.authorizationRevocationGeneration,
    dispatchFenceGeneration: 8,
    syntheticProof: 'test-fixture-only-not-attestation',
  };
}

function authorityFor(grant, overrides = {}) {
  return {
    verifyEvidence: async () => true,
    reserveAction: async () => reservationFor(grant),
    verifyReservation: async () => true,
    ...overrides,
  };
}

test('admits an exact synthetic resource binding after evidence and one-use reservation checks', async () => {
  const grant = grantFixture();
  const evidence = evidenceFor(grant);
  let calls = 0;
  const result = await admitB2ResourceAction({
    grant,
    evidence,
    authority: authorityFor(grant),
    perform: async ({ reservation }) => {
      calls += 1;
      assert.equal(reservation.attemptId, grant.attemptId);
      return 'synthetic-result';
    },
  });
  assert.deepEqual(result, {
    state: 'completed',
    reservationId: 'reservation-synthetic-1',
    result: 'synthetic-result',
  });
  assert.equal(calls, 1);
});

test('denies without trusted authorities and never calls the action', async () => {
  const grant = grantFixture();
  let calls = 0;
  const result = await admitB2ResourceAction({
    grant,
    evidence: evidenceFor(grant),
    authority: null,
    perform: async () => {
      calls += 1;
    },
  });
  assert.deepEqual(result, { state: 'denied', reason: 'trusted_authority_unavailable' });
  assert.equal(calls, 0);
});

test('denies caller substitution, changed parentage, and missing creation lineage before authority calls', async () => {
  for (const mutate of [
    (evidence) => {
      evidence.binding.resourceObjectId = 'substituted-object';
    },
    (evidence) => {
      evidence.binding.parentBindings[0].resourceObjectId = 'substituted-parent';
    },
    (evidence) => {
      evidence.binding.creationProvenance.attemptId = 'other-attempt';
    },
  ]) {
    const grant = grantFixture();
    const evidence = evidenceFor(grant);
    mutate(evidence);
    let authorityCalls = 0;
    let actionCalls = 0;
    const authority = authorityFor(grant, {
      verifyEvidence: async () => {
        authorityCalls += 1;
        return true;
      },
    });
    const result = await admitB2ResourceAction({
      grant,
      evidence,
      authority,
      perform: async () => {
        actionCalls += 1;
      },
    });
    assert.deepEqual(result, { state: 'denied', reason: 'binding_mismatch' });
    assert.equal(authorityCalls, 0);
    assert.equal(actionCalls, 0);
  }
});

test('denies rollback, stale identity, expiry, or revocation evidence rejected by authority', async () => {
  for (const rejectedEvidence of [
    'rollback',
    'stale-host-generation',
    'expired-lease',
    'revoked',
  ]) {
    const grant = grantFixture();
    let actionCalls = 0;
    const result = await admitB2ResourceAction({
      grant,
      evidence: { ...evidenceFor(grant), rejectedEvidence },
      authority: authorityFor(grant, { verifyEvidence: async () => false }),
      perform: async () => {
        actionCalls += 1;
      },
    });
    assert.deepEqual(result, { state: 'denied', reason: 'evidence_unverified' });
    assert.equal(actionCalls, 0);
  }
});

test('denies mismatched, replayed, or unauthenticated reservation receipts', async () => {
  for (const mutate of [
    (receipt) => {
      receipt.resourceObjectId = 'replacement-object';
    },
    (receipt) => {
      receipt.daemonRegistrationGeneration -= 1;
    },
    (receipt) => {
      receipt.authorizationRevocationGeneration -= 1;
    },
    (receipt) => {
      receipt.dispatchFenceGeneration = -1;
    },
  ]) {
    const grant = grantFixture();
    const receipt = reservationFor(grant);
    mutate(receipt);
    let actionCalls = 0;
    const result = await admitB2ResourceAction({
      grant,
      evidence: evidenceFor(grant),
      authority: authorityFor(grant, { reserveAction: async () => receipt }),
      perform: async () => {
        actionCalls += 1;
      },
    });
    assert.deepEqual(result, { state: 'denied', reason: 'reservation_unverified' });
    assert.equal(actionCalls, 0);
  }

  const grant = grantFixture();
  let actionCalls = 0;
  const unauthenticated = await admitB2ResourceAction({
    grant,
    evidence: evidenceFor(grant),
    authority: authorityFor(grant, { verifyReservation: async () => false }),
    perform: async () => {
      actionCalls += 1;
    },
  });
  assert.deepEqual(unauthenticated, { state: 'denied', reason: 'reservation_unverified' });
  assert.equal(actionCalls, 0);
});

test('preserves unknown after an ambiguous action and does not retry', async () => {
  const grant = grantFixture();
  let actionCalls = 0;
  const perform = async () => {
    actionCalls += 1;
    throw new Error('synthetic lost reply after possible dispatch');
  };
  const result = await admitB2ResourceAction({
    grant,
    evidence: evidenceFor(grant),
    authority: authorityFor(grant),
    perform,
  });
  assert.deepEqual(result, { state: 'unknown', attemptId: grant.attemptId });
  assert.equal(actionCalls, 1);
});

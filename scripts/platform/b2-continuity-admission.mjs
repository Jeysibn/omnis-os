const CONTRACT = 'omnis.ao107.b2-resource-identity.v1';

const requiredString = (value) => typeof value === 'string' && value.length > 0;
const safeGeneration = (value) => Number.isSafeInteger(value) && value >= 0;

function validateGrant(grant) {
  if (!grant || grant.contractRevision !== CONTRACT) return false;
  for (const key of [
    'authorizationId',
    'runId',
    'attemptId',
    'ownerPrincipalId',
    'ownerDecisionId',
    'hostPrincipalId',
    'daemonRegistrationId',
    'processRegistrationId',
    'resourceKind',
    'resourceObjectId',
    'resourceFingerprint',
    'canonicalizationVersion',
    'hashAlgorithm',
    'resourceLeaseId',
    'resourceLeaseExpiresAt',
    'policyRevision',
    'actionId',
    'actionVerb',
    'expiresAt',
  ]) {
    if (!requiredString(grant[key])) return false;
  }
  for (const key of [
    'hostGeneration',
    'daemonRegistrationGeneration',
    'processGeneration',
    'resourceLeaseGeneration',
    'authorizationRevocationGeneration',
  ]) {
    if (!safeGeneration(grant[key])) return false;
  }
  return (
    Array.isArray(grant.parentBindings) &&
    grant.parentBindings.every(
      (parent) =>
        parent &&
        requiredString(parent.resourceKind) &&
        requiredString(parent.resourceObjectId) &&
        requiredString(parent.resourceFingerprint),
    )
  );
}

function sameBinding(grant, evidence) {
  const binding = evidence?.binding;
  if (!binding) return false;
  const keys = [
    'hostPrincipalId',
    'hostGeneration',
    'daemonRegistrationId',
    'daemonRegistrationGeneration',
    'processRegistrationId',
    'processGeneration',
    'resourceKind',
    'resourceObjectId',
    'resourceFingerprint',
    'canonicalizationVersion',
    'hashAlgorithm',
    'resourceLeaseId',
    'resourceLeaseGeneration',
    'authorizationRevocationGeneration',
    'actionId',
    'actionVerb',
  ];
  return (
    keys.every((key) => binding[key] === grant[key]) &&
    Array.isArray(binding.parentBindings) &&
    binding.parentBindings.length === grant.parentBindings.length &&
    binding.parentBindings.every((parent, index) => {
      const expected = grant.parentBindings[index];
      return (
        parent?.resourceKind === expected.resourceKind &&
        parent?.resourceObjectId === expected.resourceObjectId &&
        parent?.resourceFingerprint === expected.resourceFingerprint
      );
    }) &&
    binding.creationProvenance?.authorizationId === grant.authorizationId &&
    binding.creationProvenance?.runId === grant.runId &&
    binding.creationProvenance?.attemptId === grant.attemptId &&
    binding.creationProvenance?.resourceKind === grant.resourceKind &&
    binding.creationProvenance?.resourceObjectId === grant.resourceObjectId
  );
}

function sameReservation(grant, receipt) {
  return (
    receipt?.contractRevision === CONTRACT &&
    receipt.authorizationId === grant.authorizationId &&
    receipt.runId === grant.runId &&
    receipt.attemptId === grant.attemptId &&
    receipt.hostPrincipalId === grant.hostPrincipalId &&
    receipt.hostGeneration === grant.hostGeneration &&
    receipt.daemonRegistrationId === grant.daemonRegistrationId &&
    receipt.daemonRegistrationGeneration === grant.daemonRegistrationGeneration &&
    receipt.processRegistrationId === grant.processRegistrationId &&
    receipt.processGeneration === grant.processGeneration &&
    receipt.resourceKind === grant.resourceKind &&
    receipt.resourceObjectId === grant.resourceObjectId &&
    receipt.resourceFingerprint === grant.resourceFingerprint &&
    receipt.resourceLeaseId === grant.resourceLeaseId &&
    receipt.resourceLeaseGeneration === grant.resourceLeaseGeneration &&
    receipt.resourceLeaseExpiresAt === grant.resourceLeaseExpiresAt &&
    receipt.policyRevision === grant.policyRevision &&
    receipt.actionId === grant.actionId &&
    receipt.actionVerb === grant.actionVerb &&
    receipt.authorizationRevocationGeneration === grant.authorizationRevocationGeneration &&
    safeGeneration(receipt.dispatchFenceGeneration) &&
    requiredString(receipt.reservationId)
  );
}

/**
 * Offline policy seam only. This module has no trust store, Docker access, process
 * execution, persistence, or production adapter. Production use requires an
 * independently reviewed platform registrar/action gate implementing the
 * authenticated evidence and linearized one-use reservation callbacks.
 */
export async function admitB2ResourceAction({ grant, evidence, authority, perform }) {
  if (!validateGrant(grant)) return { state: 'denied', reason: 'invalid_grant' };
  if (!sameBinding(grant, evidence)) return { state: 'denied', reason: 'binding_mismatch' };
  if (
    !authority ||
    typeof authority.verifyEvidence !== 'function' ||
    typeof authority.reserveAction !== 'function' ||
    typeof authority.verifyReservation !== 'function' ||
    typeof perform !== 'function'
  ) {
    return { state: 'denied', reason: 'trusted_authority_unavailable' };
  }

  try {
    if ((await authority.verifyEvidence({ grant, evidence })) !== true) {
      return { state: 'denied', reason: 'evidence_unverified' };
    }
    const reservation = await authority.reserveAction({ grant, evidence });
    if (
      !sameReservation(grant, reservation) ||
      (await authority.verifyReservation({ grant, evidence, reservation })) !== true
    ) {
      return { state: 'denied', reason: 'reservation_unverified' };
    }
    const result = await perform({ grant, evidence, reservation });
    return { state: 'completed', reservationId: reservation.reservationId, result };
  } catch {
    // A lost/ambiguous dispatch result cannot authorize replay. The caller must
    // preserve this attempt as unknown and reconcile it using the same receipt.
    return { state: 'unknown', attemptId: grant.attemptId };
  }
}

const CONTRACT = 'omnis.ao107.b2-resource-identity.v1';

const requiredString = (value) => typeof value === 'string' && value.length > 0;
const safeGeneration = (value) => Number.isSafeInteger(value) && value >= 0;
const GRANT_KEYS = [
  'contractRevision',
  'authorizationId',
  'runId',
  'attemptId',
  'ownerPrincipalId',
  'ownerDecisionId',
  'hostPrincipalId',
  'hostGeneration',
  'daemonRegistrationId',
  'daemonRegistrationGeneration',
  'processRegistrationId',
  'processGeneration',
  'resourceKind',
  'resourceObjectId',
  'resourceBindingDigest',
  'resourceFingerprint',
  'canonicalizationVersion',
  'hashAlgorithm',
  'parentBindings',
  'resourceLeaseId',
  'resourceLeaseGeneration',
  'resourceLeaseExpiresAt',
  'policyRevision',
  'authorizationRevocationGeneration',
  'actionId',
  'actionVerb',
  'expiresAt',
];
const BINDING_KEYS = [
  'hostPrincipalId',
  'hostGeneration',
  'daemonRegistrationId',
  'daemonRegistrationGeneration',
  'processRegistrationId',
  'processGeneration',
  'resourceKind',
  'resourceObjectId',
  'resourceBindingDigest',
  'resourceFingerprint',
  'canonicalizationVersion',
  'hashAlgorithm',
  'parentBindings',
  'resourceLeaseId',
  'resourceLeaseGeneration',
  'resourceLeaseExpiresAt',
  'policyRevision',
  'authorizationRevocationGeneration',
  'actionId',
  'actionVerb',
];
const PARENT_KEYS = ['resourceKind', 'resourceObjectId', 'resourceFingerprint'];
const PROVENANCE_KEYS = [
  'authorizationId',
  'runId',
  'attemptId',
  'resourceKind',
  'resourceObjectId',
];
const RESERVATION_KEYS = [
  'contractRevision',
  'reservationId',
  'authorizationId',
  'runId',
  'attemptId',
  ...BINDING_KEYS,
  'creationProvenance',
  'dispatchFenceGeneration',
  'authenticationProof',
];

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function immutableData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('invalid data value');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('only plain data objects are accepted');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('accessor or sparse array is not accepted');
      }
      copy.push(immutableData(descriptor.value, seen));
    }
    seen.delete(value);
    return Object.freeze(copy);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('accessor is not accepted');
    copy[key] = immutableData(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function validParents(parents) {
  return (
    Array.isArray(parents) &&
    parents.every(
      (parent) =>
        exactKeys(parent, PARENT_KEYS) &&
        requiredString(parent.resourceKind) &&
        requiredString(parent.resourceObjectId) &&
        requiredString(parent.resourceFingerprint),
    )
  );
}

function validProvenance(provenance, grant) {
  return (
    exactKeys(provenance, PROVENANCE_KEYS) &&
    provenance.authorizationId === grant.authorizationId &&
    provenance.runId === grant.runId &&
    provenance.attemptId === grant.attemptId &&
    provenance.resourceKind === grant.resourceKind &&
    provenance.resourceObjectId === grant.resourceObjectId
  );
}

function validateGrant(grant) {
  if (!exactKeys(grant, GRANT_KEYS) || grant.contractRevision !== CONTRACT) return false;
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
    'resourceBindingDigest',
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
  return validParents(grant.parentBindings);
}

function sameBinding(grant, evidence) {
  const binding = evidence?.binding;
  if (!exactKeys(binding, [...BINDING_KEYS, 'creationProvenance'])) return false;
  return (
    BINDING_KEYS.every((key) => {
      if (key === 'parentBindings') return true;
      return binding[key] === grant[key];
    }) &&
    validParents(binding.parentBindings) &&
    binding.parentBindings.length === grant.parentBindings.length &&
    binding.parentBindings.every((parent, index) =>
      PARENT_KEYS.every((key) => parent[key] === grant.parentBindings[index][key]),
    ) &&
    validProvenance(binding.creationProvenance, grant)
  );
}

function sameReservation(grant, receipt) {
  return (
    exactKeys(receipt, RESERVATION_KEYS) &&
    receipt.contractRevision === CONTRACT &&
    requiredString(receipt.reservationId) &&
    requiredString(receipt.authenticationProof) &&
    receipt.authorizationId === grant.authorizationId &&
    receipt.runId === grant.runId &&
    receipt.attemptId === grant.attemptId &&
    BINDING_KEYS.every((key) => {
      if (key === 'parentBindings') return true;
      return receipt[key] === grant[key];
    }) &&
    validParents(receipt.parentBindings) &&
    receipt.parentBindings.length === grant.parentBindings.length &&
    receipt.parentBindings.every((parent, index) =>
      PARENT_KEYS.every((key) => parent[key] === grant.parentBindings[index][key]),
    ) &&
    validProvenance(receipt.creationProvenance, grant) &&
    safeGeneration(receipt.dispatchFenceGeneration)
  );
}

/**
 * Offline policy seam only. This module has no trust store, Docker access, process
 * execution, persistence, or production adapter. Production use requires an
 * independently reviewed platform registrar/action gate implementing the
 * authenticated evidence and linearized one-use reservation callbacks. The
 * grant verifier must authenticate owner consent and exact operation scope,
 * and check grant expiry against trusted time. The
 * evidence verifier must authenticate the canonical resource-binding digest
 * over identity, provenance, parents, lease, policy, action, and generations.
 * The reservation callback must atomically revalidate fresh identity, trusted
 * time, lease expiry, revocation generation, and one-use dispatch fencing before
 * issuing a receipt bound to that same digest and exact action. A lost
 * reservation acknowledgement may recover only the same reservation or deny;
 * it must never mint a replacement reservation for the attempt.
 */
export async function admitB2ResourceAction({ grant, evidence, authority, perform }) {
  let grantSnapshot;
  let evidenceSnapshot;
  try {
    grantSnapshot = immutableData(grant);
    evidenceSnapshot = immutableData(evidence);
  } catch {
    return { state: 'denied', reason: 'invalid_data' };
  }
  if (!validateGrant(grantSnapshot)) return { state: 'denied', reason: 'invalid_grant' };
  if (
    !exactKeys(evidenceSnapshot, ['binding', 'authenticationProof']) ||
    !requiredString(evidenceSnapshot.authenticationProof)
  ) {
    return { state: 'denied', reason: 'invalid_evidence' };
  }
  if (!sameBinding(grantSnapshot, evidenceSnapshot)) {
    return { state: 'denied', reason: 'binding_mismatch' };
  }
  if (
    !authority ||
    typeof authority.verifyGrant !== 'function' ||
    typeof authority.verifyEvidence !== 'function' ||
    typeof authority.reserveAction !== 'function' ||
    typeof authority.verifyReservation !== 'function' ||
    typeof perform !== 'function'
  ) {
    return { state: 'denied', reason: 'trusted_authority_unavailable' };
  }

  let grantIsTrusted = false;
  try {
    grantIsTrusted = (await authority.verifyGrant({ grant: grantSnapshot })) === true;
  } catch {
    // A forged, expired, or unverifiable owner grant is denied before evidence lookup.
  }
  if (!grantIsTrusted) return { state: 'denied', reason: 'grant_unverified' };

  let evidenceIsTrusted = false;
  try {
    evidenceIsTrusted =
      (await authority.verifyEvidence({ grant: grantSnapshot, evidence: evidenceSnapshot })) ===
      true;
  } catch {
    // Verification failure occurs before reservation or action dispatch.
  }
  if (!evidenceIsTrusted) return { state: 'denied', reason: 'evidence_unverified' };

  let reservation;
  try {
    reservation = immutableData(
      await authority.reserveAction({ grant: grantSnapshot, evidence: evidenceSnapshot }),
    );
  } catch {
    return { state: 'denied', reason: 'reservation_unavailable' };
  }
  if (!sameReservation(grantSnapshot, reservation)) {
    return { state: 'denied', reason: 'reservation_unverified' };
  }

  let reservationIsTrusted = false;
  try {
    reservationIsTrusted =
      (await authority.verifyReservation({
        grant: grantSnapshot,
        evidence: evidenceSnapshot,
        reservation,
      })) === true;
  } catch {
    // Receipt verification failure occurs before action dispatch.
  }
  if (!reservationIsTrusted) return { state: 'denied', reason: 'reservation_unverified' };

  try {
    await perform({
      grant: grantSnapshot,
      binding: evidenceSnapshot.binding,
      reservation,
    });
    return { state: 'completed', reservationId: reservation.reservationId };
  } catch {
    // Only an exception after action invocation may have produced an effect.
    // Preserve the same attempt as UNKNOWN; never automatically retry it.
    return { state: 'unknown', attemptId: grantSnapshot.attemptId };
  }
}

import { deserialize, serialize } from 'node:v8';

const PATHS = new Set(['api', 'worker', 'broker']);
const requiredString = (value) => typeof value === 'string' && value.length > 0;
const safeGeneration = (value) => Number.isSafeInteger(value) && value >= 0;

function copyData(value) {
  try {
    return deserialize(serialize(value));
  } catch {
    throw new TypeError('persisted state must contain structured-cloneable data');
  }
}

function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.grants) ||
    !Array.isArray(snapshot.queue) ||
    !Array.isArray(snapshot.attempts) ||
    !Array.isArray(snapshot.resources)
  ) {
    throw new TypeError('invalid restored snapshot');
  }
}

function validGrant(grant) {
  return (
    grant &&
    requiredString(grant.authorizationId) &&
    requiredString(grant.runId) &&
    requiredString(grant.attemptId) &&
    requiredString(grant.enrollmentId) &&
    safeGeneration(grant.instanceGeneration) &&
    requiredString(grant.ownerPrincipalId) &&
    requiredString(grant.resourceId) &&
    safeGeneration(grant.revocationGeneration) &&
    grant.status === 'approved'
  );
}

/**
 * Synthetic-only policy model for owner-mediated re-enrollment. This is not a
 * production authorization store or host identity mechanism, and it cannot
 * distinguish a full VM/process-memory rollback without an external freshness
 * authority. The authority is injected so tests can model current registration,
 * fresh owner consent, and atomic reservation.
 */
export function createOfflineOwnerReenrollment({ snapshot, authority }) {
  const state = copyData(snapshot);
  validateSnapshot(state);
  const grants = new Map(state.grants.map((grant) => [grant.authorizationId, grant]));
  const knownRunIds = new Set([
    ...state.grants.map((grant) => grant.runId),
    ...state.queue.map((entry) => entry.runId),
  ]);
  const knownAttemptIds = new Set([
    ...state.grants.map((grant) => grant.attemptId),
    ...state.attempts.map((attempt) => attempt.attemptId),
  ]);
  const queue = [...state.queue];
  const attempts = new Map(state.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const resources = new Map(
    state.resources.map((resource) => [resource.resourceId, { ...resource, state: 'not_adopted' }]),
  );
  const reservations = new Map();
  const revokedAuthorizationIds = new Set();
  let activeEnrollment = null;
  let status = 'QUARANTINED';

  function statusResult() {
    return status;
  }

  async function checkCurrentEnrollment() {
    if (status !== 'ENROLLED' || !activeEnrollment) return 'quarantined';
    if (typeof authority?.currentInstance !== 'function') {
      status = 'QUARANTINED';
      activeEnrollment = null;
      return 'instance_unverified';
    }
    try {
      const current = await authority.currentInstance();
      if (
        !current ||
        current.instanceId !== activeEnrollment.instanceId ||
        current.generation !== activeEnrollment.instanceGeneration
      ) {
        status = 'QUARANTINED';
        activeEnrollment = null;
        return 'instance_stale';
      }
    } catch {
      status = 'QUARANTINED';
      activeEnrollment = null;
      return 'instance_unverified';
    }
    return null;
  }

  async function currentAuthorizationState(authorizationId) {
    if (typeof authority?.currentAuthorizationState !== 'function') return null;
    try {
      const state = await authority.currentAuthorizationState({ authorizationId });
      if (
        !state ||
        !safeGeneration(state.revocationGeneration) ||
        typeof state.isRevoked !== 'boolean'
      ) {
        return null;
      }
      return Object.freeze({
        revocationGeneration: state.revocationGeneration,
        isRevoked: state.isRevoked,
      });
    } catch {
      return null;
    }
  }

  async function verifyReservationDenial(receipt, grant) {
    if (
      !receipt ||
      receipt.state !== 'denied' ||
      !['already_reserved', 'revoked'].includes(receipt.reason) ||
      receipt.authorizationId !== grant.authorizationId ||
      receipt.enrollmentId !== activeEnrollment?.enrollmentId ||
      receipt.instanceGeneration !== activeEnrollment?.instanceGeneration ||
      typeof authority?.verifyReservation !== 'function'
    ) {
      return false;
    }
    const currentState = await currentAuthorizationState(grant.authorizationId);
    if (!currentState || receipt.revocationGeneration !== currentState.revocationGeneration) {
      return false;
    }
    const consistent =
      (receipt.reason === 'already_reserved' &&
        !currentState.isRevoked &&
        currentState.revocationGeneration === grant.revocationGeneration) ||
      (receipt.reason === 'revoked' &&
        (currentState.isRevoked ||
          currentState.revocationGeneration !== grant.revocationGeneration));
    if (!consistent) return false;
    try {
      return (
        (await authority.verifyReservation({ receipt, enrollment: activeEnrollment })) === true
      );
    } catch {
      return false;
    }
  }

  async function enroll({ challenge }) {
    status = 'QUARANTINED';
    activeEnrollment = null;
    if (
      !authority ||
      typeof authority.currentInstance !== 'function' ||
      typeof authority.verifyOwnerEnrollment !== 'function'
    ) {
      return { state: 'denied', reason: 'fresh_authority_unavailable' };
    }

    let instance;
    let receipt;
    try {
      instance = copyData(await authority.currentInstance());
      if (
        !instance ||
        !requiredString(instance.instanceId) ||
        !safeGeneration(instance.generation)
      ) {
        return { state: 'denied', reason: 'instance_unverified' };
      }
      receipt = copyData(await authority.verifyOwnerEnrollment({ challenge, instance }));
    } catch {
      return { state: 'denied', reason: 'enrollment_unverified' };
    }
    if (
      !receipt ||
      !requiredString(receipt.enrollmentId) ||
      !requiredString(receipt.ownerPrincipalId) ||
      receipt.instanceGeneration !== instance.generation
    ) {
      return { state: 'denied', reason: 'enrollment_unverified' };
    }

    activeEnrollment = Object.freeze({
      enrollmentId: receipt.enrollmentId,
      ownerPrincipalId: receipt.ownerPrincipalId,
      instanceId: instance.instanceId,
      instanceGeneration: instance.generation,
    });
    status = 'ENROLLED';
    return { state: 'enrolled', enrollmentId: activeEnrollment.enrollmentId };
  }

  async function authorizeNewWork({
    authorizationId,
    runId,
    attemptId,
    resourceId,
    approval,
    creationReceipt,
  }) {
    if (status !== 'ENROLLED' || !activeEnrollment) {
      throw new Error('owner enrollment required');
    }
    const instanceFailure = await checkCurrentEnrollment();
    if (instanceFailure) throw new Error('current enrollment required');
    if (
      !requiredString(authorizationId) ||
      !requiredString(runId) ||
      !requiredString(attemptId) ||
      !requiredString(resourceId) ||
      grants.has(authorizationId) ||
      knownRunIds.has(runId) ||
      knownAttemptIds.has(attemptId) ||
      resources.has(resourceId) ||
      typeof authority?.verifyOwnerApproval !== 'function' ||
      typeof authority?.verifyResourceCreation !== 'function'
    ) {
      throw new Error('new owner approval and resource receipt required');
    }
    const initialAuthorizationState = await currentAuthorizationState(authorizationId);
    if (!initialAuthorizationState || initialAuthorizationState.isRevoked) {
      throw new Error('fresh authorization state required');
    }

    const approved =
      (await authority.verifyOwnerApproval({ approval, enrollment: activeEnrollment })) === true;
    if (!approved) throw new Error('owner approval is not fresh for this enrollment');
    const resourceCreated =
      (await authority.verifyResourceCreation({
        receipt: creationReceipt,
        enrollment: activeEnrollment,
        resourceId,
      })) === true;
    if (!resourceCreated) throw new Error('resource creation receipt is not current');
    const instanceFailureAfterApproval = await checkCurrentEnrollment();
    if (instanceFailureAfterApproval) throw new Error('current enrollment required');
    const authorizationStateAfterApproval = await currentAuthorizationState(authorizationId);
    if (
      !authorizationStateAfterApproval ||
      authorizationStateAfterApproval.isRevoked ||
      authorizationStateAfterApproval.revocationGeneration !==
        initialAuthorizationState.revocationGeneration
    ) {
      throw new Error('authorization changed during approval');
    }

    const grant = Object.freeze({
      authorizationId,
      runId,
      attemptId,
      enrollmentId: activeEnrollment.enrollmentId,
      instanceGeneration: activeEnrollment.instanceGeneration,
      ownerPrincipalId: activeEnrollment.ownerPrincipalId,
      resourceId,
      revocationGeneration: authorizationStateAfterApproval.revocationGeneration,
      status: 'approved',
    });
    grants.set(authorizationId, grant);
    knownRunIds.add(runId);
    knownAttemptIds.add(attemptId);
    resources.set(resourceId, {
      resourceId,
      enrollmentId: activeEnrollment.enrollmentId,
      instanceGeneration: activeEnrollment.instanceGeneration,
      state: 'current',
      creationReceipt,
    });
    return grant;
  }

  async function admit({ path, authorizationId, dispatch }) {
    if (!PATHS.has(path)) return { state: 'denied', reason: 'invalid_admission_path' };
    if (status !== 'ENROLLED' || !activeEnrollment) {
      return { state: 'denied', reason: 'quarantined' };
    }
    const instanceFailure = await checkCurrentEnrollment();
    if (instanceFailure) return { state: 'denied', reason: instanceFailure };
    const grant = grants.get(authorizationId);
    if (
      !validGrant(grant) ||
      grant.enrollmentId !== activeEnrollment.enrollmentId ||
      grant.instanceGeneration !== activeEnrollment.instanceGeneration ||
      grant.ownerPrincipalId !== activeEnrollment.ownerPrincipalId
    ) {
      return { state: 'denied', reason: 'stale_grant' };
    }
    const attempt = attempts.get(grant.attemptId);
    if (attempt?.status === 'unknown') {
      return { state: 'unknown', attemptId: grant.attemptId };
    }
    const authorizationState = await currentAuthorizationState(authorizationId);
    if (!authorizationState) return { state: 'denied', reason: 'revocation_unverified' };
    if (
      revokedAuthorizationIds.has(authorizationId) ||
      authorizationState.isRevoked ||
      authorizationState.revocationGeneration !== grant.revocationGeneration
    ) {
      return { state: 'denied', reason: 'revoked' };
    }
    const resource = resources.get(grant.resourceId);
    if (
      !resource ||
      resource.state !== 'current' ||
      resource.enrollmentId !== activeEnrollment.enrollmentId ||
      resource.instanceGeneration !== activeEnrollment.instanceGeneration
    ) {
      return { state: 'denied', reason: 'resource_not_adopted' };
    }
    if (typeof dispatch !== 'function') return { state: 'denied', reason: 'dispatch_unavailable' };
    if (reservations.has(authorizationId)) {
      return { state: 'denied', reason: 'already_reserved' };
    }
    // This local marker prevents concurrent/replayed calls. The injected platform
    // authority owns durable reservation and serialization with revocation.
    const reservationState = {
      state: 'reserving',
      path,
      revocationGeneration: grant.revocationGeneration,
    };
    reservations.set(authorizationId, reservationState);
    let receipt;
    try {
      receipt = await authority.reserveAction({
        authorizationId,
        runId: grant.runId,
        attemptId: grant.attemptId,
        enrollment: activeEnrollment,
        revocationGeneration: reservationState.revocationGeneration,
      });
    } catch {
      reservationState.state = 'unknown';
      attempts.set(grant.attemptId, {
        attemptId: grant.attemptId,
        status: 'unknown',
        acknowledgement: 'reservation_lost',
      });
      return { state: 'unknown', attemptId: grant.attemptId };
    }
    if (await verifyReservationDenial(receipt, grant)) {
      reservationState.state = 'denied';
      return { state: 'denied', reason: receipt.reason };
    }
    if (
      !receipt ||
      !requiredString(receipt.reservationId) ||
      receipt.state !== undefined ||
      receipt.authorizationId !== grant.authorizationId ||
      receipt.enrollmentId !== activeEnrollment.enrollmentId ||
      receipt.instanceGeneration !== activeEnrollment.instanceGeneration ||
      receipt.revocationGeneration !== reservationState.revocationGeneration ||
      typeof authority.verifyReservation !== 'function'
    ) {
      reservationState.state = 'unknown';
      attempts.set(grant.attemptId, {
        attemptId: grant.attemptId,
        status: 'unknown',
        acknowledgement: 'reservation_unverified',
      });
      return { state: 'unknown', attemptId: grant.attemptId };
    }
    let trusted = false;
    try {
      trusted =
        (await authority.verifyReservation({ receipt, enrollment: activeEnrollment })) === true;
    } catch {
      // A reservation may already be durable; keep the attempt non-replayable.
    }
    if (!trusted) {
      reservationState.state = 'unknown';
      attempts.set(grant.attemptId, {
        attemptId: grant.attemptId,
        status: 'unknown',
        acknowledgement: 'reservation_unverified',
      });
      return { state: 'unknown', attemptId: grant.attemptId };
    }
    const instanceFailureAfterReservation = await checkCurrentEnrollment();
    if (instanceFailureAfterReservation) {
      reservationState.state = 'unknown';
      attempts.set(grant.attemptId, {
        attemptId: grant.attemptId,
        status: 'unknown',
        acknowledgement: instanceFailureAfterReservation,
      });
      return { state: 'unknown', attemptId: grant.attemptId };
    }
    const currentAuthorizationStateAfterReservation =
      await currentAuthorizationState(authorizationId);
    if (
      !currentAuthorizationStateAfterReservation ||
      currentAuthorizationStateAfterReservation.isRevoked ||
      currentAuthorizationStateAfterReservation.revocationGeneration !== grant.revocationGeneration
    ) {
      reservationState.state = 'unknown';
      attempts.set(grant.attemptId, {
        attemptId: grant.attemptId,
        status: 'unknown',
        acknowledgement: 'revoked_after_reservation',
      });
      return { state: 'unknown', attemptId: grant.attemptId };
    }

    reservationState.state = 'dispatching';
    try {
      await dispatch({ grant, receipt, path });
      reservationState.state = 'completed';
      attempts.set(grant.attemptId, { attemptId: grant.attemptId, status: 'completed' });
      return { state: 'completed', reservationId: receipt.reservationId };
    } catch {
      reservationState.state = 'unknown';
      attempts.set(grant.attemptId, {
        attemptId: grant.attemptId,
        status: 'unknown',
        acknowledgement: 'lost',
      });
      return { state: 'unknown', attemptId: grant.attemptId };
    }
  }

  async function admitApi({ authorizationId, dispatch }) {
    return admit({ path: 'api', authorizationId, dispatch });
  }

  async function admitAtBroker({ authorizationId, dispatch }) {
    return admit({ path: 'broker', authorizationId, dispatch });
  }

  async function processWorkerQueue({ dispatch }) {
    let admitted = 0;
    let denied = 0;
    const entries = queue.splice(0);
    for (const entry of entries) {
      const result = await admit({
        path: 'worker',
        authorizationId: entry.authorizationId,
        dispatch,
      });
      if (result.state === 'completed') admitted += 1;
      else denied += 1;
    }
    return { admitted, denied };
  }

  async function revoke({ authorizationId }) {
    if (
      !grants.has(authorizationId) ||
      typeof authority?.revokeAuthorization !== 'function' ||
      typeof authority?.verifyRevocation !== 'function'
    ) {
      return false;
    }
    const previousState = await currentAuthorizationState(authorizationId);
    if (!previousState || previousState.isRevoked) return false;

    let receipt;
    try {
      receipt = await authority.revokeAuthorization({ authorizationId });
    } catch {
      return false;
    }
    const currentState = await currentAuthorizationState(authorizationId);
    if (
      !receipt ||
      receipt.state !== 'revoked' ||
      receipt.authorizationId !== authorizationId ||
      !safeGeneration(receipt.revocationGeneration) ||
      receipt.revocationGeneration <= previousState.revocationGeneration ||
      !currentState?.isRevoked ||
      currentState.revocationGeneration !== receipt.revocationGeneration
    ) {
      return false;
    }
    let trusted = false;
    try {
      trusted = (await authority.verifyRevocation({ receipt })) === true;
    } catch {
      // An unverifiable receipt does not update the local fast-deny cache.
    }
    if (!trusted) return false;
    revokedAuthorizationIds.add(authorizationId);
    return true;
  }

  function attempt(attemptId) {
    const record = attempts.get(attemptId);
    if (!record) return null;
    return Object.freeze({ status: record.status, acknowledgement: record.acknowledgement });
  }

  function resource(resourceId) {
    const record = resources.get(resourceId);
    if (!record || record.state !== 'current') return Object.freeze({ state: 'not_adopted' });
    return Object.freeze({ state: 'current', enrollmentId: record.enrollmentId });
  }

  async function reconcileAttempt({ attemptId, dispatch }) {
    const record = attempts.get(attemptId);
    if (!record || record.status !== 'unknown') return { state: 'denied', reason: 'not_unknown' };
    // Unknown is observational only; reconciliation never creates replacement work.
    void dispatch;
    return { state: 'unknown', attemptId };
  }

  return Object.freeze({
    status: statusResult,
    enroll,
    authorizeNewWork,
    admitApi,
    admitAtBroker,
    processWorkerQueue,
    revoke,
    attempt,
    resource,
    reconcileAttempt,
  });
}

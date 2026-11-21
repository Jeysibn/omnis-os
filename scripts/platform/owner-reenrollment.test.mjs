import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineOwnerReenrollment } from './owner-reenrollment.mjs';

const oldApproval = {
  authorizationId: 'auth-old',
  runId: 'run-old',
  attemptId: 'attempt-old',
  enrollmentId: 'enrollment-old',
  instanceGeneration: 40,
  ownerPrincipalId: 'owner-1',
  resourceId: 'container-old',
  status: 'approved',
};

function restoredSnapshot() {
  return {
    enrollments: [{ enrollmentId: 'enrollment-old', instanceGeneration: 40 }],
    grants: [oldApproval],
    queue: [{ authorizationId: 'auth-old', runId: 'run-old' }],
    attempts: [
      {
        authorizationId: 'auth-lost',
        runId: 'run-lost',
        attemptId: 'attempt-lost',
        status: 'unknown',
        acknowledgement: 'lost',
      },
    ],
    resources: [
      {
        resourceId: 'container-old',
        enrollmentId: 'enrollment-old',
        instanceGeneration: 40,
        labels: { owner: 'omnis', run: 'run-old' },
        fingerprint: 'sha256:old-copy',
      },
    ],
  };
}

function authorityFor(initialGeneration = 41) {
  let generation = initialGeneration;
  let reservation = 0;
  let enrollment = 0;
  const reservedAuthorizationIds = new Set();
  const usedChallenges = new Set();
  return {
    currentInstance: async () => ({ instanceId: `instance-${generation}`, generation }),
    advanceGeneration: (nextGeneration) => {
      generation = nextGeneration;
    },
    verifyOwnerEnrollment: async ({ challenge, instance }) => {
      if (challenge !== 'fresh-owner-challenge' || usedChallenges.has(challenge)) return null;
      usedChallenges.add(challenge);
      enrollment += 1;
      return {
        enrollmentId: `enrollment-new-${enrollment}`,
        ownerPrincipalId: 'owner-1',
        instanceGeneration: instance.generation,
      };
    },
    verifyOwnerApproval: async ({ approval, enrollment: active }) =>
      approval === 'fresh-approval' && active.ownerPrincipalId === 'owner-1',
    verifyResourceCreation: async ({ receipt, enrollment: active }) =>
      receipt === 'fresh-resource-receipt' && active.enrollmentId.startsWith('enrollment-new-'),
    reserveAction: async ({ authorizationId, enrollment: active, revocationGeneration }) => {
      if (reservedAuthorizationIds.has(authorizationId)) {
        return {
          state: 'denied',
          reason: 'already_reserved',
          authorizationId,
          enrollmentId: active.enrollmentId,
          instanceGeneration: active.instanceGeneration,
          revocationGeneration,
        };
      }
      reservedAuthorizationIds.add(authorizationId);
      reservation += 1;
      return {
        reservationId: `reservation-${reservation}`,
        authorizationId,
        enrollmentId: active.enrollmentId,
        instanceGeneration: active.instanceGeneration,
        revocationGeneration,
      };
    },
    verifyReservation: async () => true,
    reservationCount: () => reservation,
  };
}

function createGate(snapshot = restoredSnapshot(), authority = authorityFor()) {
  return createOfflineOwnerReenrollment({ snapshot, authority });
}

test('a restored copy starts quarantined and rejects the copied grant via API, worker, and broker', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  let dispatches = 0;
  const dispatch = async () => {
    dispatches += 1;
  };

  assert.equal(gate.status(), 'QUARANTINED');
  assert.deepEqual(await gate.admitApi({ authorizationId: 'auth-old', dispatch }), {
    state: 'denied',
    reason: 'quarantined',
  });
  assert.deepEqual(await gate.processWorkerQueue({ dispatch }), {
    admitted: 0,
    denied: 1,
  });
  assert.deepEqual(await gate.admitAtBroker({ authorizationId: 'auth-old', dispatch }), {
    state: 'denied',
    reason: 'quarantined',
  });
  assert.equal(dispatches, 0);
  assert.equal(authority.reservationCount(), 0);
});

test('fresh enrollment allows new work only and never revives copied approval, uncertain attempt, queue item, or resource', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });

  let dispatches = 0;
  const dispatch = async () => {
    dispatches += 1;
  };
  assert.equal(gate.status(), 'ENROLLED');
  assert.deepEqual(await gate.admitApi({ authorizationId: 'auth-old', dispatch }), {
    state: 'denied',
    reason: 'stale_grant',
  });
  assert.deepEqual(await gate.processWorkerQueue({ dispatch }), {
    admitted: 0,
    denied: 1,
  });
  assert.deepEqual(await gate.admitAtBroker({ authorizationId: 'auth-old', dispatch }), {
    state: 'denied',
    reason: 'stale_grant',
  });
  assert.deepEqual(gate.attempt('attempt-lost'), { status: 'unknown', acknowledgement: 'lost' });
  assert.deepEqual(gate.resource('container-old'), { state: 'not_adopted' });
  assert.equal(dispatches, 0);
  assert.equal(authority.reservationCount(), 0);
});

test('a fresh grant for a newly enrolled resource dispatches exactly once', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });
  const grant = await gate.authorizeNewWork({
    authorizationId: 'auth-new',
    runId: 'run-new',
    attemptId: 'attempt-new',
    resourceId: 'container-new',
    approval: 'fresh-approval',
    creationReceipt: 'fresh-resource-receipt',
  });
  let dispatches = 0;
  const dispatch = async () => {
    dispatches += 1;
  };

  const [first, concurrent] = await Promise.all([
    gate.admitApi({ authorizationId: grant.authorizationId, dispatch }),
    gate.admitAtBroker({ authorizationId: grant.authorizationId, dispatch }),
  ]);
  assert.equal([first, concurrent].filter((result) => result.state === 'completed').length, 1);
  const replay = await gate.admitAtBroker({ authorizationId: grant.authorizationId, dispatch });
  assert.deepEqual(replay, { state: 'denied', reason: 'already_reserved' });
  assert.equal(dispatches, 1);
});

test('shared authority permits exactly one reservation across restored runtime instances', async () => {
  const authority = authorityFor();
  authority.verifyOwnerEnrollment = async ({ challenge, instance }) => {
    if (!['owner-session-a', 'owner-session-b'].includes(challenge)) return null;
    return {
      enrollmentId: 'enrollment-shared',
      ownerPrincipalId: 'owner-1',
      instanceGeneration: instance.generation,
    };
  };
  authority.verifyResourceCreation = async ({ receipt, enrollment }) =>
    receipt === 'fresh-resource-receipt' && enrollment.enrollmentId === 'enrollment-shared';
  const gateA = createGate(restoredSnapshot(), authority);
  const gateB = createGate(restoredSnapshot(), authority);
  await Promise.all([
    gateA.enroll({ challenge: 'owner-session-a' }),
    gateB.enroll({ challenge: 'owner-session-b' }),
  ]);
  const work = {
    authorizationId: 'auth-shared',
    runId: 'run-shared',
    attemptId: 'attempt-shared',
    resourceId: 'container-shared',
    approval: 'fresh-approval',
    creationReceipt: 'fresh-resource-receipt',
  };
  const [grantA, grantB] = await Promise.all([
    gateA.authorizeNewWork(work),
    gateB.authorizeNewWork(work),
  ]);
  assert.equal(grantA.authorizationId, grantB.authorizationId);

  let dispatches = 0;
  const dispatch = async () => {
    dispatches += 1;
  };
  const results = await Promise.all([
    gateA.admitApi({ authorizationId: 'auth-shared', dispatch }),
    gateB.admitAtBroker({ authorizationId: 'auth-shared', dispatch }),
  ]);

  assert.equal(results.filter((result) => result.state === 'completed').length, 1);
  assert.deepEqual(
    results.find((result) => result.state === 'denied'),
    {
      state: 'denied',
      reason: 'already_reserved',
    },
  );
  assert.equal(dispatches, 1);
  assert.equal(authority.reservationCount(), 1);
});

test('an uncertain attempt stays unknown and is not resubmitted after fresh enrollment', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });
  let dispatches = 0;
  const result = await gate.reconcileAttempt({
    attemptId: 'attempt-lost',
    dispatch: async () => {
      dispatches += 1;
    },
  });

  assert.deepEqual(result, { state: 'unknown', attemptId: 'attempt-lost' });
  assert.deepEqual(gate.attempt('attempt-lost'), { status: 'unknown', acknowledgement: 'lost' });
  assert.equal(dispatches, 0);
});

test('revocation that wins before reservation produces zero broker dispatches', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });
  const grant = await gate.authorizeNewWork({
    authorizationId: 'auth-revoked-first',
    runId: 'run-revoked-first',
    attemptId: 'attempt-revoked-first',
    resourceId: 'container-revoked-first',
    approval: 'fresh-approval',
    creationReceipt: 'fresh-resource-receipt',
  });
  assert.equal(gate.revoke({ authorizationId: grant.authorizationId }), true);
  let dispatches = 0;

  assert.deepEqual(
    await gate.admitAtBroker({
      authorizationId: grant.authorizationId,
      dispatch: async () => {
        dispatches += 1;
      },
    }),
    { state: 'denied', reason: 'revoked' },
  );
  assert.equal(authority.reservationCount(), 0);
  assert.equal(dispatches, 0);
});

test('reservation that wins first is one-use and a lost acknowledgement remains unknown after revocation', async () => {
  const authority = authorityFor();
  let releaseReservation;
  let signalReservationStarted;
  const reservationStarted = new Promise((resolve) => {
    signalReservationStarted = resolve;
  });
  const originalReserve = authority.reserveAction;
  authority.reserveAction = async (request) => {
    const receipt = await originalReserve(request);
    signalReservationStarted();
    await new Promise((resolve) => {
      releaseReservation = resolve;
    });
    return receipt;
  };
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });
  const grant = await gate.authorizeNewWork({
    authorizationId: 'auth-reserved-first',
    runId: 'run-reserved-first',
    attemptId: 'attempt-reserved-first',
    resourceId: 'container-reserved-first',
    approval: 'fresh-approval',
    creationReceipt: 'fresh-resource-receipt',
  });
  let dispatches = 0;
  const inFlight = gate.admitApi({
    authorizationId: grant.authorizationId,
    dispatch: async () => {
      dispatches += 1;
      throw new Error('synthetic lost acknowledgement');
    },
  });
  await reservationStarted;
  assert.equal(authority.reservationCount(), 1);
  assert.equal(gate.revoke({ authorizationId: grant.authorizationId }), true);
  releaseReservation();

  assert.deepEqual(await inFlight, { state: 'unknown', attemptId: grant.attemptId });
  assert.equal(dispatches, 0);
  assert.deepEqual(gate.attempt(grant.attemptId), {
    status: 'unknown',
    acknowledgement: 'revoked_after_reservation',
  });
  assert.deepEqual(
    await gate.admitAtBroker({
      authorizationId: grant.authorizationId,
      dispatch: async () => {
        dispatches += 1;
      },
    }),
    { state: 'denied', reason: 'revoked' },
  );
  assert.equal(dispatches, 0);
  assert.equal(authority.reservationCount(), 1);
});

test('fresh enrollment cannot mint a new grant by reusing a copied run or attempt identity', async () => {
  const gate = createGate();
  await gate.enroll({ challenge: 'fresh-owner-challenge' });

  await assert.rejects(
    gate.authorizeNewWork({
      authorizationId: 'auth-rebound',
      runId: 'run-old',
      attemptId: 'attempt-rebound',
      resourceId: 'container-new',
      approval: 'fresh-approval',
      creationReceipt: 'fresh-resource-receipt',
    }),
    /new owner approval and resource receipt required/,
  );
  await assert.rejects(
    gate.authorizeNewWork({
      authorizationId: 'auth-rebound',
      runId: 'run-new',
      attemptId: 'attempt-old',
      resourceId: 'container-new',
      approval: 'fresh-approval',
      creationReceipt: 'fresh-resource-receipt',
    }),
    /new owner approval and resource receipt required/,
  );
});

test('identity drift prevents fresh authorization until another owner re-enrollment', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });
  authority.advanceGeneration(42);

  await assert.rejects(
    gate.authorizeNewWork({
      authorizationId: 'auth-stale-enrollment',
      runId: 'run-stale-enrollment',
      attemptId: 'attempt-stale-enrollment',
      resourceId: 'container-stale-enrollment',
      approval: 'fresh-approval',
      creationReceipt: 'fresh-resource-receipt',
    }),
    /current enrollment required/,
  );
  assert.equal(gate.status(), 'QUARANTINED');
  assert.equal(authority.reservationCount(), 0);
});

test('identity drift during owner approval cannot issue a new grant', async () => {
  const authority = authorityFor();
  const verifyOwnerApproval = authority.verifyOwnerApproval;
  authority.verifyOwnerApproval = async (request) => {
    authority.advanceGeneration(42);
    return verifyOwnerApproval(request);
  };
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });

  await assert.rejects(
    gate.authorizeNewWork({
      authorizationId: 'auth-drift-during-approval',
      runId: 'run-drift-during-approval',
      attemptId: 'attempt-drift-during-approval',
      resourceId: 'container-drift-during-approval',
      approval: 'fresh-approval',
      creationReceipt: 'fresh-resource-receipt',
    }),
    /current enrollment required/,
  );
  assert.equal(gate.status(), 'QUARANTINED');
});

test('identity drift after enrollment quarantines admission before reservation', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });
  const grant = await gate.authorizeNewWork({
    authorizationId: 'auth-instance-drift',
    runId: 'run-instance-drift',
    attemptId: 'attempt-instance-drift',
    resourceId: 'container-instance-drift',
    approval: 'fresh-approval',
    creationReceipt: 'fresh-resource-receipt',
  });
  authority.advanceGeneration(42);
  let dispatches = 0;

  assert.deepEqual(
    await gate.admitApi({
      authorizationId: grant.authorizationId,
      dispatch: async () => {
        dispatches += 1;
      },
    }),
    { state: 'denied', reason: 'instance_stale' },
  );
  assert.equal(gate.status(), 'QUARANTINED');
  assert.equal(authority.reservationCount(), 0);
  assert.equal(dispatches, 0);
});

test('a lost dispatch acknowledgement remains unknown and is never retried', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });
  const grant = await gate.authorizeNewWork({
    authorizationId: 'auth-lost-ack',
    runId: 'run-lost-ack',
    attemptId: 'attempt-lost-ack',
    resourceId: 'container-lost-ack',
    approval: 'fresh-approval',
    creationReceipt: 'fresh-resource-receipt',
  });
  let dispatches = 0;
  const dispatch = async () => {
    dispatches += 1;
    throw new Error('synthetic lost dispatch acknowledgement');
  };

  assert.deepEqual(await gate.admitApi({ authorizationId: grant.authorizationId, dispatch }), {
    state: 'unknown',
    attemptId: grant.attemptId,
  });
  assert.deepEqual(await gate.admitAtBroker({ authorizationId: grant.authorizationId, dispatch }), {
    state: 'unknown',
    attemptId: grant.attemptId,
  });
  assert.equal(dispatches, 1);
  assert.equal(authority.reservationCount(), 1);
});

test('an invalid or replayed owner challenge leaves the restored runtime quarantined', async () => {
  const gate = createGate();
  assert.deepEqual(await gate.enroll({ challenge: 'copied-old-challenge' }), {
    state: 'denied',
    reason: 'enrollment_unverified',
  });
  assert.equal(gate.status(), 'QUARANTINED');
  assert.deepEqual(await gate.admitApi({ authorizationId: 'auth-old', dispatch: async () => {} }), {
    state: 'denied',
    reason: 'quarantined',
  });
});

test('a copied owner session/approval cannot authorize work after fresh enrollment', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  await gate.enroll({ challenge: 'fresh-owner-challenge' });

  await assert.rejects(
    gate.authorizeNewWork({
      authorizationId: 'auth-stale-session',
      runId: 'run-stale-session',
      attemptId: 'attempt-stale-session',
      resourceId: 'container-stale-session',
      approval: 'copied-old-session',
      creationReceipt: 'fresh-resource-receipt',
    }),
    /owner approval is not fresh for this enrollment/,
  );
  assert.equal(gate.resource('container-stale-session').state, 'not_adopted');
  assert.equal(authority.reservationCount(), 0);
});

test('a replayed enrollment challenge or stale registrar generation cannot enroll', async () => {
  const authority = authorityFor();
  const gate = createGate(restoredSnapshot(), authority);
  assert.equal((await gate.enroll({ challenge: 'fresh-owner-challenge' })).state, 'enrolled');
  assert.deepEqual(await gate.enroll({ challenge: 'fresh-owner-challenge' }), {
    state: 'denied',
    reason: 'enrollment_unverified',
  });
  assert.equal(gate.status(), 'QUARANTINED');

  const staleAuthority = authorityFor(41);
  staleAuthority.verifyOwnerEnrollment = async () => ({
    enrollmentId: 'enrollment-replayed',
    ownerPrincipalId: 'owner-1',
    instanceGeneration: 40,
  });
  const staleGate = createGate(restoredSnapshot(), staleAuthority);
  assert.deepEqual(await staleGate.enroll({ challenge: 'fresh-owner-challenge' }), {
    state: 'denied',
    reason: 'enrollment_unverified',
  });
  assert.equal(staleGate.status(), 'QUARANTINED');
});

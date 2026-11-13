import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  FakeAuthorizationAuthority,
  FakeDockerEngineRecorder,
  makeSafeEngineCreateRequest,
} from './fixtures.mjs';
import {
  FakeAuthorityLedger,
  FakeIndependentAnchor,
  FakeOutcomeLedger,
  FakeStopAuthority,
  makeOutcomeBody,
  makeOutcomeEnvelope,
} from './advanced-fixtures.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const otherRunId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const payload = Buffer.from('synthetic Stage A payload');
const intent = (overrides = {}) => ({
  peerIdentity: 'uid:61001',
  operationId,
  stepIndex: 0,
  stepType: 'create',
  runId,
  generation: 1,
  payload,
  authorizationRevision: 4,
  taskRevision: 2,
  profileRevision: 3,
  leaseRevision: 7,
  ...overrides,
});
const ticket = () => {
  const authority = new FakeAuthorizationAuthority();
  return authority.reserve(intent()).ticket;
};
const stopFixture = () => {
  const stop = new FakeStopAuthority();
  const registration = {
    runId,
    generation: 1,
    registrationId: 'reg-1',
    revision: 1,
    digest: 'sha256:registration',
    handle: 'opaque-reg-handle',
    bootId: 'boot-1',
    signatureValid: true,
  };
  assert.equal(stop.register(registration).ok, true);
  assert.equal(
    stop.arm({
      ...registration,
      registrationRevision: 1,
      registrationDigest: registration.digest,
      stopId: 'stop-1',
      stopCapability: 'stop-cap-1',
      deadline: 2000,
      expiresAt: 2200,
      signatureValid: true,
    }).ok,
    true,
  );
  return {
    stop,
    registration,
    request: {
      peerIdentity: 'uid:61005',
      operation: 'terminate_registered_scope',
      runId,
      generation: 1,
      registrationId: 'reg-1',
      registrationRevision: 1,
      registrationDigest: 'sha256:registration',
      bootId: 'boot-1',
      handle: 'opaque-reg-handle',
      stopCapability: 'stop-cap-1',
      stopId: 'stop-1',
    },
  };
};

test('C-1 accepts only authenticated, correctly bound Gateway outcome reports', () => {
  const t = ticket();
  const ledger = new FakeOutcomeLedger();
  ledger.register(t);
  const nextTicket = {
    ...t,
    jti: 'fixture-step-2',
    stepIndex: 1,
    stepType: 'start',
    reservationId: 'fixture-reservation-2',
    reservationRevision: 2,
  };
  assert.equal(ledger.register(nextTicket).reason, 'step_order');
  const body = makeOutcomeBody(t);
  assert.equal(ledger.submit(makeOutcomeEnvelope(body), { peerIdentity: 'uid:61003' }).ok, true);
  for (const [badBody, options] of [
    [body, { peerIdentity: 'uid:61004' }],
    [body, { peerIdentity: 'uid:61003', envelope: { signature: 'forged' } }],
    [{ ...body, runId: otherRunId }, { peerIdentity: 'uid:61003' }],
    [{ ...body, generation: 2 }, { peerIdentity: 'uid:61003' }],
    [{ ...body, reservationId: 'wrong-reservation' }, { peerIdentity: 'uid:61003' }],
    [{ ...body, ticketJti: 'wrong-ticket' }, { peerIdentity: 'uid:61003' }],
  ]) {
    const envelope = options.envelope ?? makeOutcomeEnvelope(badBody);
    assert.equal(ledger.submit(envelope, { peerIdentity: options.peerIdentity }).ok, false);
  }

  const stale = new FakeOutcomeLedger();
  stale.register(t);
  assert.equal(
    stale.submit(makeOutcomeEnvelope({ ...body, ledgerRevision: 99 }), {
      peerIdentity: 'uid:61003',
    }).reason,
    'stale_ledger_revision',
  );

  const duplicate = new FakeOutcomeLedger();
  duplicate.register(t);
  const first = makeOutcomeEnvelope(makeOutcomeBody(t));
  const accepted = duplicate.submit(first, { peerIdentity: 'uid:61003' });
  assert.equal(duplicate.submit(first, { peerIdentity: 'uid:61003' }).replayed, true);
  const conflict = makeOutcomeBody(t, { state: 'UNKNOWN' });
  assert.equal(
    duplicate.submit(makeOutcomeEnvelope(conflict), { peerIdentity: 'uid:61003' }).reason,
    'report_id_conflict',
  );
  assert.equal(accepted.ok, true);
});

test('C-1 outcome transitions enforce step order, crashes and unknown no-replay', () => {
  const t = ticket();
  const ledger = new FakeOutcomeLedger();
  ledger.register(t);
  const nextTicket = {
    ...t,
    jti: 'fixture-step-2',
    stepIndex: 1,
    stepType: 'start',
    reservationId: 'fixture-reservation-2',
    reservationRevision: 2,
  };
  assert.equal(ledger.register(nextTicket).reason, 'step_order');
  const submit = (state, revision, reportId) =>
    ledger.submit(
      makeOutcomeEnvelope(makeOutcomeBody(t, { state, ledgerRevision: revision, reportId })),
      { peerIdentity: 'uid:61003' },
    );
  assert.equal(submit('DISPATCHED', 1, 'out-of-order').reason, 'outcome_order');
  assert.equal(submit('CONSUMED', 1, 'consumed').ok, true);
  assert.equal(submit('DISPATCHED', 2, 'dispatched').ok, true);
  assert.equal(ledger.claimDispatch(t.jti).ok, true);
  assert.equal(ledger.claimDispatch(t.jti).reason, 'dispatch_not_permitted');
  assert.equal(submit('ACKNOWLEDGED', 3, 'acknowledged').ok, true);
  assert.equal(ledger.register(nextTicket).ok, true);

  for (const crashState of ['CONSUMED', 'DISPATCHED']) {
    const isolated = new FakeOutcomeLedger();
    isolated.register(t);
    const state = crashState === 'CONSUMED' ? 'CONSUMED' : 'CONSUMED';
    isolated.submit(
      makeOutcomeEnvelope(makeOutcomeBody(t, { state, reportId: `crash-${crashState}` })),
      { peerIdentity: 'uid:61003' },
    );
    if (crashState === 'DISPATCHED')
      isolated.submit(
        makeOutcomeEnvelope(
          makeOutcomeBody(t, {
            state: 'DISPATCHED',
            ledgerRevision: 2,
            reportId: 'crash-dispatched',
          }),
        ),
        { peerIdentity: 'uid:61003' },
      );
    if (crashState === 'DISPATCHED') assert.equal(isolated.claimDispatch(t.jti).ok, true);
    assert.equal(isolated.recoverAfterGatewayCrash(t.jti).state, 'UNKNOWN');
    assert.equal(isolated.claimDispatch(t.jti).reason, 'dispatch_not_permitted');
    assert.equal(isolated.dispatches.size, crashState === 'DISPATCHED' ? 1 : 0);
  }

  const unavailable = new FakeOutcomeLedger({ available: false });
  unavailable.register(t);
  assert.equal(
    unavailable.submit(makeOutcomeEnvelope(makeOutcomeBody(t)), { peerIdentity: 'uid:61003' })
      .reason,
    'authorizer_unavailable',
  );
  assert.equal(unavailable.state(t.jti), 'RESERVED');
});

test('C-2 start requires current registration and armed lease; denials dispatch no start', () => {
  const recorder = new FakeDockerEngineRecorder();
  const authority = new FakeAuthorizationAuthority();
  const start = intent({ stepIndex: 1, stepType: 'start' });
  const denied = (candidate, expected) => {
    const result = authority.reserve(candidate);
    assert.equal(result.reason, expected);
    assert.throws(() => recorder.startContainer({ authorized: false }));
    assert.equal(recorder.calls.filter((call) => call.operation === 'start').length, 0);
  };
  denied(start, 'stop_registration_missing');
  const created = authority.reserve(intent());
  assert.equal(created.ok, true);
  assert.equal(authority.consume(created.ticket, { payload }).ok, true);
  assert.equal(authority.completeStep(created.ticket.jti, 'completed').ok, true);

  const registration = authority.registerRuntime({
    runId,
    generation: 1,
    registrationId: 'reg-c2',
    revision: 2,
    digest: 'sha256:reg-c2',
    handle: 'opaque-reg-c2',
  }).registration;
  const lease = authority.armStopLease({
    runId,
    generation: 1,
    stopLeaseId: 'lease-c2',
    registrationId: registration.registrationId,
    registrationRevision: registration.revision,
    registrationDigest: registration.digest,
    absoluteDeadline: 2000,
    expiresAt: 2200,
    maximumTerminationGraceMs: 100,
    evidenceWindowMs: 100,
  }).lease;
  denied(
    {
      ...start,
      registrationRevision: 1,
      registrationId: registration.registrationId,
      registrationDigest: registration.digest,
      stopLeaseId: lease.stopLeaseId,
    },
    'stale_stop_registration',
  );
  denied(
    {
      ...start,
      runId: otherRunId,
      registrationId: registration.registrationId,
      registrationRevision: registration.revision,
      registrationDigest: registration.digest,
      stopLeaseId: lease.stopLeaseId,
    },
    'stop_registration_missing',
  );
  denied(
    {
      ...start,
      generation: 2,
      registrationId: registration.registrationId,
      registrationRevision: registration.revision,
      registrationDigest: registration.digest,
      stopLeaseId: lease.stopLeaseId,
    },
    'stop_registration_missing',
  );
  denied(
    {
      ...start,
      registrationId: registration.registrationId,
      registrationRevision: registration.revision,
      registrationDigest: registration.digest,
      stopLeaseId: 'substituted',
    },
    'stop_lease_unarmed',
  );

  const valid = authority.reserve({
    ...start,
    registrationId: registration.registrationId,
    registrationRevision: registration.revision,
    registrationDigest: registration.digest,
    stopLeaseId: lease.stopLeaseId,
  });
  assert.equal(valid.ok, true);
  assert.doesNotThrow(() =>
    recorder.startContainer({
      authorized: true,
      registrationId: registration.registrationId,
      stopLeaseId: lease.stopLeaseId,
    }),
  );
  assert.equal(recorder.calls.filter((call) => call.operation === 'start').length, 1);
  const preFenced = new FakeAuthorizationAuthority();
  preFenced.recordStopIntent({ runId, generation: 1, stopOperationId: 'stop-before-registration' });
  assert.equal(
    preFenced.registerRuntime({
      runId,
      generation: 1,
      registrationId: 'late',
      revision: 3,
      digest: 'sha256:late',
      handle: 'late',
    }).reason,
    'generation_fenced',
  );

  const expiredAuthority = new FakeAuthorizationAuthority({ now: 1000 });
  const create = expiredAuthority.reserve(
    intent({ operationId: '44444444-4444-4444-8444-444444444444' }),
  );
  expiredAuthority.consume(create.ticket, { payload });
  expiredAuthority.completeStep(create.ticket.jti, 'completed');
  const expReg = expiredAuthority.registerRuntime({
    runId,
    generation: 1,
    registrationId: 'reg-exp',
    revision: 1,
    digest: 'sha256:exp',
    handle: 'exp',
  }).registration;
  const expLease = expiredAuthority.armStopLease({
    runId,
    generation: 1,
    stopLeaseId: 'lease-exp',
    registrationId: expReg.registrationId,
    registrationRevision: 1,
    registrationDigest: expReg.digest,
    absoluteDeadline: 1500,
    expiresAt: 1800,
    maximumTerminationGraceMs: 100,
    evidenceWindowMs: 100,
  }).lease;
  expiredAuthority.now = expLease.expiresAt;
  assert.equal(
    expiredAuthority.reserve({
      ...start,
      operationId: create.ticket.operationId,
      registrationId: expReg.registrationId,
      registrationRevision: 1,
      registrationDigest: expReg.digest,
      stopLeaseId: expLease.stopLeaseId,
    }).reason,
    'stop_lease_expired',
  );
});

test('C-2 stop deadline is independent of Authorizer/Gateway and missing confirmation stays UNKNOWN', () => {
  const { stop } = stopFixture();
  const expired = stop.deadline({ now: 2000, authorizerAvailable: false, gatewayAvailable: false });
  assert.equal(expired.status, 'ATTEMPTED');
  assert.equal(expired.duringOutage, true);
  assert.equal(stop.confirm('stop-1', null).status, 'UNKNOWN');
  assert.equal(stop.records.get('stop-1').status, 'UNKNOWN');
  const unavailable = stopFixture().stop.deadline({ now: 2000, actuatorAvailable: false });
  assert.equal(unavailable.status, 'UNKNOWN');
});

test('terminator and actuator reject forged, stale, foreign and overbroad stop requests', () => {
  const { stop, request } = stopFixture();
  const denials = [
    { ...request, peerIdentity: 'launcher-uid' },
    { ...request, handle: 'substituted-handle' },
    { ...request, runId: otherRunId },
    { ...request, generation: 2 },
    { ...request, stopCapability: 'stale-capability' },
    { ...request, operation: 'kill_any_pid' },
    { ...request, pid: 1 },
    { ...request, path: '/tmp/anything' },
    { ...request, unit: 'arbitrary.service' },
  ];
  for (const candidate of denials) assert.equal(stop.requestStop(candidate).ok, false);
  assert.equal(stop.requestStop(request).ok, true);
  assert.equal(
    stop.requestStop({ ...request, stopId: 'another-stop' }).reason,
    'stop_capability_reused',
  );
  assert.equal(
    stop.confirm('stop-1', {
      source: 'synthetic-actuator',
      runId,
      generation: 1,
      registrationId: 'reg-1',
      inventoryComplete: true,
      remainingProcesses: 1,
    }).status,
    'UNKNOWN',
  );
  assert.equal(
    stop.confirm(
      'stop-1',
      {
        source: 'synthetic-actuator',
        runId,
        generation: 1,
        registrationId: 'reg-1',
        inventoryComplete: true,
        remainingProcesses: 0,
      },
      { storageAvailable: false },
    ).status,
    'UNKNOWN',
  );
  assert.equal(
    stop.confirm(
      'stop-1',
      {
        source: 'synthetic-actuator',
        runId,
        generation: 1,
        registrationId: 'reg-1',
        inventoryComplete: true,
        remainingProcesses: 0,
      },
      { peerIdentity: 'forged-actuator' },
    ).status,
    'UNKNOWN',
  );
});

test('R-03 Gateway and Engine observations cannot authorize or prove termination', () => {
  const { stop, request } = stopFixture();
  for (const operation of ['cancel', 'stop', 'kill'])
    assert.equal(stop.requestStop({ ...request, peerIdentity: 'uid:61003', operation }).ok, false);
  assert.equal(stop.gatewayObservation('stop-1').evidence, false);
  assert.equal(
    stop.confirm('missing-stop', {
      source: 'docker-engine-ack',
      runId,
      generation: 1,
      registrationId: 'reg-1',
      inventoryComplete: true,
      remainingProcesses: 0,
    }).status,
    'UNKNOWN',
  );
  stop.fenceBeforeRegistration({ runId, generation: 1, stopId: 'pre-registration-stop' });
  assert.equal(
    stop.register({
      runId,
      generation: 1,
      registrationId: 'late',
      digest: 'd',
      handle: 'h',
      signatureValid: true,
    }).reason,
    'generation_fenced',
  );
});

test('C-3 revocation is pre-fenced before DB commit and anchor failures fail closed', () => {
  const anchor = new FakeIndependentAnchor();
  const ledger = new FakeAuthorityLedger({ anchor });
  assert.equal(ledger.reserve({ nonce: 'initial' }).ok, true);
  const changed = ledger.change({ transitionId: 'revoke-1', databaseAvailable: true });
  assert.equal(changed.effective, true);
  assert.equal(changed.protection, 'anchored');
  assert.equal(ledger.reserve({ nonce: 'after-revoke' }).reason, 'authority_state');

  const failingAnchor = new FakeIndependentAnchor({ available: false });
  const failingLedger = new FakeAuthorityLedger({ anchor: failingAnchor });
  assert.equal(failingLedger.change({ transitionId: 'revoke-fail' }).reason, 'anchor_unavailable');
  assert.equal(failingLedger.reserve({ nonce: 'fail-closed' }).reason, 'anchor_unavailable');

  const pendingAnchor = new FakeIndependentAnchor();
  const pendingLedger = new FakeAuthorityLedger({ anchor: pendingAnchor });
  const pending = pendingLedger.change({
    transitionId: 'revoke-pending',
    databaseAvailable: false,
  });
  assert.equal(pending.preFenced, true);
  assert.equal(pendingLedger.reserve({ nonce: 'blocked-pending' }).reason, 'anchor_fenced');
  assert.equal(pendingLedger.retry('revoke-pending').protection, 'anchored');

  const finalizeAnchor = new FakeIndependentAnchor();
  const finalizeLedger = new FakeAuthorityLedger({ anchor: finalizeAnchor });
  const dbCommitted = finalizeLedger.change({
    transitionId: 'revoke-db-first',
    finalizeAvailable: false,
  });
  assert.equal(dbCommitted.databaseCommitted, true);
  assert.equal(dbCommitted.protection, 'pending');
  assert.equal(finalizeLedger.reserve({ nonce: 'blocked-unanchored' }).reason, 'authority_state');
  finalizeAnchor.available = true;
  assert.equal(finalizeLedger.retry('revoke-db-first').protection, 'anchored');

  const { stop } = stopFixture();
  const independentLedger = new FakeAuthorityLedger();
  const revoked = independentLedger.change({ transitionId: 'revoke-with-stop-armed' });
  assert.equal(revoked.effective, true);
  assert.equal(
    stop.deadline({ now: 2000, authorizerAvailable: false, gatewayAvailable: false }).status,
    'ATTEMPTED',
  );
});

test('C-3 rollback, stale revisions, duplicate receipts and unavailable anchor are rejected', () => {
  const anchor = new FakeIndependentAnchor();
  const ledger = new FakeAuthorityLedger({ anchor });
  const before = ledger.snapshot();
  assert.equal(
    ledger.change({
      transitionId: 'lease-advance',
      kind: 'lease_supersession',
      subjectId: 'lease-1',
    }).protection,
    'anchored',
  );
  assert.equal(ledger.restore(before, { freshEpoch: true }).reason, 'rollback_detected');
  assert.equal(
    ledger.change({ transitionId: 'stale-auth', expectedRevision: 0 }).reason,
    'stale_revision',
  );
  assert.equal(
    ledger.change({
      transitionId: 'stale-lease',
      kind: 'lease_supersession',
      subjectId: 'lease-1',
      expectedRevision: 1,
    }).reason,
    'stale_revision',
  );

  const intent = {
    transitionId: 'duplicate',
    kind: 'authorization_revocation',
    subjectId: 'auth-1',
    expectedRevision: 1,
    newRevision: 2,
    epoch: anchor.epoch,
  };
  const first = anchor.preFence(intent);
  assert.equal(anchor.preFence(intent).replayed, true);
  assert.equal(anchor.preFence({ ...intent, newRevision: 3 }).reason, 'anchor_conflict');
  const finalized = anchor.finalize({
    transitionId: intent.transitionId,
    receipt: first.receipt,
    databaseReceipt: { transitionId: intent.transitionId, newRevision: 2 },
  });
  assert.equal(finalized.ok, true);
  assert.equal(
    anchor.finalize({
      transitionId: intent.transitionId,
      receipt: first.receipt,
      databaseReceipt: { transitionId: intent.transitionId, newRevision: 2 },
    }).replayed,
    true,
  );
  assert.equal(
    anchor.admission({
      kind: intent.kind,
      subjectId: intent.subjectId,
      revision: 1,
      epoch: anchor.epoch,
      nonce: 'fenced-admission',
    }).reason,
    'anchor_fenced',
  );
  assert.equal(first.ok, true);

  const unavailable = new FakeAuthorityLedger({
    anchor: new FakeIndependentAnchor({ available: false }),
  });
  assert.equal(unavailable.reserve({ nonce: 'no-anchor' }).reason, 'anchor_unavailable');
});

test('C-3 local restoration cannot claim rollback detection without fresh independent evidence', () => {
  const anchor = new FakeIndependentAnchor();
  const ledger = new FakeAuthorityLedger({ anchor });
  const snapshot = ledger.snapshot();
  assert.equal(ledger.restore(snapshot).reason, 'fresh_epoch_required');
  assert.equal(
    ledger.restore({ ...snapshot, epoch: 'changed' }, { freshEpoch: true }).reason,
    'fresh_epoch_required',
  );
  assert.equal(ledger.restore(snapshot, { freshEpoch: true }).ok, true);
});

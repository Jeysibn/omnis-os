import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  cloneFixture,
  buildProtocolRequest,
  deriveContainerName,
  evaluateOfflineRequest,
  FakeAuthorizationAuthority,
  FakeDockerEngineRecorder,
  makeSafeEngineCreateRequest,
  makeSyntheticPolicyContext,
  makeFrame,
  makeProtocolResponse,
  MockMonotonicAnchor,
  MockTerminationAuthority,
  OfflineOutcomeLedger,
  parseEngineLogs,
  parseEngineResponse,
  requestHash,
} from './fixtures.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const payload = Buffer.from('synthetic prompt fixture');

test('current runtime protocol accepts the valid synthetic request and rejects malformed boundaries', () => {
  const valid = buildProtocolRequest();
  assert.deepEqual(evaluateOfflineRequest(makeFrame(JSON.stringify(valid))), {
    decision: 'allow',
    reason: 'permitted',
    effectState: 'not_attempted',
  });

  for (const raw of [
    '{"protocol_version":1,"protocol_version":1}',
    '{malformed',
    JSON.stringify({ ...valid, operation: 'unknown_method' }),
    JSON.stringify({ ...valid, operation: 'create' }),
  ]) {
    assert.equal(evaluateOfflineRequest(makeFrame(raw)).decision, 'deny');
  }
  assert.deepEqual(evaluateOfflineRequest(makeFrame('{"protocol_version":1,"operation":"exec"}')), {
    decision: 'deny',
    reason: 'MALFORMED_REQUEST',
    effectState: 'not_attempted',
  });

  const tooLarge = Buffer.alloc(65541);
  tooLarge.writeUInt32BE(65537);
  assert.equal(evaluateOfflineRequest(tooLarge).decision, 'deny');
  assert.equal(evaluateOfflineRequest(Buffer.from([0, 0, 0])).decision, 'deny');
});

test('current protocol binds peer, run, generation and expiry and remains test-verifier only', () => {
  const request = buildProtocolRequest();
  const context = makeSyntheticPolicyContext();
  assert.equal(
    evaluateOfflineRequest(makeFrame(JSON.stringify(request)), context).decision,
    'allow',
  );

  for (const changedContext of [
    { ...context, peerSubject: 'launcher-uid' },
    { ...context, now: request.capability.claims.expires_at },
    { ...context, expectedIssuer: 'wrong-issuer' },
  ]) {
    assert.equal(
      evaluateOfflineRequest(makeFrame(JSON.stringify(request)), changedContext).decision,
      'deny',
    );
  }

  const substituted = cloneFixture(request);
  substituted.arguments.generation = 2;
  substituted.request_hash = requestHash(substituted);
  substituted.capability.claims.request_hash = substituted.request_hash;
  assert.equal(
    evaluateOfflineRequest(makeFrame(JSON.stringify(substituted)), context).decision,
    'deny',
  );
  const otherRun = cloneFixture(request);
  otherRun.arguments.run_id = '33333333-3333-4333-8333-333333333333';
  otherRun.request_hash = requestHash(otherRun);
  otherRun.capability.claims.request_hash = otherRun.request_hash;
  assert.equal(
    evaluateOfflineRequest(makeFrame(JSON.stringify(otherRun)), context).decision,
    'deny',
  );
});

test('fake issuer binds exact payload, revisions, identity and one ordered ticket per step', () => {
  const authority = new FakeAuthorizationAuthority();
  const first = authority.reserve({
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
  });
  assert.equal(first.ok, true);
  assert.equal(first.ticket.payloadLength, payload.length);
  assert.equal(first.ticket.payloadDigest, authority.digestPayload(payload, first.ticket));
  assert.deepEqual(
    {
      operationId: first.ticket.operationId,
      stepIndex: first.ticket.stepIndex,
      stepType: first.ticket.stepType,
      reservationId: first.ticket.reservationId,
      reservationRevision: first.ticket.reservationRevision,
      authorizationId: first.ticket.authorizationId,
      authorizationRevision: first.ticket.authorizationRevision,
      taskId: first.ticket.taskId,
      taskRevision: first.ticket.taskRevision,
      profileId: first.ticket.profileId,
      profileRevision: first.ticket.profileRevision,
      leaseOwner: first.ticket.leaseOwner,
      leaseId: first.ticket.leaseId,
      leaseRevision: first.ticket.leaseRevision,
      runId: first.ticket.runId,
      generation: first.ticket.generation,
      inputProfileVersion: first.ticket.inputProfileVersion,
      issuer: first.ticket.issuer,
      audience: first.ticket.audience,
      peerIdentity: first.ticket.peerIdentity,
      jti: first.ticket.jti,
      expiry: first.ticket.expiresAt,
      restrictions: first.ticket.policyRestrictions,
    },
    {
      operationId,
      stepIndex: 0,
      stepType: 'create',
      reservationId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      reservationRevision: 1,
      authorizationId: 'auth-fixture-1',
      authorizationRevision: 4,
      taskId: 'task-fixture-1',
      taskRevision: 2,
      profileId: 'profile-fixture-1',
      profileRevision: 3,
      leaseOwner: 'worker-1',
      leaseId: 'lease-fixture-1',
      leaseRevision: 7,
      runId,
      generation: 1,
      inputProfileVersion: 'synthetic-input-v1',
      issuer: 'stage-a-authorizer',
      audience: 'stage-a-gateway',
      peerIdentity: 'uid:61002',
      jti: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      expiry: 31_000,
      restrictions: {
        policyDigest: `sha256:${'b'.repeat(64)}`,
        imageDigest: `sha256:${'c'.repeat(64)}`,
        network: 'none',
        tools: 'none',
        outputLimit: 8192,
      },
    },
  );
  assert.equal(authority.consume(first.ticket, { payload }).status, 'consumed');
  assert.equal(authority.completeStep(first.ticket.jti, 'completed').ok, true);

  const second = authority.reserve({
    peerIdentity: 'uid:61001',
    operationId,
    stepIndex: 1,
    stepType: 'start',
    runId,
    generation: 1,
    payload,
    authorizationRevision: 4,
    taskRevision: 2,
    profileRevision: 3,
    leaseRevision: 7,
  });
  assert.equal(second.ok, true);
  assert.notEqual(second.ticket.jti, first.ticket.jti);

  const uncertain = new FakeAuthorizationAuthority();
  const unknownTicket = uncertain.reserve({
    peerIdentity: 'uid:61001',
    operationId: '66666666-6666-4666-8666-666666666666',
    stepIndex: 0,
    stepType: 'create',
    runId,
    generation: 1,
    payload,
    authorizationRevision: 4,
    taskRevision: 2,
    profileRevision: 3,
    leaseRevision: 7,
  }).ticket;
  assert.equal(uncertain.consume(unknownTicket, { payload }).status, 'consumed');
  assert.equal(uncertain.completeStep(unknownTicket.jti, 'unknown').state, 'unknown');
  assert.equal(
    uncertain.reserve({
      peerIdentity: 'uid:61001',
      operationId: unknownTicket.operationId,
      stepIndex: 1,
      stepType: 'start',
      runId,
      generation: 1,
      payload,
      authorizationRevision: 4,
      taskRevision: 2,
      profileRevision: 3,
      leaseRevision: 7,
    }).reason,
    'step_order',
  );
});

test('fake issuer fails closed on substituted payload, stale revisions, invalid steps, expiry and unauthorized intent', () => {
  const authority = new FakeAuthorizationAuthority();
  const validIntent = {
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
  };

  assert.equal(
    authority.reserve({ ...validIntent, peerIdentity: 'uid:61002' }).reason,
    'worker_identity',
  );
  assert.equal(
    authority.reserve({ ...validIntent, authorizationRevision: 3 }).reason,
    'stale_revision',
  );
  assert.equal(authority.reserve({ ...validIntent, taskRevision: 1 }).reason, 'stale_revision');
  assert.equal(authority.reserve({ ...validIntent, profileRevision: 2 }).reason, 'stale_revision');
  assert.equal(authority.reserve({ ...validIntent, stepType: 'start' }).reason, 'step_order');
  assert.equal(authority.reserve({ ...validIntent, stepIndex: 1 }).reason, 'step_order');
  assert.equal(authority.reserve({ ...validIntent, stepType: 'exec' }).reason, 'unsupported_step');
  assert.equal(authority.reserve({ ...validIntent, leaseRevision: 6 }).reason, 'lease_lost');
  assert.equal(authority.reserve({ ...validIntent, payload: undefined }).reason, 'payload_missing');
  assert.equal(
    authority.reserve({ ...validIntent, payload: Buffer.alloc(65537) }).reason,
    'payload_too_large',
  );

  const reserved = authority.reserve(validIntent);
  assert.equal(reserved.ok, true);
  assert.equal(
    authority.consume(reserved.ticket, { payload: Buffer.from('substituted') }).reason,
    'payload_mismatch',
  );
  assert.equal(
    authority.consume(reserved.ticket, { now: reserved.ticket.expiresAt }).reason,
    'ticket_expired',
  );

  const revoked = new FakeAuthorizationAuthority({ revoked: true });
  assert.equal(revoked.reserve(validIntent).reason, 'authorization_revoked');
  const unavailable = new FakeAuthorizationAuthority({ available: false });
  assert.equal(unavailable.reserve(validIntent).reason, 'authority_unavailable');
  const superseded = new FakeAuthorizationAuthority();
  superseded.supersedeLease();
  assert.equal(superseded.reserve(validIntent).reason, 'lease_lost');
});

test('revocation and lease supersession serialize with reservation; concurrent consume is one-use', async () => {
  const validIntent = {
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
  };
  const before = new FakeAuthorizationAuthority({ revoked: true });
  assert.equal(before.reserve(validIntent).reason, 'authorization_revoked');

  const after = new FakeAuthorizationAuthority();
  const reservation = after.reserve(validIntent);
  after.revoke();
  assert.equal(after.consume(reservation.ticket, { payload }).status, 'consumed');
  assert.equal(
    after.reserve({ ...validIntent, stepIndex: 1, stepType: 'start' }).reason,
    'authorization_revoked',
  );

  const racing = new FakeAuthorizationAuthority();
  const ticket = racing.reserve(validIntent).ticket;
  const results = await Promise.all([
    racing.consume(ticket, { payload }),
    racing.consume(ticket, { payload }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['consumed', 'rejected']);
  assert.equal(results.filter((result) => result.reason === 'replay_conflict').length, 1);

  const reservationRace = new FakeAuthorizationAuthority();
  const concurrentReservations = await Promise.all([
    Promise.resolve().then(() => reservationRace.reserve(validIntent)),
    Promise.resolve().then(() => reservationRace.reserve(validIntent)),
  ]);
  assert.equal(concurrentReservations.filter((result) => result.ok).length, 1);
  assert.equal(concurrentReservations.filter((result) => !result.ok).length, 1);

  const conflicting = new FakeAuthorizationAuthority();
  assert.equal(conflicting.reserve(validIntent).ok, true);
  assert.equal(
    conflicting.reserve({ ...validIntent, payload: Buffer.from('different operation binding') })
      .reason,
    'operation_conflict',
  );
});

test('fake Engine recorder accepts only the explicit synthetic container request', () => {
  const recorder = new FakeDockerEngineRecorder();
  const request = makeSafeEngineCreateRequest({ runId, generation: 1 });
  const recorded = recorder.createContainer(request);
  assert.deepEqual(recorded, request);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].operation, 'create');
  assert.equal(recorder.readOutput(Buffer.alloc(1024)).length, 1024);
  assert.throws(() => recorder.readOutput(Buffer.alloc(8193)), /output limit/);

  for (const unsafe of [
    { ...request, name: '../../host-docker-socket' },
    { ...request, HostConfig: { ...request.HostConfig, Privileged: true } },
    { ...request, HostConfig: { ...request.HostConfig, NetworkMode: 'host' } },
    { ...request, HostConfig: { ...request.HostConfig, PidMode: 'host' } },
    { ...request, HostConfig: { ...request.HostConfig, IpcMode: 'host' } },
    { ...request, HostConfig: { ...request.HostConfig, Binds: ['/var/run/docker.sock:/socket'] } },
    { ...request, HostConfig: { ...request.HostConfig, Memory: 0 } },
    { ...request, User: '0:0' },
    { ...request, Cmd: ['/bin/sh', '-c', 'anything'] },
    {
      ...request,
      HostConfig: { ...request.HostConfig, ExtraHosts: ['host.docker.internal:host-gateway'] },
    },
  ]) {
    assert.throws(() => recorder.createContainer(unsafe));
  }
  assert.equal(recorder.calls.length, 2, 'rejected requests are never recorded as accepted');
});

test('adversarial Engine response and log frames classify deterministically and fail closed', () => {
  const valid = makeProtocolResponse({ runId, generation: 1 });
  const responseIdentity = {
    expectedRequestId: '22222222-2222-4222-8222-222222222222',
    expectedOperationId: '33333333-3333-4333-8333-333333333333',
    expectedRunId: runId,
    expectedGeneration: 1,
  };
  const parse = (body, contentType = 'application/json') =>
    parseEngineResponse({ ...responseIdentity, contentType, body }, 'launch');
  assert.deepEqual(parse(makeFrame(JSON.stringify(valid))), {
    ok: true,
    classification: 'PERMITTED',
  });
  assert.equal(
    parse(makeFrame(JSON.stringify(valid)), 'text/plain').classification,
    'MALFORMED_RESPONSE',
  );
  assert.equal(parse(Buffer.alloc(16389)).classification, 'MALFORMED_RESPONSE');
  assert.equal(parse(makeFrame('{"a":1,"a":2}')).classification, 'MALFORMED_RESPONSE');
  assert.equal(
    parse(Buffer.concat([makeFrame(JSON.stringify(valid)), makeFrame(JSON.stringify(valid))]))
      .classification,
    'MALFORMED_RESPONSE',
  );
  assert.equal(
    parse(
      makeFrame(
        JSON.stringify({ ...valid, classification: 'OUTCOME_UNKNOWN', effect_state: 'committed' }),
      ),
    ).classification,
    'MALFORMED_RESPONSE',
  );
  assert.equal(
    parse(
      makeFrame(
        JSON.stringify({
          ...valid,
          result: { ...valid.result, run_id: '33333333-3333-4333-8333-333333333333' },
        }),
      ),
    ).classification,
    'MALFORMED_RESPONSE',
  );
  const unknown = {
    ...valid,
    classification: 'OUTCOME_UNKNOWN',
    reason_code: 'outcome_unknown',
    effect_state: 'unknown',
    result: { run_id: runId, generation: 1, state: 'unknown' },
  };
  assert.equal(parse(makeFrame(JSON.stringify(unknown))).classification, 'OUTCOME_UNKNOWN');

  const logFrame = Buffer.alloc(8 + 4);
  logFrame[0] = 1;
  logFrame.writeUInt32BE(4, 4);
  logFrame.write('test', 8);
  assert.deepEqual(parseEngineLogs(logFrame, 12), [
    { stream: 'stdout', bytes: Buffer.from('test') },
  ]);
  assert.throws(() => parseEngineLogs(logFrame.subarray(0, 10), 12), /truncated/);
  const badHeader = Buffer.from(logFrame);
  badHeader[0] = 3;
  assert.throws(() => parseEngineLogs(badHeader, 12), /stream/);
  assert.throws(() => parseEngineLogs(logFrame, 11), /limit/);
});

test('unsafe Engine resource names and run labels are rejected', () => {
  const expected = deriveContainerName(runId, 3);
  assert.equal(expected, `omnis-${runId.replaceAll('-', '')}-g3`);
  assert.throws(() => deriveContainerName('../../host', 3));
  assert.throws(() => deriveContainerName(runId, 0));
  assert.throws(() => deriveContainerName(runId, 2.5));
});

test('unknown mutation outcomes never auto-retry and read-only reconciliation does not redispatch', () => {
  const ledger = new OfflineOutcomeLedger();
  const id = ledger.reserve({ operationId, runId, generation: 1 });
  assert.equal(ledger.transition(id, 'ticket_consumed').ok, true);
  assert.equal(ledger.transition(id, 'dispatch_attempted').ok, true);
  assert.equal(ledger.transition(id, 'engine_ack_lost').ok, true);
  assert.equal(ledger.transition(id, 'reconciliation_pending').ok, true);
  assert.equal(ledger.reconcile(id, { observation: 'missing' }).state, 'outcome_unknown');
  assert.equal(ledger.canDispatchAgain(id), false);
  assert.equal(ledger.transition(id, 'dispatch_attempted').ok, false);

  const completed = ledger.reserve({
    operationId: '33333333-3333-4333-8333-333333333333',
    runId,
    generation: 1,
  });
  assert.equal(ledger.transition(completed, 'ticket_consumed').ok, true);
  assert.equal(ledger.transition(completed, 'dispatch_attempted').ok, true);
  assert.equal(ledger.transition(completed, 'reconciliation_pending').ok, true);
  assert.equal(
    ledger.reconcile(completed, { observation: 'owned_completed' }).state,
    'outcome_unknown',
  );
  assert.equal(
    ledger.reconcile(completed, {
      operationId: '33333333-3333-4333-8333-333333333333',
      runId,
      generation: 1,
      source: 'synthetic-exact-inspect',
      observation: 'owned_completed',
    }).state,
    'outcome_unknown',
  );
  assert.equal(ledger.canDispatchAgain(completed), false);

  const terminal = ledger.reserve({
    operationId: '77777777-7777-4777-8777-777777777777',
    runId,
    generation: 1,
  });
  assert.equal(ledger.transition(terminal, 'ticket_consumed').ok, true);
  assert.equal(ledger.transition(terminal, 'dispatch_attempted').ok, true);
  assert.equal(ledger.transition(terminal, 'reconciliation_pending').ok, true);
  assert.equal(ledger.transition(terminal, 'definitively_completed').ok, false);
  assert.equal(
    ledger.reconcile(terminal, {
      operationId: '77777777-7777-4777-8777-777777777777',
      runId,
      generation: 1,
      source: 'synthetic-exact-inspect',
      observation: 'owned_completed',
    }).state,
    'definitively_completed',
  );
  assert.equal(ledger.canDispatchAgain(terminal), false);

  const failed = ledger.reserve({
    operationId: '88888888-8888-4888-8888-888888888888',
    runId,
    generation: 1,
  });
  assert.equal(ledger.transition(failed, 'ticket_consumed').ok, true);
  assert.equal(ledger.transition(failed, 'dispatch_attempted').ok, true);
  assert.equal(ledger.transition(failed, 'reconciliation_pending').ok, true);
  assert.equal(
    ledger.reconcile(failed, {
      operationId: '88888888-8888-4888-8888-888888888888',
      runId,
      generation: 1,
      source: 'synthetic-exact-inspect',
      observation: 'confirmed_no_effect',
    }).state,
    'definitively_failed',
  );
  assert.equal(ledger.canDispatchAgain(failed), false);
  assert.equal(ledger.canDispatchAgain(completed), false);
});

test('mock monotonic anchor detects local rollback only when its independent state is retained', () => {
  const anchor = new MockMonotonicAnchor({ epoch: 'fixture-1' });
  const local = { epoch: 'fixture-1', sequence: 0, digest: 'genesis' };
  assert.equal(anchor.advance(local, { sequence: 1, digest: 'ticket-1' }).ok, true);
  const rolledBack = { ...local };
  assert.equal(anchor.admit(rolledBack).ok, false);
  assert.equal(anchor.admit({ epoch: 'fixture-1', sequence: 1, digest: 'ticket-1' }).ok, true);
  assert.equal(
    anchor.advance(
      { ...local, sequence: 1, digest: 'ticket-1' },
      { sequence: 1, digest: 'ticket-1' },
    ).ok,
    false,
  );

  const sameDomainRestore = new MockMonotonicAnchor({
    epoch: 'fixture-1',
    sequence: 0,
    digest: 'genesis',
  });
  assert.equal(
    sameDomainRestore.admit(local).ok,
    true,
    'a common rollback cannot be detected from local state alone',
  );
  assert.equal(new MockMonotonicAnchor({ available: false }).admit(local).ok, false);
});

test('mock termination authority rejects foreign identity and treats missing evidence as unknown', () => {
  const terminator = new MockTerminationAuthority();
  const cgroupId = 'cg-fixture-a1';
  terminator.register({ runId, generation: 1, cgroupId });
  const stop = {
    authority: 'synthetic-stop-only',
    runId,
    generation: 1,
    cgroupId,
    stopId: 'stop-1',
  };
  assert.equal(
    terminator.requestStop({ ...stop, runId: '33333333-3333-4333-8333-333333333333' }).status,
    'denied',
  );
  assert.equal(terminator.requestStop({ ...stop, generation: 0 }).status, 'denied');
  assert.equal(
    terminator.requestStop({ ...stop, cgroupId: 'cg-fixture-substituted' }).status,
    'denied',
  );
  assert.equal(terminator.requestStop(stop).status, 'attempted');
  assert.equal(terminator.confirm(stop.stopId, null).status, 'unknown');
  assert.equal(
    terminator.confirm(stop.stopId, { emptyCgroup: true, processInventory: [] }).status,
    'confirmed',
  );
  assert.equal(terminator.realProcessesTerminated, false);
});

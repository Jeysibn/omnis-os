import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeStage1ValidationAdapter } from './stage1-adapter.test-only.ts';
import {
  SimulatedLedgerStore,
  seedAuthorizationForTests,
  type FaultPoint,
} from './ledger.test-only.ts';
import type { SimulatedRequest } from './schema.test-only.ts';
import { validAuthorization, validRequest } from './fixtures.test-only.ts';

const authorization = validAuthorization;
const request = validRequest;

function activeStage1(auth = authorization()): FakeStage1ValidationAdapter {
  return new FakeStage1ValidationAdapter({
    mode: 'synthetic-stage1-only',
    sessionState: 'active',
    reservationState: 'valid',
    runId: auth.runId,
    sessionId: auth.sessionId,
    generation: auth.generation,
    manifestSha256: auth.manifestSha256,
    attemptId: auth.attemptId,
    path: auth.path,
    ordinal: auth.ordinal,
    controllerPid: auth.controllerPid,
    controllerStartTimeTicks: auth.controllerStartTimeTicks,
    journalSequenceDigest: auth.journalSequenceDigest,
    requestDigest: auth.requestDigest,
    receiptId: auth.receiptId,
    bootId: auth.bootId,
    reservationBootTimeNs: auth.reservationBootTimeNs,
    deadlineBootTimeNs: auth.deadlineBootTimeNs,
  });
}

async function withStore(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'omnis-stage2a-synthetic-'));
  try {
    await seedAuthorizationForTests(directory, authorization());
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('consumes a valid synthetic authorization once and reports only simulated state', async () => {
  await withStore(async (directory) => {
    const store = new SimulatedLedgerStore(directory, activeStage1());
    assert.deepEqual(await store.consume(request()), {
      mode: 'synthetic-only',
      kind: 'simulated_consumed',
      authorizationId: authorization().authorizationId,
    });
    assert.equal((await store.read()).entries[0]?.state, 'consumed');
  });
});

test('rejects duplicate, replayed and conflicting payloads', async () => {
  await withStore(async (directory) => {
    const store = new SimulatedLedgerStore(directory, activeStage1());
    await store.consume(request());
    await assert.rejects(store.consume(request()), /already_consumed/);
    await assert.rejects(
      store.consume(request(authorization(), { requestDigest: 'b'.repeat(64) })),
      /payload_conflict/,
    );
    await store.recover();
    await assert.rejects(store.consume(request()), /already_consumed/);
  });
});

test('rejects expiry, boot mismatch, revocation and fixture mismatch', async () => {
  await withStore(async (directory) => {
    const store = new SimulatedLedgerStore(directory, activeStage1());
    await assert.rejects(
      store.consume(request(authorization(), { nowNs: '200' })),
      /authorization_expired/,
    );
    await assert.rejects(
      store.consume(request(authorization(), { bootId: '77777777-7777-4777-8777-777777777777' })),
      /boot_mismatch/,
    );
    await assert.rejects(
      store.consume(request(authorization(), { fixtureId: 'sim-fixture:other' })),
      /payload_conflict/,
    );
    await assert.rejects(
      store.consume(request(authorization(), { ownerSubjectId: 'sim-owner:bob' })),
      /payload_conflict/,
    );
    await assert.rejects(
      store.consume(request(authorization(), { ownerSessionId: 'sim-session:other' })),
      /payload_conflict/,
    );
    await store.revoke(authorization().authorizationId, '160');
    await assert.rejects(store.consume(request()), /authorization_revoked/);
  });
});

test('serializes concurrent consumption so exactly one synthetic transition wins', async () => {
  await withStore(async (directory) => {
    const store = new SimulatedLedgerStore(directory, activeStage1());
    const outcomes = await Promise.allSettled([store.consume(request()), store.consume(request())]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal((await store.read()).entries[0]?.state, 'consumed');
  });
});

test('recovery turns durable pending state into unknown and never consumes it', async () => {
  await withStore(async (directory) => {
    const crash: FaultPoint = 'after_pending_persisted';
    const store = new SimulatedLedgerStore(directory, activeStage1(), { faultAt: crash });
    await assert.rejects(store.consume(request()), /simulated_crash/);
    const recovered = new SimulatedLedgerStore(directory, activeStage1());
    await recovered.recover();
    assert.equal((await recovered.read()).entries[0]?.state, 'unknown');
    await assert.rejects(recovered.consume(request()), /unknown_outcome/);
  });
});

test('ambiguous consumed persistence is poisoned and recovery never sends again', async () => {
  await withStore(async (directory) => {
    const store = new SimulatedLedgerStore(directory, activeStage1(), {
      faultAt: 'after_consumed_rename',
    });
    await assert.rejects(store.consume(request()), /unknown_outcome/);
    const recovered = new SimulatedLedgerStore(directory, activeStage1());
    await recovered.recover();
    assert.ok(['unknown', 'consumed'].includes((await recovered.read()).entries[0]?.state ?? ''));
    await assert.rejects(recovered.consume(request()), /already_consumed|unknown_outcome/);
  });
});

test('lost acknowledgment returns unknown and duplicate status cannot produce another result', async () => {
  await withStore(async (directory) => {
    const store = new SimulatedLedgerStore(directory, activeStage1(), {
      faultAt: 'after_consumed_persisted',
    });
    await assert.rejects(store.consume(request()), /acknowledgment_lost/);
    const recovered = new SimulatedLedgerStore(directory, activeStage1());
    await recovered.recover();
    assert.equal((await recovered.read()).entries[0]?.state, 'consumed');
    await assert.rejects(recovered.consume(request()), /already_consumed/);
  });
});

test('refuses missing, corrupt, unsafe and partial ledger storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnis-stage2a-missing-'));
  await rm(directory, { recursive: true, force: true });
  await assert.rejects(
    new SimulatedLedgerStore(directory, activeStage1()).read(),
    /storage_missing/,
  );

  await withStore(async (existing) => {
    const store = new SimulatedLedgerStore(existing, activeStage1());
    await store.corruptForTests();
    await assert.rejects(store.read(), /ledger_corrupt/);
  });
});

test('simulated Stage 1 termination blocks before synthetic consumption', async () => {
  await withStore(async (directory) => {
    const auth = authorization();
    const terminal = new FakeStage1ValidationAdapter({
      mode: 'synthetic-stage1-only',
      sessionState: 'terminal',
      reservationState: 'valid',
      runId: auth.runId,
      sessionId: auth.sessionId,
      generation: auth.generation,
      manifestSha256: auth.manifestSha256,
      attemptId: auth.attemptId,
      path: auth.path,
      ordinal: auth.ordinal,
      controllerPid: auth.controllerPid,
      controllerStartTimeTicks: auth.controllerStartTimeTicks,
      journalSequenceDigest: auth.journalSequenceDigest,
      requestDigest: auth.requestDigest,
      receiptId: auth.receiptId,
      bootId: auth.bootId,
      reservationBootTimeNs: auth.reservationBootTimeNs,
      deadlineBootTimeNs: auth.deadlineBootTimeNs,
    });
    const store = new SimulatedLedgerStore(directory, terminal);
    await assert.rejects(store.consume(request()), /stage1_terminal_session/);
    assert.equal((await store.read()).entries[0]?.state, 'issued');
  });
});

test('rejects every Stage 1 identity mismatch against the fake live reservation', async () => {
  const auth = authorization();
  const mismatches: Array<Partial<ConstructorParameters<typeof FakeStage1ValidationAdapter>[0]>> = [
    { sessionId: '77777777-7777-4777-8777-777777777777' },
    { runId: '88888888-8888-4888-8888-888888888888' },
    { receiptId: '99999999-9999-4999-8999-999999999999' },
    { generation: auth.generation + 1 },
    { attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { path: 'windows' },
    { ordinal: 1 },
    { controllerPid: auth.controllerPid + 1 },
    { controllerStartTimeTicks: '98766' },
    { journalSequenceDigest: 'f'.repeat(64) },
    { requestDigest: 'c'.repeat(64) },
    { manifestSha256: 'd'.repeat(64) },
    { bootId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    { reservationBootTimeNs: '101' },
    { deadlineBootTimeNs: '720000000101' },
  ];
  for (const mismatch of mismatches) {
    const base = {
      mode: 'synthetic-stage1-only' as const,
      sessionState: 'active' as const,
      reservationState: 'valid' as const,
      runId: auth.runId,
      sessionId: auth.sessionId,
      generation: auth.generation,
      manifestSha256: auth.manifestSha256,
      attemptId: auth.attemptId,
      path: auth.path,
      ordinal: auth.ordinal,
      controllerPid: auth.controllerPid,
      controllerStartTimeTicks: auth.controllerStartTimeTicks,
      journalSequenceDigest: auth.journalSequenceDigest,
      requestDigest: auth.requestDigest,
      receiptId: auth.receiptId,
      bootId: auth.bootId,
      reservationBootTimeNs: auth.reservationBootTimeNs,
      deadlineBootTimeNs: auth.deadlineBootTimeNs,
    };
    const invalid = new FakeStage1ValidationAdapter({ ...base, ...mismatch });
    await withStore(async (directory) => {
      const store = new SimulatedLedgerStore(directory, invalid);
      await assert.rejects(store.consume(request()), /stage1_reservation_conflict/);
      assert.equal((await store.read()).entries[0]?.state, 'issued');
    });
  }
});

test('rejects every Stage 1 identity mismatch copied into the request payload', async () => {
  const auth = authorization();
  const mismatches: Array<Partial<SimulatedRequest>> = [
    { sessionId: '77777777-7777-4777-8777-777777777777' },
    { runId: '88888888-8888-4888-8888-888888888888' },
    { receiptId: '99999999-9999-4999-8999-999999999999' },
    { generation: auth.generation + 1 },
    { attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { path: 'windows' },
    { ordinal: 1 },
    { controllerPid: auth.controllerPid + 1 },
    { controllerStartTimeTicks: '98766' },
    { journalSequenceDigest: 'f'.repeat(64) },
    { requestDigest: 'c'.repeat(64) },
    { manifestSha256: 'd'.repeat(64) },
    { bootId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    { reservationBootTimeNs: '101' },
    { deadlineBootTimeNs: '720000000101' },
  ];
  for (const mismatch of mismatches) {
    await withStore(async (directory) => {
      const store = new SimulatedLedgerStore(directory, activeStage1(auth));
      const expected = 'bootId' in mismatch ? /boot_mismatch/ : /payload_conflict/;
      await assert.rejects(store.consume(request(auth, mismatch)), expected);
      assert.equal((await store.read()).entries[0]?.state, 'issued');
    });
  }
});

test('rejects fake poisoned session, missing reservation and stale reservation', async () => {
  await withStore(async (directory) => {
    const auth = authorization();
    for (const [state, expected] of [
      [{ sessionState: 'poisoned' as const }, /stage1_poisoned_session/],
      [{ reservationState: 'missing' as const }, /stage1_reservation_missing/],
    ] as const) {
      const base = {
        mode: 'synthetic-stage1-only' as const,
        sessionState: 'active' as const,
        reservationState: 'valid' as const,
        runId: auth.runId,
        sessionId: auth.sessionId,
        generation: auth.generation,
        manifestSha256: auth.manifestSha256,
        attemptId: auth.attemptId,
        path: auth.path,
        ordinal: auth.ordinal,
        controllerPid: auth.controllerPid,
        controllerStartTimeTicks: auth.controllerStartTimeTicks,
        journalSequenceDigest: auth.journalSequenceDigest,
        requestDigest: auth.requestDigest,
        receiptId: auth.receiptId,
        bootId: auth.bootId,
        reservationBootTimeNs: auth.reservationBootTimeNs,
        deadlineBootTimeNs: auth.deadlineBootTimeNs,
      };
      const adapter = new FakeStage1ValidationAdapter({ ...base, ...state });
      const store = new SimulatedLedgerStore(directory, adapter);
      await assert.rejects(store.consume(request()), expected);
      assert.equal((await store.read()).entries[0]?.state, 'issued');
    }
    assert.throws(
      () => activeStage1(auth).validate(auth, auth.deadlineBootTimeNs),
      /stage1_deadline_expired/,
    );
  });
});

test('concurrent revocation and consumption serialize to one terminal decision', async () => {
  await withStore(async (directory) => {
    const auth = authorization();
    const store = new SimulatedLedgerStore(directory, activeStage1());
    const results = await Promise.allSettled([
      store.consume(request(auth)),
      store.revoke(auth.authorizationId, '150'),
    ]);
    const ledger = await store.read();
    assert.ok(['consumed', 'revoked'].includes(ledger.entries[0]?.state ?? ''));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  });
});

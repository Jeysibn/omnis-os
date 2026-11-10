import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyReservation,
  createReservationRequest,
  type ClockReading,
  type ReservationRequest,
} from './admission.ts';
import { type JournalState } from './schema.ts';

const journal = (): JournalState => ({
  schemaVersion: 1,
  runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
  generation: 1,
  manifestSha256: 'a'.repeat(64),
  bootId: 'c1111111-1111-4111-8111-111111111111',
  startedAtBootTimeNs: '1000',
  deadlineBootTimeNs: '720000001000',
  lastObservedBootTimeNs: '1000',
  session: {
    id: 'd1111111-1111-4111-8111-111111111111',
    ownerPid: 123,
    ownerStartTimeTicks: '987654',
  },
  attemptCounts: { windows: 0, wsl: 0, direct: 0, published: 0 },
  reservations: [],
  events: [],
});

const request = (overrides: Partial<ReservationRequest> = {}): ReservationRequest => ({
  attemptId: 'e1111111-1111-4111-8111-111111111111',
  runId: journal().runId,
  generation: 1,
  path: 'direct',
  ...overrides,
});

const reading = (overrides: Partial<ClockReading> = {}): ClockReading => ({
  bootId: journal().bootId,
  bootTimeNs: 1001n,
  ...overrides,
});

test('reserves at most three attempts and returns only reservation evidence', () => {
  let state = journal();
  for (let index = 0; index < 3; index += 1) {
    const result = applyReservation(
      state,
      request({
        attemptId: `e1111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      }),
      reading({ bootTimeNs: BigInt(1001 + index) }),
    );
    assert.equal(result.kind, 'reserved');
    state = result.state;
  }

  assert.equal(state.attemptCounts.direct, 3);
  assert.throws(
    () =>
      applyReservation(
        state,
        request({
          attemptId: 'e1111111-1111-4111-8111-999999999999',
        }),
        reading({ bootTimeNs: 1004n }),
      ),
    /attempt_limit/,
  );
  assert.equal('release' in applyReservation(journal(), request(), reading()), false);
});

test('identical duplicate is non-actionable and conflicting duplicate is rejected', () => {
  const first = applyReservation(journal(), request(), reading());
  assert.equal(first.kind, 'reserved');
  const duplicate = applyReservation(first.state, request(), reading({ bootTimeNs: 1002n }));
  assert.equal(duplicate.kind, 'already_reserved');
  assert.deepEqual(duplicate.state, first.state);
  assert.equal('receipt' in duplicate, false);
  assert.equal('reservation' in duplicate, false);
  assert.equal('receiptId' in duplicate, false);

  assert.throws(
    () => applyReservation(first.state, request({ path: 'wsl' }), reading({ bootTimeNs: 1002n })),
    /idempotency_conflict/,
  );
});

test('rejects wrong run, stale generation and malformed request identity', () => {
  assert.throws(
    () =>
      applyReservation(
        journal(),
        request({ runId: 'f1111111-1111-4111-8111-111111111111' }),
        reading(),
      ),
    /run_mismatch/,
  );
  assert.throws(
    () => applyReservation(journal(), request({ generation: 2 }), reading()),
    /stale_generation/,
  );
  assert.throws(
    () => applyReservation(journal(), request({ attemptId: 'bad' }), reading()),
    /invalid_attempt_id/,
  );
});

test('rejects invalid, backward, expired and wrong-boot clock readings', () => {
  for (const invalid of [
    reading({ bootId: 'bad' }),
    reading({ bootTimeNs: -1n }),
    reading({ bootTimeNs: Number.NaN as unknown as bigint }),
    reading({ bootId: 'f1111111-1111-4111-8111-111111111111' }),
    reading({ bootTimeNs: 720000001000n }),
  ]) {
    assert.throws(() => applyReservation(journal(), request(), invalid));
  }

  const state = journal();
  state.lastObservedBootTimeNs = '1002';
  assert.throws(
    () => applyReservation(state, request(), reading({ bootTimeNs: 1001n })),
    /clock_moved_backwards/,
  );
});

test('equal clock readings are valid within clock resolution', () => {
  const state = journal();
  state.lastObservedBootTimeNs = '1001';
  assert.equal(applyReservation(state, request(), reading({ bootTimeNs: 1001n })).kind, 'reserved');
});

test('new request helper creates a canonical random attempt identity', () => {
  const created = createReservationRequest(journal().runId, 1, 'windows');
  assert.match(
    created.attemptId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(created.path, 'windows');
});

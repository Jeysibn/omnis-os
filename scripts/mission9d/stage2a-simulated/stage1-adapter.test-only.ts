import type { SimulatedAuthorization } from './schema.test-only.ts';

export interface FakeStage1State {
  mode: 'synthetic-stage1-only';
  sessionState: 'active' | 'terminal' | 'poisoned';
  reservationState: 'valid' | 'missing';
  runId: string;
  sessionId: string;
  generation: number;
  manifestSha256: string;
  attemptId: string;
  path: SimulatedAuthorization['path'];
  ordinal: number;
  controllerPid: number;
  controllerStartTimeTicks: string;
  journalSequenceDigest: string;
  requestDigest: string;
  receiptId: string;
  bootId: string;
  reservationBootTimeNs: string;
  deadlineBootTimeNs: string;
}

export class FakeStage1ValidationAdapter {
  readonly #state: FakeStage1State;

  constructor(state: FakeStage1State) {
    this.#state = state;
  }

  validate(authorization: SimulatedAuthorization, nowNs: string): void {
    const state = this.#state;
    if (state.mode !== 'synthetic-stage1-only') throw new Error('invalid_fake_adapter');
    if (state.sessionState === 'terminal') throw new Error('stage1_terminal_session');
    if (state.sessionState === 'poisoned') throw new Error('stage1_poisoned_session');
    if (state.reservationState !== 'valid') throw new Error('stage1_reservation_missing');
    const identityMatches =
      state.runId === authorization.runId &&
      state.sessionId === authorization.sessionId &&
      state.generation === authorization.generation &&
      state.manifestSha256 === authorization.manifestSha256 &&
      state.attemptId === authorization.attemptId &&
      state.path === authorization.path &&
      state.ordinal === authorization.ordinal &&
      state.controllerPid === authorization.controllerPid &&
      state.controllerStartTimeTicks === authorization.controllerStartTimeTicks &&
      state.journalSequenceDigest === authorization.journalSequenceDigest &&
      state.requestDigest === authorization.requestDigest &&
      state.receiptId === authorization.receiptId &&
      state.bootId === authorization.bootId &&
      state.reservationBootTimeNs === authorization.reservationBootTimeNs &&
      state.deadlineBootTimeNs === authorization.deadlineBootTimeNs;
    if (!identityMatches) throw new Error('stage1_reservation_conflict');
    const reserved = BigInt(state.reservationBootTimeNs);
    const deadline = BigInt(state.deadlineBootTimeNs);
    const now = BigInt(nowNs);
    if (
      deadline <= reserved ||
      deadline - reserved > 720_000_000_000n ||
      now < reserved ||
      now >= deadline
    )
      throw new Error('stage1_deadline_expired');
    if (BigInt(authorization.issuedAtNs) < reserved || BigInt(authorization.issuedAtNs) >= deadline)
      throw new Error('stage1_authorization_outside_reservation');
  }
}

import { createHash, randomUUID } from 'node:crypto';
import {
  ATTEMPT_PATHS,
  validateJournal,
  type AttemptPath,
  type JournalEvent,
  type JournalState,
  type Reservation,
} from './schema.ts';

export interface ClockReading {
  bootId: string;
  bootTimeNs: bigint;
}

export interface ClockAdapter {
  read(): Promise<ClockReading>;
}

export interface ReservationRequest {
  attemptId: string;
  runId: string;
  generation: number;
  path: AttemptPath;
}

export function createReservationRequest(
  runId: string,
  generation: number,
  path: AttemptPath,
): ReservationRequest {
  return { attemptId: randomUUID(), runId, generation, path };
}

export interface EventRequest {
  eventId: string;
  eventType: string;
}

export type ReservationDecision =
  | { kind: 'reserved'; state: JournalState; reservation: Reservation }
  | {
      kind: 'already_reserved';
      state: JournalState;
      attemptId: string;
      path: AttemptPath;
      ordinal: number;
    };

export type EventDecision = { kind: 'recorded'; state: JournalState; event: JournalEvent };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_RUN_DURATION_NS = 720_000_000_000n;
const MAX_SIGNED_64 = 9_223_372_036_854_775_807n;

function validClockReading(value: unknown): ClockReading {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid_clock');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid_clock');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    keys.some((key) => typeof key !== 'string' || !['bootId', 'bootTimeNs'].includes(key))
  ) {
    throw new Error('invalid_clock');
  }
  for (const key of ['bootId', 'bootTimeNs']) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new Error('invalid_clock');
  }
  const reading = Object.fromEntries(
    keys.map((key) => [key, descriptors[key as string]?.value]),
  ) as Partial<ClockReading>;
  if (typeof reading.bootId !== 'string' || !UUID.test(reading.bootId))
    throw new Error('invalid_boot_id');
  if (
    typeof reading.bootTimeNs !== 'bigint' ||
    reading.bootTimeNs < 0n ||
    reading.bootTimeNs > MAX_SIGNED_64
  ) {
    throw new Error('invalid_boottime');
  }
  return { bootId: reading.bootId, bootTimeNs: reading.bootTimeNs };
}

function checkedStateAndTime(
  state: JournalState,
  readingInput: ClockReading,
): { state: JournalState; now: bigint } {
  const validated = validateJournal(state);
  const reading = validClockReading(readingInput);
  if (reading.bootId !== validated.bootId) throw new Error('boot_mismatch');
  const now = reading.bootTimeNs;
  const started = BigInt(validated.startedAtBootTimeNs);
  const deadline = BigInt(validated.deadlineBootTimeNs);
  const previous = BigInt(validated.lastObservedBootTimeNs);
  if (deadline - started > MAX_RUN_DURATION_NS) throw new Error('deadline_exceeds_run_limit');
  if (now < previous) throw new Error('clock_moved_backwards');
  if (now < started) throw new Error('clock_before_run_start');
  if (now >= deadline) throw new Error('deadline_expired');
  return { state: validated, now };
}

function validateRequest(request: ReservationRequest): ReservationRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request))
    throw new Error('invalid_request');
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid_request');
  const record = request as unknown as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        typeof key !== 'string' || !['attemptId', 'runId', 'generation', 'path'].includes(key),
    )
  ) {
    throw new Error('invalid_request');
  }
  for (const key of ['attemptId', 'runId', 'generation', 'path']) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new Error('invalid_request');
  }
  if (typeof record['attemptId'] !== 'string' || !UUID.test(record['attemptId']))
    throw new Error('invalid_attempt_id');
  if (typeof record['runId'] !== 'string' || !UUID.test(record['runId']))
    throw new Error('invalid_run_id');
  if (!Number.isSafeInteger(record['generation']) || (record['generation'] as number) <= 0)
    throw new Error('invalid_generation');
  if (
    typeof record['path'] !== 'string' ||
    !ATTEMPT_PATHS.includes(record['path'] as AttemptPath)
  ) {
    throw new Error('invalid_attempt_path');
  }
  return {
    attemptId: record['attemptId'],
    runId: record['runId'],
    generation: record['generation'] as number,
    path: record['path'] as AttemptPath,
  };
}

function digestRequest(request: ReservationRequest, manifestSha256: string): string {
  const canonical = JSON.stringify({
    attemptId: request.attemptId,
    generation: request.generation,
    manifestSha256,
    path: request.path,
    runId: request.runId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function applyReservation(
  stateInput: JournalState,
  requestInput: ReservationRequest,
  clockReading: ClockReading,
): ReservationDecision {
  const { state, now } = checkedStateAndTime(stateInput, clockReading);
  const request = validateRequest(requestInput);
  if (request.runId !== state.runId) throw new Error('run_mismatch');
  if (request.generation !== state.generation) throw new Error('stale_generation');

  const requestDigest = digestRequest(request, state.manifestSha256);
  const existing = state.reservations.find(
    (reservation) => reservation.attemptId === request.attemptId,
  );
  if (existing) {
    if (existing.requestDigest !== requestDigest || existing.path !== request.path) {
      throw new Error('idempotency_conflict');
    }
    return {
      kind: 'already_reserved',
      state,
      attemptId: existing.attemptId,
      path: existing.path,
      ordinal: existing.ordinal,
    };
  }

  const ordinal = state.attemptCounts[request.path] + 1;
  if (ordinal > 3) throw new Error('attempt_limit');

  const reservation: Reservation = {
    receiptId: randomUUID(),
    attemptId: request.attemptId,
    requestDigest,
    path: request.path,
    ordinal,
    reservedAtBootTimeNs: now.toString(),
  };
  const next: JournalState = {
    ...state,
    lastObservedBootTimeNs: now.toString(),
    attemptCounts: { ...state.attemptCounts, [request.path]: ordinal },
    reservations: [...state.reservations, reservation],
  };
  return { kind: 'reserved', state: validateJournal(next), reservation };
}

export function applyEvent(
  stateInput: JournalState,
  requestInput: EventRequest,
  clockReading: ClockReading,
): EventDecision {
  const { state, now } = checkedStateAndTime(stateInput, clockReading);
  if (typeof requestInput !== 'object' || requestInput === null || Array.isArray(requestInput)) {
    throw new Error('invalid_event_request');
  }
  const prototype = Object.getPrototypeOf(requestInput);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('invalid_event_request');
  const request = requestInput as unknown as Record<string, unknown>;
  const keys = Reflect.ownKeys(request);
  if (
    keys.length !== 2 ||
    keys.some((key) => typeof key !== 'string' || !['eventId', 'eventType'].includes(key))
  ) {
    throw new Error('invalid_event_request');
  }
  for (const key of ['eventId', 'eventType']) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new Error('invalid_event_request');
  }
  const eventId = request['eventId'];
  const eventType = request['eventType'];
  if (typeof eventId !== 'string' || !UUID.test(eventId)) throw new Error('invalid_event_id');
  if (typeof eventType !== 'string' || !EVENT_TYPE.test(eventType))
    throw new Error('invalid_event_type');
  if (state.events.some((event) => event.eventId === eventId))
    throw new Error('duplicate_event_id');

  const event: JournalEvent = { eventId, eventType, recordedAtBootTimeNs: now.toString() };
  const next: JournalState = {
    ...state,
    lastObservedBootTimeNs: now.toString(),
    events: [...state.events, event],
  };
  return { kind: 'recorded', state: validateJournal(next), event };
}

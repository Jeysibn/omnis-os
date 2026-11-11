export const ATTEMPT_PATHS = ['windows', 'wsl', 'direct', 'published'] as const;

export type AttemptPath = (typeof ATTEMPT_PATHS)[number];

export interface SessionIdentity {
  id: string;
  ownerPid: number;
  ownerStartTimeTicks: string;
}

export interface Reservation {
  receiptId: string;
  attemptId: string;
  requestDigest: string;
  path: AttemptPath;
  ordinal: number;
  reservedAtBootTimeNs: string;
}

export interface JournalEvent {
  eventId: string;
  eventType: string;
  recordedAtBootTimeNs: string;
}

export interface AttemptCounts {
  windows: number;
  wsl: number;
  direct: number;
  published: number;
}

export interface JournalState {
  schemaVersion: 1;
  runId: string;
  generation: number;
  manifestSha256: string;
  bootId: string;
  startedAtBootTimeNs: string;
  deadlineBootTimeNs: string;
  lastObservedBootTimeNs: string;
  session: SessionIdentity;
  attemptCounts: AttemptCounts;
  reservations: Reservation[];
  events: JournalEvent[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
const PATH_SET = new Set<string>(ATTEMPT_PATHS);
const MAX_RUN_DURATION_NS = 720_000_000_000n;

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid_${label}`);
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`invalid_${label}`);

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) {
      throw new Error(`invalid_${label}`);
    }

    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new Error(`invalid_${label}`);
      }
    }

    return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
  } catch {
    throw new Error(`invalid_${label}`);
  }
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`invalid_${label}`);
  return value;
}

function requireDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UNSIGNED_DECIMAL.test(value))
    throw new Error(`invalid_${label}`);
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`invalid_${label}`);
  return value as number;
}

function parseSession(value: unknown): SessionIdentity {
  const record = exactRecord(value, ['id', 'ownerPid', 'ownerStartTimeTicks'], 'session');
  return {
    id: requireUuid(record['id'], 'session_id'),
    ownerPid: requirePositiveSafeInteger(record['ownerPid'], 'session_owner_pid'),
    ownerStartTimeTicks: requireDecimal(record['ownerStartTimeTicks'], 'session_owner_start_time'),
  };
}

function parseCounts(value: unknown): AttemptCounts {
  const record = exactRecord(value, [...ATTEMPT_PATHS], 'attempt_counts');
  const counts = {} as AttemptCounts;
  for (const path of ATTEMPT_PATHS) {
    const count = record[path];
    if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 3) {
      throw new Error('invalid_attempt_count');
    }
    counts[path] = count as number;
  }
  return counts;
}

function parseReservation(value: unknown): Reservation {
  const record = exactRecord(
    value,
    ['receiptId', 'attemptId', 'requestDigest', 'path', 'ordinal', 'reservedAtBootTimeNs'],
    'reservation',
  );
  const path = record['path'];
  if (typeof path !== 'string' || !PATH_SET.has(path)) throw new Error('invalid_reservation_path');
  const ordinal = record['ordinal'];
  if (!Number.isInteger(ordinal) || (ordinal as number) < 1 || (ordinal as number) > 3) {
    throw new Error('invalid_reservation_ordinal');
  }
  const requestDigest = record['requestDigest'];
  if (typeof requestDigest !== 'string' || !SHA256.test(requestDigest)) {
    throw new Error('invalid_reservation_digest');
  }
  return {
    receiptId: requireUuid(record['receiptId'], 'receipt_id'),
    attemptId: requireUuid(record['attemptId'], 'attempt_id'),
    requestDigest,
    path: path as AttemptPath,
    ordinal: ordinal as number,
    reservedAtBootTimeNs: requireDecimal(record['reservedAtBootTimeNs'], 'reservation_time'),
  };
}

function parseEvent(value: unknown): JournalEvent {
  const record = exactRecord(value, ['eventId', 'eventType', 'recordedAtBootTimeNs'], 'event');
  const eventType = record['eventType'];
  if (typeof eventType !== 'string' || !EVENT_TYPE.test(eventType))
    throw new Error('invalid_event_type');
  return {
    eventId: requireUuid(record['eventId'], 'event_id'),
    eventType,
    recordedAtBootTimeNs: requireDecimal(record['recordedAtBootTimeNs'], 'event_time'),
  };
}

export function validateJournal(value: unknown): JournalState {
  const record = exactRecord(
    value,
    [
      'schemaVersion',
      'runId',
      'generation',
      'manifestSha256',
      'bootId',
      'startedAtBootTimeNs',
      'deadlineBootTimeNs',
      'lastObservedBootTimeNs',
      'session',
      'attemptCounts',
      'reservations',
      'events',
    ],
    'journal',
  );

  if (record['schemaVersion'] !== 1) throw new Error('invalid_schema_version');
  const generation = requirePositiveSafeInteger(record['generation'], 'generation');
  const manifestSha256 = record['manifestSha256'];
  if (typeof manifestSha256 !== 'string' || !SHA256.test(manifestSha256)) {
    throw new Error('invalid_manifest_digest');
  }
  const bootId = requireUuid(record['bootId'], 'boot_id');
  const startedAtBootTimeNs = requireDecimal(record['startedAtBootTimeNs'], 'start_time');
  const deadlineBootTimeNs = requireDecimal(record['deadlineBootTimeNs'], 'deadline');
  const lastObservedBootTimeNs = requireDecimal(
    record['lastObservedBootTimeNs'],
    'last_clock_reading',
  );
  if (
    BigInt(deadlineBootTimeNs) <= BigInt(startedAtBootTimeNs) ||
    BigInt(deadlineBootTimeNs) - BigInt(startedAtBootTimeNs) > MAX_RUN_DURATION_NS
  ) {
    throw new Error('invalid_deadline');
  }
  if (
    BigInt(lastObservedBootTimeNs) < BigInt(startedAtBootTimeNs) ||
    BigInt(lastObservedBootTimeNs) >= BigInt(deadlineBootTimeNs)
  )
    throw new Error('invalid_last_clock_reading');

  if (!Array.isArray(record['reservations']) || !Array.isArray(record['events'])) {
    throw new Error('invalid_journal_arrays');
  }
  const reservations = record['reservations'].map(parseReservation);
  const events = record['events'].map(parseEvent);
  if (reservations.length > ATTEMPT_PATHS.length * 3) throw new Error('too_many_reservations');

  const counts = parseCounts(record['attemptCounts']);
  const actualCounts: AttemptCounts = { windows: 0, wsl: 0, direct: 0, published: 0 };
  const startNs = BigInt(startedAtBootTimeNs);
  const deadlineNs = BigInt(deadlineBootTimeNs);
  const seenAttemptIds = new Set<string>();
  for (const reservation of reservations) {
    if (seenAttemptIds.has(reservation.attemptId)) throw new Error('duplicate_attempt_id');
    seenAttemptIds.add(reservation.attemptId);
    if (reservation.ordinal !== actualCounts[reservation.path] + 1)
      throw new Error('invalid_attempt_ordinal');
    const reservedAt = BigInt(reservation.reservedAtBootTimeNs);
    if (reservedAt < startNs || reservedAt >= deadlineNs)
      throw new Error('reservation_time_outside_run');
    actualCounts[reservation.path] += 1;
  }
  for (const path of ATTEMPT_PATHS) {
    if (actualCounts[path] !== counts[path]) throw new Error('inconsistent_attempt_counts');
  }

  const seenEventIds = new Set<string>();
  for (const event of events) {
    if (seenEventIds.has(event.eventId)) throw new Error('duplicate_event_id');
    seenEventIds.add(event.eventId);
    const recordedAt = BigInt(event.recordedAtBootTimeNs);
    if (recordedAt < startNs || recordedAt >= deadlineNs) throw new Error('event_time_outside_run');
  }

  return {
    schemaVersion: 1,
    runId: requireUuid(record['runId'], 'run_id'),
    generation,
    manifestSha256,
    bootId,
    startedAtBootTimeNs,
    deadlineBootTimeNs,
    lastObservedBootTimeNs,
    session: parseSession(record['session']),
    attemptCounts: counts,
    reservations,
    events,
  };
}

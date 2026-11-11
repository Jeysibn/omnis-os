import { createHash } from 'node:crypto';

export const SIMULATION_MODE = 'synthetic-only' as const;
export const LEDGER_MODE = 'synthetic-ledger-only' as const;
export const MAX_AUTHORIZATION_LIFETIME_NS = 720_000_000_000n;

export interface SimulatedAuthorization {
  mode: typeof SIMULATION_MODE;
  authorizationId: string;
  ownerSubjectId: string;
  ownerSessionId: string;
  operationId: string;
  fixtureId: string;
  fixtureGeneration: number;
  runId: string;
  sessionId: string;
  generation: number;
  manifestSha256: string;
  attemptId: string;
  path: 'windows' | 'wsl' | 'direct' | 'published';
  ordinal: number;
  controllerPid: number;
  controllerStartTimeTicks: string;
  journalSequenceDigest: string;
  requestDigest: string;
  receiptId: string;
  bootId: string;
  reservationBootTimeNs: string;
  deadlineBootTimeNs: string;
  issuedAtNs: string;
  expiresAtNs: string;
  singleUse: true;
}

export interface SimulatedRequest {
  mode: typeof SIMULATION_MODE;
  requestId: string;
  authorizationId: string;
  ownerSubjectId: string;
  ownerSessionId: string;
  operationId: string;
  fixtureId: string;
  fixtureGeneration: number;
  runId: string;
  sessionId: string;
  generation: number;
  manifestSha256: string;
  attemptId: string;
  path: 'windows' | 'wsl' | 'direct' | 'published';
  ordinal: number;
  controllerPid: number;
  controllerStartTimeTicks: string;
  journalSequenceDigest: string;
  requestDigest: string;
  receiptId: string;
  bootId: string;
  reservationBootTimeNs: string;
  deadlineBootTimeNs: string;
  nowNs: string;
}

export type SimulatedEntryState = 'issued' | 'pending' | 'consumed' | 'revoked' | 'unknown';

export interface SimulatedLedgerEntry {
  authorization: SimulatedAuthorization;
  state: SimulatedEntryState;
  requestId: string | null;
  updatedAtNs: string;
}

export interface SimulatedLedger {
  schemaVersion: 1;
  mode: typeof LEDGER_MODE;
  sequence: number;
  entries: SimulatedLedgerEntry[];
  integritySha256: string;
}

const IDENTIFIER = /^sim-[a-z]+:[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ATTEMPT_PATHS = new Set(['windows', 'wsl', 'direct', 'published']);
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const MAX_SIGNED_64 = 9_223_372_036_854_775_807n;
const ENTRY_STATES = new Set<SimulatedEntryState>([
  'issued',
  'pending',
  'consumed',
  'revoked',
  'unknown',
]);

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`invalid_${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`invalid_${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw new Error(`invalid_${label}`);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new Error(`invalid_${label}`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`invalid_${label}`);
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`invalid_${label}`);
  return value;
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value) || BigInt(value) > MAX_SIGNED_64)
    throw new Error(`invalid_${label}`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`invalid_${label}`);
  return value as number;
}

interface Stage1Binding {
  runId: string;
  sessionId: string;
  bootId: string;
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
  reservationBootTimeNs: string;
  deadlineBootTimeNs: string;
}

function validateStage1Binding(input: Record<string, unknown>): Stage1Binding {
  for (const field of ['manifestSha256', 'requestDigest']) {
    if (typeof input[field] !== 'string' || !SHA256.test(input[field]))
      throw new Error(`invalid_${field}`);
  }
  for (const field of ['runId', 'sessionId', 'attemptId', 'receiptId']) uuid(input[field], field);
  if (typeof input['path'] !== 'string' || !ATTEMPT_PATHS.has(input['path']))
    throw new Error('invalid_stage1_attempt_path');
  const ordinal = positiveInteger(input['ordinal'], 'stage1_ordinal');
  if (ordinal > 3) throw new Error('invalid_stage1_attempt_ordinal');
  const journalSequenceDigest = input['journalSequenceDigest'];
  if (typeof journalSequenceDigest !== 'string' || !SHA256.test(journalSequenceDigest))
    throw new Error('invalid_journal_sequence_digest');
  return {
    runId: uuid(input['runId'], 'run_id'),
    sessionId: uuid(input['sessionId'], 'session_id'),
    bootId: uuid(input['bootId'], 'boot_id'),
    generation: positiveInteger(input['generation'], 'stage1_generation'),
    manifestSha256: input['manifestSha256'] as string,
    attemptId: uuid(input['attemptId'], 'attempt_id'),
    path: input['path'] as Stage1Binding['path'],
    ordinal,
    controllerPid: positiveInteger(input['controllerPid'], 'controller_pid'),
    controllerStartTimeTicks: decimal(input['controllerStartTimeTicks'], 'controller_start_time'),
    journalSequenceDigest,
    requestDigest: input['requestDigest'] as string,
    receiptId: uuid(input['receiptId'], 'receipt_id'),
    reservationBootTimeNs: decimal(input['reservationBootTimeNs'], 'stage1_reservation_time'),
    deadlineBootTimeNs: decimal(input['deadlineBootTimeNs'], 'stage1_deadline'),
  };
}

export function validateAuthorization(value: unknown): SimulatedAuthorization {
  const fields = [
    'mode',
    'authorizationId',
    'ownerSubjectId',
    'ownerSessionId',
    'operationId',
    'fixtureId',
    'fixtureGeneration',
    'runId',
    'sessionId',
    'generation',
    'manifestSha256',
    'attemptId',
    'path',
    'ordinal',
    'controllerPid',
    'controllerStartTimeTicks',
    'journalSequenceDigest',
    'requestDigest',
    'receiptId',
    'bootId',
    'reservationBootTimeNs',
    'deadlineBootTimeNs',
    'issuedAtNs',
    'expiresAtNs',
    'singleUse',
  ] as const;
  const input = record(value, fields, 'authorization');
  if (input['mode'] !== SIMULATION_MODE || input['singleUse'] !== true)
    throw new Error('invalid_simulation_authorization');
  if (typeof input['requestDigest'] !== 'string' || !SHA256.test(input['requestDigest']))
    throw new Error('invalid_request_digest');
  const stage1 = validateStage1Binding(input);
  const issuedAtNs = decimal(input['issuedAtNs'], 'issued_at');
  const expiresAtNs = decimal(input['expiresAtNs'], 'expires_at');
  const issued = BigInt(issuedAtNs);
  const expires = BigInt(expiresAtNs);
  const reservationAt = BigInt(stage1.reservationBootTimeNs);
  const stage1Deadline = BigInt(stage1.deadlineBootTimeNs);
  if (
    expires <= issued ||
    expires - issued > MAX_AUTHORIZATION_LIFETIME_NS ||
    reservationAt >= stage1Deadline ||
    issued < reservationAt ||
    expires > stage1Deadline ||
    stage1Deadline - reservationAt > MAX_AUTHORIZATION_LIFETIME_NS
  )
    throw new Error('invalid_authorization_window');
  return {
    mode: SIMULATION_MODE,
    authorizationId: identifier(input['authorizationId'], 'authorization_id'),
    ownerSubjectId: identifier(input['ownerSubjectId'], 'owner_subject_id'),
    ownerSessionId: identifier(input['ownerSessionId'], 'owner_session_id'),
    ...stage1,
    operationId: identifier(input['operationId'], 'operation_id'),
    fixtureId: identifier(input['fixtureId'], 'fixture_id'),
    fixtureGeneration: positiveInteger(input['fixtureGeneration'], 'fixture_generation'),
    issuedAtNs,
    expiresAtNs,
    singleUse: true,
  };
}

export function validateRequest(value: unknown): SimulatedRequest {
  const fields = [
    'mode',
    'requestId',
    'authorizationId',
    'ownerSubjectId',
    'ownerSessionId',
    'operationId',
    'fixtureId',
    'fixtureGeneration',
    'runId',
    'sessionId',
    'generation',
    'manifestSha256',
    'attemptId',
    'path',
    'ordinal',
    'controllerPid',
    'controllerStartTimeTicks',
    'journalSequenceDigest',
    'requestDigest',
    'receiptId',
    'bootId',
    'reservationBootTimeNs',
    'deadlineBootTimeNs',
    'nowNs',
  ] as const;
  const input = record(value, fields, 'request');
  if (input['mode'] !== SIMULATION_MODE) throw new Error('invalid_simulation_request');
  if (typeof input['requestDigest'] !== 'string' || !SHA256.test(input['requestDigest']))
    throw new Error('invalid_request_digest');
  const stage1 = validateStage1Binding(input);
  const nowNs = decimal(input['nowNs'], 'now');
  const now = BigInt(nowNs);
  if (now < BigInt(stage1.reservationBootTimeNs) || now >= BigInt(stage1.deadlineBootTimeNs))
    throw new Error('stale_stage1_reservation');
  return {
    mode: SIMULATION_MODE,
    requestId: identifier(input['requestId'], 'request_id'),
    authorizationId: identifier(input['authorizationId'], 'authorization_id'),
    ownerSubjectId: identifier(input['ownerSubjectId'], 'owner_subject_id'),
    ownerSessionId: identifier(input['ownerSessionId'], 'owner_session_id'),
    ...stage1,
    operationId: identifier(input['operationId'], 'operation_id'),
    fixtureId: identifier(input['fixtureId'], 'fixture_id'),
    fixtureGeneration: positiveInteger(input['fixtureGeneration'], 'fixture_generation'),
    nowNs,
  };
}

export function sealLedger(value: Omit<SimulatedLedger, 'integritySha256'>): SimulatedLedger {
  const core = {
    schemaVersion: value.schemaVersion,
    mode: value.mode,
    sequence: value.sequence,
    entries: value.entries,
  };
  return {
    ...core,
    integritySha256: createHash('sha256').update(JSON.stringify(core), 'utf8').digest('hex'),
  };
}

export function validateLedger(value: unknown): SimulatedLedger {
  const input = record(
    value,
    ['schemaVersion', 'mode', 'sequence', 'entries', 'integritySha256'],
    'ledger',
  );
  if (input['schemaVersion'] !== 1 || input['mode'] !== LEDGER_MODE)
    throw new Error('invalid_simulation_ledger');
  if (!Number.isSafeInteger(input['sequence']) || (input['sequence'] as number) < 0)
    throw new Error('invalid_ledger_sequence');
  if (!Array.isArray(input['entries']) || input['entries'].length > 10_000)
    throw new Error('invalid_ledger_entries');
  const seen = new Set<string>();
  const entries = input['entries'].map((value) => {
    const entry = record(value, ['authorization', 'state', 'requestId', 'updatedAtNs'], 'entry');
    const authorization = validateAuthorization(entry['authorization']);
    if (seen.has(authorization.authorizationId)) throw new Error('duplicate_authorization');
    seen.add(authorization.authorizationId);
    if (
      typeof entry['state'] !== 'string' ||
      !ENTRY_STATES.has(entry['state'] as SimulatedEntryState)
    )
      throw new Error('invalid_entry_state');
    const requestId = entry['requestId'];
    if (requestId !== null) identifier(requestId, 'request_id');
    if ((entry['state'] === 'issued' || entry['state'] === 'revoked') && requestId !== null)
      throw new Error('inconsistent_entry_state');
    if (entry['state'] !== 'issued' && entry['state'] !== 'revoked' && requestId === null)
      throw new Error('inconsistent_entry_state');
    return {
      authorization,
      state: entry['state'] as SimulatedEntryState,
      requestId: requestId as string | null,
      updatedAtNs: decimal(entry['updatedAtNs'], 'updated_at'),
    };
  });
  const normalized = {
    schemaVersion: 1 as const,
    mode: LEDGER_MODE,
    sequence: input['sequence'] as number,
    entries,
  };
  const sealed = sealLedger(normalized);
  if (input['integritySha256'] !== sealed.integritySha256)
    throw new Error('invalid_ledger_integrity');
  return sealed;
}

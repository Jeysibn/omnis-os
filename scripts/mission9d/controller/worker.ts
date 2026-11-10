import { constants, fstatSync, fsyncSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { applyEvent, applyReservation, type ClockReading } from './admission.ts';
import {
  findHeldLockDescriptor,
  loadWorkerJournal,
  parseWorkerClockLine,
  validateWorkerLock,
  verifyWorkerDirectoryPath,
  workerDirectoryIdentity,
  writeJournalFile,
} from './journal.ts';
import { validateJournal, type JournalState } from './schema.ts';

const MAX_RUN_DURATION_NS = 720_000_000_000n;
const MAX_PROTOCOL_LINE_BYTES = 64_000;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = input[Symbol.asyncIterator]();

interface WorkerRequest {
  op: 'initialize' | 'reserve' | 'record' | 'read';
  sessionId: string;
  ownerPid: number;
  ownerStartTimeTicks: string;
  allowInitialJournal?: boolean;
  initialClock: { bootId: string; bootTimeNs: string };
  identity?: { runId: string; generation: number; manifestSha256: string };
  request?: {
    attemptId: string;
    runId: string;
    generation: number;
    path: 'windows' | 'wsl' | 'direct' | 'published';
  };
  event?: { eventId: string; eventType: string };
}

function environment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('worker_configuration_invalid');
  return value;
}

function numberEnvironment(name: string): number {
  const value = Number(environment(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('worker_configuration_invalid');
  return value;
}

function parseRequest(line: string): WorkerRequest {
  if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES)
    throw new Error('worker_request_too_large');
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('invalid_worker_request');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid_worker_request');
  const request = value as Record<string, unknown>;
  const op = request['op'];
  if (op !== 'initialize' && op !== 'reserve' && op !== 'record' && op !== 'read')
    throw new Error('invalid_worker_request');
  if (
    typeof request['sessionId'] !== 'string' ||
    typeof request['ownerStartTimeTicks'] !== 'string'
  ) {
    throw new Error('invalid_worker_request');
  }
  if (!Number.isSafeInteger(request['ownerPid']) || (request['ownerPid'] as number) < 1)
    throw new Error('invalid_worker_request');
  if (op === 'initialize' && typeof request['allowInitialJournal'] !== 'boolean')
    throw new Error('invalid_worker_request');
  if (typeof request['initialClock'] !== 'object' || request['initialClock'] === null)
    throw new Error('invalid_worker_request');
  return request as unknown as WorkerRequest;
}

async function nextLine(): Promise<string> {
  const next = await lines.next();
  if (next.done || typeof next.value !== 'string') throw new Error('worker_protocol_closed');
  if (Buffer.byteLength(next.value, 'utf8') > MAX_PROTOCOL_LINE_BYTES)
    throw new Error('worker_request_too_large');
  return next.value;
}

function emit(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function requestPrecommitClock(
  state: JournalState,
  initial: ClockReading,
  phase: 'precommit' | 'postcommit',
  notBefore: bigint = initial.bootTimeNs,
): Promise<ClockReading> {
  emit({ type: `need_${phase}_clock` });
  const response = JSON.parse(await nextLine()) as {
    type?: string;
    reading?: { bootId: string; bootTimeNs: string };
  };
  if (response.type !== 'clock' || !response.reading) throw new Error('invalid_worker_protocol');
  const reading = parseWorkerClockLine(JSON.stringify(response.reading));
  if (
    reading.bootId !== state.bootId ||
    reading.bootTimeNs < notBefore ||
    reading.bootTimeNs < initial.bootTimeNs ||
    reading.bootTimeNs < BigInt(state.lastObservedBootTimeNs) ||
    reading.bootTimeNs >= BigInt(state.deadlineBootTimeNs)
  ) {
    throw new Error(`clock_invalid_${phase}`);
  }
  return reading;
}

async function verifyLockAndRequestClock(
  lockIdentity: { dev: string; ino: string },
  directoryFd: number,
  uid: number,
  gid: number,
  state: JournalState,
  initial: ClockReading,
  phase: 'precommit' | 'postcommit' = 'precommit',
  notBefore: bigint = initial.bootTimeNs,
): Promise<ClockReading> {
  const lockFd = findHeldLockDescriptor(lockIdentity);
  await validateWorkerLock(lockFd, directoryFd, lockIdentity, uid, gid);
  return requestPrecommitClock(state, initial, phase, notBefore);
}

async function ownerIsCurrent(uid: number, pid: number, startTicks: string): Promise<boolean> {
  try {
    const info = await stat(`/proc/${pid}`);
    if (info.uid !== uid) return false;
    const handle = await open(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const line = await handle.readFile({ encoding: 'utf8' });
      const closeParen = line.lastIndexOf(')');
      if (closeParen < 0) return false;
      const fields = line
        .slice(closeParen + 1)
        .trim()
        .split(/\s+/);
      return fields[19] === startTicks;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function readInitialClock(value: WorkerRequest['initialClock']): Promise<ClockReading> {
  const serialized = JSON.stringify(value);
  const reading = parseWorkerClockLine(serialized);
  if (reading.bootTimeNs > 9_223_372_036_854_775_807n) throw new Error('invalid_boottime');
  return reading;
}

async function operate(request: WorkerRequest): Promise<void> {
  const directoryPath = environment('OMNIS_STAGE1_DIRECTORY');
  const directoryDev = environment('OMNIS_STAGE1_DIRECTORY_DEV');
  const directoryIno = environment('OMNIS_STAGE1_DIRECTORY_INO');
  const lockIdentity = {
    dev: environment('OMNIS_STAGE1_LOCK_DEV'),
    ino: environment('OMNIS_STAGE1_LOCK_INO'),
  };
  const uid = numberEnvironment('OMNIS_STAGE1_UID');
  const gid = numberEnvironment('OMNIS_STAGE1_GID');
  const expectedSessionId = environment('OMNIS_STAGE1_SESSION_ID');
  const expectedOwnerPid = numberEnvironment('OMNIS_STAGE1_OWNER_PID');
  const expectedOwnerStart = environment('OMNIS_STAGE1_OWNER_START_TICKS');
  const directoryFd = 3;
  const expectedDirectory = { dev: directoryDev, ino: directoryIno };
  if (
    workerDirectoryIdentity(directoryFd).dev !== directoryDev ||
    workerDirectoryIdentity(directoryFd).ino !== directoryIno
  ) {
    throw new Error('directory_identity_changed');
  }

  const lockFd = findHeldLockDescriptor(lockIdentity);
  await validateWorkerLock(lockFd, directoryFd, lockIdentity, uid, gid);
  fsyncSync(lockFd);
  fsyncSync(directoryFd);
  const directory = await verifyWorkerDirectoryPath(directoryPath, uid, gid, expectedDirectory);
  const clock = await readInitialClock(request.initialClock);

  try {
    const existing = await loadWorkerJournal(directoryFd, lockFd, lockIdentity, uid, gid).catch(
      (error: unknown) => {
        if (error instanceof Error && error.message === 'missing_journal') return undefined;
        throw error;
      },
    );

    if (request.op === 'initialize') {
      if (!request.identity) throw new Error('invalid_run_identity');
      if (existing) {
        const prior = existing.state;
        if (
          request.sessionId !== expectedSessionId ||
          request.ownerPid !== expectedOwnerPid ||
          request.ownerStartTimeTicks !== expectedOwnerStart ||
          prior.session.id !== request.sessionId ||
          prior.session.ownerPid !== request.ownerPid ||
          prior.session.ownerStartTimeTicks !== request.ownerStartTimeTicks
        )
          throw new Error('session_terminal');
        if (!(await ownerIsCurrent(uid, expectedOwnerPid, expectedOwnerStart)))
          throw new Error('session_terminal');
        if (
          prior.runId !== request.identity.runId ||
          prior.generation !== request.identity.generation ||
          prior.manifestSha256 !== request.identity.manifestSha256
        )
          throw new Error('run_identity_conflict');
        emit({
          type: 'result',
          value: prior,
          bootId: prior.bootId,
          deadlineBootTimeNs: prior.deadlineBootTimeNs,
          commitClock: clock.bootTimeNs.toString(),
        });
        return;
      }

      if (request.allowInitialJournal !== true) throw new Error('missing_journal');

      if (clock.bootTimeNs > 9_223_372_036_854_775_807n - MAX_RUN_DURATION_NS)
        throw new Error('invalid_deadline');
      const initialState = validateJournal({
        schemaVersion: 1,
        runId: request.identity.runId,
        generation: request.identity.generation,
        manifestSha256: request.identity.manifestSha256,
        bootId: clock.bootId,
        startedAtBootTimeNs: clock.bootTimeNs.toString(),
        deadlineBootTimeNs: (clock.bootTimeNs + MAX_RUN_DURATION_NS).toString(),
        lastObservedBootTimeNs: clock.bootTimeNs.toString(),
        session: {
          id: request.sessionId,
          ownerPid: request.ownerPid,
          ownerStartTimeTicks: request.ownerStartTimeTicks,
        },
        attemptCounts: { windows: 0, wsl: 0, direct: 0, published: 0 },
        reservations: [],
        events: [],
      });
      const postcommitClock = await writeJournalFile(
        directory,
        directoryFd,
        lockFd,
        lockIdentity,
        uid,
        gid,
        null,
        initialState,
        () => verifyLockAndRequestClock(lockIdentity, directoryFd, uid, gid, initialState, clock),
        (precommit) =>
          verifyLockAndRequestClock(
            lockIdentity,
            directoryFd,
            uid,
            gid,
            initialState,
            clock,
            'postcommit',
            precommit.bootTimeNs,
          ),
      );
      emit({
        type: 'result',
        value: initialState,
        bootId: initialState.bootId,
        deadlineBootTimeNs: initialState.deadlineBootTimeNs,
        commitClock: postcommitClock.bootTimeNs.toString(),
      });
      return;
    }

    if (!existing) throw new Error('missing_journal');
    let state = existing.state;
    if (
      request.sessionId !== expectedSessionId ||
      request.ownerPid !== expectedOwnerPid ||
      request.ownerStartTimeTicks !== expectedOwnerStart ||
      state.session.id !== request.sessionId ||
      state.session.ownerPid !== request.ownerPid ||
      state.session.ownerStartTimeTicks !== request.ownerStartTimeTicks ||
      state.session.ownerPid !== expectedOwnerPid ||
      state.session.ownerStartTimeTicks !== expectedOwnerStart
    ) {
      throw new Error('session_terminal');
    }
    if (state.bootId !== clock.bootId || state.bootId !== request.initialClock.bootId)
      throw new Error('boot_mismatch');
    if (!(await ownerIsCurrent(uid, expectedOwnerPid, expectedOwnerStart)))
      throw new Error('session_terminal');

    if (request.op === 'read') {
      emit({
        type: 'result',
        value: state,
        bootId: state.bootId,
        deadlineBootTimeNs: state.deadlineBootTimeNs,
        commitClock: clock.bootTimeNs.toString(),
      });
      return;
    }

    let nextState: JournalState;
    let value: unknown;
    if (request.op === 'reserve') {
      if (!request.request) throw new Error('invalid_reservation_request');
      const decision = applyReservation(state, request.request, clock);
      value =
        decision.kind === 'already_reserved'
          ? {
              kind: decision.kind,
              attemptId: decision.attemptId,
              path: decision.path,
              ordinal: decision.ordinal,
            }
          : { kind: decision.kind, reservation: decision.reservation };
      if (decision.kind === 'already_reserved') {
        emit({
          type: 'result',
          value,
          bootId: state.bootId,
          deadlineBootTimeNs: state.deadlineBootTimeNs,
          commitClock: clock.bootTimeNs.toString(),
        });
        return;
      }
      nextState = decision.state;
    } else {
      if (!request.event) throw new Error('invalid_event_request');
      const decision = applyEvent(state, request.event, clock);
      value = decision.event;
      nextState = decision.state;
    }

    if (clock.bootTimeNs < BigInt(state.lastObservedBootTimeNs))
      throw new Error('clock_moved_backwards');
    state = nextState;
    const postcommitClock = await writeJournalFile(
      directory,
      directoryFd,
      lockFd,
      lockIdentity,
      uid,
      gid,
      existing.identity,
      state,
      () => verifyLockAndRequestClock(lockIdentity, directoryFd, uid, gid, state, clock),
      (precommit) =>
        verifyLockAndRequestClock(
          lockIdentity,
          directoryFd,
          uid,
          gid,
          state,
          clock,
          'postcommit',
          precommit.bootTimeNs,
        ),
    );
    emit({
      type: 'result',
      value,
      bootId: state.bootId,
      deadlineBootTimeNs: state.deadlineBootTimeNs,
      commitClock: postcommitClock.bootTimeNs.toString(),
    });
  } finally {
    await directory.handle.close();
  }
}

async function main(): Promise<void> {
  const first = await lines.next();
  if (first.done || typeof first.value !== 'string') throw new Error('missing_worker_request');
  const request = parseRequest(first.value);
  const heldLock = findHeldLockDescriptor({
    dev: environment('OMNIS_STAGE1_LOCK_DEV'),
    ino: environment('OMNIS_STAGE1_LOCK_INO'),
  });
  if (!isRegularMode(fstatSync(heldLock, { bigint: true }).mode))
    throw new Error('unsafe_lock_file');
  await operate(request);
  input.close();
  process.stdin.destroy();
}

function isRegularMode(mode: bigint): boolean {
  return (mode & 0o170000n) === 0o100000n;
}

main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
      ? error.message
      : 'worker_failed';
  emit({ type: 'error', code });
  input.close();
  process.stdin.destroy();
  process.exitCode = 1;
});

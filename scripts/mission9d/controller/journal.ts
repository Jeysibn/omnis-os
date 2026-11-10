import { constants, fstatSync, fsyncSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  type ClockAdapter,
  type ClockReading,
  type EventRequest,
  type ReservationRequest,
} from './admission.ts';
import {
  validateJournal,
  type JournalEvent,
  type JournalState,
  type Reservation,
} from './schema.ts';

const FLOCK_PATH = '/usr/bin/flock';
const MAX_JOURNAL_BYTES = 1_048_576;
const MAX_PROTOCOL_LINE_BYTES = 64_000;
const MAX_LOCK_WAIT_SECONDS = 30;
const ROOT_FD = '/';
const JOURNAL_NAME = 'journal.json';
const LOCK_NAME = 'journal.lock';
const WORKER_PATH = fileURLToPath(new URL('./worker.ts', import.meta.url));

export interface ControllerOptions {
  directory: string;
  clockAdapter: ClockAdapter;
  lockWaitSeconds?: number;
}

export interface RunIdentity {
  runId: string;
  generation: number;
  manifestSha256: string;
}

export interface DurableReservationReceipt {
  durable: true;
  reservation: Reservation;
}

export type ReserveOutcome =
  | { kind: 'reserved'; receipt: DurableReservationReceipt }
  | {
      kind: 'already_reserved';
      attemptId: string;
      path: Reservation['path'];
      ordinal: number;
    };

export interface AdmissionController {
  initialize(identity: RunIdentity): Promise<JournalState>;
  reserve(request: ReservationRequest): Promise<ReserveOutcome>;
  record(event: EventRequest): Promise<JournalEvent>;
  read(): Promise<JournalState>;
  close(): Promise<void>;
}

export interface DurableWriteOperations {
  writeTemp(): Promise<void>;
  syncTemp(): Promise<void>;
  verifyBeforeReplace(): Promise<ClockReading | void>;
  renameJournal(): Promise<void>;
  syncDirectory(): Promise<void>;
  verifyAfterSync(): Promise<ClockReading | void>;
}

export async function commitDurably(
  operations: DurableWriteOperations,
): Promise<ClockReading | void> {
  await operations.writeTemp();
  await operations.syncTemp();
  await operations.verifyBeforeReplace();
  await operations.renameJournal();
  await operations.syncDirectory();
  return operations.verifyAfterSync();
}

interface FileIdentity {
  dev: string;
  ino: string;
}

interface SecureDirectory {
  handle: FileHandle;
  path: string;
  identity: FileIdentity;
  uid: number;
  gid: number;
}

interface WorkerMessage {
  type: 'need_precommit_clock' | 'need_postcommit_clock' | 'result' | 'error';
  code?: string;
  value?: unknown;
  deadlineBootTimeNs?: string;
  bootId?: string;
  commitClock?: string;
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return '';
}

function fail(code: string): never {
  throw new Error(code);
}

function pathAt(directoryFd: number, name: string): string {
  return `/proc/self/fd/${directoryFd}/${name}`;
}

function identityFromStat(info: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isDirectoryMode(mode: bigint): boolean {
  return (mode & 0o170000n) === 0o040000n;
}

function isRegularMode(mode: bigint): boolean {
  return (mode & 0o170000n) === 0o100000n;
}

function checkAncestor(
  info: Awaited<ReturnType<FileHandle['stat']>>,
  final: boolean,
  uid: number,
  gid: number,
): void {
  const statInfo = info as typeof info & { uid: bigint; gid: bigint; mode: bigint };
  if (!isDirectoryMode(statInfo.mode)) fail('unsafe_directory_object');
  if (final) {
    if (
      statInfo.uid !== BigInt(uid) ||
      statInfo.gid !== BigInt(gid) ||
      (statInfo.mode & 0o077n) !== 0n
    ) {
      fail('unsafe_directory_owner_or_mode');
    }
    return;
  }

  if (![0n, BigInt(uid)].includes(statInfo.uid) || ![0n, BigInt(gid)].includes(statInfo.gid)) {
    fail('unsafe_parent_owner');
  }
  const worldWritable = (statInfo.mode & 0o002n) !== 0n;
  const groupWritable = (statInfo.mode & 0o020n) !== 0n;
  const sticky = (statInfo.mode & 0o1000n) !== 0n;
  if ((worldWritable || groupWritable) && !(statInfo.uid === 0n && sticky))
    fail('unsafe_parent_world_write');
}

export async function openSecureDirectory(
  directory: string,
  uid: number,
  gid: number,
): Promise<SecureDirectory> {
  if (!isAbsolute(directory) || directory.includes('\0')) fail('directory_must_be_absolute');
  const normalized = resolve(directory);
  const components = normalized.split(sep).filter(Boolean);
  let current = await open(
    ROOT_FD,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    checkAncestor(await current.stat({ bigint: true }), components.length === 0, uid, gid);
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (!component || component === '.' || component === '..' || component.includes('/'))
        fail('unsafe_directory_component');
      const next = await open(
        `/proc/self/fd/${current.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      checkAncestor(await next.stat({ bigint: true }), index === components.length - 1, uid, gid);
      await current.close();
      current = next;
    }
    const identity = identityFromStat(await current.stat({ bigint: true }));
    return { handle: current, path: normalized, identity, uid, gid };
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function revalidateDirectory(directory: SecureDirectory, directoryFd: number): Promise<void> {
  const reopened = await openSecureDirectory(directory.path, directory.uid, directory.gid);
  try {
    const held = identityFromStat(await reopened.handle.stat({ bigint: true }));
    const workerHeld = identityFromStat(fstatSync(directoryFd, { bigint: true }));
    if (!sameIdentity(directory.identity, held) || !sameIdentity(directory.identity, workerHeld)) {
      fail('directory_identity_changed');
    }
  } finally {
    await reopened.handle.close();
  }
}

async function verifyRegularFile(
  handle: FileHandle,
  uid: number,
  gid: number,
  mode: number,
): Promise<FileIdentity> {
  const info = await handle.stat({ bigint: true });
  if (!isRegularMode(info.mode) || info.uid !== BigInt(uid) || info.gid !== BigInt(gid))
    fail('unsafe_file_owner_or_type');
  if ((info.mode & 0o777n) !== BigInt(mode) || info.nlink !== 1n) fail('unsafe_file_mode_or_links');
  return identityFromStat(info);
}

async function ensureStableLock(
  directory: SecureDirectory,
): Promise<{ identity: FileIdentity; created: boolean }> {
  const lockPath = pathAt(directory.handle.fd, LOCK_NAME);
  let lockHandle: FileHandle;
  let created = false;
  try {
    lockHandle = await open(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    lockHandle = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const identity = await verifyRegularFile(lockHandle, directory.uid, directory.gid, 0o600);
    if (created) {
      await lockHandle.sync();
      fsyncSync(directory.handle.fd);
    }
    const named = lstatSync(lockPath, { bigint: true });
    if (!isRegularMode(named.mode) || !sameIdentity(identity, identityFromStat(named)))
      fail('lock_path_identity_mismatch');
    return { identity, created };
  } finally {
    await lockHandle.close();
  }
}

async function readJournal(
  directoryFd: number,
  uid: number,
  gid: number,
): Promise<{ state: JournalState; identity: FileIdentity }> {
  let handle: FileHandle;
  try {
    handle = await open(
      pathAt(directoryFd, JOURNAL_NAME),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') fail('missing_journal');
    throw error;
  }
  try {
    const identity = await verifyRegularFile(handle, uid, gid, 0o600);
    const info = await handle.stat({ bigint: true });
    if (info.size > BigInt(MAX_JOURNAL_BYTES)) fail('journal_too_large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    } catch {
      fail('corrupt_journal');
    }
    return { state: validateJournal(parsed), identity };
  } finally {
    await handle.close();
  }
}

async function atomicReplaceJournal(
  directory: SecureDirectory,
  directoryFd: number,
  lockIdentity: FileIdentity,
  previousIdentity: FileIdentity | null,
  nextState: JournalState,
  requestPrecommitClock: () => Promise<ClockReading>,
  requestPostcommitClock: (precommit: ClockReading) => Promise<ClockReading>,
): Promise<ClockReading> {
  const temporaryName = `.journal-${randomUUID()}.tmp`;
  const temporaryPath = pathAt(directoryFd, temporaryName);
  const journalPath = pathAt(directoryFd, JOURNAL_NAME);
  const lockPath = pathAt(directoryFd, LOCK_NAME);
  const contents = JSON.stringify(nextState);
  if (Buffer.byteLength(contents, 'utf8') > MAX_JOURNAL_BYTES) fail('journal_too_large');

  let temporary: FileHandle | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let precommitClock: ClockReading | undefined;
  let renamed = false;
  try {
    const postcommitClock = await commitDurably({
      async writeTemp() {
        temporary = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        temporaryIdentity = await verifyRegularFile(temporary, directory.uid, directory.gid, 0o600);
        await temporary.writeFile(contents, { encoding: 'utf8' });
      },
      async syncTemp() {
        if (!temporary) fail('temporary_file_unavailable');
        await temporary.sync();
      },
      async verifyBeforeReplace() {
        if (!temporary || !temporaryIdentity) fail('temporary_file_unavailable');
        await revalidateDirectory(directory, directoryFd);

        const lockNamed = lstatSync(lockPath, { bigint: true });
        if (
          !isRegularMode(lockNamed.mode) ||
          !sameIdentity(lockIdentity, identityFromStat(lockNamed))
        ) {
          fail('lock_path_identity_mismatch');
        }

        if (previousIdentity) {
          const current = await open(
            journalPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const currentIdentity = await verifyRegularFile(
              current,
              directory.uid,
              directory.gid,
              0o600,
            );
            if (!sameIdentity(previousIdentity, currentIdentity))
              fail('journal_path_identity_mismatch');
          } finally {
            await current.close();
          }
        } else {
          try {
            lstatSync(journalPath, { bigint: true });
            fail('journal_already_exists');
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
        }

        precommitClock = await requestPrecommitClock();
        return precommitClock;
      },
      async renameJournal() {
        if (!temporary || !temporaryIdentity) fail('temporary_file_unavailable');
        const namedTemporary = lstatSync(temporaryPath, { bigint: true });
        if (
          !isRegularMode(namedTemporary.mode) ||
          !sameIdentity(temporaryIdentity, identityFromStat(namedTemporary))
        ) {
          fail('temporary_path_identity_mismatch');
        }
        await temporary.close();
        temporary = undefined;
        await rename(temporaryPath, journalPath);
        renamed = true;
      },
      async syncDirectory() {
        fsyncSync(directoryFd);
      },
      async verifyAfterSync() {
        if (!precommitClock) fail('precommit_clock_missing');
        return requestPostcommitClock(precommitClock);
      },
    });
    if (!postcommitClock) fail('postcommit_clock_missing');
    return postcommitClock;
  } catch (error) {
    if (!renamed) await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await temporary?.close().catch(() => undefined);
  }
}

function parseStartTime(statLine: string): string {
  const closingParen = statLine.lastIndexOf(')');
  if (closingParen < 0) fail('invalid_process_stat');
  const fieldsAfterCommand = statLine
    .slice(closingParen + 1)
    .trim()
    .split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  if (!startTime || !/^(0|[1-9][0-9]*)$/.test(startTime)) fail('invalid_process_start_time');
  return startTime;
}

export async function currentProcessStartTimeTicks(pid = process.pid): Promise<string> {
  const handle = await open(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return parseStartTime(await handle.readFile({ encoding: 'utf8' }));
  } finally {
    await handle.close();
  }
}

function serializeClock(reading: ClockReading): { bootId: string; bootTimeNs: string } {
  if (
    typeof reading !== 'object' ||
    reading === null ||
    typeof reading.bootId !== 'string' ||
    typeof reading.bootTimeNs !== 'bigint' ||
    reading.bootTimeNs < 0n ||
    reading.bootTimeNs > 9_223_372_036_854_775_807n
  ) {
    fail('invalid_clock_reading');
  }
  return { bootId: reading.bootId, bootTimeNs: reading.bootTimeNs.toString() };
}

function parseClock(value: { bootId: string; bootTimeNs: string }): ClockReading {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.bootId)
  ) {
    fail('invalid_boot_id');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value.bootTimeNs)) fail('invalid_boottime');
  return { bootId: value.bootId, bootTimeNs: BigInt(value.bootTimeNs) };
}

function statIdentity(path: string): FileIdentity {
  return identityFromStat(lstatSync(path, { bigint: true }));
}

function isFlockBinarySafe(): boolean {
  try {
    const info = lstatSync(FLOCK_PATH, { bigint: true });
    return (
      isRegularMode(info.mode) &&
      info.uid === 0n &&
      (info.mode & 0o022n) === 0n &&
      (info.mode & 0o111n) !== 0n
    );
  } catch {
    return false;
  }
}

class Controller implements AdmissionController {
  private readonly directory: SecureDirectory;
  private readonly lockIdentity: FileIdentity;
  private readonly clockAdapter: ClockAdapter;
  private readonly lockWaitSeconds: number;
  private readonly sessionId = randomUUID();
  private readonly ownerPid = process.pid;
  private ownerStartTimeTicks = '';
  private canCreateInitialJournal: boolean;
  private initialized = false;
  private closed = false;
  private poisoned = false;
  private bootId: string | undefined;
  private deadlineBootTimeNs: bigint | undefined;
  private lastClock: bigint | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    directory: SecureDirectory,
    lockIdentity: FileIdentity,
    canCreateInitialJournal: boolean,
    clockAdapter: ClockAdapter,
    lockWaitSeconds: number,
  ) {
    this.directory = directory;
    this.lockIdentity = lockIdentity;
    this.canCreateInitialJournal = canCreateInitialJournal;
    this.clockAdapter = clockAdapter;
    this.lockWaitSeconds = lockWaitSeconds;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readClock(): Promise<ClockReading> {
    let reading: ClockReading;
    try {
      reading = parseClock(serializeClock(await this.clockAdapter.read()));
    } catch {
      this.poisoned = true;
      fail('clock_unavailable_or_invalid');
    }
    if (this.bootId && reading.bootId !== this.bootId) {
      this.poisoned = true;
      fail('boot_mismatch');
    }
    if (this.lastClock !== undefined && reading.bootTimeNs < this.lastClock) {
      this.poisoned = true;
      fail('clock_moved_backwards');
    }
    if (this.deadlineBootTimeNs !== undefined && reading.bootTimeNs >= this.deadlineBootTimeNs) {
      this.poisoned = true;
      fail('deadline_expired');
    }
    this.bootId ??= reading.bootId;
    this.lastClock = reading.bootTimeNs;
    return reading;
  }

  private ensureUsable(allowUninitialized = false): void {
    if (this.closed) fail('controller_closed');
    if (this.poisoned) fail('controller_session_terminal');
    if (!allowUninitialized && !this.initialized) fail('journal_not_initialized');
  }

  async initialize(identity: RunIdentity): Promise<JournalState> {
    return this.enqueue(async () => {
      this.ensureUsable(true);
      if (this.initialized) fail('controller_already_initialized');
      this.ownerStartTimeTicks ||= await currentProcessStartTimeTicks(this.ownerPid);
      const initialClock = await this.readClock();
      const response = await this.invokeWorker({
        op: 'initialize',
        identity,
        allowInitialJournal: this.canCreateInitialJournal,
        initialClock: serializeClock(initialClock),
      });
      const state = validateJournal(response.value);
      if (
        state.session.id !== this.sessionId ||
        state.session.ownerPid !== this.ownerPid ||
        state.session.ownerStartTimeTicks !== this.ownerStartTimeTicks
      ) {
        this.poisoned = true;
        fail('session_identity_mismatch');
      }
      this.deadlineBootTimeNs = BigInt(state.deadlineBootTimeNs);
      await this.checkAfterUnlock(response, initialClock);
      this.initialized = true;
      this.canCreateInitialJournal = false;
      return state;
    });
  }

  async reserve(request: ReservationRequest): Promise<ReserveOutcome> {
    return this.enqueue(async () => {
      this.ensureUsable();
      const initialClock = await this.readClock();
      const response = await this.invokeWorker({
        op: 'reserve',
        request,
        initialClock: serializeClock(initialClock),
      });
      await this.checkAfterUnlock(response, initialClock);
      const value = response.value as {
        kind: string;
        reservation?: Reservation;
        attemptId?: string;
        path?: Reservation['path'];
        ordinal?: number;
      };
      if (value.kind === 'already_reserved')
        return {
          kind: 'already_reserved',
          attemptId: value.attemptId ?? fail('invalid_worker_result'),
          path: value.path ?? fail('invalid_worker_result'),
          ordinal: value.ordinal ?? fail('invalid_worker_result'),
        };
      if (value.kind !== 'reserved' || !value.reservation) fail('invalid_worker_result');
      return { kind: 'reserved', receipt: { durable: true, reservation: value.reservation } };
    });
  }

  async record(event: EventRequest): Promise<JournalEvent> {
    return this.enqueue(async () => {
      this.ensureUsable();
      const initialClock = await this.readClock();
      const response = await this.invokeWorker({
        op: 'record',
        event,
        initialClock: serializeClock(initialClock),
      });
      await this.checkAfterUnlock(response, initialClock);
      return response.value as JournalEvent;
    });
  }

  async read(): Promise<JournalState> {
    return this.enqueue(async () => {
      this.ensureUsable();
      const initialClock = await this.readClock();
      const response = await this.invokeWorker({
        op: 'read',
        initialClock: serializeClock(initialClock),
      });
      await this.checkAfterUnlock(response, initialClock);
      return validateJournal(response.value);
    });
  }

  private async checkAfterUnlock(response: WorkerMessage, previous: ClockReading): Promise<void> {
    let after: ClockReading;
    try {
      after = parseClock(serializeClock(await this.clockAdapter.read()));
    } catch {
      this.poisoned = true;
      fail('clock_unavailable_after_commit');
    }
    const deadline = response.deadlineBootTimeNs
      ? BigInt(response.deadlineBootTimeNs)
      : this.deadlineBootTimeNs;
    const committedAt = response.commitClock ? BigInt(response.commitClock) : previous.bootTimeNs;
    if (
      after.bootId !== previous.bootId ||
      after.bootId !== response.bootId ||
      after.bootTimeNs < committedAt ||
      (deadline !== undefined && after.bootTimeNs >= deadline)
    ) {
      this.poisoned = true;
      fail('clock_invalid_or_expired_after_unlock');
    }
    this.bootId = after.bootId;
    this.lastClock = after.bootTimeNs;
  }

  private async invokeWorker(request: Record<string, unknown>): Promise<WorkerMessage> {
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      OMNIS_STAGE1_DIRECTORY: this.directory.path,
      OMNIS_STAGE1_DIRECTORY_DEV: this.directory.identity.dev,
      OMNIS_STAGE1_DIRECTORY_INO: this.directory.identity.ino,
      OMNIS_STAGE1_LOCK_DEV: this.lockIdentity.dev,
      OMNIS_STAGE1_LOCK_INO: this.lockIdentity.ino,
      OMNIS_STAGE1_UID: String(this.directory.uid),
      OMNIS_STAGE1_GID: String(this.directory.gid),
      OMNIS_STAGE1_SESSION_ID: this.sessionId,
      OMNIS_STAGE1_OWNER_PID: String(this.ownerPid),
      OMNIS_STAGE1_OWNER_START_TICKS: this.ownerStartTimeTicks,
    };
    const child = spawn(
      FLOCK_PATH,
      [
        '--exclusive',
        '--no-fork',
        '--timeout',
        String(this.lockWaitSeconds),
        '--conflict-exit-code',
        '75',
        '/proc/self/fd/3/journal.lock',
        process.execPath,
        '--experimental-strip-types',
        WORKER_PATH,
      ],
      { stdio: ['pipe', 'pipe', 'pipe', this.directory.handle.fd], env: environment },
    );

    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill('SIGKILL');
      this.poisoned = true;
      fail('worker_stdio_unavailable');
    }
    const childInput = child.stdin;
    const childOutput = child.stdout;
    const childErrors = child.stderr;

    const lineReader = createInterface({ input: childOutput });
    let outputBytes = 0;
    let workerResult: WorkerMessage | undefined;
    let stderrBytes = 0;
    childErrors.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PROTOCOL_LINE_BYTES) child.kill('SIGKILL');
    });

    const protocol = (async () => {
      try {
        for await (const line of lineReader) {
          outputBytes += Buffer.byteLength(line, 'utf8');
          if (outputBytes > MAX_PROTOCOL_LINE_BYTES) fail('worker_output_limit');
          let message: WorkerMessage;
          try {
            message = JSON.parse(line) as WorkerMessage;
          } catch {
            fail('invalid_worker_protocol');
          }
          if (message.type === 'need_precommit_clock' || message.type === 'need_postcommit_clock') {
            const reading = await this.readClock();
            childInput.write(
              `${JSON.stringify({ type: 'clock', reading: serializeClock(reading) })}\n`,
            );
          } else if (message.type === 'result' || message.type === 'error') {
            workerResult = message;
          } else {
            fail('invalid_worker_protocol');
          }
        }
      } catch (error) {
        this.poisoned = true;
        child.kill('SIGTERM');
        childInput.end();
        throw error;
      }
    })();
    const protocolOutcome = protocol.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    childInput.write(
      `${JSON.stringify({
        ...request,
        sessionId: this.sessionId,
        ownerPid: this.ownerPid,
        ownerStartTimeTicks: this.ownerStartTimeTicks,
      })}\n`,
    );

    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', (code) => resolveExit(code ?? 1));
    });
    childInput.end();
    const outcome = await protocolOutcome;
    if (!outcome.ok) throw outcome.error;

    if (exitCode === 75) fail('lock_busy');
    if (!workerResult || workerResult.type !== 'result' || exitCode !== 0) {
      const code =
        workerResult?.type === 'error' ? (workerResult.code ?? 'worker_failed') : 'worker_failed';
      if (
        ![
          'attempt_limit',
          'idempotency_conflict',
          'stale_generation',
          'run_mismatch',
          'duplicate_event_id',
        ].includes(code)
      ) {
        this.poisoned = true;
      }
      fail(code);
    }
    return workerResult;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.queue;
    this.closed = true;
    await this.directory.handle.close();
  }
}

export async function openAdmissionController(
  options: ControllerOptions,
): Promise<AdmissionController> {
  if (
    process.platform !== 'linux' ||
    typeof process.getuid !== 'function' ||
    typeof process.getgid !== 'function'
  ) {
    fail('unsupported_platform');
  }
  if (!isFlockBinarySafe()) fail('flock_unavailable_or_unsafe');
  const lockWaitSeconds = options.lockWaitSeconds ?? 5;
  if (
    !Number.isInteger(lockWaitSeconds) ||
    lockWaitSeconds < 1 ||
    lockWaitSeconds > MAX_LOCK_WAIT_SECONDS
  ) {
    fail('invalid_lock_wait');
  }
  const directory = await openSecureDirectory(
    options.directory,
    process.getuid(),
    process.getgid(),
  );
  try {
    const lock = await ensureStableLock(directory);
    return new Controller(
      directory,
      lock.identity,
      lock.created,
      options.clockAdapter,
      lockWaitSeconds,
    );
  } catch (error) {
    await directory.handle.close();
    throw error;
  }
}

export function isJournalLockPathIdentity(directoryFd: number, expected: FileIdentity): boolean {
  try {
    return sameIdentity(expected, statIdentity(pathAt(directoryFd, LOCK_NAME)));
  } catch {
    return false;
  }
}

export function findHeldLockDescriptor(expected: FileIdentity): number {
  const matches: number[] = [];
  for (const entry of readdirSync('/proc/self/fd')) {
    if (!/^\d+$/.test(entry)) continue;
    const fd = Number(entry);
    try {
      const info = fstatSync(fd, { bigint: true });
      if (sameIdentity(expected, identityFromStat(info))) matches.push(fd);
    } catch {
      // The descriptor may close while /proc is enumerated; it is not a lock match.
    }
  }
  if (matches.length !== 1) fail('held_lock_descriptor_not_unique');
  return matches[0] as number;
}

export function workerDirectoryIdentity(fd: number): FileIdentity {
  return identityFromStat(fstatSync(fd, { bigint: true }));
}

export function parseWorkerClockLine(line: string): ClockReading {
  const input = JSON.parse(line) as { bootId: string; bootTimeNs: string };
  return parseClock(input);
}

export async function verifyWorkerDirectoryPath(
  path: string,
  uid: number,
  gid: number,
  expected: FileIdentity,
): Promise<SecureDirectory> {
  const directory = await openSecureDirectory(path, uid, gid);
  if (!sameIdentity(directory.identity, expected)) {
    await directory.handle.close();
    fail('directory_identity_changed');
  }
  return directory;
}

export async function writeJournalFile(
  directory: SecureDirectory,
  directoryFd: number,
  lockFd: number,
  lockIdentity: FileIdentity,
  uid: number,
  gid: number,
  previousIdentity: FileIdentity | null,
  state: JournalState,
  requestPrecommitClock: () => Promise<ClockReading>,
  requestPostcommitClock: (precommit: ClockReading) => Promise<ClockReading>,
): Promise<ClockReading> {
  await validateWorkerLock(lockFd, directoryFd, lockIdentity, uid, gid);
  return atomicReplaceJournal(
    directory,
    directoryFd,
    lockIdentity,
    previousIdentity,
    state,
    requestPrecommitClock,
    requestPostcommitClock,
  );
}

export async function loadWorkerJournal(
  directoryFd: number,
  lockFd: number,
  lockIdentity: FileIdentity,
  uid: number,
  gid: number,
): Promise<{ state: JournalState; identity: FileIdentity }> {
  await validateWorkerLock(lockFd, directoryFd, lockIdentity, uid, gid);
  return readJournal(directoryFd, uid, gid);
}

function linuxDeviceParts(device: bigint): { major: string; minor: string } {
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return { major: major.toString(16), minor: minor.toString(16) };
}

export async function validateWorkerLock(
  fd: number,
  directoryFd: number,
  expected: FileIdentity,
  uid: number,
  gid: number,
): Promise<void> {
  const info = fstatSync(fd, { bigint: true });
  const held = identityFromStat(info);
  if (
    !isRegularMode(info.mode) ||
    info.uid !== BigInt(uid) ||
    info.gid !== BigInt(gid) ||
    (info.mode & 0o777n) !== 0o600n ||
    info.nlink !== 1n ||
    !sameIdentity(held, expected) ||
    !isJournalLockPathIdentity(directoryFd, expected)
  ) {
    fail('lock_path_identity_mismatch');
  }

  const device = linuxDeviceParts(info.dev);
  let lockTable: string;
  try {
    lockTable = readFileSync('/proc/locks', 'utf8');
  } catch {
    fail('journal_lock_state_unavailable');
  }
  const lockHeld = lockTable.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    if (
      fields[1] !== 'FLOCK' ||
      fields[2] !== 'ADVISORY' ||
      fields[3] !== 'WRITE' ||
      fields[4] !== String(process.pid)
    ) {
      return false;
    }
    const [majorHex, minorHex, inodeDecimal] = (fields[5] ?? '').split(':');
    if (!majorHex || !minorHex || !inodeDecimal) return false;
    return (
      BigInt(`0x${majorHex}`) === BigInt(`0x${device.major}`) &&
      BigInt(`0x${minorHex}`) === BigInt(`0x${device.minor}`) &&
      inodeDecimal === info.ino.toString()
    );
  });
  if (!lockHeld) fail('journal_lock_not_held_by_process');
}

export async function readWorkerOwnerStartTime(pid: number): Promise<string> {
  const handle = await open(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return parseStartTime(await handle.readFile({ encoding: 'utf8' }));
  } finally {
    await handle.close();
  }
}

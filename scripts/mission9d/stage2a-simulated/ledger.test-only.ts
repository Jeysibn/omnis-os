import { constants, lstat, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { FakeStage1ValidationAdapter } from './stage1-adapter.test-only.ts';
import {
  LEDGER_MODE,
  sealLedger,
  validateAuthorization,
  validateLedger,
  validateRequest,
  type SimulatedAuthorization,
  type SimulatedLedger,
  type SimulatedLedgerEntry,
  type SimulatedRequest,
} from './schema.test-only.ts';

const LEDGER_NAME = 'stage2a-synthetic-ledger.json';
const MAX_LEDGER_BYTES = 1_048_576;
const locks = new Map<string, Promise<void>>();

export type FaultPoint =
  'after_pending_persisted' | 'after_consumed_rename' | 'after_consumed_persisted';

export interface StoreOptions {
  faultAt?: FaultPoint;
}

export interface SimulatedConsumeResult {
  mode: 'synthetic-only';
  kind: 'simulated_consumed';
  authorizationId: string;
}

async function withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const prior = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = prior.then(() => current);
  locks.set(path, tail);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(path) === tail) locks.delete(path);
  }
}

async function verifyDirectory(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error('storage_missing');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('storage_unsafe');
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error('storage_ownership_invalid');
}

async function readLedger(path: string): Promise<SimulatedLedger> {
  await verifyDirectory(dirname(path));
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error('storage_missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ledger_unsafe');
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
    throw new Error('ledger_ownership_invalid');
  if (stat.size > MAX_LEDGER_BYTES) throw new Error('ledger_oversized');
  try {
    return validateLedger(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    throw new Error('ledger_corrupt');
  }
}

async function persistLedger(
  path: string,
  ledger: SimulatedLedger,
  fault?: (stage: 'after_rename' | 'after_directory_sync') => void,
): Promise<void> {
  await verifyDirectory(dirname(path));
  const temp = join(dirname(path), `.${LEDGER_NAME}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(ledger)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    fault?.('after_rename');
    const directory = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    fault?.('after_directory_sync');
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function exactBinding(authorization: SimulatedAuthorization, request: SimulatedRequest): boolean {
  return (
    authorization.authorizationId === request.authorizationId &&
    authorization.ownerSubjectId === request.ownerSubjectId &&
    authorization.ownerSessionId === request.ownerSessionId &&
    authorization.operationId === request.operationId &&
    authorization.fixtureId === request.fixtureId &&
    authorization.fixtureGeneration === request.fixtureGeneration &&
    authorization.runId === request.runId &&
    authorization.sessionId === request.sessionId &&
    authorization.generation === request.generation &&
    authorization.manifestSha256 === request.manifestSha256 &&
    authorization.attemptId === request.attemptId &&
    authorization.path === request.path &&
    authorization.ordinal === request.ordinal &&
    authorization.controllerPid === request.controllerPid &&
    authorization.controllerStartTimeTicks === request.controllerStartTimeTicks &&
    authorization.journalSequenceDigest === request.journalSequenceDigest &&
    authorization.requestDigest === request.requestDigest &&
    authorization.receiptId === request.receiptId &&
    authorization.bootId === request.bootId &&
    authorization.reservationBootTimeNs === request.reservationBootTimeNs &&
    authorization.deadlineBootTimeNs === request.deadlineBootTimeNs
  );
}

function nextLedger(
  ledger: SimulatedLedger,
  entry: SimulatedLedgerEntry,
  updated: SimulatedLedgerEntry,
): SimulatedLedger {
  return sealLedger({
    schemaVersion: 1,
    mode: LEDGER_MODE,
    sequence: ledger.sequence + 1,
    entries: ledger.entries.map((candidate) =>
      candidate.authorization.authorizationId === entry.authorization.authorizationId
        ? updated
        : candidate,
    ),
  });
}

export async function seedAuthorizationForTests(
  scratchDirectory: string,
  authorizationInput: SimulatedAuthorization,
): Promise<void> {
  const directory = resolve(scratchDirectory);
  await verifyDirectory(directory);
  const authorization = validateAuthorization(authorizationInput);
  const path = join(directory, LEDGER_NAME);
  try {
    await lstat(path);
    throw new Error('ledger_already_exists');
  } catch (error) {
    if (error instanceof Error && error.message === 'ledger_already_exists') throw error;
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw new Error('ledger_unavailable', { cause: error });
  }
  await persistLedger(
    path,
    sealLedger({
      schemaVersion: 1,
      mode: LEDGER_MODE,
      sequence: 0,
      entries: [
        { authorization, state: 'issued', requestId: null, updatedAtNs: authorization.issuedAtNs },
      ],
    }),
  );
}

export class SimulatedLedgerStore {
  readonly #path: string;
  readonly #options: StoreOptions;
  readonly #stage1: FakeStage1ValidationAdapter;
  #poisoned = false;
  #faultUsed = false;

  constructor(
    scratchDirectory: string,
    stage1: FakeStage1ValidationAdapter,
    options: StoreOptions = {},
  ) {
    this.#path = join(resolve(scratchDirectory), LEDGER_NAME);
    this.#stage1 = stage1;
    this.#options = options;
  }

  async read(): Promise<SimulatedLedger> {
    return withPathLock(this.#path, () => readLedger(this.#path));
  }

  async revoke(authorizationId: string, nowNs: string): Promise<void> {
    if (!/^sim-auth:[A-Za-z0-9._:-]{1,128}$/.test(authorizationId))
      throw new Error('invalid_authorization_id');
    if (!/^(0|[1-9][0-9]{0,18})$/.test(nowNs) || BigInt(nowNs) > 9_223_372_036_854_775_807n)
      throw new Error('invalid_revocation_time');
    await withPathLock(this.#path, async () => {
      this.#assertHealthy();
      const ledger = await readLedger(this.#path);
      const entry = ledger.entries.find(
        (item) => item.authorization.authorizationId === authorizationId,
      );
      if (!entry) throw new Error('authorization_missing');
      if (entry.state === 'revoked') return;
      if (entry.state !== 'issued') throw new Error('authorization_not_revocable');
      if (BigInt(nowNs) < BigInt(entry.authorization.issuedAtNs))
        throw new Error('invalid_revocation_time');
      const updated: SimulatedLedgerEntry = { ...entry, state: 'revoked', updatedAtNs: nowNs };
      await this.#persist(nextLedger(ledger, entry, updated));
    });
  }

  async consume(requestInput: SimulatedRequest): Promise<SimulatedConsumeResult> {
    const request = validateRequest(requestInput);
    return withPathLock(this.#path, async () => {
      this.#assertHealthy();
      let ledger = await readLedger(this.#path);
      const entry = ledger.entries.find(
        (item) => item.authorization.authorizationId === request.authorizationId,
      );
      if (!entry) throw new Error('authorization_missing');
      this.#stage1.validate(entry.authorization, request.nowNs);
      if (request.bootId !== entry.authorization.bootId) throw new Error('boot_mismatch');
      if (!exactBinding(entry.authorization, request)) throw new Error('payload_conflict');
      if (entry.state === 'revoked') throw new Error('authorization_revoked');
      if (entry.state === 'pending' || entry.state === 'unknown')
        throw new Error('unknown_outcome');
      if (entry.state === 'consumed') throw new Error('already_consumed');
      const now = BigInt(request.nowNs);
      if (
        now < BigInt(entry.authorization.issuedAtNs) ||
        now >= BigInt(entry.authorization.expiresAtNs)
      )
        throw new Error('authorization_expired');

      const pending: SimulatedLedgerEntry = {
        ...entry,
        state: 'pending',
        requestId: request.requestId,
        updatedAtNs: request.nowNs,
      };
      try {
        ledger = nextLedger(ledger, entry, pending);
        await this.#persist(ledger);
        this.#trip('after_pending_persisted');
        const consumed: SimulatedLedgerEntry = { ...pending, state: 'consumed' };
        ledger = nextLedger(ledger, pending, consumed);
        await this.#persist(ledger, 'after_consumed_rename');
        this.#trip('after_consumed_persisted');
      } catch (error) {
        this.#poisoned = true;
        if (error instanceof Error && error.message === 'simulated_crash') throw error;
        if (error instanceof Error && error.message === 'acknowledgment_lost') throw error;
        if (error instanceof Error && error.message === 'ambiguous_persistence')
          throw new Error('unknown_outcome', { cause: error });
        throw new Error('unknown_outcome', { cause: error });
      }
      return {
        mode: 'synthetic-only',
        kind: 'simulated_consumed',
        authorizationId: request.authorizationId,
      };
    });
  }

  async recover(): Promise<void> {
    await withPathLock(this.#path, async () => {
      const ledger = await readLedger(this.#path);
      const pending = ledger.entries.filter((entry) => entry.state === 'pending');
      if (pending.length === 0) {
        this.#poisoned = false;
        return;
      }
      const updated = ledger.entries.map((entry) =>
        entry.state === 'pending' ? { ...entry, state: 'unknown' as const } : entry,
      );
      this.#poisoned = false;
      try {
        await this.#persist(
          sealLedger({
            schemaVersion: 1,
            mode: LEDGER_MODE,
            sequence: ledger.sequence + 1,
            entries: updated,
          }),
        );
      } catch {
        this.#poisoned = true;
        throw new Error('unknown_outcome');
      }
    });
  }

  async corruptForTests(): Promise<void> {
    await withPathLock(this.#path, () => writeFile(this.#path, '{broken', { mode: 0o600 }));
  }

  #assertHealthy(): void {
    if (this.#poisoned) throw new Error('unknown_outcome');
  }

  #trip(point: FaultPoint): void {
    if (this.#faultUsed || this.#options.faultAt !== point) return;
    this.#faultUsed = true;
    throw new Error(
      point === 'after_consumed_persisted' ? 'acknowledgment_lost' : 'simulated_crash',
    );
  }

  async #persist(ledger: SimulatedLedger, faultPoint?: FaultPoint): Promise<void> {
    await persistLedger(this.#path, ledger, (stage) => {
      if (
        this.#options.faultAt === faultPoint &&
        faultPoint === 'after_consumed_rename' &&
        stage === 'after_rename'
      )
        throw new Error('ambiguous_persistence');
    });
  }
}

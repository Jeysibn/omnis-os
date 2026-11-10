import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  commitDurably,
  loadWorkerJournal,
  openAdmissionController,
  verifyWorkerDirectoryPath,
  writeJournalFile,
  type AdmissionController,
  type DurableWriteOperations,
} from './journal.ts';
import type { ClockAdapter } from './admission.ts';

const scratchRoot = process.env['OMNIS_STAGE1_TEST_ROOT'];
if (!scratchRoot || !scratchRoot.startsWith('/')) {
  throw new Error('OMNIS_STAGE1_TEST_ROOT must name an explicit user-owned scratch directory');
}

const bootId = 'c1111111-1111-4111-8111-111111111111';
const manifestSha256 = 'a'.repeat(64);

function testUid(): number {
  if (typeof process.getuid !== 'function') throw new Error('Linux test process required');
  return process.getuid();
}

function testGid(): number {
  if (typeof process.getgid !== 'function') throw new Error('Linux test process required');
  return process.getgid();
}

function createClock(start = 1_000n): ClockAdapter {
  let now = start;
  return {
    async read() {
      const value = now;
      now += 1n;
      return { bootId, bootTimeNs: value };
    },
  };
}

async function createController(
  clockAdapter: ClockAdapter = createClock(),
  lockWaitSeconds = 5,
): Promise<{ directory: string; controller: AdmissionController }> {
  const directory = await mkdtemp(join(scratchRoot as string, 'mission9d-'));
  const controller = await openAdmissionController({ directory, clockAdapter, lockWaitSeconds });
  return { directory, controller };
}

function sequenceClock(values: bigint[]): ClockAdapter {
  let index = 0;
  return {
    async read() {
      const value = values[Math.min(index, values.length - 1)];
      if (value === undefined) throw new Error('test clock sequence is empty');
      index += 1;
      return { bootId, bootTimeNs: value };
    },
  };
}

async function closeAndRemove(controller: AdmissionController, directory: string): Promise<void> {
  await controller.close();
  await rm(directory, { recursive: true, force: true });
}

function withJournalLock(directory: string, operation: string, argument = ''): string {
  const helper = `
    import { execFileSync } from 'node:child_process';
    import { lstat, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const [operation, directory, argument] = process.argv.slice(1);
    const journal = join(directory, 'journal.json');
    if (operation === 'read') process.stdout.write(await readFile(journal, 'utf8'));
    else if (operation === 'write') await writeFile(journal, argument);
    else if (operation === 'unlink') await unlink(journal);
    else if (operation === 'symlink') {
      const saved = join(directory, 'journal.saved');
      await rename(journal, saved);
      await symlink(saved, journal, 'file');
    } else if (operation === 'fifo') {
      await rename(journal, join(directory, 'journal.saved'));
      execFileSync('/usr/bin/mkfifo', [journal], { stdio: 'ignore' });
    } else if (operation === 'exists') {
      try { await lstat(journal); process.stdout.write('true'); }
      catch (error) { if (error.code === 'ENOENT') process.stdout.write('false'); else throw error; }
    } else if (operation === 'entries') {
      process.stdout.write(JSON.stringify(await readdir(directory)));
    } else throw new Error('invalid test journal operation');
  `;
  const result = spawnSync(
    '/usr/bin/flock',
    [
      '--exclusive',
      '--no-fork',
      '--timeout',
      '5',
      '--conflict-exit-code',
      '75',
      join(directory, 'journal.lock'),
      process.execPath,
      '--input-type=module',
      '-e',
      helper,
      operation,
      directory,
      argument,
    ],
    { encoding: 'utf8', timeout: 7_000, env: { PATH: '/usr/bin:/bin' } },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function readJournalWhileLocked(directory: string): Record<string, unknown> {
  return JSON.parse(withJournalLock(directory, 'read')) as Record<string, unknown>;
}

async function runConcurrentWorkerReservation(
  directory: string,
  session: { id: string; ownerPid: number; ownerStartTimeTicks: string },
  request: { attemptId: string; runId: string; generation: number; path: 'direct' },
): Promise<{ code: number; message: Record<string, unknown> | undefined }> {
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const directoryInfo = await directoryHandle.stat({ bigint: true });
  const lockHandle = await open(
    join(directory, 'journal.lock'),
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  const lockInfo = await lockHandle.stat({ bigint: true });
  const environment = {
    PATH: '/usr/bin:/bin',
    OMNIS_STAGE1_DIRECTORY: directory,
    OMNIS_STAGE1_DIRECTORY_DEV: directoryInfo.dev.toString(),
    OMNIS_STAGE1_DIRECTORY_INO: directoryInfo.ino.toString(),
    OMNIS_STAGE1_LOCK_DEV: lockInfo.dev.toString(),
    OMNIS_STAGE1_LOCK_INO: lockInfo.ino.toString(),
    OMNIS_STAGE1_UID: String(testUid()),
    OMNIS_STAGE1_GID: String(testGid()),
    OMNIS_STAGE1_SESSION_ID: session.id,
    OMNIS_STAGE1_OWNER_PID: String(session.ownerPid),
    OMNIS_STAGE1_OWNER_START_TICKS: session.ownerStartTimeTicks,
  };
  await lockHandle.close();
  const workerPath = fileURLToPath(new URL('./worker.ts', import.meta.url));
  const child = spawn(
    '/usr/bin/flock',
    [
      '--exclusive',
      '--no-fork',
      '--timeout',
      '5',
      '--conflict-exit-code',
      '75',
      '/proc/self/fd/3/journal.lock',
      process.execPath,
      '--experimental-strip-types',
      workerPath,
    ],
    { stdio: ['pipe', 'pipe', 'ignore', directoryHandle.fd], env: environment },
  );
  if (!child.stdin || !child.stdout) throw new Error('concurrent worker stdio unavailable');
  const childInput = child.stdin;

  let clock = 1_005n;
  let message: Record<string, unknown> | undefined;
  const reader = createInterface({ input: child.stdout });
  const protocol = (async () => {
    for await (const line of reader) {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event['type'] === 'need_precommit_clock' || event['type'] === 'need_postcommit_clock') {
        childInput.write(
          `${JSON.stringify({
            type: 'clock',
            reading: { bootId, bootTimeNs: clock.toString() },
          })}\n`,
        );
        clock += 1n;
      } else {
        message = event;
      }
    }
  })();

  childInput.write(
    `${JSON.stringify({
      op: 'reserve',
      sessionId: session.id,
      ownerPid: session.ownerPid,
      ownerStartTimeTicks: session.ownerStartTimeTicks,
      initialClock: { bootId, bootTimeNs: '1004' },
      request,
    })}\n`,
  );
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });
  await protocol;
  await directoryHandle.close();
  return { code, message };
}

async function waitForMarker(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).then((handle) => handle.close());
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('interruption marker deadline exceeded');
}

async function interruptReservationProcess(directory: string, pauseAtRead: number): Promise<void> {
  const marker = join(scratchRoot as string, `mission9d-interrupt-${process.pid}-${pauseAtRead}`);
  const moduleUrl = new URL('./journal.ts', import.meta.url).href;
  const script = `
    import { writeFile } from 'node:fs/promises';
    const { openAdmissionController } = await import(${JSON.stringify(moduleUrl)});
    let reads = 0;
    const controller = await openAdmissionController({
      directory: process.env.OMNIS_TEST_DIR,
      clockAdapter: { async read() {
        reads += 1;
        if (reads === Number(process.env.OMNIS_PAUSE_AT_READ)) {
          await writeFile(process.env.OMNIS_TEST_MARKER, 'reached');
          setInterval(() => {}, 1_000);
          await new Promise(() => {});
        }
        return { bootId: '${bootId}', bootTimeNs: BigInt(1000 + reads) };
      } },
    });
    await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256: '${manifestSha256}',
    });
    await controller.reserve({
      attemptId: 'e1111111-1111-4111-8111-111111111111',
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      path: 'direct',
    });
  `;
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        OMNIS_TEST_DIR: directory,
        OMNIS_TEST_MARKER: marker,
        OMNIS_PAUSE_AT_READ: String(pauseAtRead),
      },
    },
  );
  const closed = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve(status ?? (signal === 'SIGKILL' ? 137 : 1)));
  });
  let ended = false;
  try {
    await waitForMarker(marker);
    child.kill('SIGKILL');
    const code = await closed;
    ended = true;
    assert.equal(code, 137);
  } finally {
    if (!ended) {
      child.kill('SIGKILL');
      await closed.catch(() => undefined);
    }
    await rm(marker, { force: true });
  }
}

test('atomically admits three attempts under concurrent requests and rejects the fourth', async () => {
  const { directory, controller } = await createController();
  try {
    await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        controller.reserve({
          attemptId: `e1111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
          runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
          generation: 1,
          path: 'direct',
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 5);
    const state = await controller.read();
    assert.equal(state.attemptCounts.direct, 3);
    assert.equal(state.reservations.length, 3);
  } finally {
    await closeAndRemove(controller, directory);
  }
});

test('independent worker processes serialize reservations without lost updates', async () => {
  const { directory, controller } = await createController();
  try {
    const initialized = await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runConcurrentWorkerReservation(directory, initialized.session, {
          attemptId: `e1111111-1111-4111-8111-${String(index + 101).padStart(12, '0')}`,
          runId: initialized.runId,
          generation: initialized.generation,
          path: 'direct',
        }),
      ),
    );
    const committed = results.filter((result) => result.message?.['type'] === 'result');
    const denied = results.filter((result) => result.message?.['code'] === 'attempt_limit');
    assert.equal(committed.length, 3);
    assert.equal(denied.length, 5);
    assert.ok(results.every((result) => result.code === 0 || result.code === 1));

    const state = await controller.read();
    assert.equal(state.attemptCounts.direct, 3);
    assert.equal(state.reservations.length, 3);
    assert.deepEqual(
      state.reservations.map((reservation) => reservation.ordinal).sort(),
      [1, 2, 3],
    );
  } finally {
    await closeAndRemove(controller, directory);
  }
});

test('identical retries do not create a second reservation or receipt', async () => {
  const { directory, controller } = await createController();
  try {
    await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256,
    });
    const request = {
      attemptId: 'e1111111-1111-4111-8111-111111111111',
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      path: 'direct' as const,
    };
    const first = await controller.reserve(request);
    const duplicate = await controller.reserve(request);
    assert.equal(first.kind, 'reserved');
    assert.equal(duplicate.kind, 'already_reserved');
    assert.equal(duplicate.attemptId, request.attemptId);
    assert.equal('receipt' in duplicate, false);
    assert.equal('reservation' in duplicate, false);
    assert.equal((await controller.read()).attemptCounts.direct, 1);
    await assert.rejects(
      () => controller.reserve({ ...request, path: 'windows' }),
      /idempotency_conflict/,
    );
  } finally {
    await closeAndRemove(controller, directory);
  }
});

test('event recording shares the journal lock and rejects duplicate event IDs', async () => {
  const { directory, controller } = await createController();
  try {
    await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256,
    });
    const event = {
      eventId: 'f1111111-1111-4111-8111-111111111111',
      eventType: 'reservation.checked',
    };
    const recorded = await controller.record(event);
    assert.equal(recorded.eventId, event.eventId);
    assert.equal((await controller.read()).events.length, 1);
    await assert.rejects(() => controller.record(event), /duplicate_event_id/);
  } finally {
    await closeAndRemove(controller, directory);
  }
});

test('a new controller cannot resume a previously claimed run session', async () => {
  const { directory, controller } = await createController();
  await controller.initialize({
    runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
    generation: 1,
    manifestSha256,
  });
  await controller.close();

  const restarted = await openAdmissionController({ directory, clockAdapter: createClock() });
  try {
    await assert.rejects(
      () =>
        restarted.initialize({
          runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
          generation: 1,
          manifestSha256,
        }),
      /session_terminal/,
    );
  } finally {
    await closeAndRemove(restarted, directory);
  }
});

test('corrupt journals fail closed and are never initialized over', async () => {
  const { directory, controller } = await createController();
  await controller.initialize({
    runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
    generation: 1,
    manifestSha256,
  });
  await controller.close();
  withJournalLock(directory, 'write', '{corrupt');

  const reopened = await openAdmissionController({ directory, clockAdapter: createClock() });
  try {
    await assert.rejects(
      () =>
        reopened.initialize({
          runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
          generation: 1,
          manifestSha256,
        }),
      /corrupt_journal/,
    );
  } finally {
    await closeAndRemove(reopened, directory);
  }
});

test('a missing journal after prior initialization cannot reset the run', async () => {
  const { directory, controller } = await createController();
  await controller.initialize({
    runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
    generation: 1,
    manifestSha256,
  });
  await controller.close();
  withJournalLock(directory, 'unlink');

  const reopened = await openAdmissionController({ directory, clockAdapter: createClock() });
  try {
    await assert.rejects(
      () =>
        reopened.initialize({
          runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
          generation: 1,
          manifestSha256,
        }),
      /missing_journal/,
    );
  } finally {
    await closeAndRemove(reopened, directory);
  }
});

test('FIFO journal entries fail closed without blocking', { timeout: 2_000 }, async () => {
  const { directory, controller } = await createController();
  await controller.initialize({
    runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
    generation: 1,
    manifestSha256,
  });
  await controller.close();
  withJournalLock(directory, 'fifo');

  const reopened = await openAdmissionController({ directory, clockAdapter: createClock() });
  try {
    await assert.rejects(
      () =>
        reopened.initialize({
          runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
          generation: 1,
          manifestSha256,
        }),
      /unsafe_file_owner_or_type/,
    );
  } finally {
    await closeAndRemove(reopened, directory);
  }
});

test('clock adapters must return an exact bounded bigint reading', async () => {
  for (const bootTimeNs of [
    1_000,
    '1000',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    9_223_372_036_854_775_808n,
  ]) {
    const badClock = {
      async read() {
        return { bootId, bootTimeNs };
      },
    } as unknown as ClockAdapter;
    const { directory, controller } = await createController(badClock);
    try {
      await assert.rejects(
        () =>
          controller.initialize({
            runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
            generation: 1,
            manifestSha256,
          }),
        /clock_unavailable_or_invalid/,
      );
      assert.equal(withJournalLock(directory, 'exists'), 'false');
    } finally {
      await closeAndRemove(controller, directory);
    }
  }
});

test('symlinked journal entries fail closed', async () => {
  const { directory, controller } = await createController();
  await controller.initialize({
    runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
    generation: 1,
    manifestSha256,
  });
  await controller.close();
  withJournalLock(directory, 'symlink');

  const reopened = await openAdmissionController({ directory, clockAdapter: createClock() });
  try {
    await assert.rejects(() =>
      reopened.initialize({
        runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
        generation: 1,
        manifestSha256,
      }),
    );
  } finally {
    await closeAndRemove(reopened, directory);
  }
});

test('durability failures never acknowledge a committed receipt', async () => {
  const stages: Array<keyof DurableWriteOperations> = [
    'writeTemp',
    'syncTemp',
    'verifyBeforeReplace',
    'renameJournal',
    'syncDirectory',
    'verifyAfterSync',
  ];

  for (const failingStage of stages) {
    const called: string[] = [];
    const operations: DurableWriteOperations = {
      async writeTemp() {
        called.push('writeTemp');
        if (failingStage === 'writeTemp') throw new Error('injected');
      },
      async syncTemp() {
        called.push('syncTemp');
        if (failingStage === 'syncTemp') throw new Error('injected');
      },
      async verifyBeforeReplace() {
        called.push('verifyBeforeReplace');
        if (failingStage === 'verifyBeforeReplace') throw new Error('injected');
      },
      async renameJournal() {
        called.push('renameJournal');
        if (failingStage === 'renameJournal') throw new Error('injected');
      },
      async syncDirectory() {
        called.push('syncDirectory');
        if (failingStage === 'syncDirectory') throw new Error('injected');
      },
      async verifyAfterSync() {
        called.push('verifyAfterSync');
        if (failingStage === 'verifyAfterSync') throw new Error('injected');
      },
    };
    await assert.rejects(() => commitDurably(operations));
    assert.equal(called.at(-1), failingStage);
  }
});

test(
  'real filesystem rename and directory-fsync failures never return a receipt',
  { timeout: 10_000 },
  async () => {
    const { directory, controller } = await createController();
    try {
      const state = await controller.initialize({
        runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
        generation: 1,
        manifestSha256,
      });
      await controller.close();
      const nextState = {
        ...state,
        events: [
          {
            eventId: 'f1111111-1111-4111-8111-111111111111',
            eventType: 'reservation.checked',
            recordedAtBootTimeNs: '1001',
          },
        ],
      };

      const helper = `
      import { constants, openSync, closeSync } from 'node:fs';
      import { mkdir, open, rename, rmdir } from 'node:fs/promises';
      import { join } from 'node:path';
      const moduleUrl = ${JSON.stringify(new URL('./journal.ts', import.meta.url).href)};
      const nextState = ${JSON.stringify(nextState)};
      const { loadWorkerJournal, verifyWorkerDirectoryPath, writeJournalFile } = await import(moduleUrl);
      const [directory, stage] = process.argv.slice(1);
      const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const lock = await open(join(directory, 'journal.lock'), constants.O_RDWR | constants.O_NOFOLLOW);
      const dirInfo = await dir.stat({ bigint: true });
      const lockInfo = await lock.stat({ bigint: true });
      const uid = process.getuid();
      const gid = process.getgid();
      const lockIdentity = { dev: lockInfo.dev.toString(), ino: lockInfo.ino.toString() };
      const secureDirectory = await verifyWorkerDirectoryPath(directory, uid, gid, {
        dev: dirInfo.dev.toString(), ino: dirInfo.ino.toString()
      });
      let state;
      let journalIdentity;
      try {
        ({ state, identity: journalIdentity } = await loadWorkerJournal(dir.fd, lock.fd, lockIdentity, uid, gid));
        if (stage === 'file-fsync') {
          const probe = await open('/dev/null', constants.O_RDONLY);
          const handlePrototype = Object.getPrototypeOf(probe);
          const originalSync = handlePrototype.sync;
          await probe.close();
          handlePrototype.sync = async function() {
            await this.close();
            return originalSync.call(this);
          };
        }
        let directoryFd = dir.fd;
        if (stage === 'directory-fsync') {
          await dir.close();
          directoryFd = openSync(directory, 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        }
        try {
          await writeJournalFile(
            secureDirectory, directoryFd, lock.fd, lockIdentity, uid, gid,
            journalIdentity, nextState,
            async () => {
              if (stage === 'rename') {
                await rename(join(directory, 'journal.json'), join(directory, 'journal.saved'));
                await mkdir(join(directory, 'journal.json'));
              }
              return { bootId: '${bootId}', bootTimeNs: 1001n };
            },
            async () => ({ bootId: '${bootId}', bootTimeNs: 1002n }),
          );
          process.stdout.write('RECEIPT');
        } catch (error) {
          process.stdout.write('NO_RECEIPT:' + (error instanceof Error ? error.message : String(error)));
        } finally {
          if (stage === 'directory-fsync') closeSync(directoryFd);
          else await dir.close();
        }
      } finally {
        if (stage === 'rename') {
          await rmdir(join(directory, 'journal.json')).catch(() => undefined);
          await rename(join(directory, 'journal.saved'), join(directory, 'journal.json')).catch(() => undefined);
        }
        await secureDirectory.handle.close();
        await lock.close();
      }
    `;

      for (const stage of ['file-fsync', 'rename', 'directory-fsync'] as const) {
        const result = spawnSync(
          '/usr/bin/flock',
          [
            '--exclusive',
            '--no-fork',
            '--timeout',
            '5',
            '--conflict-exit-code',
            '75',
            join(directory, 'journal.lock'),
            process.execPath,
            '--experimental-strip-types',
            '--input-type=module',
            '-e',
            helper,
            directory,
            stage,
          ],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000, env: { PATH: '/usr/bin:/bin' } },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^NO_RECEIPT:/, `${stage} unexpectedly returned a receipt`);
        if (stage === 'rename') {
          assert.equal(withJournalLock(directory, 'exists'), 'true');
          const persisted = readJournalWhileLocked(directory) as { events: unknown[] };
          assert.equal(persisted.events.length, 0);
        } else if (stage === 'directory-fsync') {
          const persisted = readJournalWhileLocked(directory) as { events: unknown[] };
          assert.equal(persisted.events.length, 1);
        } else {
          const persisted = readJournalWhileLocked(directory) as { events: unknown[] };
          assert.equal(persisted.events.length, 0);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('lock contention fails closed without stealing or poisoning the journal', async () => {
  const { directory, controller } = await createController(createClock(), 1);
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256,
    });
    holder = spawn(
      '/usr/bin/flock',
      [
        '--exclusive',
        '--no-fork',
        join(directory, 'journal.lock'),
        process.execPath,
        '-e',
        'process.stdout.write("lock-held\\n"); process.stdin.resume()',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    if (!holder.stdout) throw new Error('lock holder stdout unavailable');
    await once(holder.stdout, 'data');
    await assert.rejects(() => controller.read(), /lock_busy/);
    holder.kill('SIGTERM');
    await once(holder, 'close');
    assert.equal((await controller.read()).runId, '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd');
  } finally {
    holder?.kill('SIGTERM');
    await closeAndRemove(controller, directory);
  }
});

test('journal storage rejects unlocked reads and writes at its boundary', async () => {
  const { directory, controller } = await createController();
  const state = await controller.initialize({
    runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
    generation: 1,
    manifestSha256,
  });
  await controller.close();

  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const lockHandle = await open(
    join(directory, 'journal.lock'),
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  const directoryInfo = await directoryHandle.stat({ bigint: true });
  const lockInfo = await lockHandle.stat({ bigint: true });
  const lockIdentity = { dev: lockInfo.dev.toString(), ino: lockInfo.ino.toString() };
  const secureDirectory = await verifyWorkerDirectoryPath(directory, testUid(), testGid(), {
    dev: directoryInfo.dev.toString(),
    ino: directoryInfo.ino.toString(),
  });
  try {
    await assert.rejects(
      () =>
        loadWorkerJournal(directoryHandle.fd, lockHandle.fd, lockIdentity, testUid(), testGid()),
      /journal_lock_not_held_by_process/,
    );
    await assert.rejects(
      () =>
        writeJournalFile(
          secureDirectory,
          directoryHandle.fd,
          lockHandle.fd,
          lockIdentity,
          testUid(),
          testGid(),
          { dev: '0', ino: '0' },
          state,
          async () => ({ bootId, bootTimeNs: 1_001n }),
          async () => ({ bootId, bootTimeNs: 1_002n }),
        ),
      /journal_lock_not_held_by_process/,
    );
  } finally {
    await secureDirectory.handle.close();
    await lockHandle.close();
    await directoryHandle.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('symlinked state directories are rejected', async () => {
  const target = await mkdtemp(join(scratchRoot as string, 'mission9d-target-'));
  const link = join(scratchRoot as string, `mission9d-link-${process.pid}-${Date.now()}`);
  try {
    await symlink(target, link, 'dir');
    await assert.rejects(() =>
      openAdmissionController({ directory: link, clockAdapter: createClock() }),
    );
  } finally {
    await rm(link, { force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('deadline expiry before replacement produces no reservation', async () => {
  const deadline = 720_000_001_000n;
  const clock = sequenceClock([1_000n, 1_001n, 1_002n, 1_003n, 1_004n, deadline]);
  const { directory, controller } = await createController(clock);
  try {
    await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256,
    });
    await assert.rejects(
      () =>
        controller.reserve({
          attemptId: 'e1111111-1111-4111-8111-111111111111',
          runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
          generation: 1,
          path: 'direct',
        }),
      /deadline_expired/,
    );
    const state = readJournalWhileLocked(directory) as {
      attemptCounts: { direct: number };
    };
    assert.equal(state.attemptCounts.direct, 0);
    assert.equal(
      (JSON.parse(withJournalLock(directory, 'entries')) as string[]).some(
        (name) => name.startsWith('.journal-') && name.endsWith('.tmp'),
      ),
      true,
    );
    assert.equal(withJournalLock(directory, 'exists'), 'true');
  } finally {
    await closeAndRemove(controller, directory);
  }
});

test('expiry after durable commit returns no receipt and leaves the attempt consumed', async () => {
  const deadline = 720_000_001_000n;
  const clock = sequenceClock([1_000n, 1_001n, 1_002n, 1_003n, 1_004n, 1_005n, deadline]);
  const { directory, controller } = await createController(clock);
  try {
    await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256,
    });
    await assert.rejects(
      () =>
        controller.reserve({
          attemptId: 'e1111111-1111-4111-8111-111111111111',
          runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
          generation: 1,
          path: 'direct',
        }),
      /deadline_expired/,
    );
    const state = readJournalWhileLocked(directory) as {
      attemptCounts: { direct: number };
      reservations: Array<{ receiptId: string }>;
    };
    assert.equal(state.attemptCounts.direct, 1);
    assert.equal(state.reservations.length, 1);
    assert.match(state.reservations[0]?.receiptId ?? '', /^[0-9a-f-]{36}$/);
  } finally {
    await closeAndRemove(controller, directory);
  }
});

test('expiry after unlock returns no receipt and keeps the committed attempt consumed', async () => {
  const deadline = 720_000_001_000n;
  const clock = sequenceClock([1_000n, 1_001n, 1_002n, 1_003n, 1_004n, 1_005n, 1_006n, deadline]);
  const { directory, controller } = await createController(clock);
  try {
    await controller.initialize({
      runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
      generation: 1,
      manifestSha256,
    });
    await assert.rejects(
      () =>
        controller.reserve({
          attemptId: 'e1111111-1111-4111-8111-111111111111',
          runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
          generation: 1,
          path: 'direct',
        }),
      /clock_invalid_or_expired_after_unlock/,
    );
    const state = readJournalWhileLocked(directory) as {
      attemptCounts: { direct: number };
    };
    assert.equal(state.attemptCounts.direct, 1);
  } finally {
    await closeAndRemove(controller, directory);
  }
});

test('a different process cannot resume a run after its owner exits', async () => {
  const directory = await mkdtemp(join(scratchRoot as string, 'mission9d-owner-'));
  const moduleUrl = new URL('./journal.ts', import.meta.url).href;
  const script = `
    const { openAdmissionController } = await import(${JSON.stringify(moduleUrl)});
    const c = await openAdmissionController({
      directory: process.env.OMNIS_TEST_DIR,
      clockAdapter: { async read() { return { bootId: 'c1111111-1111-4111-8111-111111111111', bootTimeNs: 1000n }; } }
    });
    await c.initialize({ runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd', generation: 1, manifestSha256: '${manifestSha256}' });
    await c.close();
  `;
  try {
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        env: { PATH: '/usr/bin:/bin', OMNIS_TEST_DIR: directory },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const restarted = await openAdmissionController({ directory, clockAdapter: createClock() });
    try {
      await assert.rejects(
        () =>
          restarted.initialize({
            runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
            generation: 1,
            manifestSha256,
          }),
        /session_terminal/,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'abrupt owner interruption leaves a terminal, verifiable journal state',
  { timeout: 20_000 },
  async () => {
    for (const [pauseAtRead, expectedAttempts] of [
      [6, 0],
      [8, 1],
    ] as const) {
      const directory = await mkdtemp(join(scratchRoot as string, 'mission9d-interruption-'));
      try {
        await interruptReservationProcess(directory, pauseAtRead);
        const state = readJournalWhileLocked(directory) as {
          attemptCounts: { direct: number };
        };
        assert.equal(state.attemptCounts.direct, expectedAttempts);

        const recovered = await openAdmissionController({ directory, clockAdapter: createClock() });
        try {
          await assert.rejects(
            () =>
              recovered.initialize({
                runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
                generation: 1,
                manifestSha256,
              }),
            /session_terminal/,
          );
        } finally {
          await recovered.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from '../../apps/worker/node_modules/pg-boss/dist/index.js';
import { createPool, PostgresRunStore } from '../../packages/db/src/index.ts';
import { provisionDatabaseRoles } from '../../packages/db/src/provision-roles.ts';
import { metricsQuery } from '../../scripts/db-recovery/metrics.mjs';

const legacyRevision = '708d0f5e9b6083da852e26c0643c60c0f5879f85';
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const adminUrl = process.env.OMNIS_TEST_ADMIN_DATABASE_URL;
if (!adminUrl)
  throw new Error('Set OMNIS_TEST_ADMIN_DATABASE_URL for the disposable upgrade drill.');
const adminBase = new URL(adminUrl);
if (adminBase.username !== 'omnis' || !/(?:^|[_-])tests?$/i.test(adminBase.pathname.slice(1))) {
  throw new Error('The legacy upgrade drill requires the disposable omnis test administrator URL.');
}
const migrationBase = process.env.OMNIS_TEST_MIGRATION_DATABASE_URL;
const runtimeBase = process.env.OMNIS_TEST_DATABASE_URL;
if (!migrationBase || !runtimeBase) {
  throw new Error('Set test migration and runtime database URLs for the legacy upgrade drill.');
}
if (
  new URL(migrationBase).username !== 'omnis_migrator' ||
  new URL(runtimeBase).username !== 'omnis_runtime'
) {
  throw new Error(
    'Legacy upgrade credentials must use the restricted migration and runtime roles.',
  );
}
const migrationPassword = decodeURIComponent(new URL(migrationBase).password);
const runtimePassword = decodeURIComponent(new URL(runtimeBase).password);

const suffix = `${process.pid}_${Date.now().toString(36)}`.toLowerCase();
const databaseName = `omnis_legacy_upgrade_${suffix}`;
const databaseUrl = databaseUrlFor('omnis_runtime', runtimePassword);
const migrationUrl = databaseUrlFor('omnis_migrator', migrationPassword);
const clusterAdminPool = createPool(adminUrl);
const databaseAdminPool = createPool(
  databaseUrlFor('omnis', decodeURIComponent(adminBase.password)),
);
const legacyPool = createPool(databaseUrlFor('omnis', decodeURIComponent(adminBase.password)));
const runtimePool = createPool(databaseUrl);
const migrationPool = createPool(migrationUrl);
const legacyWorktree = await mkdtemp(join(tmpdir(), 'omnis-r1-legacy-worktree-'));
let legacyBoss;
let runtimeBoss;
let worker;
let workerLogs = '';
let createdDatabase = false;

try {
  await makeLegacyWorktree();
  await clusterAdminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  createdDatabase = true;

  const legacyDatabase = await import(
    pathToFileURL(join(legacyWorktree, 'packages/db/src/index.ts')).href
  );
  await legacyDatabase.migrate(legacyPool);
  legacyBoss = new PgBoss({
    connectionString: legacyPool.options.connectionString,
    schema: 'pgboss',
    supervise: false,
  });
  await legacyBoss.start({ attempts: 3 });
  await legacyBoss.createQueue('omnis-mock-run', { retryLimit: 0, retryDelay: 0 });

  await legacyPool.query(`
    CREATE TYPE omnis.legacy_marker AS ENUM ('created', 'preserved');
    CREATE FUNCTION omnis.legacy_identity(value integer)
      RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT value';
  `);

  const legacyStore = new legacyDatabase.PostgresRunStore(legacyPool);
  const legacyTask = await legacyStore.createTask({
    title: 'Legacy upgrade fixture',
    detail: 'Created by the implementation at the audited R1 revision.',
  });
  const legacyAdmission = await legacyStore.admitRun(
    legacyTask.id,
    `legacy-upgrade-${suffix}`,
    (db, data) =>
      legacyBoss.send('omnis-mock-run', data, {
        retryLimit: 0,
        retryDelay: 0,
        expireInSeconds: 60,
        heartbeatSeconds: 10,
        db,
      }),
  );
  const legacyRun = legacyAdmission.run;
  const beforeUpgrade = (await databaseAdminPool.query(metricsQuery)).rows[0].json_build_object;
  assert.equal(beforeUpgrade.tasks, 1);
  assert.equal(beforeUpgrade.runs, 1);
  assert.equal(beforeUpgrade.events, 1);
  assert.equal(beforeUpgrade.idempotencyRecords, 1);
  assert.equal(beforeUpgrade.unsafeRunStates, 1);

  await legacyBoss.stop();
  legacyBoss = undefined;

  await provisionDatabaseRoles(databaseAdminPool, {
    migration: migrationPassword,
    runtime: runtimePassword,
  });
  await runCurrentMigration();
  await applyRestrictedPgBossMigrations();

  const afterUpgrade = (await databaseAdminPool.query(metricsQuery)).rows[0].json_build_object;
  assert.deepEqual(afterUpgrade.recordFingerprints, beforeUpgrade.recordFingerprints);
  assert.deepEqual(afterUpgrade.migrations, [
    '0001_initial',
    '0002_runtime_grants',
    '0003_runtime_privileges',
    '0004_narrow_runtime_sequence_defaults',
  ]);
  assert.equal(afterUpgrade.unsafeRunStates, 1);
  assert.equal(
    (
      await databaseAdminPool.query(
        "SELECT checksum FROM omnis.schema_migrations WHERE id = '0001_initial'",
      )
    ).rows[0].checksum.length,
    64,
  );

  const ownership = await databaseAdminPool.query(`
    SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('omnis', 'pgboss') AND c.relkind IN ('r', 'p', 'S')
          AND c.relowner <> 'omnis_migrator'::regrole) AS relations,
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname IN ('omnis', 'pgboss') AND t.typrelid = 0 AND t.typelem = 0
          AND t.typisdefined AND t.typtype IN ('d', 'e', 'r', 'm')
          AND t.typowner <> 'omnis_migrator'::regrole) AS user_types,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('omnis', 'pgboss')
          AND p.prokind IN ('f', 'p', 'a', 'w')
          AND p.proowner <> 'omnis_migrator'::regrole) AS routines
  `);
  assert.deepEqual(ownership.rows[0], { relations: '0', user_types: '0', routines: '0' });
  assert.equal(
    (await databaseAdminPool.query("SELECT 'preserved'::omnis.legacy_marker AS marker")).rows[0]
      .marker,
    'preserved',
  );
  assert.equal(
    (await runtimePool.query('SELECT omnis.legacy_identity(42) AS value')).rows[0].value,
    42,
  );
  await assert.rejects(
    runtimePool.query("SELECT * FROM omnis.schema_migrations WHERE id = '0001_initial'"),
    /permission denied/,
  );

  runtimeBoss = new PgBoss({
    connectionString: databaseUrl,
    schema: 'pgboss',
    supervise: false,
    migrate: false,
    createSchema: false,
  });
  await runtimeBoss.start({ attempts: 3 });
  await runtimeBoss.createQueue('omnis-mock-run', { retryLimit: 0, retryDelay: 0 });

  worker = await startRestrictedWorker();
  const migratedStore = new PostgresRunStore(runtimePool);
  await waitForRun(migratedStore, legacyRun.id, 'completed');
  const completedLegacyEvents = await migratedStore.getEvents(legacyRun.id);
  assert.equal(completedLegacyEvents[0]?.type, 'run.queued');
  assert.equal(completedLegacyEvents.at(-1)?.type, 'run.completed');
  const queueState = await runtimePool.query('SELECT state FROM pgboss.job WHERE id = $1::uuid', [
    (
      await databaseAdminPool.query('SELECT pg_boss_job_id FROM omnis.runs WHERE id = $1', [
        legacyRun.id,
      ])
    ).rows[0].pg_boss_job_id,
  ]);
  assert.equal(queueState.rows[0]?.state, 'completed');

  const newTask = await migratedStore.createTask({
    title: 'Post-upgrade runtime task',
    detail: 'Verify current restricted runtime inserts after legacy conversion.',
  });
  const newRun = await migratedStore.admitRun(newTask.id, `current-upgrade-${suffix}`, (db, data) =>
    runtimeBoss.send('omnis-mock-run', data, {
      retryLimit: 0,
      retryDelay: 0,
      expireInSeconds: 60,
      heartbeatSeconds: 10,
      db,
    }),
  );
  await waitForRun(migratedStore, newRun.run.id, 'completed');

  process.stdout.write(
    `Legacy upgrade passed from ${legacyRevision}: pre-migration records preserved, role ownership normalized, migration checksums upgraded, restricted pg-boss and worker operations completed, and post-upgrade task/run creation succeeded in ${databaseName}.\n`,
  );
} finally {
  await stopWorker(worker);
  await runtimeBoss?.stop().catch(() => undefined);
  await legacyBoss?.stop().catch(() => undefined);
  await Promise.all([
    migrationPool.end(),
    runtimePool.end(),
    legacyPool.end(),
    databaseAdminPool.end(),
    clusterAdminPool.end(),
  ]);
  if (createdDatabase) {
    const cleanupPool = createPool(adminUrl);
    await cleanupPool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
    await cleanupPool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await cleanupPool.end();
  }
  await removeLegacyWorktree();
}

async function makeLegacyWorktree() {
  const present = spawnSync('git', ['cat-file', '-e', `${legacyRevision}^{commit}`], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  });
  if (present.status !== 0) {
    const fetched = spawnSync(
      'git',
      ['fetch', '--no-tags', '--depth=1', 'origin', legacyRevision],
      {
        cwd: repositoryRoot,
        stdio: 'ignore',
      },
    );
    if (fetched.status !== 0)
      throw new Error('Could not fetch the audited legacy source revision.');
  }
  const added = spawnSync('git', ['worktree', 'add', '--detach', legacyWorktree, legacyRevision], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (added.status !== 0) throw new Error('Could not create the isolated legacy source worktree.');
  await symlink(join(repositoryRoot, 'node_modules'), join(legacyWorktree, 'node_modules'), 'dir');
  for (const workspace of [
    'apps/api',
    'apps/worker',
    'apps/web',
    'packages/contracts',
    'packages/db',
    'packages/policy',
    'packages/runtime-adapters',
  ]) {
    await symlink(
      join(repositoryRoot, workspace, 'node_modules'),
      join(legacyWorktree, workspace, 'node_modules'),
      'dir',
    );
  }
}

async function removeLegacyWorktree() {
  spawnSync('git', ['worktree', 'remove', '--force', legacyWorktree], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  });
  await rm(legacyWorktree, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: repositoryRoot, stdio: 'ignore' });
}

async function runCurrentMigration() {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'apps/worker/src/migrate.ts'],
    {
      cwd: repositoryRoot,
      env: { ...process.env, OMNIS_MIGRATION_DATABASE_URL: migrationUrl },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Restricted-role application migration failed (${result.status ?? 'unknown'}).`,
    );
  }
}

async function applyRestrictedPgBossMigrations() {
  const migratorBoss = new PgBoss({
    connectionString: migrationUrl,
    schema: 'pgboss',
    supervise: false,
    migrate: true,
    createSchema: false,
  });
  try {
    await migratorBoss.start({ attempts: 3 });
    await migratorBoss.createQueue('omnis-mock-run', { retryLimit: 0, retryDelay: 0 });
  } finally {
    await migratorBoss.stop().catch(() => undefined);
  }
}

async function startRestrictedWorker() {
  const port = await freePort();
  const internalToken = randomBytes(64).toString('hex');
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: join(repositoryRoot, 'apps/worker'),
    env: {
      ...workerEnvironment(),
      NODE_ENV: 'test',
      OMNIS_DATABASE_URL: databaseUrl,
      OMNIS_INTERNAL_TOKEN: internalToken,
      OMNIS_WORKER_HOST: '127.0.0.1',
      OMNIS_WORKER_PORT: String(port),
      OMNIS_MOCK_TEST_DELAY_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      workerLogs = `${workerLogs}${chunk.toString('utf8')}`.slice(-64_000);
    });
  }
  const healthUrl = `http://127.0.0.1:${port}/internal/v1/health`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `Restricted worker exited during legacy upgrade (${child.exitCode}). ${sanitize(workerLogs)}`,
      );
    }
    try {
      const response = await fetch(healthUrl, {
        headers: { 'x-omnis-internal-token': internalToken },
      });
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.runtimeKind, 'mock');
        assert.equal(health.synthetic, true);
        assert.equal(health.persistence, 'postgresql');
        return child;
      }
    } catch {
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await delay(250);
  }
  await stopWorker(child);
  throw new Error(
    `Restricted worker did not become healthy. Captured output: ${sanitize(workerLogs)}`,
  );
}

async function waitForRun(store, runId, expectedStatus) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const run = await store.getRun(runId);
    if (run?.status === expectedStatus) return run;
    if (run && ['failed', 'interrupted', 'cancelled'].includes(run.status)) {
      throw new Error(`Legacy upgrade run ended in ${run.status}.`);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the migrated mock run to become ${expectedStatus}.`);
}

async function stopWorker(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(5_000).then(() => child.kill('SIGKILL')),
  ]);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

function databaseUrlFor(username, password) {
  const url = new URL(adminUrl);
  url.username = username;
  url.password = password;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function workerEnvironment() {
  const environment = { ...process.env };
  for (const key of [
    'OMNIS_ADMIN_DATABASE_URL',
    'OMNIS_MIGRATION_DATABASE_URL',
    'OMNIS_MIGRATION_DB_PASSWORD',
    'OMNIS_DB_PASSWORD',
    'OMNIS_RUNTIME_DB_PASSWORD',
    'OMNIS_TEST_ADMIN_DATABASE_URL',
    'OMNIS_TEST_MIGRATION_DATABASE_URL',
    'OMNIS_TEST_DATABASE_URL',
  ]) {
    delete environment[key];
  }
  return environment;
}

function sanitize(output) {
  return output.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database URL redacted]');
}

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from '../../apps/worker/node_modules/pg-boss/dist/index.js';
import {
  createPool,
  migrate,
  PostgresAuthorizationStore,
  PostgresRunStore,
} from '../../packages/db/src/index.ts';
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
const authorizerBase = process.env.OMNIS_TEST_AUTHORIZER_DATABASE_URL;
const launcherBase = process.env.OMNIS_TEST_LAUNCHER_DATABASE_URL;
if (!migrationBase || !runtimeBase || !authorizerBase || !launcherBase) {
  throw new Error(
    'Set test migration, runtime, and authorizer database URLs for the legacy upgrade drill.',
  );
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
const authorizerPassword = decodeURIComponent(new URL(authorizerBase).password);
const launcherPassword = decodeURIComponent(new URL(launcherBase).password);

const suffix = `${process.pid}_${Date.now().toString(36)}`.toLowerCase();
const databaseName = `omnis_legacy_upgrade_${suffix}`;
const databaseUrl = databaseUrlFor('omnis_runtime', runtimePassword);
const migrationUrl = databaseUrlFor('omnis_migrator', migrationPassword);
const authorizerUrl = databaseUrlFor('omnis_authorizer', authorizerPassword);
const launcherUrl = databaseUrlFor('omnis_launcher', launcherPassword);
const clusterAdminPool = createPool(adminUrl);
const databaseAdminPool = createPool(
  databaseUrlFor('omnis', decodeURIComponent(adminBase.password)),
);
const legacyPool = createPool(databaseUrlFor('omnis', decodeURIComponent(adminBase.password)));
const runtimePool = createPool(databaseUrl);
const migrationPool = createPool(migrationUrl);
const authorizerPool = createPool(authorizerUrl);
const launcherPool = createPool(launcherUrl);
const legacyWorktree = await mkdtemp(join(tmpdir(), 'omnis-r1-legacy-worktree-'));
const serviceSocketDirectory = await mkdtemp(join(tmpdir(), 'omnis-r1-service-sockets-'));
const launcherSocket = join(serviceSocketDirectory, 'launcher.sock');
const authorizerSocket = join(serviceSocketDirectory, 'authorizer.sock');
let legacyBoss;
let runtimeBoss;
let worker;
let authorizerService;
let launcherService;
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

  const interruptedLegacyTask = await legacyStore.createTask({
    title: 'Legacy running execution',
    detail: 'Pre-authorization execution is fenced and interrupted after upgrade.',
  });
  const interruptedLegacyRun = await insertLegacyRunningRun(
    interruptedLegacyTask.id,
    interruptedLegacyTask.title,
    'legacy-interrupt-worker',
  );
  const failedLegacyTask = await legacyStore.createTask({
    title: 'Legacy failed execution',
    detail: 'Pre-authorization failure transitions remain available after upgrade.',
  });
  const failedLegacyRun = await insertLegacyRunningRun(
    failedLegacyTask.id,
    failedLegacyTask.title,
    'legacy-failure-worker',
  );
  const beforeUpgrade = (
    await databaseAdminPool.query(`
      SELECT json_build_object(
        'tasks', (SELECT count(*) FROM omnis.tasks),
        'runs', (SELECT count(*) FROM omnis.runs),
        'events', (SELECT count(*) FROM omnis.run_events),
        'idempotencyRecords', (SELECT count(*) FROM omnis.run_idempotency),
        'unsafeRunStates', (SELECT count(*) FROM omnis.runs
          WHERE status IN ('queued', 'running', 'stopping', 'unknown')),
        'recordFingerprints', json_build_object(
          'tasks', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), ':' ORDER BY t.id), '')) FROM omnis.tasks t),
          'runs', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(r)::text), ':' ORDER BY r.id), '')) FROM omnis.runs r),
          'events', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(e)::text), ':' ORDER BY e.run_id, e.sequence), '')) FROM omnis.run_events e),
          'idempotency', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(i)::text), ':' ORDER BY i.idempotency_key), '')) FROM omnis.run_idempotency i)
        )
      )
    `)
  ).rows[0].json_build_object;
  assert.equal(beforeUpgrade.tasks, 3);
  assert.equal(beforeUpgrade.runs, 3);
  assert.equal(beforeUpgrade.events, 3);
  assert.equal(beforeUpgrade.idempotencyRecords, 1);
  assert.equal(beforeUpgrade.unsafeRunStates, 3);

  await legacyBoss.stop();
  legacyBoss = undefined;

  await provisionDatabaseRoles(databaseAdminPool, {
    migration: migrationPassword,
    runtime: runtimePassword,
    authorizer: authorizerPassword,
    launcher: launcherPassword,
  });
  await runCurrentMigration();
  await applyRestrictedPgBossMigrations();
  await verifyPost0005ProvenanceUpgrade();

  const afterUpgrade = (await databaseAdminPool.query(metricsQuery)).rows[0].json_build_object;
  for (const [table, fingerprint] of Object.entries(beforeUpgrade.recordFingerprints)) {
    assert.equal(afterUpgrade.recordFingerprints[table], fingerprint);
  }
  assert.deepEqual(afterUpgrade.migrations, [
    '0001_initial',
    '0002_runtime_grants',
    '0003_runtime_privileges',
    '0004_narrow_runtime_sequence_defaults',
    '0005_durable_authorization',
    '0006_authorization_revocation_lock_order',
    '0007_authorization_audit_and_revoke_order',
    '0008_revocation_availability_and_legacy_run_recovery',
    '0009_authorizer_process_boundary',
    '0010_runtime_admission_identity',
    '0011_authorized_mock_sandbox_launch',
    '0012_agent_profiles',
    '0013_department_management',
    '0014_agent_profile_lifecycle',
    '0015_project_management',
    '0016_project_lifecycle',
    '0017_task_project_admission',
  ]);
  assert.equal(afterUpgrade.unsafeRunStates, 3);
  assert.equal(
    (
      await databaseAdminPool.query(
        'SELECT count(*)::int AS count FROM omnis.legacy_unscoped_runs WHERE run_id = ANY($1::text[])',
        [[legacyRun.id, interruptedLegacyRun, failedLegacyRun]],
      )
    ).rows[0].count,
    3,
  );
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
  await assert.rejects(
    runtimePool.query('SELECT * FROM omnis.legacy_unscoped_runs'),
    /permission denied/,
  );
  const migratedStore = new PostgresRunStore(runtimePool);

  runtimeBoss = new PgBoss({
    connectionString: databaseUrl,
    schema: 'pgboss',
    supervise: false,
    migrate: false,
    createSchema: false,
  });
  await runtimeBoss.start({ attempts: 3 });
  await runtimeBoss.createQueue('omnis-mock-run', { retryLimit: 0, retryDelay: 0 });

  await migratedStore.requestStop(legacyRun.id);
  const legacyJobId = (
    await databaseAdminPool.query('SELECT pg_boss_job_id FROM omnis.runs WHERE id=$1', [
      legacyRun.id,
    ])
  ).rows[0].pg_boss_job_id;
  await runtimeBoss.cancel('omnis-mock-run', legacyJobId);
  const queueState = await runtimePool.query('SELECT state FROM pgboss.job WHERE id = $1::uuid', [
    legacyJobId,
  ]);
  assert.equal(queueState.rows[0]?.state, 'cancelled');
  const cancelledLegacyRun = await migratedStore.cancelRunAfterQueueTerminal(legacyRun.id);
  assert.equal(cancelledLegacyRun?.run.status, 'cancelled');

  const interrupted = await migratedStore.interruptRun(
    interruptedLegacyRun,
    'legacy-interrupt-worker',
    3,
  );
  assert.equal(interrupted?.run.status, 'interrupted');
  const failed = await migratedStore.failRun(
    failedLegacyRun,
    'legacy-failure-worker',
    3,
    'Synthetic pre-authorization failure.',
  );
  assert.equal(failed.run.status, 'failed');
  const legacyAudit = await databaseAdminPool.query(
    `SELECT run_id, authorization_id, actor_id, event_type
       FROM omnis.authorization_audit WHERE run_id = ANY($1::text[]) ORDER BY run_id`,
    [[legacyRun.id, interruptedLegacyRun, failedLegacyRun]],
  );
  assert.deepEqual(
    legacyAudit.rows.map((row) => [row.authorization_id, row.actor_id, row.event_type]),
    [
      [null, 'service:omnis-runtime', 'operation.cancelled'],
      [null, 'service:omnis-runtime', 'operation.interrupted'],
      [null, 'service:omnis-runtime', 'operation.failed'],
    ],
  );

  launcherService = await startRestrictedLauncher(launcherSocket);
  await waitForSocketHealth(launcherSocket, launcherService.child, '/health');
  worker = await startRestrictedWorker(launcherSocket);
  const finalLegacyEvents = await migratedStore.getEvents(legacyRun.id);
  assert.deepEqual(
    finalLegacyEvents.map((event) => event.type),
    ['run.queued', 'run.stop_requested', 'run.cancelled'],
  );

  const busyTask = await migratedStore.createTask({
    title: 'Revocation contention API check',
    detail: 'The internal API must surface a failed revoke without claiming success.',
  });
  const busyRequest = await new PostgresAuthorizationStore(runtimePool, authorizerPool).request(
    busyTask.id,
    'owner',
  );
  const busyGrant = await new PostgresAuthorizationStore(runtimePool, authorizerPool).decide(
    busyRequest.id,
    'owner',
    'approve',
  );
  authorizerService = await startRestrictedAuthorizer();
  const grantHolder = await runtimePool.connect();
  try {
    await grantHolder.query('BEGIN');
    const lockedGrant = await grantHolder.query(
      'SELECT omnis.lock_run_authorization_for_admission($1,$2) AS allowed',
      [busyGrant.id, busyTask.id],
    );
    assert.equal(lockedGrant.rows[0]?.allowed, true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedAt = Date.now();
      const busyResponse = await socketRequest(
        authorizerService.socketPath,
        `/internal/v1/authorizations/${busyGrant.id}/revoke`,
        { method: 'POST', headers: { 'x-omnis-authorizer-token': authorizerService.token } },
      );
      assert.equal(busyResponse.status, 503);
      const body = await busyResponse.json();
      assert.equal(body.error.code, 'authorization_busy');
      assert.match(body.error.message, /not committed/i);
      assert.ok(Date.now() - startedAt < 5_000, 'revocation contention response must be bounded');
      assert.equal(
        (
          await authorizerPool.query(
            'SELECT status FROM omnis.runtime_authorizations WHERE id=$1',
            [busyGrant.id],
          )
        ).rows[0]?.status,
        'authorized',
      );
      assert.equal(
        (
          await databaseAdminPool.query(
            "SELECT count(*)::int AS count FROM omnis.authorization_audit WHERE authorization_id=$1 AND event_type='authorization.revoked'",
            [busyGrant.id],
          )
        ).rows[0].count,
        0,
      );
    }
  } finally {
    await grantHolder.query('ROLLBACK').catch(() => undefined);
    grantHolder.release();
  }
  const retryResponse = await socketRequest(
    authorizerService.socketPath,
    `/internal/v1/authorizations/${busyGrant.id}/revoke`,
    { method: 'POST', headers: { 'x-omnis-authorizer-token': authorizerService.token } },
  );
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json()).status, 'revoked');

  const admissionTask = await migratedStore.createTask({
    title: 'Admission lock API check',
    detail: 'The public advisory key must produce a prompt and truthful retry response.',
  });
  const admissionRequest = await new PostgresAuthorizationStore(
    runtimePool,
    authorizerPool,
  ).request(admissionTask.id, 'owner');
  const admissionGrant = await new PostgresAuthorizationStore(runtimePool, authorizerPool).decide(
    admissionRequest.id,
    'owner',
    'approve',
  );
  const admissionHolder = await runtimePool.connect();
  const admissionIdempotencyKey = `api-admission-${suffix}-retry`;
  try {
    await admissionHolder.query('SELECT pg_advisory_lock(70463909136524)');
    const startedAt = Date.now();
    const response = await fetch(`${worker.baseUrl}/internal/v1/runs`, {
      method: 'POST',
      headers: {
        'x-omnis-internal-token': worker.internalToken,
        'idempotency-key': admissionIdempotencyKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskId: admissionTask.id, authorizationId: admissionGrant.id }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'admission_busy');
    assert.match(body.error.message, /no run was admitted/i);
    assert.ok(Date.now() - startedAt < 5_000, 'admission contention response must be bounded');
    assert.equal(
      (
        await authorizerPool.query(
          'SELECT consumed_run_id FROM omnis.runtime_authorizations WHERE id=$1',
          [admissionGrant.id],
        )
      ).rows[0].consumed_run_id,
      null,
    );
    assert.equal(
      (
        await databaseAdminPool.query('SELECT 1 FROM omnis.runs WHERE task_id=$1', [
          admissionTask.id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await databaseAdminPool.query(
          'SELECT 1 FROM omnis.run_idempotency WHERE idempotency_key=$1',
          [admissionIdempotencyKey],
        )
      ).rowCount,
      0,
    );
  } finally {
    await admissionHolder.query('SELECT pg_advisory_unlock(70463909136524)').catch(() => undefined);
    admissionHolder.release();
  }
  const admissionRetry = await fetch(`${worker.baseUrl}/internal/v1/runs`, {
    method: 'POST',
    headers: {
      'x-omnis-internal-token': worker.internalToken,
      'idempotency-key': admissionIdempotencyKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: admissionTask.id, authorizationId: admissionGrant.id }),
  });
  assert.equal(admissionRetry.status, 201);
  const admittedBody = await admissionRetry.json();
  await waitForRun(migratedStore, admittedBody.id, 'completed');

  const newTask = await migratedStore.createTask({
    title: 'Post-upgrade runtime task',
    detail: 'Verify current restricted runtime inserts after legacy conversion.',
  });
  const authorizationStore = new PostgresAuthorizationStore(runtimePool, authorizerPool);
  const request = await authorizationStore.request(newTask.id, 'owner');
  const authorization = await authorizationStore.decide(request.id, 'owner', 'approve');
  const newRun = await migratedStore.admitRun(
    newTask.id,
    `current-upgrade-${suffix}`,
    authorization.id,
    (db, data) =>
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
    `Legacy upgrade passed from ${legacyRevision}: pre-migration records preserved; staged 0001–0007 provenance classified only the pre-0005 run; runtime timestamp backdating was denied; grantless legacy cancellation/interruption/failure succeeded without synthetic grants; repeated revoke attempts returned 503 without committing and succeeded on retry; admission lock contention returned a truthful 503 then succeeded on retry; role ownership, migration checksums, restricted pg-boss, worker execution, and post-upgrade task/run creation passed in ${databaseName}.\n`,
  );
} finally {
  await stopWorker(authorizerService?.child);
  await stopWorker(launcherService?.child);
  await stopWorker(worker?.child);
  await runtimeBoss?.stop().catch(() => undefined);
  await legacyBoss?.stop().catch(() => undefined);
  await Promise.all([
    migrationPool.end(),
    authorizerPool.end(),
    launcherPool.end(),
    runtimePool.end(),
    legacyPool.end(),
    databaseAdminPool.end(),
    clusterAdminPool.end(),
  ]);
  await rm(serviceSocketDirectory, { recursive: true, force: true });
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

async function verifyPost0005ProvenanceUpgrade() {
  const stagedName = `omnis_provenance_${suffix}`;
  let created = false;
  const stagedAdminUrl = databaseUrlFor(
    'omnis',
    decodeURIComponent(adminBase.password),
    stagedName,
  );
  const stagedMigrationUrl = databaseUrlFor('omnis_migrator', migrationPassword, stagedName);
  const stagedRuntimeUrl = databaseUrlFor('omnis_runtime', runtimePassword, stagedName);
  const stagedAdmin = createPool(stagedAdminUrl);
  const stagedMigrator = createPool(stagedMigrationUrl);
  const stagedRuntime = createPool(stagedRuntimeUrl);
  try {
    await clusterAdminPool.query(`CREATE DATABASE ${quoteIdentifier(stagedName)}`);
    created = true;
    await provisionDatabaseRoles(stagedAdmin, {
      migration: migrationPassword,
      runtime: runtimePassword,
      authorizer: authorizerPassword,
      launcher: launcherPassword,
    });
    await stagedMigrator.query(`
      CREATE TABLE omnis.schema_migrations (
        id text PRIMARY KEY,
        checksum text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrationDirectory = join(repositoryRoot, 'packages/db/migrations');
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((name) => /^000[1-7]_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    for (const file of migrationFiles) {
      const id = file.slice(0, -4);
      const sql = await readFile(join(migrationDirectory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      await stagedMigrator.query('BEGIN');
      try {
        await stagedMigrator.query(sql);
        await stagedMigrator.query(
          'INSERT INTO omnis.schema_migrations (id, checksum) VALUES ($1, $2)',
          [id, checksum],
        );
        await stagedMigrator.query('COMMIT');
      } catch (error) {
        await stagedMigrator.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      if (id === '0004_narrow_runtime_sequence_defaults') {
        await stagedMigrator.query(`
          INSERT INTO omnis.tasks (id, title, detail, status)
          VALUES ('legacy-before-0005-task', 'Historical task', 'Synthetic fixture', 'in_progress');
          INSERT INTO omnis.runs (
            id, task_id, task_title, status, runtime_kind, synthetic, usage
          ) VALUES (
            'run-legacy-before-0005', 'legacy-before-0005-task', 'Historical task',
            'queued', 'mock', true,
            '{"quality":"unknown","inputTokens":null,"outputTokens":null,"cost":null}'::jsonb
          );
        `);
      }
    }

    const runtimeStore = new PostgresRunStore(stagedRuntime);
    const modernTask = await runtimeStore.createTask({
      title: 'Modern grantless task',
      detail: 'Must not be classified as pre-authorization data.',
    });
    const modernRun = await stagedRuntime.query(
      `
      INSERT INTO omnis.runs (id, task_id, task_title)
      VALUES ('run-' || lpad(nextval('omnis.run_id_seq')::text, 4, '0'), $1, $2)
      RETURNING id
      `,
      [modernTask.id, 'Modern grantless task'],
    );
    await assert.rejects(
      stagedRuntime.query(
        `INSERT INTO omnis.runs (id, task_id, task_title, created_at)
         VALUES ('run-forged-date', $1, $2, '2000-01-01T00:00:00Z')`,
        [modernTask.id, 'Backdated run'],
      ),
      /permission denied/i,
    );
    await assert.rejects(
      stagedRuntime.query("UPDATE omnis.runs SET created_at='2000-01-01T00:00:00Z' WHERE id=$1", [
        modernRun.rows[0].id,
      ]),
      /permission denied/i,
    );
    assert.equal(
      (
        await stagedAdmin.query(
          "SELECT has_column_privilege('omnis_runtime','omnis.runs','created_at','INSERT') AS can_insert, has_column_privilege('omnis_runtime','omnis.runs','created_at','UPDATE') AS can_update",
        )
      ).rows[0].can_insert,
      false,
    );
    assert.equal(
      (
        await stagedAdmin.query(
          "SELECT has_column_privilege('omnis_runtime','omnis.runs','created_at','UPDATE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );

    await migrate(stagedMigrator);
    const classifications = await stagedAdmin.query(
      'SELECT run_id FROM omnis.legacy_unscoped_runs ORDER BY run_id',
    );
    assert.deepEqual(
      classifications.rows.map((row) => row.run_id),
      ['run-legacy-before-0005'],
    );
    const historicalTermination = await runtimeStore.beginExecution(
      'run-legacy-before-0005',
      'legacy-provenance-recovery',
      30,
    );
    assert.equal(historicalTermination.started, false);
    assert.equal(historicalTermination.run.status, 'interrupted');
    await assert.rejects(
      runtimeStore.beginExecution(modernRun.rows[0].id, 'modern-grantless-attempt', 30),
      /audit event could not be associated/i,
    );
    assert.equal((await runtimeStore.getRun(modernRun.rows[0].id))?.status, 'queued');
    const migrationRows = await stagedAdmin.query(
      "SELECT id, length(checksum) AS checksum_length FROM omnis.schema_migrations WHERE id LIKE '00%' ORDER BY id",
    );
    assert.deepEqual(migrationRows.rows.at(-1), {
      id: '0017_task_project_admission',
      checksum_length: 64,
    });
  } finally {
    await Promise.all([stagedAdmin.end(), stagedMigrator.end(), stagedRuntime.end()]);
    if (created) {
      await clusterAdminPool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [stagedName],
      );
      await clusterAdminPool.query(`DROP DATABASE ${quoteIdentifier(stagedName)}`);
    }
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

async function insertLegacyRunningRun(taskId, taskTitle, workerId) {
  const result = await legacyPool.query(
    `INSERT INTO omnis.runs (
       id, task_id, task_title, status, runtime_kind, synthetic, usage,
       execution_generation, lease_owner,
       lease_expires_at, last_event_sequence
     ) VALUES (
       'run-' || lpad(nextval('omnis.run_id_seq')::text, 4, '0'),
       $1, $2, 'running', 'mock', true,
       '{"quality":"unknown","inputTokens":null,"outputTokens":null,"cost":null}'::jsonb,
       3, $3, now() + interval '1 hour', 1
     ) RETURNING id`,
    [taskId, taskTitle, workerId],
  );
  const runId = result.rows[0].id;
  await legacyPool.query("UPDATE omnis.tasks SET status='in_progress' WHERE id=$1", [taskId]);
  await legacyPool.query(
    `INSERT INTO omnis.run_events (
       id, run_id, sequence, event_type, source, synthetic, message
     ) VALUES ($1,$2,1,'run.queued','mock',true,'Synthetic pre-authorization queued event.')`,
    [`legacy-event-${runId}`, runId],
  );
  return runId;
}

async function startRestrictedWorker(launcherSocket) {
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
      OMNIS_SANDBOX_LAUNCHER_SOCKET: launcherSocket,
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
        return { child, baseUrl: `http://127.0.0.1:${port}`, internalToken };
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

async function startRestrictedAuthorizer() {
  const token = randomBytes(64).toString('hex');
  const childEnvironment = { ...process.env };
  for (const key of [
    'OMNIS_ADMIN_DATABASE_URL',
    'OMNIS_MIGRATION_DATABASE_URL',
    'OMNIS_MIGRATION_DB_PASSWORD',
    'OMNIS_RUNTIME_DB_PASSWORD',
    'OMNIS_TEST_ADMIN_DATABASE_URL',
    'OMNIS_TEST_MIGRATION_DATABASE_URL',
    'OMNIS_TEST_DATABASE_URL',
    'OMNIS_TEST_AUTHORIZER_DATABASE_URL',
    'OMNIS_TEST_AUTHORIZER_DATABASE_URL',
    'OMNIS_TEST_LAUNCHER_DATABASE_URL',
    'OMNIS_AUTHORIZER_DB_PASSWORD',
    'OMNIS_AUTHORIZER_DATABASE_URL',
    'OMNIS_LAUNCHER_DB_PASSWORD',
    'OMNIS_LAUNCHER_DATABASE_URL',
    'OMNIS_API_AUTHORIZER_TOKEN',
    'OMNIS_AGENT_IDEMPOTENCY_KEY',
    'OMNIS_AGENT_IDEMPOTENCY_KEY_VERSION',
    'OMNIS_OWNER_PASSWORD_HASH',
    'OMNIS_SESSION_SECRET',
    'OMNIS_INTERNAL_TOKEN',
    'OMNIS_ALLOWED_ORIGIN',
    'OMNIS_SECURE_COOKIES',
  ])
    delete childEnvironment[key];
  childEnvironment.OMNIS_AUTHORIZER_DATABASE_URL = authorizerUrl;
  childEnvironment.OMNIS_AUTHORIZER_SOCKET = authorizerSocket;
  childEnvironment.OMNIS_AUTHORIZER_SOCKET_MODE = '600';
  childEnvironment.OMNIS_API_AUTHORIZER_TOKEN = token;
  childEnvironment.OMNIS_AGENT_IDEMPOTENCY_KEY = randomBytes(32).toString('hex');
  childEnvironment.OMNIS_AGENT_IDEMPOTENCY_KEY_VERSION = '1';
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: join(repositoryRoot, 'apps/authorizer'),
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      workerLogs = `${workerLogs}${chunk.toString('utf8')}`.slice(-64_000);
    });
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Authorizer exited during legacy-upgrade test.');
    try {
      const response = await socketRequest(authorizerSocket, '/internal/v1/health');
      if (response.ok) return { child, socketPath: authorizerSocket, token };
    } catch {
      // Retry until the bounded startup deadline.
    }
    await delay(100);
  }
  await stopWorker(child);
  throw new Error('Authorizer did not become healthy during legacy-upgrade test.');
}

async function startRestrictedLauncher(socketPath) {
  const childEnvironment = { ...workerEnvironment() };
  const workspaceRoot = join(serviceSocketDirectory, 'workspaces');
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: join(repositoryRoot, 'apps/sandbox-launcher'),
    env: {
      ...childEnvironment,
      OMNIS_LAUNCHER_DATABASE_URL: launcherUrl,
      OMNIS_SANDBOX_LAUNCHER_SOCKET: socketPath,
      OMNIS_SANDBOX_LAUNCHER_SOCKET_MODE: '600',
      OMNIS_SANDBOX_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      workerLogs = `${workerLogs}${chunk.toString('utf8')}`.slice(-64_000);
    });
  }
  return { child, socketPath };
}

async function waitForSocketHealth(socketPath, child, requestPath) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error('Sandbox launcher exited before becoming healthy.');
    try {
      const response = await socketRequest(socketPath, requestPath);
      if (response.ok) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error('Sandbox launcher did not become healthy within the startup deadline.');
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

function socketRequest(socketPath, requestPath, init = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path: requestPath,
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.once('end', () => resolve(new Response(body, { status: res.statusCode ?? 503 })));
      },
    );
    req.once('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('unix_socket_request_timeout')));
    req.end(init.body);
  });
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

function databaseUrlFor(username, password, targetDatabase = databaseName) {
  const url = new URL(adminUrl);
  url.username = username;
  url.password = password;
  url.pathname = `/${targetDatabase}`;
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
    'OMNIS_AUTHORIZER_DB_PASSWORD',
    'OMNIS_AUTHORIZER_DATABASE_URL',
    'OMNIS_API_AUTHORIZER_TOKEN',
    'OMNIS_TEST_ADMIN_DATABASE_URL',
    'OMNIS_TEST_MIGRATION_DATABASE_URL',
    'OMNIS_TEST_DATABASE_URL',
    'OMNIS_TEST_AUTHORIZER_DATABASE_URL',
    'OMNIS_TEST_LAUNCHER_DATABASE_URL',
    'OMNIS_LAUNCHER_DB_PASSWORD',
    'OMNIS_LAUNCHER_DATABASE_URL',
    'OMNIS_OWNER_PASSWORD_HASH',
    'OMNIS_SESSION_SECRET',
    'OMNIS_INTERNAL_TOKEN',
    'OMNIS_ALLOWED_ORIGIN',
    'OMNIS_SECURE_COOKIES',
  ]) {
    delete environment[key];
  }
  return environment;
}

function sanitize(output) {
  return output.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database URL redacted]');
}

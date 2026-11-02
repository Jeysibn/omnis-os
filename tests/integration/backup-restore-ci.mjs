import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const randomSuffix = randomBytes(6).toString('hex');
const projectName = `omnis-backup-ci-${randomSuffix}`;
const databaseName = 'omnis_backup_test';
const restoreDatabase = `omnis_restore_ci_${randomSuffix}`;
const legacyRestoreDatabase = `omnis_restore_acl_free_${randomSuffix}`;
const deniedGrantDatabase = `omnis_restore_bad_grant_${randomSuffix}`;
const mismatchedAclDatabase = `omnis_restore_bad_acl_${randomSuffix}`;
const unacknowledgedDatabase = `omnis_restore_unacknowledged_${randomSuffix}`;
const commandFailureDatabase = `omnis_restore_command_failure_${randomSuffix}`;
const cleanupFailureDatabase = `omnis_restore_cleanup_failure_${randomSuffix}`;
const roleFailureDatabase = `omnis_restore_role_failure_${randomSuffix}`;
const existingTargetDatabase = `omnis_restore_existing_${randomSuffix}`;
const directory = await mkdtemp(path.join(tmpdir(), 'omnis-backup-restore-'));
const envPath = path.join(directory, 'postgres.env');
const dumpPath = path.join(directory, 'synthetic.dump');
const port = await freePort();
const adminPassword = randomBytes(32).toString('hex');
const migrationPassword = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex');
const authorizerPassword = randomBytes(32).toString('hex');
const composeArgs = [
  'compose',
  '--project-name',
  projectName,
  '--project-directory',
  repositoryRoot,
  '--env-file',
  envPath,
  '-f',
  path.join(repositoryRoot, 'infra/compose/docker-compose.yml'),
];
const baseEnv = {
  ...process.env,
  OMNIS_COMPOSE_PROJECT_NAME: projectName,
  OMNIS_COMPOSE_ENV_FILE: envPath,
  OMNIS_BACKUP_DATABASE: databaseName,
  OMNIS_DB_NAME: databaseName,
  OMNIS_DB_PORT: String(port),
  OMNIS_DB_PASSWORD: adminPassword,
  OMNIS_MIGRATION_DB_PASSWORD: migrationPassword,
  OMNIS_RUNTIME_DB_PASSWORD: runtimePassword,
  OMNIS_AUTHORIZER_DB_PASSWORD: authorizerPassword,
  OMNIS_R1G3_DISPOSABLE: 'true',
  OMNIS_TRUSTED_ARCHIVE_ACKNOWLEDGED: 'true',
};
const adminUrl = connectionUrl('omnis', adminPassword, port, databaseName);
const migrationUrl = connectionUrl('omnis_migrator', migrationPassword, port, databaseName);
const runtimeUrl = connectionUrl('omnis_runtime', runtimePassword, port, databaseName);
const authorizerUrl = connectionUrl('omnis_authorizer', authorizerPassword, port, databaseName);

await writeFile(
  envPath,
  [
    `OMNIS_DB_NAME=${databaseName}`,
    `OMNIS_DB_PORT=${port}`,
    `OMNIS_DB_PASSWORD=${adminPassword}`,
    'OMNIS_R1G3_DISPOSABLE=true',
    '',
  ].join('\n'),
  { mode: 0o600 },
);

let composeStarted = false;
try {
  composeStarted = true;
  run('docker', [...composeArgs, 'up', '-d', '--wait', 'postgres'], { env: baseEnv });

  run(process.execPath, ['--experimental-strip-types', 'packages/db/src/provision.ts'], {
    env: { ...baseEnv, OMNIS_ADMIN_DATABASE_URL: adminUrl },
  });
  run(process.execPath, ['--experimental-strip-types', 'apps/worker/src/migrate.ts'], {
    env: { ...baseEnv, OMNIS_MIGRATION_DATABASE_URL: migrationUrl },
  });
  run(
    'docker',
    [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-X',
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--username=omnis',
      `--dbname=${databaseName}`,
      '--command',
      'CREATE EXTENSION pgcrypto WITH SCHEMA public',
    ],
    { env: baseEnv },
  );
  run('pnpm', ['--filter', '@omnis/db', 'test'], {
    env: {
      ...baseEnv,
      OMNIS_TEST_ADMIN_DATABASE_URL: adminUrl,
      OMNIS_TEST_MIGRATION_DATABASE_URL: migrationUrl,
      OMNIS_TEST_DATABASE_URL: runtimeUrl,
      OMNIS_TEST_AUTHORIZER_DATABASE_URL: authorizerUrl,
    },
  });

  await addFutureMigrationAclFixtures(migrationUrl, randomSuffix);
  await createSyntheticRecords(runtimeUrl, adminUrl, randomSuffix);

  const staleDump = path.join(directory, 'stale.dump');
  await setSequenceState(adminUrl, true);
  const staleBackup = run(process.execPath, ['scripts/db-recovery/backup.mjs', staleDump], {
    env: baseEnv,
    allowFailure: true,
  });
  assert.notEqual(staleBackup.status, 0, 'backup must reject a deliberately stale sequence');
  assert.match(staleBackup.output, /sequence is stale/i);
  assert.equal(await exists(staleDump), false, 'failed backup must remove the partial dump');
  assert.equal(await exists(`${staleDump}.manifest.json`), false);

  await setSequenceState(adminUrl, false);
  run(process.execPath, ['scripts/db-recovery/backup.mjs', dumpPath], { env: baseEnv });
  await verifyLiveAclBoundaries(adminUrl);
  await verifyRestoreRequiresTrustedArchiveAcknowledgement(unacknowledgedDatabase);
  run(process.execPath, ['scripts/db-recovery/restore-verify.mjs', dumpPath, restoreDatabase], {
    env: baseEnv,
  });
  await verifyRestoredMigrationAcl(
    connectionUrl('omnis_runtime', runtimePassword, port, restoreDatabase),
    randomSuffix,
  );
  await verifyRestoreRejectsUnauthorizedGrant(adminUrl, deniedGrantDatabase);
  await verifyRestoreRejectsMismatchedSnapshot(mismatchedAclDatabase);
  await verifyRestoreRejectsCommandFailure(commandFailureDatabase);
  await verifyRestoreQuarantinesWhenCleanupFails(cleanupFailureDatabase);
  await verifyRestoreRejectsEscalatedRuntimeRole(roleFailureDatabase);
  await verifyExistingRestoreTargetIsUntouched(existingTargetDatabase);

  const legacyDumpPath = path.join(directory, 'acl-free-legacy.dump');
  await createAclFreeLegacyArchive(legacyDumpPath);
  run(
    process.execPath,
    ['scripts/db-recovery/restore-verify.mjs', legacyDumpPath, legacyRestoreDatabase],
    { env: baseEnv },
  );
  await verifyLegacyAclBaseline(
    connectionUrl('omnis_runtime', runtimePassword, port, legacyRestoreDatabase),
    randomSuffix,
  );
  await verifyLegacyRuntimeAclParity(
    adminUrl,
    connectionUrl('omnis', adminPassword, port, legacyRestoreDatabase),
  );

  process.stdout.write(
    `Disposable PostgreSQL backup/restore integration passed for ${projectName}; archive and credentials were kept private and removed.\n`,
  );
} finally {
  if (composeStarted) {
    run(
      'docker',
      [
        ...composeArgs,
        'exec',
        '-T',
        'postgres',
        'dropdb',
        '--if-exists',
        '--force',
        '--username=omnis',
        '--maintenance-db=postgres',
        restoreDatabase,
      ],
      { env: baseEnv, allowFailure: true },
    );
    for (const failedTarget of [
      deniedGrantDatabase,
      mismatchedAclDatabase,
      unacknowledgedDatabase,
      commandFailureDatabase,
      cleanupFailureDatabase,
      roleFailureDatabase,
      existingTargetDatabase,
    ]) {
      run(
        'docker',
        [
          ...composeArgs,
          'exec',
          '-T',
          'postgres',
          'dropdb',
          '--if-exists',
          '--force',
          '--username=omnis',
          '--maintenance-db=postgres',
          failedTarget,
        ],
        { env: baseEnv, allowFailure: true },
      );
    }
    run(
      'docker',
      [
        ...composeArgs,
        'exec',
        '-T',
        'postgres',
        'dropdb',
        '--if-exists',
        '--force',
        '--username=omnis',
        '--maintenance-db=postgres',
        legacyRestoreDatabase,
      ],
      { env: baseEnv, allowFailure: true },
    );
    run('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], {
      env: baseEnv,
      allowFailure: true,
    });
  }
  await rm(directory, { recursive: true, force: true });
}

async function createSyntheticRecords(runtimeUrl, adminUrl, suffix) {
  const { createPool, PostgresAuthorizationStore, PostgresRunStore } =
    await import('../../packages/db/src/index.ts');
  const { PgBoss } = await import(
    new URL('../../apps/worker/node_modules/pg-boss/dist/index.js', import.meta.url).href
  );
  const runtime = createPool(runtimeUrl);
  const admin = createPool(adminUrl);
  const authUrl = connectionUrl('omnis_authorizer', authorizerPassword, port, databaseName);
  const authorizer = createPool(authUrl);
  const boss = new PgBoss({
    connectionString: runtimeUrl,
    schema: 'pgboss',
    application_name: 'omnis-backup-ci-fixture',
    max: 2,
    supervise: false,
    migrate: false,
    createSchema: false,
  });
  try {
    await boss.start();
    const queueName = `backup-ci-${suffix}`;
    await boss.createQueue(queueName, { retryLimit: 0, retryDelay: 0 });
    await boss.send(queueName, { synthetic: true, fixture: suffix });

    const store = new PostgresRunStore(runtime);
    const authorizations = new PostgresAuthorizationStore(runtime, authorizer);
    const task = await store.createTask({
      title: `Synthetic backup task ${suffix}`,
      detail: 'Disposable backup/restore verification record.',
    });
    const authorizationRequest = await authorizations.request(task.id, 'owner');
    const authorization = await authorizations.decide(authorizationRequest.id, 'owner', 'approve');
    const admitted = await store.admitRun(
      task.id,
      `backup-ci-${suffix}`,
      authorization.id,
      'owner',
      async () => 'fixture-job',
    );
    const claim = await store.beginExecution(admitted.run.id, `backup-ci-${suffix}`, 30);
    await store.completeRun(
      admitted.run.id,
      `backup-ci-${suffix}`,
      claim.generation,
      'Synthetic backup integration result.',
      [],
    );
    const { rows } = await admin.query(
      'SELECT count(*)::integer AS count FROM omnis.run_events WHERE run_id = $1',
      [admitted.run.id],
    );
    assert.equal(rows[0]?.count, 3);
  } finally {
    await boss.stop().catch(() => undefined);
    await runtime.end();
    await admin.end();
    await authorizer.end();
  }
}

async function addFutureMigrationAclFixtures(migrationUrl, suffix) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const migration = createPool(migrationUrl);
  const table = `future_acl_${suffix}`;
  const deniedTable = `future_denied_${suffix}`;
  const sequence = `future_acl_seq_${suffix}`;
  const deniedSequence = `future_denied_seq_${suffix}`;
  try {
    await migration.query(`
      CREATE TABLE omnis.${table} (id integer PRIMARY KEY);
      INSERT INTO omnis.${table} VALUES (41);
      CREATE TABLE omnis.${deniedTable} (id integer PRIMARY KEY);
      CREATE SEQUENCE omnis.${sequence};
      CREATE SEQUENCE omnis.${deniedSequence};
    `);
  } finally {
    await migration.end();
  }
}

async function verifyRestoredMigrationAcl(runtimeUrl, suffix) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const runtime = createPool(runtimeUrl);
  try {
    await assert.rejects(
      runtime.query(`SELECT id FROM omnis.future_acl_${suffix}`),
      /permission denied/,
      'future application tables require explicit ACL-policy approval before runtime reads',
    );
    await assert.rejects(
      runtime.query(`SELECT nextval('omnis.future_acl_seq_${suffix}')`),
      /permission denied/,
    );
    await assert.rejects(
      runtime.query(`SELECT id FROM omnis.future_denied_${suffix}`),
      /permission denied/,
    );
    await assert.rejects(
      runtime.query(`SELECT nextval('omnis.future_denied_seq_${suffix}')`),
      /permission denied/,
    );
  } finally {
    await runtime.end();
  }
}

async function verifyLiveAclBoundaries(adminUrl) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const { aclSnapshotQuery, assertRuntimeAclPolicy } =
    await import('../../scripts/db-recovery/acl-integrity.mjs');
  const admin = createPool(adminUrl);
  try {
    const assertPolicyRejects = async (pattern, reason) => {
      const { rows } = await admin.query(aclSnapshotQuery);
      assert.throws(() => assertRuntimeAclPolicy(rows[0]?.acl_snapshot), pattern, reason);
    };
    await admin.query(
      'CREATE SCHEMA acl_boundary_fixture; GRANT USAGE ON SCHEMA acl_boundary_fixture TO omnis_runtime',
    );
    await assertPolicyRejects(
      /Runtime schema privilege USAGE is prohibited on acl_boundary_fixture/,
      'unexpected schema access is denied',
    );
    await admin.query('REVOKE USAGE ON SCHEMA acl_boundary_fixture FROM omnis_runtime');

    await admin.query('GRANT SELECT ON omnis.tasks TO PUBLIC');
    await assertPolicyRejects(/grants SELECT to PUBLIC/, 'PUBLIC table reads are denied');
    await admin.query('REVOKE SELECT ON omnis.tasks FROM PUBLIC');

    await admin.query(
      'CREATE VIEW omnis.acl_boundary_view AS SELECT 1 AS value; GRANT SELECT ON omnis.acl_boundary_view TO omnis_runtime',
    );
    await assertPolicyRejects(
      /Runtime view privilege SELECT is prohibited/,
      'runtime reads of views are denied',
    );
    await admin.query('DROP VIEW omnis.acl_boundary_view');

    await admin.query(
      'CREATE ROLE omnis_acl_boundary_member NOLOGIN; GRANT omnis_acl_boundary_member TO omnis_runtime',
    );
    await assertPolicyRejects(
      /membership involving the runtime role is prohibited/,
      'role memberships are denied',
    );
  } finally {
    await admin
      .query(
        `
      REVOKE omnis_acl_boundary_member FROM omnis_runtime;
      DROP ROLE IF EXISTS omnis_acl_boundary_member;
      REVOKE SELECT ON omnis.tasks FROM PUBLIC;
      DROP VIEW IF EXISTS omnis.acl_boundary_view;
      DROP SCHEMA IF EXISTS acl_boundary_fixture;
    `,
      )
      .catch(() => undefined);
    await admin.end();
  }
}

async function verifyRestoreRejectsUnauthorizedGrant(adminUrl, targetDatabase) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const { aclSnapshotQuery } = await import('../../scripts/db-recovery/acl-integrity.mjs');
  const admin = createPool(adminUrl);
  const archivePath = path.join(directory, 'unauthorized-select.dump');
  try {
    await admin.query('GRANT SELECT ON omnis.schema_migrations TO omnis_runtime');
    const [{ acl_snapshot: aclSnapshot }] = (await admin.query(aclSnapshotQuery)).rows;
    const binary = runBinary('docker', [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--username=omnis',
      `--dbname=${databaseName}`,
    ]);
    await writeFile(archivePath, binary, { mode: 0o600, flag: 'wx' });
    const baseManifest = JSON.parse(await readFile(`${dumpPath}.manifest.json`, 'utf8'));
    await writeFile(
      `${archivePath}.manifest.json`,
      `${JSON.stringify({ ...baseManifest, dumpBytes: binary.length, dumpSha256: createHash('sha256').update(binary).digest('hex'), aclSnapshot }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  } finally {
    await admin
      .query('REVOKE SELECT ON omnis.schema_migrations FROM omnis_runtime')
      .catch(() => undefined);
    await admin.end();
  }
  const result = run(
    process.execPath,
    ['scripts/db-recovery/restore-verify.mjs', archivePath, targetDatabase],
    { env: baseEnv, allowFailure: true },
  );
  assert.notEqual(result.status, 0, 'restore must reject an archive that grants schema_migrations');
  assert.match(result.output, /schema_migrations/);
  await assertTargetAbsentOrQuarantined(targetDatabase);
}

async function verifyRestoreRejectsMismatchedSnapshot(targetDatabase) {
  const archivePath = path.join(directory, 'mismatched-acl.dump');
  await copyFile(dumpPath, archivePath);
  const manifest = JSON.parse(await readFile(`${dumpPath}.manifest.json`, 'utf8'));
  const changedSnapshot = manifest.aclSnapshot.filter(
    (entry) =>
      !(
        entry.grantee === 'omnis_runtime' &&
        entry.objectType === 'table' &&
        entry.schema === 'omnis' &&
        entry.object === 'tasks' &&
        entry.privilege === 'SELECT'
      ),
  );
  assert.notEqual(changedSnapshot.length, manifest.aclSnapshot.length);
  await writeFile(
    `${archivePath}.manifest.json`,
    `${JSON.stringify({ ...manifest, aclSnapshot: changedSnapshot }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  const result = run(
    process.execPath,
    ['scripts/db-recovery/restore-verify.mjs', archivePath, targetDatabase],
    { env: baseEnv, allowFailure: true },
  );
  assert.notEqual(
    result.status,
    0,
    'restore must reject a manifest with a mismatched ACL snapshot',
  );
  assert.match(result.output, /do not match the source ACL snapshot/i);
  await assertTargetAbsentOrQuarantined(targetDatabase);
}

async function verifyRestoreRejectsCommandFailure(targetDatabase) {
  const archivePath = await writeInvalidRestoreArchive('restore-command-failure');
  const result = run(
    process.execPath,
    ['scripts/db-recovery/restore-verify.mjs', archivePath, targetDatabase],
    { env: baseEnv, allowFailure: true },
  );
  assert.notEqual(result.status, 0, 'restore-command failure must reject the archive');
  assert.match(result.output, /Restore rejected/);
  await assertTargetAbsentOrQuarantined(targetDatabase);
}

async function verifyRestoreQuarantinesWhenCleanupFails(targetDatabase) {
  const archivePath = await writeInvalidRestoreArchive('restore-cleanup-failure');
  const result = run(
    process.execPath,
    ['scripts/db-recovery/restore-verify.mjs', archivePath, targetDatabase],
    {
      env: { ...baseEnv, OMNIS_RESTORE_TEST_FAIL_CLEANUP: 'true' },
      allowFailure: true,
    },
  );
  assert.notEqual(result.status, 0, 'injected cleanup failure must remain a failed restore');
  assert.match(result.output, /CRITICAL: restore rejected and automatic cleanup did not complete/);
  await assertTargetAbsentOrQuarantined(targetDatabase, { requireQuarantine: true });
}

async function verifyRestoreRejectsEscalatedRuntimeRole(targetDatabase) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const admin = createPool(adminUrl);
  try {
    await admin.query('ALTER ROLE omnis_runtime CREATEROLE');
    const result = run(
      process.execPath,
      ['scripts/db-recovery/restore-verify.mjs', dumpPath, targetDatabase],
      { env: baseEnv, allowFailure: true },
    );
    assert.notEqual(result.status, 0, 'restore must reject an escalated runtime role');
    assert.match(result.output, /omnis_runtime has unsafe createRole/);
    await assertTargetAbsentOrQuarantined(targetDatabase);
  } finally {
    await admin.query('ALTER ROLE omnis_runtime NOCREATEROLE');
    await admin.end();
  }
}

async function verifyExistingRestoreTargetIsUntouched(targetDatabase) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const admin = createPool(adminUrl);
  try {
    await admin.query(`CREATE DATABASE "${targetDatabase}"`);
    await admin.query(`COMMENT ON DATABASE "${targetDatabase}" IS 'pre-existing-test-fixture'`);
    const result = run(
      process.execPath,
      ['scripts/db-recovery/restore-verify.mjs', dumpPath, targetDatabase],
      { env: baseEnv, allowFailure: true },
    );
    assert.notEqual(result.status, 0, 'restore must refuse to overwrite an existing target');
    assert.match(result.output, /already exists|refusing to overwrite/i);
    const { rows } = await admin.query(
      `SELECT datallowconn, shobj_description(oid, 'pg_database') AS marker
         FROM pg_database WHERE datname = $1`,
      [targetDatabase],
    );
    assert.deepEqual(rows[0], { datallowconn: true, marker: 'pre-existing-test-fixture' });
  } finally {
    await admin.end();
  }
}

async function writeInvalidRestoreArchive(label) {
  const archivePath = path.join(directory, `${label}.dump`);
  const invalidArchive = Buffer.from('PGDMPsynthetic-invalid-restore-payload');
  await writeFile(archivePath, invalidArchive, { mode: 0o600, flag: 'wx' });
  const sourceManifest = JSON.parse(await readFile(`${dumpPath}.manifest.json`, 'utf8'));
  await writeFile(
    `${archivePath}.manifest.json`,
    `${JSON.stringify({
      ...sourceManifest,
      dumpBytes: invalidArchive.length,
      dumpSha256: createHash('sha256').update(invalidArchive).digest('hex'),
    })}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return archivePath;
}

async function assertTargetAbsentOrQuarantined(database, { requireQuarantine = false } = {}) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const admin = createPool(adminUrl);
  try {
    const { rows } = await admin.query(
      `SELECT datallowconn,
              has_database_privilege('omnis_runtime', oid, 'CONNECT') AS runtime_connect,
              has_database_privilege('omnis_migrator', oid, 'CONNECT') AS migrator_connect
         FROM pg_database WHERE datname = $1`,
      [database],
    );
    if (rows.length === 0) {
      assert.equal(
        requireQuarantine,
        false,
        'cleanup failure should retain a quarantined database',
      );
      return;
    }
    assert.equal(rows[0].datallowconn, false, 'rejected target must reject all new connections');
    assert.equal(rows[0].runtime_connect, false, 'runtime must not connect to a rejected target');
    assert.equal(rows[0].migrator_connect, false, 'migrator must not connect to a rejected target');
  } finally {
    await admin.end();
  }
}

async function verifyRestoreRequiresTrustedArchiveAcknowledgement(targetDatabase) {
  const environment = { ...baseEnv };
  delete environment.OMNIS_TRUSTED_ARCHIVE_ACKNOWLEDGED;
  const result = run(
    process.execPath,
    ['scripts/db-recovery/restore-verify.mjs', dumpPath, targetDatabase],
    { env: environment, allowFailure: true },
  );
  assert.notEqual(
    result.status,
    0,
    'restore must require an explicit trusted-input acknowledgement',
  );
  assert.match(result.output, /operator-vetted trusted archives/i);
  await assertTargetAbsentOrQuarantined(targetDatabase);
}

async function verifyLegacyRuntimeAclParity(sourceUrl, restoredUrl) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const { aclSnapshotQuery, runtimeAclSnapshotsMatch } =
    await import('../../scripts/db-recovery/acl-integrity.mjs');
  const source = createPool(sourceUrl);
  const restored = createPool(restoredUrl);
  try {
    const [sourceResult, restoredResult] = await Promise.all([
      source.query(aclSnapshotQuery),
      restored.query(aclSnapshotQuery),
    ]);
    assert.equal(
      runtimeAclSnapshotsMatch(
        sourceResult.rows[0]?.acl_snapshot,
        restoredResult.rows[0]?.acl_snapshot,
      ),
      true,
      'ACL-free restore runtime grants must match the approved fresh-database grant set',
    );
  } finally {
    await Promise.all([source.end(), restored.end()]);
  }
}

async function createAclFreeLegacyArchive(destination) {
  const binary = runBinary('docker', [
    ...composeArgs,
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--username=omnis',
    `--dbname=${databaseName}`,
  ]);
  await writeFile(destination, binary, { mode: 0o600, flag: 'wx' });
  const currentManifest = JSON.parse(await readFile(`${dumpPath}.manifest.json`, 'utf8'));
  const legacyManifest = {
    format: 'postgres-custom',
    sourceDatabase: databaseName,
    dumpBytes: binary.length,
    dumpSha256: createHash('sha256').update(binary).digest('hex'),
    snapshotMetrics: currentManifest.snapshotMetrics,
  };
  await writeFile(`${destination}.manifest.json`, `${JSON.stringify(legacyManifest)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}

async function verifyLegacyAclBaseline(runtimeUrl, suffix) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const runtime = createPool(runtimeUrl);
  try {
    assert.ok((await runtime.query('SELECT id FROM omnis.tasks LIMIT 1')).rowCount >= 1);
    await assert.rejects(
      runtime.query(`SELECT id FROM omnis.future_acl_${suffix}`),
      /permission denied/,
      'ACL-free restore must not invent later migration privileges',
    );
    await assert.rejects(
      runtime.query(`SELECT nextval('omnis.future_acl_seq_${suffix}')`),
      /permission denied/,
      'ACL-free restore must not expose future sequences',
    );
  } finally {
    await runtime.end();
  }
}

async function setSequenceState(adminUrl, stale) {
  const { createPool } = await import('../../packages/db/src/index.ts');
  const admin = createPool(adminUrl);
  try {
    if (stale) {
      await admin.query("SELECT setval('omnis.task_id_seq', 1, false)");
    } else {
      await admin.query(`
        SELECT setval(
          'omnis.task_id_seq',
          GREATEST(COALESCE((SELECT max(substring(id from '^task-([0-9]+)$')::bigint) FROM omnis.tasks), 0), 1),
          EXISTS (SELECT 1 FROM omnis.tasks)
        )
      `);
      await admin.query(`
        SELECT setval(
          'omnis.run_id_seq',
          GREATEST(COALESCE((SELECT max(substring(id from '^run-([0-9]+)$')::bigint) FROM omnis.runs), 0), 1),
          EXISTS (SELECT 1 FROM omnis.runs)
        )
      `);
    }
  } finally {
    await admin.end();
  }
}

function connectionUrl(user, password, hostPort, database) {
  return `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/${database}`;
}

function run(command, args, { env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .replaceAll(adminPassword, '[redacted]')
      .replaceAll(migrationPassword, '[redacted]')
      .replaceAll(runtimePassword, '[redacted]');
    throw new Error(
      `${command} ${args[0] ?? ''} failed (${result.status ?? 'unknown'}): ${detail}`,
    );
  }
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function runBinary(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: baseEnv,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed while generating the legacy archive.`);
  }
  return result.stdout;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port.');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function exists(filePath) {
  try {
    await import('node:fs/promises').then(({ access }) => access(filePath));
    return true;
  } catch {
    return false;
  }
}

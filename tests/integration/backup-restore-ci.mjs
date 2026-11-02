import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const randomSuffix = randomBytes(6).toString('hex');
const projectName = `omnis-backup-ci-${randomSuffix}`;
const databaseName = 'omnis_backup_test';
const restoreDatabase = `omnis_restore_ci_${randomSuffix}`;
const directory = await mkdtemp(path.join(tmpdir(), 'omnis-backup-restore-'));
const envPath = path.join(directory, 'postgres.env');
const dumpPath = path.join(directory, 'synthetic.dump');
const port = await freePort();
const adminPassword = randomBytes(32).toString('hex');
const migrationPassword = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex');
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
  OMNIS_R1G3_DISPOSABLE: 'true',
};
const adminUrl = connectionUrl('omnis', adminPassword, port, databaseName);
const migrationUrl = connectionUrl('omnis_migrator', migrationPassword, port, databaseName);
const runtimeUrl = connectionUrl('omnis_runtime', runtimePassword, port, databaseName);

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
  run('pnpm', ['--filter', '@omnis/db', 'test'], {
    env: {
      ...baseEnv,
      OMNIS_TEST_ADMIN_DATABASE_URL: adminUrl,
      OMNIS_TEST_MIGRATION_DATABASE_URL: migrationUrl,
      OMNIS_TEST_DATABASE_URL: runtimeUrl,
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
  run(process.execPath, ['scripts/db-recovery/restore-verify.mjs', dumpPath, restoreDatabase], {
    env: baseEnv,
  });
  await verifyRestoredMigrationAcl(
    connectionUrl('omnis_runtime', runtimePassword, port, restoreDatabase),
    randomSuffix,
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
    run('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], {
      env: baseEnv,
      allowFailure: true,
    });
  }
  await rm(directory, { recursive: true, force: true });
}

async function createSyntheticRecords(runtimeUrl, adminUrl, suffix) {
  const { createPool, PostgresRunStore } = await import('../../packages/db/src/index.ts');
  const { PgBoss } = await import(
    new URL('../../apps/worker/node_modules/pg-boss/dist/index.js', import.meta.url).href
  );
  const runtime = createPool(runtimeUrl);
  const admin = createPool(adminUrl);
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
    const task = await store.createTask({
      title: `Synthetic backup task ${suffix}`,
      detail: 'Disposable backup/restore verification record.',
    });
    const admitted = await store.admitRun(
      task.id,
      `backup-ci-${suffix}`,
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
      GRANT SELECT ON omnis.${table} TO omnis_runtime;
      CREATE TABLE omnis.${deniedTable} (id integer PRIMARY KEY);
      CREATE SEQUENCE omnis.${sequence};
      GRANT USAGE, SELECT ON SEQUENCE omnis.${sequence} TO omnis_runtime;
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
    const approved = await runtime.query(`SELECT id FROM omnis.future_acl_${suffix}`);
    assert.deepEqual(approved.rows, [{ id: 41 }]);
    assert.equal(
      (await runtime.query(`SELECT nextval('omnis.future_acl_seq_${suffix}') AS value`)).rows[0]
        ?.value,
      '1',
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

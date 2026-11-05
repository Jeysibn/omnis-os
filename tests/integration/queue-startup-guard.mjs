import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createPool } from '../../packages/db/src/index.ts';
import {
  assertNoExecutableWork,
  startMockServices,
  validateTestDatabaseConfiguration,
} from './support/mock-services.mjs';

const databaseConfig = validateTestDatabaseConfiguration(process.env, { requireAdmin: true });
const migration = spawnSync(process.execPath, ['--experimental-strip-types', 'src/migrate.ts'], {
  cwd: new URL('../../apps/worker/', import.meta.url),
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    OMNIS_MIGRATION_DATABASE_URL: databaseConfig.urls.OMNIS_TEST_MIGRATION_DATABASE_URL,
  },
  encoding: 'utf8',
  timeout: 30_000,
});
if (migration.error || migration.status !== 0) {
  throw new Error('The disposable queue-guard test migrations did not complete.');
}

const adminPool = createPool({
  connectionString: databaseConfig.urls.OMNIS_TEST_ADMIN_DATABASE_URL,
  max: 1,
  application_name: 'omnis-test-queue-guard',
});
const suffix = randomUUID().replaceAll('-', '');
const taskId = `task-queue-guard-${suffix}`;
const runId = `run-${Date.now()}${Number.parseInt(suffix.slice(0, 4), 16)}`;
try {
  await assertNoExecutableWork(adminPool);

  await adminPool.query(
    `INSERT INTO omnis.tasks (id, title, detail, status)
     VALUES ($1, 'Synthetic queue guard task', 'Must never execute.', 'open')`,
    [taskId],
  );
  await adminPool.query('INSERT INTO omnis.runs (id, task_id, task_title) VALUES ($1, $2, $3)', [
    runId,
    taskId,
    'Synthetic queue guard task',
  ]);
  await assert.rejects(
    startMockServices({
      origin: 'http://127.0.0.1:5174',
      reservedPorts: [5174],
      requireAuditPool: true,
    }).then((services) => services.cleanup()),
    /existing executable work/,
  );

  const row = await adminPool.query('SELECT status FROM omnis.runs WHERE id = $1', [runId]);
  assert.equal(row.rows[0]?.status, 'queued');
} finally {
  // The fixture's task/run lifecycle events are append-only and retain source
  // references. Keep this synthetic fixture in the per-job disposable database;
  // deleting its source rows would either violate history integrity or require
  // bypassing the production immutability guard.
  await adminPool.end();
}

process.stdout.write('Disposable queue startup guard refused pre-existing work.\n');

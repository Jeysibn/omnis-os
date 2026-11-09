import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createPool, PostgresRunStore } from '../../packages/db/src/index.ts';
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
const runtimePool = createPool({
  connectionString: databaseConfig.urls.OMNIS_TEST_DATABASE_URL,
  max: 1,
  application_name: 'omnis-test-queue-guard-writer',
});
const taskStore = new PostgresRunStore(runtimePool);
let taskId;
const runId = `run-${Date.now()}${Number.parseInt(randomUUID().slice(0, 4), 16)}`;
let runSeeded = false;

try {
  await assertNoExecutableWork(adminPool);

  const task = await taskStore.createTask({
    title: 'Synthetic queue guard task',
    detail: 'Must never execute.',
  });
  taskId = task.id;

  await adminPool.query('BEGIN');
  try {
    await adminPool.query('INSERT INTO omnis.runs (id, task_id, task_title) VALUES ($1, $2, $3)', [
      runId,
      taskId,
      'Synthetic queue guard task',
    ]);
    runSeeded = true;
    await adminPool.query('COMMIT');
  } catch (error) {
    await adminPool.query('ROLLBACK').catch(() => undefined);
    runSeeded = false;
    throw error;
  }

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
  if (runSeeded) {
    await adminPool.query('DELETE FROM omnis.runs WHERE id = $1', [runId]);
  }
  // The task.created ledger row is append-only and intentionally remains in
  // this disposable database after its synthetic queue-guard Run is removed.
  await adminPool.end();
  await runtimePool.end();
}

process.stdout.write('Disposable queue startup guard refused pre-existing work.\n');

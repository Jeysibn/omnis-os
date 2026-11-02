import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import {
  createPool,
  migrate,
  PostgresRunStore,
  StoreError,
  type PgBossTransaction,
} from './index.ts';

const databaseUrl = process.env.OMNIS_TEST_DATABASE_URL;
const pool = databaseUrl ? createPool(databaseUrl) : undefined;
let nextKey = 0;
const postgresSuite = describe('PostgreSQL run store', { skip: !databaseUrl }, () => {
  const store = new PostgresRunStore(pool!);

  beforeEach(async () => {
    assertTestDatabase(databaseUrl!);
    await migrate(pool!);
    await pool!.query(`
      CREATE TABLE IF NOT EXISTS omnis.test_queue_outbox (
        run_id text PRIMARY KEY
      )
    `);
    await pool!.query(
      'TRUNCATE omnis.test_queue_outbox, omnis.run_idempotency, omnis.run_events, omnis.runs, omnis.tasks',
    );
    await pool!.query('ALTER SEQUENCE omnis.task_id_seq RESTART WITH 1');
    await pool!.query('ALTER SEQUENCE omnis.run_id_seq RESTART WITH 1');
    nextKey += 1;
  });

  it('commits task, run, initial event, idempotency, and queue outbox atomically', async () => {
    const task = await store.createTask({
      title: 'Inspect files',
      detail: 'List files read-only.',
    });
    const admitted = await store.admitRun(task.id, key('atomic'), async (tx, { runId }) => {
      await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
      return `job-${runId}`;
    });

    assert.equal(admitted.created, true);
    assert.equal(admitted.run.status, 'queued');
    assert.equal(admitted.events[0]?.event.type, 'run.queued');
    assert.equal((await store.getEvents(admitted.run.id)).length, 1);
    assert.equal(
      (
        await pool!.query('SELECT 1 FROM omnis.test_queue_outbox WHERE run_id = $1', [
          admitted.run.id,
        ])
      ).rowCount,
      1,
    );
  });

  it('rolls run state and queue admission back when enqueue fails', async () => {
    const task = await store.createTask({
      title: 'Inspect files',
      detail: 'List files read-only.',
    });
    await assert.rejects(
      store.admitRun(task.id, key('rollback'), async () => {
        throw new Error('queue rejected');
      }),
      /queue rejected/,
    );
    assert.equal((await store.listRuns()).length, 0);
    assert.equal((await store.listTasks())[0]?.status, 'open');
    assert.equal((await pool!.query('SELECT 1 FROM omnis.run_events')).rowCount, 0);
    assert.equal((await pool!.query('SELECT 1 FROM omnis.run_idempotency')).rowCount, 0);
  });

  it('makes concurrent retries idempotent and serializes distinct active work', async () => {
    const task = await store.createTask({
      title: 'Inspect files',
      detail: 'List files read-only.',
    });
    const idem = key('retry');
    const enqueue = async (tx: PgBossTransaction, { runId }: { runId: string }) => {
      await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
      return `job-${runId}`;
    };
    const [first, retry] = await Promise.all([
      store.admitRun(task.id, idem, enqueue),
      store.admitRun(task.id, idem, enqueue),
    ]);
    assert.equal(first.run.id, retry.run.id);
    assert.equal([first.created, retry.created].filter(Boolean).length, 1);
    assert.equal((await pool!.query('SELECT 1 FROM omnis.test_queue_outbox')).rowCount, 1);

    const otherTask = await store.createTask({
      title: 'Another task',
      detail: 'Read another file list.',
    });
    await assert.rejects(
      store.admitRun(otherTask.id, key('concurrency'), enqueue),
      (error: unknown) => error instanceof StoreError && error.code === 'concurrency_limit',
    );
  });

  it('persists cancellation and event replay with a stable ordered cursor', async () => {
    const task = await store.createTask({
      title: 'Inspect files',
      detail: 'List files read-only.',
    });
    const admitted = await store.admitRun(task.id, key('cancel'), async (tx, { runId }) => {
      await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
      return `job-${runId}`;
    });
    await store.beginExecution(admitted.run.id, 'worker-test', 30);
    await store.requestStop(admitted.run.id);
    const cancelled = await store.cancelRun(admitted.run.id, 'worker-test');
    const events = await store.getEvents(admitted.run.id);

    assert.equal(cancelled.run.status, 'cancelled');
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['run.queued', 'run.started', 'run.stop_requested', 'run.cancelled'],
    );
    assert.equal((await store.getEvents(admitted.run.id, 2)).length, 2);
  });

  it('completes a run only when the row-lock query confirms its lease owner', async () => {
    const task = await store.createTask({
      title: 'Complete an owned run',
      detail: 'Persist deterministic synthetic output.',
    });
    const admitted = await store.admitRun(task.id, key('complete-owned'), async () => 'job');
    await store.beginExecution(admitted.run.id, 'worker-owner', 30);

    const completed = await store.completeRun(
      admitted.run.id,
      'worker-owner',
      'Synthetic result only.',
      [],
    );
    assert.equal(completed.run.status, 'completed');
    assert.deepEqual(
      (await store.getEvents(admitted.run.id)).map((event) => event.type),
      ['run.queued', 'run.started', 'run.completed'],
    );
    await assert.rejects(
      store.completeRun(admitted.run.id, 'different-worker', 'Not accepted.', []),
      (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
    );
  });

  it('delivers a durable stop request to the process holding the execution lease', async () => {
    const task = await store.createTask({
      title: 'Observe stop state',
      detail: 'A second worker process requested cancellation.',
    });
    const admitted = await store.admitRun(task.id, key('cross-worker-stop'), async () => 'job');
    await store.beginExecution(admitted.run.id, 'worker-owner', 30);
    await store.requestStop(admitted.run.id);

    assert.equal(await store.renewLease(admitted.run.id, 'worker-owner', 30), 'stop_requested');
    assert.equal(await store.renewLease(admitted.run.id, 'other-worker', 30), false);
  });

  it('acknowledges cancellation when an unstarted queued job is gone', async () => {
    const task = await store.createTask({
      title: 'Inspect files',
      detail: 'List files read-only.',
    });
    const admitted = await store.admitRun(task.id, key('queued-cancel'), async (tx, { runId }) => {
      await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
      return `job-${runId}`;
    });
    await store.requestStop(admitted.run.id);

    const recovered = await store.interruptQueuedRun(admitted.run.id, 'The queue job is missing.');
    assert.equal(recovered?.run.status, 'cancelled');
    assert.equal(recovered?.events[0]?.event.type, 'run.cancelled');
  });

  it('acknowledges a stop after pg-boss confirms the execution job is terminal', async () => {
    const task = await store.createTask({
      title: 'Settle a terminal queue job',
      detail: 'The queue reports no active executor for this run.',
    });
    const admitted = await store.admitRun(task.id, key('terminal-queue-stop'), async () => 'job');
    await store.beginExecution(admitted.run.id, 'worker-old', 30);
    await store.requestStop(admitted.run.id);

    const recovered = await store.cancelRunAfterQueueTerminal(admitted.run.id);
    assert.equal(recovered?.run.status, 'cancelled');
    assert.equal(recovered?.events[0]?.event.type, 'run.cancelled');
  });

  it('recovers an expired execution lease without replay and allows a fresh run', async () => {
    const task = await store.createTask({
      title: 'Inspect files',
      detail: 'List files read-only.',
    });
    const admitted = await store.admitRun(task.id, key('interrupted'), async (tx, { runId }) => {
      await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
      return `job-${runId}`;
    });
    await store.beginExecution(admitted.run.id, 'worker-old', 1);
    await pool!.query(
      "UPDATE omnis.runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [admitted.run.id],
    );

    const recovered = await store.reconcileExpiredRuns();
    assert.equal((await store.getRun(admitted.run.id))?.status, 'interrupted');
    assert.equal(recovered[0]?.event.type, 'run.interrupted');
    assert.equal((await store.getTask(task.id))?.status, 'open');

    const anotherTask = await store.createTask({
      title: 'Later task',
      detail: 'Read another file list.',
    });
    const later = await store.admitRun(anotherTask.id, key('fresh-run'), async (tx, { runId }) => {
      await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
      return `job-${runId}`;
    });
    assert.equal(later.created, true);
    assert.equal(later.run.status, 'queued');
    assert.equal((await store.getRun(admitted.run.id))?.status, 'interrupted');
  });

  after(async () => {
    if (pool && databaseUrl) {
      assertTestDatabase(databaseUrl);
      await pool.query(`
        TRUNCATE omnis.test_queue_outbox, omnis.run_idempotency,
          omnis.run_events, omnis.runs, omnis.tasks
      `);
      await pool.query('ALTER SEQUENCE omnis.task_id_seq RESTART WITH 1');
      await pool.query('ALTER SEQUENCE omnis.run_id_seq RESTART WITH 1');
      await pool.query('DROP TABLE IF EXISTS omnis.test_queue_outbox');
    }
    await pool?.end();
  });
});

void postgresSuite;

function key(prefix: string): string {
  return `${prefix}-${String(nextKey).padStart(4, '0')}-unique`;
}

function assertTestDatabase(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:^|[_-])test(?:s)?$/i.test(databaseName)) {
    throw new Error('OMNIS_TEST_DATABASE_URL must point to a database ending in test or tests.');
  }
}

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import {
  createPool,
  migrate,
  PostgresRunStore,
  StoreError,
  type PgBossTransaction,
} from './index.ts';
import { provisionDatabaseRoles } from './provision-roles.ts';
import { assertValidMetrics, metricsQuery } from '../../../scripts/db-recovery/metrics.mjs';

const databaseUrl = process.env.OMNIS_TEST_DATABASE_URL;
const pool = databaseUrl ? createPool(databaseUrl) : undefined;
const migrationUrl = process.env.OMNIS_TEST_MIGRATION_DATABASE_URL;
const migrationPool = migrationUrl ? createPool(migrationUrl) : undefined;
const adminUrl = process.env.OMNIS_TEST_ADMIN_DATABASE_URL;
const adminPool = adminUrl ? createPool(adminUrl) : undefined;
let nextKey = 0;
const postgresSuite = describe(
  'PostgreSQL run store',
  {
    skip: !databaseUrl || !migrationUrl || !adminUrl,
  },
  () => {
    const store = new PostgresRunStore(pool!);

    beforeEach(async () => {
      assertTestDatabase(databaseUrl!);
      await migrate(migrationPool!);
      await adminPool!.query(`
      CREATE TABLE IF NOT EXISTS omnis.test_queue_outbox (
        run_id text PRIMARY KEY
      )
    `);
      await adminPool!.query(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON omnis.test_queue_outbox TO omnis_runtime',
      );
      await adminPool!.query(
        'TRUNCATE omnis.test_queue_outbox, omnis.run_idempotency, omnis.run_events, omnis.runs, omnis.tasks',
      );
      await adminPool!.query('ALTER SEQUENCE omnis.task_id_seq RESTART WITH 1');
      await adminPool!.query('ALTER SEQUENCE omnis.run_id_seq RESTART WITH 1');
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

    it('uses a restricted runtime role without DDL or superuser privileges', async () => {
      const identity = await pool!.query<{
        current_user: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
      }>(
        `SELECT current_user, r.rolsuper, r.rolcreatedb FROM pg_roles r WHERE r.rolname = current_user`,
      );
      assert.equal(identity.rows[0]?.current_user, 'omnis_runtime');
      assert.equal(identity.rows[0]?.rolsuper, false);
      assert.equal(identity.rows[0]?.rolcreatedb, false);
      await assert.rejects(
        pool!.query('CREATE TABLE omnis.runtime_ddl_probe (id integer)'),
        /permission denied/,
      );
      await assert.rejects(pool!.query('SELECT pg_reload_conf()'), /permission denied/);
      await assert.rejects(
        pool!.query("SELECT setval('omnis.task_id_seq', 1)"),
        /permission denied/,
      );
    });

    it('preserves later migration privileges when runtime roles are re-provisioned', async () => {
      const laterMigrationTable = 'future_privilege_probe';
      const ungrantedTable = 'future_ungranted_probe';
      const laterMigrationSequence = 'future_privilege_sequence';
      const ungrantedSequence = 'future_ungranted_sequence';
      try {
        await migrationPool!.query(`
          CREATE TABLE omnis.${laterMigrationTable} (id integer PRIMARY KEY);
          INSERT INTO omnis.${laterMigrationTable} VALUES (7);
          GRANT SELECT ON omnis.${laterMigrationTable} TO omnis_runtime;
          CREATE TABLE omnis.${ungrantedTable} (id integer PRIMARY KEY);
          CREATE SEQUENCE omnis.${laterMigrationSequence};
          GRANT USAGE, SELECT ON SEQUENCE omnis.${laterMigrationSequence} TO omnis_runtime;
          CREATE SEQUENCE omnis.${ungrantedSequence};
        `);

        const migrationConnection = new URL(migrationUrl!);
        await provisionDatabaseRoles(adminPool!, {
          migration: decodeURIComponent(migrationConnection.password),
          runtime: decodeURIComponent(new URL(databaseUrl!).password),
        });

        assert.equal(
          (await pool!.query(`SELECT id FROM omnis.${laterMigrationTable}`)).rows[0]?.id,
          7,
          'a privilege added by a later migration should survive role reprovisioning',
        );
        await assert.rejects(
          pool!.query(`SELECT id FROM omnis.${ungrantedTable}`),
          /permission denied/,
          'reprovisioning must not grant access to future objects without migration approval',
        );
        await assert.rejects(
          pool!.query(`SELECT nextval('omnis.${ungrantedSequence}')`),
          /permission denied/,
          'reprovisioning must not grant access to future sequences without migration approval',
        );
        assert.equal(
          (await pool!.query(`SELECT nextval('omnis.${laterMigrationSequence}') AS value`)).rows[0]
            ?.value,
          '1',
          'a later migration sequence grant should survive role reprovisioning',
        );

        const task = await store.createTask({
          title: 'Reprovisioning regression',
          detail: 'Normal task admission remains available.',
        });
        const admitted = await store.admitRun(task.id, key('reprovisioning'), async () => 'job');
        assert.equal(admitted.created, true);
        assert.equal(admitted.run.runtimeKind, 'mock');
      } finally {
        await adminPool!.query(
          `DROP TABLE IF EXISTS omnis.${laterMigrationTable}, omnis.${ungrantedTable}; DROP SEQUENCE IF EXISTS omnis.${laterMigrationSequence}, omnis.${ungrantedSequence}`,
        );
      }
    });

    it('limits runtime changes to task/run lifecycle operations and append-only records', async () => {
      const task = await store.createTask({
        title: 'Privilege boundary fixture',
        detail: 'Exercise allowed and prohibited SQL under omnis_runtime.',
      });
      const admitted = await store.admitRun(task.id, key('least-privilege'), async () => 'job');
      const eventId = admitted.events[0]!.event.id;

      await assert.rejects(
        pool!.query('UPDATE omnis.tasks SET title = $2 WHERE id = $1', [task.id, 'tampered']),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          "INSERT INTO omnis.tasks (id, title, detail, status) VALUES ('task-9999', 'Explicit status', 'Must use the database default.', 'open')",
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          'INSERT INTO omnis.runs (id, task_id, task_title, status, runtime_kind, synthetic, usage) VALUES (\'run-9999\', $1, \'Explicit runtime\', \'queued\', \'mock\', TRUE, \'{"quality":"unknown","inputTokens":null,"outputTokens":null,"cost":null}\'::jsonb)',
          [task.id],
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('UPDATE omnis.runs SET runtime_kind = $2 WHERE id = $1', [
          admitted.run.id,
          'real',
        ]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('UPDATE omnis.runs SET retry_count = 99 WHERE id = $1', [admitted.run.id]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('UPDATE omnis.run_events SET message = $2 WHERE id = $1', [
          eventId,
          'tampered',
        ]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('DELETE FROM omnis.run_events WHERE id = $1', [eventId]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          "INSERT INTO omnis.run_events (id, run_id, sequence, event_type, source, synthetic, message) VALUES ('event-untrusted', $1, 99, 'run.output', 'mock', TRUE, 'Must use database defaults.')",
          [admitted.run.id],
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          'UPDATE omnis.run_idempotency SET request_fingerprint = $2 WHERE idempotency_key = $1',
          [key('least-privilege'), 'tampered'],
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('DELETE FROM omnis.run_idempotency WHERE idempotency_key = $1', [
          key('least-privilege'),
        ]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query("SELECT * FROM omnis.schema_migrations WHERE id = '0001_initial'"),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query("UPDATE omnis.schema_migrations SET id = 'tampered' WHERE id = '0001_initial'"),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query("DELETE FROM omnis.schema_migrations WHERE id = '0001_initial'"),
        /permission denied/,
      );

      await store.requestStop(admitted.run.id);
      const cancelled = await store.beginExecution(admitted.run.id, 'cancel-before-claim', 30);
      assert.equal(cancelled.run.status, 'cancelled');
      assert.deepEqual(
        (await store.getEvents(admitted.run.id)).map((event) => event.type),
        ['run.queued', 'run.stop_requested', 'run.cancelled'],
      );
    });

    it('detects deliberately stale task and run sequences against existing identifiers', async () => {
      const task = await store.createTask({ title: 'Sequence fixture', detail: 'Task ID check.' });
      const admitted = await store.admitRun(task.id, key('sequence-integrity'), async () => 'job');

      await adminPool!.query("SELECT setval('omnis.task_id_seq', 1, false)");
      await adminPool!.query("SELECT setval('omnis.run_id_seq', 1, false)");
      const stale = await adminPool!.query(metricsQuery);
      const staleMetrics = stale.rows[0]!.json_build_object as Record<string, unknown>;
      assert.throws(() => assertValidMetrics(staleMetrics), /task ID sequence is stale/i);

      await adminPool!.query("SELECT setval('omnis.task_id_seq', 1, true)");
      const staleRun = await adminPool!.query(metricsQuery);
      assert.throws(
        () => assertValidMetrics(staleRun.rows[0]!.json_build_object as Record<string, unknown>),
        /run ID sequence is stale/i,
      );

      await adminPool!.query("SELECT setval('omnis.run_id_seq', 1, true)");
      const safe = await adminPool!.query(metricsQuery);
      assert.doesNotThrow(() =>
        assertValidMetrics(safe.rows[0]!.json_build_object as Record<string, unknown>),
      );
      assert.equal(admitted.run.id, 'run-0001');
    });

    it('accepts empty application tables with task/run sequences not yet called', async () => {
      const report = await adminPool!.query(metricsQuery);
      const metrics = report.rows[0]!.json_build_object as Record<string, unknown> & {
        idSequences: {
          tasks: { isCalled: boolean };
          runs: { isCalled: boolean };
        };
      };
      assertValidMetrics(metrics);
      assert.deepEqual(metrics.idSequences, {
        tasks: {
          lastValue: '1',
          isCalled: false,
          incrementBy: '1',
          maxIssued: '0',
          malformedIds: 0,
          nextValue: '1',
        },
        runs: {
          lastValue: '1',
          isCalled: false,
          incrementBy: '1',
          maxIssued: '0',
          malformedIds: 0,
          nextValue: '1',
        },
      });
    });

    it('upgrades the released checksum-less migration ledger while preserving application rows', async () => {
      const task = await store.createTask({
        title: 'Upgrade fixture',
        detail: 'Preserve this row.',
      });
      const checksum = await adminPool!.query<{ checksum: string }>(
        "SELECT checksum FROM omnis.schema_migrations WHERE id = '0001_initial'",
      );
      assert.ok(checksum.rows[0]?.checksum);
      await adminPool!.query(
        "UPDATE omnis.schema_migrations SET checksum = NULL WHERE id = '0001_initial'",
      );

      await migrate(migrationPool!);

      assert.equal((await store.getTask(task.id))?.title, 'Upgrade fixture');
      const upgraded = await adminPool!.query<{ checksum: string | null }>(
        "SELECT checksum FROM omnis.schema_migrations WHERE id = '0001_initial'",
      );
      assert.equal(upgraded.rows[0]?.checksum, checksum.rows[0]!.checksum);
      assert.equal(
        (
          await adminPool!.query(
            "SELECT 1 FROM omnis.schema_migrations WHERE id = '0002_runtime_grants'",
          )
        ).rowCount,
        1,
      );
    });

    it('rejects historical migration checksum drift and serializes concurrent migrations', async () => {
      const original = await adminPool!.query<{ checksum: string }>(
        "SELECT checksum FROM omnis.schema_migrations WHERE id = '0001_initial'",
      );
      await adminPool!.query(
        "UPDATE omnis.schema_migrations SET checksum = repeat('0', 64) WHERE id = '0001_initial'",
      );
      try {
        await assert.rejects(migrate(migrationPool!), /has been modified/);
      } finally {
        await adminPool!.query(
          "UPDATE omnis.schema_migrations SET checksum = $1 WHERE id = '0001_initial'",
          [original.rows[0]!.checksum],
        );
      }

      const concurrentPool = createPool(migrationUrl!);
      try {
        await Promise.all([migrate(migrationPool!), migrate(concurrentPool)]);
      } finally {
        await concurrentPool.end();
      }
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
      const claim = await store.beginExecution(admitted.run.id, 'worker-test', 30);
      await store.requestStop(admitted.run.id);
      const cancelled = await store.cancelRun(admitted.run.id, 'worker-test', claim.generation);
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
      const claim = await store.beginExecution(admitted.run.id, 'worker-owner', 30);

      const completed = await store.completeRun(
        admitted.run.id,
        'worker-owner',
        claim.generation,
        'Synthetic result only.',
        [],
      );
      assert.equal(completed.run.status, 'completed');
      assert.deepEqual(
        (await store.getEvents(admitted.run.id)).map((event) => event.type),
        ['run.queued', 'run.started', 'run.completed'],
      );
      await assert.rejects(
        store.completeRun(
          admitted.run.id,
          'different-worker',
          claim.generation,
          'Not accepted.',
          [],
        ),
        (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
      );
    });

    it('rejects stale completion after a new worker generation owns the execution', async () => {
      const task = await store.createTask({
        title: 'Fence an old worker',
        detail: 'An old generation cannot finalize a run claimed by another worker.',
      });

      const admitted = await store.admitRun(task.id, key('stale-finalizer'), async () => 'job');
      const staleClaim = await store.beginExecution(admitted.run.id, 'worker-old', 30);
      await pool!.query(
        "UPDATE omnis.runs SET execution_generation = execution_generation + 1, lease_owner = 'worker-new' WHERE id = $1",
        [admitted.run.id],
      );
      await assert.rejects(
        store.completeRun(
          admitted.run.id,
          'worker-old',
          staleClaim.generation,
          'stale output.',
          [],
        ),
        (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
      );
      assert.equal(
        (await store.getEvents(admitted.run.id)).some((event) => event.type === 'run.completed'),
        false,
      );
      const current = await store.completeRun(
        admitted.run.id,
        'worker-new',
        staleClaim.generation + 1,
        'current output.',
        [],
      );
      assert.equal(current.run.status, 'completed');
    });

    it('allows one competing worker claim and fences stale completion, failure, heartbeat, and cancellation', async () => {
      const task = await store.createTask({
        title: 'Fence competing worker claims',
        detail: 'Only one worker may own the execution generation.',
      });
      const admitted = await store.admitRun(task.id, key('two-worker-claim'), async () => 'job');
      const secondPool = createPool(databaseUrl!);
      const secondStore = new PostgresRunStore(secondPool);
      try {
        const claimAttempts = await Promise.all([
          store.beginExecution(admitted.run.id, 'worker-alpha', 30).then((claim) => ({
            workerId: 'worker-alpha',
            claim,
          })),
          secondStore.beginExecution(admitted.run.id, 'worker-beta', 30).then((claim) => ({
            workerId: 'worker-beta',
            claim,
          })),
        ]);
        assert.equal(claimAttempts.filter(({ claim }) => claim.started).length, 1);
        assert.equal(claimAttempts.filter(({ claim }) => !claim.started).length, 1);
        const { workerId: staleWorker, claim } = claimAttempts.find(
          ({ claim: attempt }) => attempt.started,
        )!;
        const currentWorker = staleWorker === 'worker-alpha' ? 'worker-beta' : 'worker-alpha';
        const currentGeneration = claim.generation + 1;

        await pool!.query(
          "UPDATE omnis.runs SET execution_generation = $2, lease_owner = $3, lease_expires_at = now() + interval '30 seconds' WHERE id = $1",
          [admitted.run.id, currentGeneration, currentWorker],
        );
        await assert.rejects(
          store.completeRun(admitted.run.id, staleWorker, claim.generation, 'stale output.', []),
          (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
        );
        await assert.rejects(
          store.failRun(admitted.run.id, staleWorker, claim.generation, 'stale failure.'),
          (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
        );
        assert.equal(
          await store.renewLease(admitted.run.id, staleWorker, claim.generation, 30),
          false,
        );
        assert.equal(
          await store.appendOutput(admitted.run.id, staleWorker, claim.generation, 'stale output'),
          undefined,
        );

        await store.requestStop(admitted.run.id);
        await assert.rejects(
          store.cancelRun(admitted.run.id, staleWorker, claim.generation),
          (error: unknown) => error instanceof StoreError && error.code === 'conflict',
        );
        await store.cancelRun(admitted.run.id, currentWorker, currentGeneration);
        await assert.rejects(
          store.completeRun(admitted.run.id, currentWorker, currentGeneration, 'late output.', []),
          (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
        );
        await assert.rejects(
          store.failRun(admitted.run.id, currentWorker, currentGeneration, 'late failure.'),
          (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
        );
        assert.equal(
          (await store.getEvents(admitted.run.id)).filter((event) => event.type === 'run.started')
            .length,
          1,
        );
      } finally {
        await secondPool.end();
      }
    });

    it('persists sandbox failure state and a safe ordered failure event', async () => {
      const task = await store.createTask({
        title: 'Exercise the isolated runtime',
        detail: 'The trusted worker owns this task and failure state.',
      });
      const admitted = await store.admitRun(task.id, key('sandbox-failure'), async () => 'job');
      const claim = await store.beginExecution(admitted.run.id, 'worker-sandbox', 30);

      const failed = await store.failRun(
        admitted.run.id,
        'worker-sandbox',
        claim.generation,
        'The sandbox execution exceeded its time limit.',
      );

      assert.equal(failed.run.status, 'failed');
      assert.deepEqual(
        (await store.getEvents(admitted.run.id)).map((event) => [event.sequence, event.type]),
        [
          [1, 'run.queued'],
          [2, 'run.started'],
          [3, 'run.failed'],
        ],
      );
      assert.equal(
        (await store.getEvents(admitted.run.id))[2]?.message,
        'The sandbox execution exceeded its time limit.',
      );
      assert.equal((await store.getTask(task.id))?.status, 'open');
    });

    it('delivers a durable stop request to the process holding the execution lease', async () => {
      const task = await store.createTask({
        title: 'Observe stop state',
        detail: 'A second worker process requested cancellation.',
      });
      const admitted = await store.admitRun(task.id, key('cross-worker-stop'), async () => 'job');
      const claim = await store.beginExecution(admitted.run.id, 'worker-owner', 30);
      await store.requestStop(admitted.run.id);

      assert.equal(
        await store.renewLease(admitted.run.id, 'worker-owner', claim.generation, 30),
        'stop_requested',
      );
      assert.equal(
        await store.renewLease(admitted.run.id, 'other-worker', claim.generation, 30),
        false,
      );
    });

    it('does not let an expired worker lease be revived by a late heartbeat', async () => {
      const task = await store.createTask({
        title: 'Reject stale lease heartbeat',
        detail: 'Expired lease ownership cannot be reclaimed without a new run.',
      });
      const admitted = await store.admitRun(
        task.id,
        key('expired-lease-heartbeat'),
        async () => 'job',
      );
      const claim = await store.beginExecution(admitted.run.id, 'stale-worker', 30);
      await pool!.query(
        "UPDATE omnis.runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [admitted.run.id],
      );

      assert.equal(
        await store.renewLease(admitted.run.id, 'stale-worker', claim.generation, 30),
        false,
      );
      assert.deepEqual(await store.listActiveRunIds([admitted.run.id]), []);
    });

    it('acknowledges cancellation when an unstarted queued job is gone', async () => {
      const task = await store.createTask({
        title: 'Inspect files',
        detail: 'List files read-only.',
      });
      const admitted = await store.admitRun(
        task.id,
        key('queued-cancel'),
        async (tx, { runId }) => {
          await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
          return `job-${runId}`;
        },
      );
      await store.requestStop(admitted.run.id);

      const recovered = await store.interruptQueuedRun(
        admitted.run.id,
        'The queue job is missing.',
      );
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
      assert.ok((await store.listActiveRunIds()).includes(admitted.run.id));
      await pool!.query(
        "UPDATE omnis.runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [admitted.run.id],
      );

      const recovered = await store.reconcileExpiredRuns();
      assert.equal((await store.getRun(admitted.run.id))?.status, 'interrupted');
      assert.equal(recovered[0]?.event.type, 'run.interrupted');
      assert.equal((await store.getTask(task.id))?.status, 'open');
      assert.equal((await store.listActiveRunIds()).includes(admitted.run.id), false);

      const anotherTask = await store.createTask({
        title: 'Later task',
        detail: 'Read another file list.',
      });
      const later = await store.admitRun(
        anotherTask.id,
        key('fresh-run'),
        async (tx, { runId }) => {
          await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
          return `job-${runId}`;
        },
      );
      assert.equal(later.created, true);
      assert.equal(later.run.status, 'queued');
      assert.equal((await store.getRun(admitted.run.id))?.status, 'interrupted');
    });

    after(async () => {
      if (pool && databaseUrl) {
        assertTestDatabase(databaseUrl);
        await adminPool!.query(`
        TRUNCATE omnis.test_queue_outbox, omnis.run_idempotency,
          omnis.run_events, omnis.runs, omnis.tasks
      `);
        await adminPool!.query('ALTER SEQUENCE omnis.task_id_seq RESTART WITH 1');
        await adminPool!.query('ALTER SEQUENCE omnis.run_id_seq RESTART WITH 1');
        await adminPool!.query('DROP TABLE IF EXISTS omnis.test_queue_outbox');
      }
      await pool?.end();
      await migrationPool?.end();
      await adminPool?.end();
    });
  },
);

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

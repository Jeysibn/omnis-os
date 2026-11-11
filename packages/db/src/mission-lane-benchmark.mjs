import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';

const repoRoot = path.resolve(
  process.env.OMNIS_BENCHMARK_SOURCE_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
);
const databaseUrl = process.env.OMNIS_BENCHMARK_DATABASE_URL;
const adminUrl = process.env.OMNIS_BENCHMARK_ADMIN_DATABASE_URL;
const authorizerUrl = process.env.OMNIS_BENCHMARK_AUTHORIZER_DATABASE_URL;
const operation = process.env.OMNIS_BENCHMARK_OPERATION;
const version = process.env.OMNIS_BENCHMARK_VERSION;
const concurrency = Number(process.env.OMNIS_BENCHMARK_CONCURRENCY ?? '1');
const count = Number(process.env.OMNIS_BENCHMARK_COUNT ?? '10000');
const batchSize = Number(process.env.OMNIS_BENCHMARK_BATCH_SIZE ?? '1000');
const warmupCount = Number(process.env.OMNIS_BENCHMARK_WARMUP ?? '200');
const allowedOperations = new Set([
  'create',
  'assign',
  'reassign',
  'mixed-complete',
  'mixed-cancel',
  'mixed-expire',
]);

assert.ok(databaseUrl && adminUrl, 'Disposable database URLs are required.');
if (operation.startsWith('mixed-'))
  assert.ok(authorizerUrl, 'Mixed lifecycle profiles require the authorizer role.');
assert.ok(allowedOperations.has(operation), 'Benchmark operation is not supported.');
assert.ok(
  ['baseline', 'unbounded', 'candidate'].includes(version),
  'Benchmark version identity is required.',
);
assert.ok([1, 4].includes(concurrency), 'Supported benchmark concurrency is 1 or 4.');
assert.ok(
  Number.isInteger(count) && count >= 1000,
  'Each measured repetition must contain at least 1,000 operations.',
);
assert.ok(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 1000);
assert.ok(Number.isInteger(warmupCount) && warmupCount >= 100);

const { PostgresRunStore } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/db/src/run-store.ts')).href
);
const { createPool } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/db/src/database.ts')).href
);
const { PostgresAuthorizationStore } = operation.startsWith('mixed-')
  ? await import(pathToFileURL(path.join(repoRoot, 'packages/db/src/authorization-store.ts')).href)
  : { PostgresAuthorizationStore: undefined };
const writerPool = createPool({
  connectionString: databaseUrl,
  max: 8,
  application_name: 'mission-lane-benchmark-writer',
});
const adminPool = new Pool({
  connectionString: adminUrl,
  max: 2,
  application_name: 'mission-lane-benchmark-fixture',
});
const authorizerPool = authorizerUrl
  ? createPool({
      connectionString: authorizerUrl,
      max: 2,
      application_name: 'mission-lane-benchmark-authorizer',
    })
  : undefined;
const store = new PostgresRunStore(writerPool);
const authorizationStore = PostgresAuthorizationStore
  ? new PostgresAuthorizationStore(writerPool, authorizerPool)
  : undefined;
const mutationQueryTimings = [];
const readQueryTimings = [];
const poolCheckoutTimings = [];
const instrumentedClients = new WeakSet();
let collectMutationTimings = false;
const originalPoolConnect = writerPool.connect.bind(writerPool);
const instrumentClient = (client) => {
  if (instrumentedClients.has(client)) return;
  instrumentedClients.add(client);
  const originalClientQuery = client.query.bind(client);
  client.query = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
    const isMutation =
      collectMutationTimings && /SELECT\s+omnis\.(create_task|set_task_project)\(/i.test(sql);
    const isRead = collectMutationTimings && /SELECT\s+.*FROM\s+omnis\.tasks\b/i.test(sql);
    if (!isMutation && !isRead) return originalClientQuery(...args);
    const started = process.hrtime.bigint();
    const callbackIndex = args.findIndex((argument) => typeof argument === 'function');
    const record = () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      if (isMutation) mutationQueryTimings.push(elapsed);
      if (isRead) readQueryTimings.push(elapsed);
    };
    if (callbackIndex >= 0) {
      const wrappedArgs = [...args];
      const callback = wrappedArgs[callbackIndex];
      wrappedArgs[callbackIndex] = (...callbackArgs) => {
        record();
        callback(...callbackArgs);
      };
      return originalClientQuery(...wrappedArgs);
    }
    return originalClientQuery(...args).then(
      (result) => {
        record();
        return result;
      },
      (error) => {
        record();
        throw error;
      },
    );
  };
};
writerPool.connect = (...args) => {
  const started = process.hrtime.bigint();
  const callback = args[0];
  if (typeof callback === 'function') {
    return originalPoolConnect((error, client) => {
      if (!error && client) instrumentClient(client);
      if (collectMutationTimings)
        poolCheckoutTimings.push(Number(process.hrtime.bigint() - started) / 1e6);
      callback(error, client);
    });
  }
  return originalPoolConnect(...args).then((client) => {
    if (collectMutationTimings)
      poolCheckoutTimings.push(Number(process.hrtime.bigint() - started) / 1e6);
    instrumentClient(client);
    return client;
  });
};
const projectA = 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const projectB = 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const eventsAreProjected = await adminPool.query(
  "SELECT to_regclass('omnis.mission_lane_events') IS NOT NULL AS enabled",
);
const hasProjection = eventsAreProjected.rows[0].enabled;
const sourceSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const sourceDirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)
  .some((entry) => !entry.endsWith('node_modules'));
const expectedSourceSha = {
  baseline: 'be9e734f134e5a9442bc1eaed989473efd1ac7a6',
  unbounded: '8e8d6a57c330e4d35b804ad2abc8cc789933c594',
  candidate: process.env.OMNIS_BENCHMARK_EXPECTED_SOURCE_SHA,
}[version];
const expectedMigration = {
  baseline: '0028_synthetic_broker_fencing',
  unbounded: '0029_mission_lane_events',
  candidate: '0030_mission_lane_admission',
}[version];

try {
  const disposable = process.env.OMNIS_BENCHMARK_DISPOSABLE === '1';
  const identity = await adminPool.query(
    "SELECT current_database() AS database_name, current_user AS role_name, current_setting('is_superuser')::boolean AS is_superuser, inet_server_addr()::text AS server_address, inet_server_port() AS server_port, current_setting('server_version_num')::integer AS server_version_num",
  );
  const writerIdentity = await writerPool.query(
    "SELECT current_database() AS database_name, current_user AS role_name, current_setting('is_superuser')::boolean AS is_superuser, inet_server_addr()::text AS server_address, inet_server_port() AS server_port, current_setting('server_version_num')::integer AS server_version_num",
  );
  const authorizerIdentity = authorizerPool
    ? await authorizerPool.query(
        "SELECT current_database() AS database_name, current_user AS role_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port, current_setting('server_version_num')::integer AS server_version_num",
      )
    : undefined;
  assert.ok(
    disposable,
    'Set OMNIS_BENCHMARK_DISPOSABLE=1 only for a disposable benchmark database.',
  );
  assert.match(
    identity.rows[0].database_name,
    /^omnis_(baseline|candidate|unbounded|benchmark)(?:_[a-z0-9]+)?$/,
    'Refusing destructive benchmark setup outside a disposable benchmark database.',
  );
  assert.equal(
    identity.rows[0].is_superuser,
    true,
    'Fixture setup requires the isolated benchmark admin role.',
  );
  assert.equal(identity.rows[0].role_name, 'omnis');
  assert.equal(writerIdentity.rows[0].role_name, 'omnis_runtime');
  assert.equal(writerIdentity.rows[0].is_superuser, false);
  assert.equal(writerIdentity.rows[0].database_name, identity.rows[0].database_name);
  assert.equal(writerIdentity.rows[0].server_address, identity.rows[0].server_address);
  assert.equal(writerIdentity.rows[0].server_port, identity.rows[0].server_port);
  if (authorizerIdentity) {
    assert.equal(authorizerIdentity.rows[0].database_name, identity.rows[0].database_name);
    assert.equal(authorizerIdentity.rows[0].role_name, 'omnis_authorizer');
    assert.equal(authorizerIdentity.rows[0].server_address, identity.rows[0].server_address);
    assert.equal(authorizerIdentity.rows[0].server_port, identity.rows[0].server_port);
  }
  assert.equal(
    writerIdentity.rows[0].server_version_num,
    170006,
    'Benchmark requires PostgreSQL 17.6.',
  );
  assert.equal(identity.rows[0].server_version_num, 170006, 'Benchmark requires PostgreSQL 17.6.');
  assert.equal(
    sourceSha,
    expectedSourceSha,
    'Set OMNIS_BENCHMARK_EXPECTED_SOURCE_SHA to the exact candidate source revision.',
  );
  assert.equal(
    sourceDirty,
    false,
    'Benchmark source tree must be clean for every comparison revision.',
  );
  const migrations = await adminPool.query(
    'SELECT max(id) AS latest, count(*)::integer AS count FROM omnis.schema_migrations',
  );
  assert.equal(
    migrations.rows[0].latest,
    expectedMigration,
    'Database migration ledger must match the selected source version.',
  );
  await ensureProjects();
  await resetFixture();
  if (['assign', 'reassign'].includes(operation))
    await seedTasks(warmupCount, operation === 'reassign');
  const warmup = await runBatch(warmupCount, true);
  const timings = [];
  const runOutcomeTimings = [];
  const batchDurations = [];
  const invariants = [];
  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset);
    await resetFixture();
    if (['assign', 'reassign'].includes(operation)) await seedTasks(size, operation === 'reassign');
    const result = await runBatch(size, false);
    timings.push(...result.timings);
    runOutcomeTimings.push(...result.runOutcomeTimings);
    batchDurations.push(result.durationMs);
    invariants.push(await verifyBatch(size));
  }
  timings.sort((a, b) => a - b);
  runOutcomeTimings.sort((a, b) => a - b);
  mutationQueryTimings.sort((a, b) => a - b);
  readQueryTimings.sort((a, b) => a - b);
  poolCheckoutTimings.sort((a, b) => a - b);
  const elapsedMs = batchDurations.reduce((sum, value) => sum + value, 0);
  const samplesPath = process.env.OMNIS_BENCHMARK_SAMPLES_PATH;
  if (samplesPath) {
    await writeFile(
      samplesPath,
      `${JSON.stringify({
        requestMs: timings,
        mutationQueryMs: mutationQueryTimings,
        readQueryMs: readQueryTimings,
        poolCheckoutMs: poolCheckoutTimings,
        runOutcomeMs: runOutcomeTimings,
      })}\n`,
      { flag: 'wx' },
    );
  }
  const summary = {
    operation,
    version,
    sourceSha,
    sourceDirty,
    databaseName: identity.rows[0].database_name,
    postgresVersion: identity.rows[0].server_version_num,
    migrationHead: migrations.rows[0].latest,
    concurrency,
    measuredOperations: timings.length,
    warmupOperations: warmup.timings.length,
    repetitions: Number(process.env.OMNIS_BENCHMARK_REPETITION ?? '1'),
    p50Ms: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    p99Ms: percentile(timings, 0.99),
    maxMs: timings.at(-1),
    runOutcomeCount: runOutcomeTimings.length,
    runOutcomeP50Ms: runOutcomeTimings.length ? percentile(runOutcomeTimings, 0.5) : null,
    runOutcomeP95Ms: runOutcomeTimings.length ? percentile(runOutcomeTimings, 0.95) : null,
    runOutcomeMaxMs: runOutcomeTimings.length ? runOutcomeTimings.at(-1) : null,
    databaseMutationQueryP50Ms: percentile(mutationQueryTimings, 0.5),
    databaseMutationQueryP95Ms: percentile(mutationQueryTimings, 0.95),
    databaseMutationQueryP99Ms: percentile(mutationQueryTimings, 0.99),
    databaseMutationQueryMaxMs: mutationQueryTimings.at(-1),
    databaseReadQueryP50Ms: readQueryTimings.length ? percentile(readQueryTimings, 0.5) : null,
    databaseReadQueryP95Ms: readQueryTimings.length ? percentile(readQueryTimings, 0.95) : null,
    poolCheckoutP50Ms: poolCheckoutTimings.length ? percentile(poolCheckoutTimings, 0.5) : null,
    poolCheckoutP95Ms: poolCheckoutTimings.length ? percentile(poolCheckoutTimings, 0.95) : null,
    poolCheckoutMaxMs: poolCheckoutTimings.length ? Math.max(...poolCheckoutTimings) : null,
    throughputOpsPerSecond: Math.round((timings.length / (elapsedMs / 1000)) * 100) / 100,
    measuredWallMs: Math.round(elapsedMs),
    projectedEvents: hasProjection,
    fixtureBatches: invariants.length,
    integrity: invariants.every(Boolean),
    samplesPath: samplesPath ?? null,
    cursorWaitSampling:
      'not available from the application client; collect separately through pg_locks/pg_stat_activity',
  };
  assert.equal(
    summary.integrity,
    true,
    'Each measured batch must have exact source/event counts and valid sequence continuity.',
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  await writerPool.end();
  await authorizerPool?.end();
  await adminPool.end();
}

async function ensureProjects() {
  await adminPool.query(
    `INSERT INTO omnis.projects(id,owner_id,project_key,name,objective_md,status,priority)
     VALUES ($1,'owner','BENCH-A','Benchmark A','Disposable benchmark project A.','active','normal'),
            ($2,'owner','BENCH-B','Benchmark B','Disposable benchmark project B.','active','normal')
     ON CONFLICT (id) DO NOTHING`,
    [projectA, projectB],
  );
  const projects = await adminPool.query(
    'SELECT id,project_key,name,objective_md,status FROM omnis.projects WHERE id=ANY($1::text[]) ORDER BY id',
    [[projectA, projectB]],
  );
  assert.deepEqual(
    projects.rows,
    [
      {
        id: projectA,
        project_key: 'BENCH-A',
        name: 'Benchmark A',
        objective_md: 'Disposable benchmark project A.',
        status: 'active',
      },
      {
        id: projectB,
        project_key: 'BENCH-B',
        name: 'Benchmark B',
        objective_md: 'Disposable benchmark project B.',
        status: 'active',
      },
    ].sort((left, right) => left.id.localeCompare(right.id)),
    'Existing benchmark project IDs must match the disposable fixture exactly.',
  );
}

async function resetFixture() {
  await adminPool.query('TRUNCATE omnis.tasks RESTART IDENTITY CASCADE');
  await adminPool.query('ALTER SEQUENCE omnis.task_id_seq RESTART WITH 1');
  await adminPool.query('ALTER SEQUENCE omnis.run_id_seq RESTART WITH 1');
  if (hasProjection) {
    await adminPool.query('TRUNCATE omnis.mission_lane_events');
    await adminPool.query(
      'UPDATE omnis.mission_lane_clock SET last_global_sequence=0 WHERE singleton',
    );
  }
}

async function seedTasks(size, assigned) {
  let cursor = 0;
  const fixtureStore = new PostgresRunStore(writerPool);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, size) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= size) return;
        await fixtureStore.createTask(
          {
            title: `Benchmark fixture ${index}`,
            detail: 'Disposable synthetic benchmark fixture.',
            ...(assigned ? { projectId: projectA } : {}),
          },
          randomUUID(),
        );
      }
    }),
  );
  if (hasProjection) {
    await adminPool.query('TRUNCATE omnis.mission_lane_events');
    await adminPool.query(
      'UPDATE omnis.mission_lane_clock SET last_global_sequence=0 WHERE singleton',
    );
  }
}

async function runBatch(size, isWarmup) {
  const timings = [];
  const runOutcomeTimings = [];
  let runAdmission;
  if (operation.startsWith('mixed-')) {
    runAdmission = await prepareRun();
    if (hasProjection) {
      await adminPool.query('TRUNCATE omnis.mission_lane_events');
      await adminPool.query(
        'UPDATE omnis.mission_lane_clock SET last_global_sequence=0 WHERE singleton',
      );
    }
  }
  let cursor = 0;
  const started = process.hrtime.bigint();
  collectMutationTimings = !isWarmup;
  try {
    const taskMutations = Promise.all(
      Array.from({ length: Math.min(concurrency, size) }, async () => {
        for (;;) {
          const index = cursor++;
          if (index >= size) return;
          const startedOperation = process.hrtime.bigint();
          const taskId = `task-${String(index + 1).padStart(4, '0')}`;
          if (operation === 'create' || operation.startsWith('mixed-')) {
            await store.createTask(
              {
                title: `Mission Lane benchmark ${index}`,
                detail: 'Disposable synthetic benchmark operation.',
              },
              randomUUID(),
            );
          } else {
            await store.setTaskProject(
              taskId,
              {
                expectedAssociationRevision: 1,
                projectId: operation === 'assign' ? projectA : projectB,
              },
              randomUUID(),
            );
          }
          timings.push(Number(process.hrtime.bigint() - startedOperation) / 1e6);
        }
      }),
    );
    const runOutcome = runAdmission
      ? (async () => {
          const outcomeStarted = process.hrtime.bigint();
          if (operation === 'mixed-complete') {
            await store.completeRun(
              runAdmission.run.id,
              runAdmission.workerId,
              runAdmission.generation,
              'Synthetic benchmark completion.',
            );
          } else if (operation === 'mixed-cancel') {
            await store.requestStop(runAdmission.run.id);
            await store.cancelRun(
              runAdmission.run.id,
              runAdmission.workerId,
              runAdmission.generation,
            );
          } else {
            await adminPool.query(
              "UPDATE omnis.runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
              [runAdmission.run.id],
            );
            await store.reconcileExpiredRuns();
          }
          runOutcomeTimings.push(Number(process.hrtime.bigint() - outcomeStarted) / 1e6);
        })()
      : Promise.resolve();
    await Promise.all([taskMutations, runOutcome]);
  } finally {
    collectMutationTimings = false;
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { timings, runOutcomeTimings, durationMs, isWarmup };
}

async function prepareRun() {
  const task = await store.createTask(
    {
      title: 'Mission Lane mixed Run fixture',
      detail: 'Disposable mock-only Run benchmark fixture.',
    },
    randomUUID(),
  );
  const grant = await authorizationStore.request(task.id, 'owner');
  await authorizationStore.decide(grant.id, 'owner', 'approve');
  const admission = await store.admitRun(task.id, randomUUID(), grant.id, async () => 'bench-job');
  const workerId = 'mission-lane-benchmark-worker';
  const claim = await store.beginExecution(admission.run.id, workerId, 30);
  assert.equal(
    claim.started,
    true,
    'Mock-only benchmark Run must enter running before measurement.',
  );
  return { run: admission.run, workerId, generation: claim.generation };
}

async function verifyBatch(expectedEvents) {
  const mixed = operation.startsWith('mixed-');
  const sources = await adminPool.query(
    operation === 'create' || mixed
      ? 'SELECT count(*)::text FROM omnis.tasks'
      : `SELECT count(*)::text FROM omnis.task_project_management_audit WHERE action = '${operation === 'assign' ? 'assigned' : 'reassigned'}'`,
  );
  const expectedTaskCount = expectedEvents + (mixed ? 1 : 0);
  assert.equal(
    Number(sources.rows[0].count),
    expectedTaskCount,
    'Source mutation count must match the workload.',
  );
  if (mixed) {
    const expectedRunStatus =
      operation === 'mixed-complete'
        ? 'completed'
        : operation === 'mixed-cancel'
          ? 'cancelled'
          : 'interrupted';
    const run = await adminPool.query(
      'SELECT status,count(*)::text AS count FROM omnis.runs GROUP BY status',
    );
    assert.deepEqual(run.rows, [{ status: expectedRunStatus, count: '1' }]);
  }
  if (!hasProjection) return true;
  const expectedEventType =
    operation === 'create'
      ? 'task.created'
      : operation === 'assign'
        ? 'task.project_assigned'
        : operation === 'reassign'
          ? 'task.project_reassigned'
          : undefined;
  const expectedMissionEvents = expectedEvents + (operation === 'mixed-cancel' ? 3 : mixed ? 2 : 0);
  const ledger = await adminPool.query(
    `SELECT count(*)::text, min(global_sequence)::text, max(global_sequence)::text,
            (SELECT last_global_sequence::text FROM omnis.mission_lane_clock WHERE singleton) AS last
       FROM omnis.mission_lane_events`,
  );
  const row = ledger.rows[0];
  assert.equal(
    Number(row.count),
    expectedMissionEvents,
    'Each source mutation must project one Mission Lane event.',
  );
  assert.equal(Number(row.min), 1);
  assert.equal(Number(row.max), expectedMissionEvents);
  assert.equal(Number(row.last), expectedMissionEvents);
  const taskEvents = await adminPool.query(
    `SELECT count(*)::text FROM omnis.mission_lane_events WHERE event_type=$1`,
    [mixed ? 'task.created' : expectedEventType],
  );
  assert.equal(Number(taskEvents.rows[0].count), expectedEvents);
  if (mixed) {
    const expectedRunTypes =
      operation === 'mixed-complete'
        ? ['run.completed']
        : operation === 'mixed-cancel'
          ? ['run.stop_requested', 'run.cancelled']
          : ['run.interrupted'];
    const runEvents = await adminPool.query(
      "SELECT event_type FROM omnis.mission_lane_events WHERE source_kind='run' ORDER BY global_sequence",
    );
    assert.deepEqual(
      runEvents.rows.map((event) => event.event_type),
      expectedRunTypes,
    );
    const taskStatus = await adminPool.query(
      "SELECT payload FROM omnis.mission_lane_events WHERE event_type='task.status_changed'",
    );
    assert.equal(taskStatus.rowCount, 1);
    assert.equal(
      taskStatus.rows[0].payload.to,
      operation === 'mixed-complete' ? 'completed' : 'open',
    );
  }
  if (operation === 'reassign') {
    const context = await adminPool.query(
      'SELECT count(*)::text FROM omnis.mission_lane_events WHERE previous_project_id=$1 AND project_id=$2',
      [projectA, projectB],
    );
    assert.equal(
      Number(context.rows[0].count),
      expectedEvents,
      'Reassignment must preserve event-time project context.',
    );
  }
  return true;
}

function percentile(values, fraction) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

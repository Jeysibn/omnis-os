import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../../packages/db/src/index.ts';

const scrypt = promisify(scryptCallback);
const password = 'test-owner-password-2026';
const origin = 'http://127.0.0.1:5173';
const databaseUrl = process.env.OMNIS_TEST_DATABASE_URL;
const migrationUrl = process.env.OMNIS_TEST_MIGRATION_DATABASE_URL;
const authorizerUrl = process.env.OMNIS_TEST_AUTHORIZER_DATABASE_URL;
const adminAuditUrl = process.env.OMNIS_TEST_ADMIN_DATABASE_URL;
if (!databaseUrl)
  throw new Error('Set OMNIS_TEST_DATABASE_URL to a disposable PostgreSQL database.');
if (!migrationUrl)
  throw new Error(
    'Set OMNIS_TEST_MIGRATION_DATABASE_URL to a disposable migration-role connection.',
  );
if (!authorizerUrl || new URL(authorizerUrl).username !== 'omnis_authorizer')
  throw new Error('Set OMNIS_TEST_AUTHORIZER_DATABASE_URL to the restricted authorization role.');
if (!adminAuditUrl || new URL(adminAuditUrl).username !== 'omnis')
  throw new Error('Set OMNIS_TEST_ADMIN_DATABASE_URL to the disposable test administrator URL.');
if (!/(?:^|[_-])test(?:s)?$/i.test(new URL(databaseUrl).pathname.slice(1))) {
  throw new Error('OMNIS_TEST_DATABASE_URL must point to a database ending in test or tests.');
}
if (new URL(databaseUrl).username !== 'omnis_runtime') {
  throw new Error('OMNIS_TEST_DATABASE_URL must use the restricted omnis_runtime role.');
}
if (new URL(migrationUrl).username !== 'omnis_migrator') {
  throw new Error('OMNIS_TEST_MIGRATION_DATABASE_URL must use omnis_migrator.');
}
const migration = spawnSync(process.execPath, ['--experimental-strip-types', 'src/migrate.ts'], {
  cwd: new URL('../../apps/worker/', import.meta.url),
  env: { ...withoutDatabaseSecrets(process.env), OMNIS_MIGRATION_DATABASE_URL: migrationUrl },
  encoding: 'utf8',
});
if (migration.error || migration.status !== 0) {
  throw new Error(
    `Disposable PostgreSQL migrations failed (exit ${migration.status ?? 'unknown'}).`,
  );
}
const tempDirectory = await mkdtemp(join(tmpdir(), 'omnis-os-mock-smoke-'));
const workerEnvPath = join(tempDirectory, 'worker.env');
const apiEnvPath = join(tempDirectory, 'api.env');
const authorizerEnvPath = join(tempDirectory, 'authorizer.env');
const canaryName = `OMNIS_DUMMY_PROVIDER_SECRET_${randomBytes(12).toString('hex')}`;
const canary = `OMNIS_SYNTHETIC_CANARY_${randomBytes(24).toString('hex')}`;
const auditPool = createPool({
  connectionString: adminAuditUrl,
  max: 1,
  application_name: 'omnis-canary-check',
});
const apiPort = await freePort();
const workerPort = await freePort(new Set([apiPort]));
const authorizerPort = await freePort(new Set([apiPort, workerPort]));
const salt = randomBytes(16);
const internalToken = randomBytes(48).toString('hex');
const authorizerToken = randomBytes(48).toString('hex');
const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
const sharedEnvLines = [
  `OMNIS_OWNER_PASSWORD_HASH=${salt.toString('hex')}:${passwordHash}`,
  `OMNIS_SESSION_SECRET=${randomBytes(48).toString('hex')}`,
  `OMNIS_INTERNAL_TOKEN=${internalToken}`,
  `OMNIS_API_AUTHORIZER_TOKEN=${authorizerToken}`,
  `OMNIS_API_HOST=127.0.0.1`,
  `OMNIS_API_PORT=${apiPort}`,
  `OMNIS_WORKER_HOST=127.0.0.1`,
  `OMNIS_WORKER_PORT=${workerPort}`,
  'OMNIS_AUTHORIZER_HOST=127.0.0.1',
  `OMNIS_AUTHORIZER_PORT=${authorizerPort}`,
  `OMNIS_ALLOWED_ORIGIN=${origin}`,
  'OMNIS_SECURE_COOKIES=false',
];
await writeFile(apiEnvPath, `${sharedEnvLines.join('\n')}\n`, { mode: 0o600 });
await writeFile(
  workerEnvPath,
  `${[...sharedEnvLines.filter((line) => !line.startsWith('OMNIS_API_AUTHORIZER_TOKEN=')), `OMNIS_DATABASE_URL=${databaseUrl}`].join('\n')}\n`,
  { mode: 0o600 },
);
await writeFile(
  authorizerEnvPath,
  [
    `OMNIS_API_AUTHORIZER_TOKEN=${authorizerToken}`,
    `OMNIS_AUTHORIZER_DATABASE_URL=${authorizerUrl}`,
    'OMNIS_AUTHORIZER_HOST=127.0.0.1',
    `OMNIS_AUTHORIZER_PORT=${authorizerPort}`,
  ].join('\n') + '\n',
  { mode: 0o600 },
);

let worker = startWorker(workerEnvPath);
let authorizer = startAuthorizer(authorizerEnvPath);
let api = startApi(apiEnvPath);

try {
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  await waitForHealth(
    baseUrl,
    `http://127.0.0.1:${workerPort}`,
    internalToken,
    worker,
    api,
    `http://127.0.0.1:${authorizerPort}`,
    authorizer,
  );

  const workerEnvText = await readFile(workerEnvPath, 'utf8');
  assert.doesNotMatch(
    workerEnvText,
    /OMNIS_(?:AUTHORIZER_DB_PASSWORD|AUTHORIZER_DATABASE_URL|API_AUTHORIZER_TOKEN)/,
  );
  const runtimeAuthorizerProbe = await fetch(
    `http://127.0.0.1:${authorizerPort}/internal/v1/authorizations`,
    {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-0001' }),
    },
  );
  assert.equal(runtimeAuthorizerProbe.status, 401);

  const health = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).product, 'Omnis OS');

  const csrfResponse = await fetch(`${baseUrl}/api/v1/auth/csrf`);
  const anonCookie = cookieValue(csrfResponse);
  const csrf = (await csrfResponse.json()).csrfToken;
  assert.equal(
    (await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie: anonCookie } })).status,
    401,
  );

  const blockedMutation = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      cookie: anonCookie,
      origin: 'https://untrusted.invalid',
      'x-omnis-csrf': csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: 'Blocked task', detail: 'This mutation must be denied.' }),
  });
  assert.equal(blockedMutation.status, 401);

  const invalidLogin = () =>
    fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        cookie: anonCookie,
        origin,
        'x-omnis-csrf': csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ password: 'incorrect synthetic password' }),
    });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await invalidLogin()).status, 401);
  }
  const throttledInvalid = await invalidLogin();
  assert.equal(throttledInvalid.status, 429);
  assert.equal(throttledInvalid.headers.get('retry-after'), '1');
  const throttledValid = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      cookie: anonCookie,
      origin,
      'x-omnis-csrf': csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  assert.equal(throttledValid.status, 429);
  await delay(1_100);

  let { ownerCookie, ownerCsrf } = await signInOwner(baseUrl);
  assert.equal(
    (await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie: ownerCookie } })).status,
    200,
  );

  const csrfRejected = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin: 'https://untrusted.invalid',
      'x-omnis-csrf': ownerCsrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: 'Blocked task', detail: 'This mutation must be denied.' }),
  });
  assert.equal(csrfRejected.status, 403);

  const createTask = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Inspect workspace files',
      detail: 'List files without changing them.',
    }),
  });
  assert.equal(createTask.status, 201);
  const task = await createTask.json();

  const forgedOwnerAdmission = await fetch(`http://127.0.0.1:${workerPort}/internal/v1/runs`, {
    method: 'POST',
    headers: {
      'x-omnis-internal-token': internalToken,
      'x-omnis-trusted-actor': 'owner',
      'idempotency-key': `forged-owner-${randomUUID()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: task.id,
      authorizationId: '00000000-0000-4000-8000-000000000001',
    }),
  });
  assert.equal(forgedOwnerAdmission.status, 409);
  assert.equal((await forgedOwnerAdmission.json()).error.code, 'invalid_transition');
  assert.equal(
    (await auditPool.query('SELECT 1 FROM omnis.runs WHERE task_id=$1', [task.id])).rowCount,
    0,
  );

  await stopProcess(authorizer);
  const failedAuthorization = await fetch(`${baseUrl}/api/v1/authorizations`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'idempotency-key': randomUUID(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: task.id }),
  });
  assert.equal(failedAuthorization.status, 503);
  assert.equal((await failedAuthorization.json()).error.code, 'authorizer_unavailable');
  assert.equal(
    (
      await auditPool.query('SELECT 1 FROM omnis.runtime_authorizations WHERE task_id=$1', [
        task.id,
      ])
    ).rowCount,
    0,
  );
  authorizer = startAuthorizer(authorizerEnvPath);
  await waitForAuthorizer(`http://127.0.0.1:${authorizerPort}`, authorizer);

  const runHeaders = {
    cookie: ownerCookie,
    origin,
    'x-omnis-csrf': ownerCsrf,
    'idempotency-key': `mock-run-idempotency-key-${randomBytes(16).toString('hex')}`,
    'content-type': 'application/json',
  };
  const authorization = await authorizeTask(baseUrl, ownerCookie, ownerCsrf, task.id);
  await stopProcess(authorizer);
  authorizer = startAuthorizer(authorizerEnvPath);
  await waitForAuthorizer(`http://127.0.0.1:${authorizerPort}`, authorizer);
  const persistedReplay = await fetch(`${baseUrl}/api/v1/authorizations`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'idempotency-key': authorization.requestKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: task.id }),
  });
  assert.equal(persistedReplay.status, 201);
  const persistedAuthorization = await persistedReplay.json();
  assert.equal(persistedAuthorization.id, authorization.id);
  assert.equal(persistedAuthorization.status, 'authorized');
  const runResponse = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: runHeaders,
    body: JSON.stringify({ taskId: task.id, authorizationId: authorization.id }),
  });
  assert.equal(runResponse.status, 201);
  const run = await runResponse.json();
  assert.equal(run.runtimeKind, 'mock');
  assert.equal(run.synthetic, true);

  const retryResponse = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: runHeaders,
    body: JSON.stringify({ taskId: task.id, authorizationId: authorization.id }),
  });
  assert.ok([200, 201].includes(retryResponse.status));
  assert.equal((await retryResponse.json()).id, run.id);

  const eventResponse = await fetch(`${baseUrl}/api/v1/runs/${run.id}/events`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type') ?? '', /text\/event-stream/);
  const eventBody = readAll(eventResponse.body);
  await delay(120);
  const stop = await fetch(`${baseUrl}/api/v1/runs/${run.id}/stop`, {
    method: 'POST',
    headers: { cookie: ownerCookie, origin, 'x-omnis-csrf': ownerCsrf },
  });
  assert.equal((await stop.json()).status, 'stopping');
  const eventText = await eventBody;
  const events = [...eventText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  assert.ok(events.some((event) => event.type === 'run.stop_requested'));
  assert.ok(events.some((event) => event.type === 'run.cancelled'));
  assert.ok(events.every((event) => event.source === 'mock' && event.synthetic === true));
  const sequences = events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1),
  );

  const finalRun = await fetch(`${baseUrl}/api/v1/runs/${run.id}`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal((await finalRun.json()).status, 'cancelled');
  const unauthorizedStop = await fetch(`${baseUrl}/api/v1/runs/${run.id}/stop`, { method: 'POST' });
  assert.equal(unauthorizedStop.status, 401);

  await stopProcess(api);
  api = startApi(apiEnvPath);
  await waitForHealth(
    baseUrl,
    `http://127.0.0.1:${workerPort}`,
    internalToken,
    worker,
    api,
    `http://127.0.0.1:${authorizerPort}`,
    authorizer,
  );
  ({ ownerCookie, ownerCsrf } = await signInOwner(baseUrl));
  const recoveredTasksResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
    headers: { cookie: ownerCookie },
  });
  const recoveredTasks = await recoveredTasksResponse.json();
  assert.equal(recoveredTasksResponse.status, 200);
  assert.ok(recoveredTasks.some((entry) => entry.id === task.id));
  const recoveredRunsResponse = await fetch(`${baseUrl}/api/v1/runs`, {
    headers: { cookie: ownerCookie },
  });
  const recoveredRuns = await recoveredRunsResponse.json();
  assert.equal(recoveredRunsResponse.status, 200);
  assert.equal(recoveredRuns.find((entry) => entry.id === run.id)?.status, 'cancelled');

  const replayResponse = await fetch(`${baseUrl}/api/v1/runs/${run.id}/events`, {
    headers: { cookie: ownerCookie, 'last-event-id': '1' },
  });
  assert.equal(replayResponse.status, 200);
  const replayText = await readAll(replayResponse.body);
  const replayEvents = [...replayText.matchAll(/^data: (.+)$/gm)].map((match) =>
    JSON.parse(match[1]),
  );
  assert.ok(replayEvents.length >= 2);
  assert.ok(replayEvents.every((event) => event.sequence > 1));
  assert.deepEqual(
    replayEvents.map((event) => event.sequence),
    Array.from(
      { length: replayEvents.at(-1).sequence - replayEvents[0].sequence + 1 },
      (_, index) => replayEvents[0].sequence + index,
    ),
  );
  assert.equal(new Set(replayEvents.map((event) => event.id)).size, replayEvents.length);

  const canaryTaskResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Synthetic credential isolation probe',
      detail: 'Run the deterministic synthetic fixture and verify credential separation.',
    }),
  });
  const canaryTaskText = await canaryTaskResponse.text();
  assert.equal(canaryTaskResponse.status, 201);
  assert.equal(canaryTaskText.includes(canary), false);
  const canaryTask = JSON.parse(canaryTaskText);
  const canaryAuthorization = await authorizeTask(baseUrl, ownerCookie, ownerCsrf, canaryTask.id);
  const canaryRunResponse = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'idempotency-key': `canary-probe-${randomBytes(16).toString('hex')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: canaryTask.id, authorizationId: canaryAuthorization.id }),
  });
  const canaryRunText = await canaryRunResponse.text();
  assert.equal(canaryRunResponse.status, 201);
  assert.equal(canaryRunText.includes(canary), false);
  const canaryRun = JSON.parse(canaryRunText);
  await waitForRunStatus(baseUrl, canaryRun.id, 'completed', ownerCookie, worker, api, 20_000);
  const canaryRevocation = await fetch(
    `${baseUrl}/api/v1/authorizations/${canaryAuthorization.id}/revoke`,
    {
      method: 'POST',
      headers: { cookie: ownerCookie, origin, 'x-omnis-csrf': ownerCsrf },
    },
  );
  assert.equal(canaryRevocation.status, 200);
  assert.equal((await canaryRevocation.json()).status, 'revoked');
  const canaryRunRead = await fetch(`${baseUrl}/api/v1/runs/${canaryRun.id}`, {
    headers: { cookie: ownerCookie },
  });
  const canaryRunReadText = await canaryRunRead.text();
  assert.equal(canaryRunRead.status, 200);
  assert.equal(canaryRunReadText.includes(canary), false);
  const canaryEvents = await fetchRunEvents(baseUrl, canaryRun.id, ownerCookie);
  assert.equal(JSON.stringify(canaryEvents).includes(canary), false);
  const persistedRecords = await auditPool.query(`
    SELECT COALESCE(string_agg(record::text, E'\\n'), '') AS records
    FROM (
      SELECT to_jsonb(t) AS record FROM omnis.tasks t
      UNION ALL SELECT to_jsonb(r) FROM omnis.runs r
      UNION ALL SELECT to_jsonb(e) FROM omnis.run_events e
      UNION ALL SELECT to_jsonb(i) FROM omnis.run_idempotency i
      UNION ALL SELECT to_jsonb(a) FROM omnis.runtime_authorizations a
      UNION ALL SELECT to_jsonb(a) FROM omnis.authorization_audit a
    ) records
  `);
  assert.equal(persistedRecords.rows[0]?.records.includes(canary), false);
  assert.equal(worker.capturedLogs.includes(canary), false);
  assert.equal(api.capturedLogs.includes(canary), false);

  await stopProcess(worker);
  worker = startWorker(workerEnvPath);
  await waitForHealth(
    baseUrl,
    `http://127.0.0.1:${workerPort}`,
    internalToken,
    worker,
    api,
    `http://127.0.0.1:${authorizerPort}`,
    authorizer,
  );
  const afterWorkerRestartResponse = await fetch(`${baseUrl}/api/v1/runs/${run.id}`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal((await afterWorkerRestartResponse.json()).status, 'cancelled');

  const interruptedTaskResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Restart recovery check',
      detail: 'Interrupt one synthetic run during worker shutdown.',
    }),
  });
  assert.equal(interruptedTaskResponse.status, 201);
  const interruptedTask = await interruptedTaskResponse.json();
  const interruptedAuthorization = await authorizeTask(
    baseUrl,
    ownerCookie,
    ownerCsrf,
    interruptedTask.id,
  );
  const interruptedAdmission = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'idempotency-key': `restart-recovery-${randomBytes(16).toString('hex')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: interruptedTask.id,
      authorizationId: interruptedAuthorization.id,
    }),
  });
  assert.equal(interruptedAdmission.status, 201);
  const interruptedRun = await interruptedAdmission.json();
  await waitForRunStatus(baseUrl, interruptedRun.id, 'running', ownerCookie, worker, api);
  await stopProcess(worker);
  worker = startWorker(workerEnvPath);
  await waitForHealth(
    baseUrl,
    `http://127.0.0.1:${workerPort}`,
    internalToken,
    worker,
    api,
    `http://127.0.0.1:${authorizerPort}`,
    authorizer,
  );
  await waitForRunStatus(
    baseUrl,
    interruptedRun.id,
    'interrupted',
    ownerCookie,
    worker,
    api,
    45_000,
  );
  const interruptedFinalResponse = await fetch(`${baseUrl}/api/v1/runs/${interruptedRun.id}`, {
    headers: { cookie: ownerCookie },
  });
  const interruptedFinal = await interruptedFinalResponse.json();
  assert.equal(interruptedFinal.status, 'interrupted');
  const interruptedEventsResponse = await fetch(
    `${baseUrl}/api/v1/runs/${interruptedRun.id}/events`,
    { headers: { cookie: ownerCookie } },
  );
  const interruptedEvents = await readThroughTerminalEvent(interruptedEventsResponse.body);
  assert.equal(interruptedEvents.filter((event) => event.type === 'run.started').length, 1);
  assert.equal(interruptedEvents.filter((event) => event.type === 'run.interrupted').length, 1);
  await waitForRunWorkspaceRemoval(interruptedRun.id);

  if (process.env.OMNIS_RECOVERY_INTEGRATION === '1') {
    const controlRun = await createTaskAndRun(
      baseUrl,
      ownerCookie,
      ownerCsrf,
      'Recovery control run',
    );
    await waitForRunStatus(baseUrl, controlRun.id, 'completed', ownerCookie, worker, api, 20_000);

    const crashedWorkerRun = await createTaskAndRun(
      baseUrl,
      ownerCookie,
      ownerCsrf,
      'Abrupt worker recovery run',
    );
    await waitForRunStatus(baseUrl, crashedWorkerRun.id, 'running', ownerCookie, worker, api);
    await waitForSandboxContainer(crashedWorkerRun.id);
    await killProcessAbruptly(worker);
    worker = startWorker(workerEnvPath);
    await waitForHealth(
      baseUrl,
      `http://127.0.0.1:${workerPort}`,
      internalToken,
      worker,
      api,
      `http://127.0.0.1:${authorizerPort}`,
      authorizer,
    );
    await waitForRunStatus(
      baseUrl,
      crashedWorkerRun.id,
      'interrupted',
      ownerCookie,
      worker,
      api,
      45_000,
    );
    const crashedWorkerEvents = await fetchRunEvents(baseUrl, crashedWorkerRun.id, ownerCookie);
    assert.equal(crashedWorkerEvents.filter((event) => event.type === 'run.started').length, 1);
    assert.equal(crashedWorkerEvents.filter((event) => event.type === 'run.interrupted').length, 1);
    await waitForRunWorkspaceRemoval(crashedWorkerRun.id);
    assert.equal((await fetchRun(baseUrl, controlRun.id, ownerCookie)).status, 'completed');

    const sandboxCrashRun = await createTaskAndRun(
      baseUrl,
      ownerCookie,
      ownerCsrf,
      'Sandbox process failure run',
    );
    await waitForSandboxContainer(sandboxCrashRun.id);
    const sandboxId = findSandboxContainer(sandboxCrashRun.id);
    docker(['kill', '--signal=KILL', sandboxId]);
    await waitForRunStatus(baseUrl, sandboxCrashRun.id, 'failed', ownerCookie, worker, api);
    assert.equal((await fetchRun(baseUrl, controlRun.id, ownerCookie)).status, 'completed');
    assert.equal((await fetchRun(baseUrl, run.id, ownerCookie)).status, 'cancelled');
    assert.equal(await runWorkspaceExists(sandboxCrashRun.id), false);

    if (process.env.OMNIS_TEST_POSTGRES_CONTAINER) {
      worker = await testDatabaseAvailabilityLoss({
        container: process.env.OMNIS_TEST_POSTGRES_CONTAINER,
        baseUrl,
        ownerCookie,
        ownerCsrf,
        workerEnvPath,
        workerUrl: `http://127.0.0.1:${workerPort}`,
        internalToken,
        worker,
        api,
        authorizer,
        authorizerUrl: `http://127.0.0.1:${authorizerPort}`,
      });
    }
  }

  console.log(
    process.env.OMNIS_RECOVERY_INTEGRATION === '1'
      ? 'PostgreSQL-backed recovery passed: durable lifecycle, API/SSE replay, abrupt worker recovery, sandbox crash cleanup, and no duplicate execution.'
      : 'PostgreSQL-backed mock lifecycle passed: auth/CSRF, task, idempotent admission, durable SSE replay, cancellation, API/worker restarts, and interrupted-run non-replay.',
  );
} finally {
  await stopProcess(api);
  await stopProcess(worker);
  await stopProcess(authorizer);
  await auditPool.end();
  await unlink(apiEnvPath).catch(() => undefined);
  await unlink(workerEnvPath).catch(() => undefined);
  await unlink(authorizerEnvPath).catch(() => undefined);
}

function startWorker(envFile) {
  const env = withoutDatabaseSecrets(process.env);
  delete env.OMNIS_TEST_DATABASE_URL;
  delete env.OMNIS_TEST_MIGRATION_DATABASE_URL;
  delete env.OMNIS_TEST_ADMIN_DATABASE_URL;
  env[canaryName] = canary;
  if (process.env.OMNIS_RECOVERY_INTEGRATION === '1') {
    env.NODE_ENV = 'test';
    env.OMNIS_MOCK_TEST_DELAY_MS = '1000';
  }
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', `--env-file=${envFile}`, 'src/server.ts'],
    {
      cwd: new URL('../../apps/worker/', import.meta.url),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return captureProcessOutput(child);
}

function withoutDatabaseSecrets(environment) {
  const clean = { ...environment };
  for (const key of [
    'OMNIS_DB_PASSWORD',
    'OMNIS_RUNTIME_DB_PASSWORD',
    'OMNIS_AUTHORIZER_DB_PASSWORD',
    'OMNIS_API_AUTHORIZER_TOKEN',
    'OMNIS_DATABASE_URL',
    'OMNIS_TEST_DATABASE_URL',
    'OMNIS_ADMIN_DATABASE_URL',
    'OMNIS_MIGRATION_DATABASE_URL',
    'OMNIS_MIGRATION_DB_PASSWORD',
    'OMNIS_TEST_ADMIN_DATABASE_URL',
    'OMNIS_TEST_MIGRATION_DATABASE_URL',
    'OMNIS_TEST_AUTHORIZER_DATABASE_URL',
  ])
    delete clean[key];
  return clean;
}

function startApi(envFile) {
  const env = withoutDatabaseSecrets(process.env);
  delete env[canaryName];
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', `--env-file=${envFile}`, 'src/server.ts'],
    {
      cwd: new URL('../../apps/api/', import.meta.url),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return captureProcessOutput(child);
}

function startAuthorizer(envFile) {
  const env = withoutDatabaseSecrets(process.env);
  delete env.OMNIS_TEST_DATABASE_URL;
  delete env.OMNIS_TEST_MIGRATION_DATABASE_URL;
  delete env.OMNIS_TEST_ADMIN_DATABASE_URL;
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', `--env-file=${envFile}`, 'src/server.ts'],
    {
      cwd: new URL('../../apps/authorizer/', import.meta.url),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return captureProcessOutput(child);
}

function captureProcessOutput(child) {
  child.capturedLogs = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      child.capturedLogs = `${child.capturedLogs}${chunk.toString('utf8')}`.slice(-262_144);
      if (process.env.OMNIS_TEST_DEBUG === '1') process.stderr.write(chunk);
    });
  }
  return child;
}

async function freePort(excluded = new Set()) {
  while (true) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not reserve an ephemeral port.');
    const { port } = address;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (!excluded.has(port)) return port;
  }
}

function cookieValue(response) {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'Expected the API to set its local owner session cookie.');
  return cookie;
}

async function waitForHealth(
  apiUrl,
  workerUrl,
  internalToken,
  workerProcess,
  apiProcess,
  authorizerUrl,
  authorizerProcess,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (
      workerProcess.exitCode !== null ||
      apiProcess.exitCode !== null ||
      authorizerProcess.exitCode !== null
    ) {
      throw new Error('The mock API, worker, or authorizer exited before becoming healthy.');
    }
    try {
      const [apiHealth, workerHealth, authorizerHealth] = await Promise.all([
        fetch(`${apiUrl}/api/v1/health`),
        fetch(`${workerUrl}/internal/v1/health`, {
          headers: { 'x-omnis-internal-token': internalToken },
        }),
        fetch(`${authorizerUrl}/internal/v1/health`),
      ]);
      if (apiHealth.ok && workerHealth.ok && authorizerHealth.ok) return;
    } catch {
      await delay(80);
    }
  }
  throw new Error('The mock API did not become healthy within eight seconds.');
}

async function waitForAuthorizer(authorizerUrl, authorizerProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    if (authorizerProcess.exitCode !== null) {
      throw new Error('The mock authorizer exited before becoming healthy.');
    }
    try {
      if ((await fetch(`${authorizerUrl}/internal/v1/health`)).ok) return;
    } catch {
      await delay(80);
    }
  }
  throw new Error('The mock authorizer did not become healthy within eight seconds.');
}

async function readAll(body) {
  assert.ok(body, 'Expected an SSE response body.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return output;
    output += decoder.decode(value, { stream: true });
  }
}

async function signInOwner(baseUrl) {
  const csrfResponse = await fetch(`${baseUrl}/api/v1/auth/csrf`);
  const csrfCookie = cookieValue(csrfResponse);
  const csrf = (await csrfResponse.json()).csrfToken;
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      cookie: csrfCookie,
      origin,
      'x-omnis-csrf': csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const ownerCookie = cookieValue(login);
  const ownerCsrfResponse = await fetch(`${baseUrl}/api/v1/auth/csrf`, {
    headers: { cookie: ownerCookie },
  });
  const ownerCsrf = (await ownerCsrfResponse.json()).csrfToken;
  return { ownerCookie, ownerCsrf };
}

async function waitForRunStatus(
  baseUrl,
  runId,
  expectedStatus,
  cookie,
  workerProcess,
  apiProcess,
  timeoutMs = 8000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (workerProcess.exitCode !== null || apiProcess.exitCode !== null) {
      throw new Error('The mock API or worker exited while waiting for a run state.');
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/runs/${runId}`, {
        headers: { cookie },
      });
      if (response.ok && (await response.json()).status === expectedStatus) return;
    } catch {
      await delay(80);
    }
    await delay(50);
  }
  throw new Error(`The run did not reach expected status: ${expectedStatus}.`);
}

async function createTaskAndRun(baseUrl, cookie, csrf, title) {
  const taskResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'x-omnis-csrf': csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, detail: 'Synthetic recovery test only.' }),
  });
  assert.equal(taskResponse.status, 201);
  const task = await taskResponse.json();
  const authorization = await authorizeTask(baseUrl, cookie, csrf, task.id);
  const runResponse = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'x-omnis-csrf': csrf,
      'idempotency-key': `r1-g3-${randomBytes(16).toString('hex')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: task.id, authorizationId: authorization.id }),
  });
  assert.equal(runResponse.status, 201);
  return runResponse.json();
}

async function authorizeTask(baseUrl, cookie, csrf, taskId) {
  const idempotencyKey = randomUUID();
  const headers = {
    cookie,
    origin,
    'x-omnis-csrf': csrf,
    'idempotency-key': idempotencyKey,
    'content-type': 'application/json',
  };
  const requested = await fetch(`${baseUrl}/api/v1/authorizations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId }),
  });
  const requestText = await requested.text();
  assert.equal(requested.status, 201, requestText);
  const authorization = JSON.parse(requestText);
  assert.equal(authorization.status, 'pending');
  assert.deepEqual(authorization.scope, { kind: 'task', taskId });
  const replay = await fetch(`${baseUrl}/api/v1/authorizations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId }),
  });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).id, authorization.id);
  assert.equal(
    (
      await auditPool.query(
        "SELECT count(*)::int AS count FROM omnis.authorization_audit WHERE authorization_id=$1 AND event_type='authorization.requested'",
        [authorization.id],
      )
    ).rows[0].count,
    1,
  );
  const decision = await fetch(`${baseUrl}/api/v1/authorizations/${authorization.id}/decision`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ decision: 'approve' }),
  });
  const decisionText = await decision.text();
  assert.equal(decision.status, 200, decisionText);
  const approved = JSON.parse(decisionText);
  assert.equal(approved.status, 'authorized');
  return { ...approved, requestKey: idempotencyKey };
}

async function fetchRun(baseUrl, runId, cookie) {
  const response = await fetch(`${baseUrl}/api/v1/runs/${runId}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

async function fetchRunEvents(baseUrl, runId, cookie) {
  const response = await fetch(`${baseUrl}/api/v1/runs/${runId}/events`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return readThroughTerminalEvent(response.body);
}

async function readThroughTerminalEvent(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const events = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return events;
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split('\n\n');
      pending = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length);
        if (!data) continue;
        const event = JSON.parse(data);
        events.push(event);
        if (
          ['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(event.type)
        ) {
          await reader.cancel();
          return events;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitForSandboxContainer(runId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (findSandboxContainer(runId, true)) return;
    await delay(50);
  }
  throw new Error('The run did not create its labelled sandbox container.');
}

async function runWorkspaceExists(runId) {
  const entries = await readdir('/tmp/omnis-os-sandbox').catch(() => []);
  return entries.some((entry) => entry.startsWith(`run-${runId}-`));
}

async function waitForRunWorkspaceRemoval(runId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (!(await runWorkspaceExists(runId))) return;
    await delay(100);
  }
  assert.equal(await runWorkspaceExists(runId), false, `workspace for ${runId} must be removed`);
}

function findSandboxContainer(runId, allowMissing = false) {
  const url = new URL(databaseUrl);
  const scope = createHash('sha256')
    .update(`${url.protocol}//${url.hostname}:${url.port}${url.pathname}`)
    .digest('hex')
    .slice(0, 24);
  const result = docker(
    [
      'ps',
      '--all',
      '--filter',
      'label=com.omnis.os.sandbox=true',
      '--filter',
      `label=com.omnis.os.scope=${scope}`,
      '--filter',
      `label=com.omnis.os.run-id=${runId}`,
      '--format',
      '{{.ID}}',
    ],
    allowMissing,
  );
  const id = result.trim().split(/\s+/)[0];
  if (!id && !allowMissing) throw new Error('The run sandbox container was not found.');
  return id;
}

function docker(args, allowFailure = false) {
  const result = spawnSync('/usr/bin/docker', args, {
    cwd: '/tmp',
    env: { DOCKER_HOST: 'unix:///var/run/docker.sock', PATH: '/usr/bin:/bin', HOME: '/tmp' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error('The controlled R1-G3 Docker operation failed.');
  }
  return result.stdout ?? '';
}

async function killProcessAbruptly(child) {
  if (child.exitCode !== null) throw new Error('The worker exited before crash injection.');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    delay(5000).then(() => {
      throw new Error('The worker did not exit after SIGKILL.');
    }),
  ]);
}

async function testDatabaseAvailabilityLoss({
  container,
  baseUrl,
  ownerCookie,
  ownerCsrf,
  workerEnvPath,
  workerUrl,
  internalToken,
  worker,
  api,
  authorizer,
  authorizerUrl,
}) {
  const labels = docker(['inspect', '--format', '{{json .Config.Labels}}', container]).trim();
  const parsedLabels = JSON.parse(labels);
  assert.equal(parsedLabels['com.omnis.os.r1g3-disposable'], 'true');
  const beforeResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(beforeResponse.status, 200);
  const before = await beforeResponse.json();
  const recoveryTaskResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Retry after database recovery',
      detail: 'Disposable test only.',
    }),
  });
  assert.equal(recoveryTaskResponse.status, 201);
  const recoveryTask = await recoveryTaskResponse.json();
  const idempotencyKey = `r1-g3-database-recovery-${randomBytes(16).toString('hex')}`;
  const recoveryAuthorization = await authorizeTask(
    baseUrl,
    ownerCookie,
    ownerCsrf,
    recoveryTask.id,
  );

  docker(['stop', '--time', '1', container]);
  try {
    const taskResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        cookie: ownerCookie,
        origin,
        'x-omnis-csrf': ownerCsrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Database outage probe', detail: 'Disposable test only.' }),
    });
    assert.equal(taskResponse.status, 500);
    assert.equal((await taskResponse.json()).error.code, 'internal_error');
    const admissionResponse = await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: {
        cookie: ownerCookie,
        origin,
        'x-omnis-csrf': ownerCsrf,
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskId: recoveryTask.id, authorizationId: recoveryAuthorization.id }),
    });
    assert.equal(admissionResponse.status, 500);
    assert.equal((await fetch(`${baseUrl}/api/v1/health`)).status, 200);
  } finally {
    docker(['start', container]);
  }

  await waitForPostgresContainer(container);
  if (worker.exitCode !== null) worker = startWorker(workerEnvPath);
  await waitForHealth(baseUrl, workerUrl, internalToken, worker, api, authorizerUrl, authorizer);
  const startedAt = Date.now();
  let recoveryResponse;
  while (Date.now() - startedAt < 15_000) {
    if (api.exitCode !== null) throw new Error('The API exited during PostgreSQL recovery.');
    try {
      recoveryResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
        headers: { cookie: ownerCookie },
      });
      if (recoveryResponse.status === 200) break;
    } catch {}
    await delay(150);
  }
  assert.equal(recoveryResponse?.status, 200, 'the API should recover after PostgreSQL returns');
  const after = await recoveryResponse.json();
  assert.equal(
    after.length,
    before.length + 1,
    'only the task created before the outage may have persisted',
  );
  const runRequest = {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: recoveryTask.id, authorizationId: recoveryAuthorization.id }),
  };
  const firstAdmission = await fetch(`${baseUrl}/api/v1/runs`, runRequest);
  assert.equal(firstAdmission.status, 201);
  const admittedRun = await firstAdmission.json();
  const repeatedAdmission = await fetch(`${baseUrl}/api/v1/runs`, runRequest);
  assert.ok([200, 201].includes(repeatedAdmission.status));
  assert.equal((await repeatedAdmission.json()).id, admittedRun.id);
  await waitForRunStatus(baseUrl, admittedRun.id, 'completed', ownerCookie, worker, api, 20_000);
  const recoveredEvents = await fetchRunEvents(baseUrl, admittedRun.id, ownerCookie);
  assert.equal(recoveredEvents.filter((event) => event.type === 'run.started').length, 1);
  const recoveredWorker = await fetch(`${workerUrl}/internal/v1/health`, {
    headers: { 'x-omnis-internal-token': internalToken },
  });
  assert.equal(recoveredWorker.status, 200);
  return worker;
}

async function waitForPostgresContainer(container) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const health = docker(
      ['inspect', '--format', '{{.State.Health.Status}}', container],
      true,
    ).trim();
    if (health === 'healthy') return;
    await delay(200);
  }
  throw new Error('The disposable PostgreSQL test container did not recover healthy.');
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(1500).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

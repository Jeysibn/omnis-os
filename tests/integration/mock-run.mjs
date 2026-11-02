import assert from 'node:assert/strict';
import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const scrypt = promisify(scryptCallback);
const password = 'test-owner-password-2026';
const origin = 'http://127.0.0.1:5173';
const databaseUrl = process.env.OMNIS_TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('Set OMNIS_TEST_DATABASE_URL to a disposable PostgreSQL database.');
if (!/(?:^|[_-])test(?:s)?$/i.test(new URL(databaseUrl).pathname.slice(1))) {
  throw new Error('OMNIS_TEST_DATABASE_URL must point to a database ending in test or tests.');
}
const tempDirectory = await mkdtemp(join(tmpdir(), 'omnis-os-mock-smoke-'));
const envPath = join(tempDirectory, 'local.env');
const apiPort = await freePort();
const workerPort = await freePort(new Set([apiPort]));
const salt = randomBytes(16);
const internalToken = randomBytes(48).toString('hex');
const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
const envLines = [
  `OMNIS_OWNER_PASSWORD_HASH=${salt.toString('hex')}:${passwordHash}`,
  `OMNIS_SESSION_SECRET=${randomBytes(48).toString('hex')}`,
  `OMNIS_INTERNAL_TOKEN=${internalToken}`,
  `OMNIS_DATABASE_URL=${databaseUrl}`,
  `OMNIS_API_HOST=127.0.0.1`,
  `OMNIS_API_PORT=${apiPort}`,
  `OMNIS_WORKER_HOST=127.0.0.1`,
  `OMNIS_WORKER_PORT=${workerPort}`,
  `OMNIS_ALLOWED_ORIGIN=${origin}`,
  'OMNIS_SECURE_COOKIES=false',
];
await writeFile(envPath, `${envLines.join('\n')}\n`, { mode: 0o600 });

let worker = startWorker(envPath);
let api = startApi(envPath);

try {
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  await waitForHealth(baseUrl, `http://127.0.0.1:${workerPort}`, internalToken, worker, api);

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

  const runHeaders = {
    cookie: ownerCookie,
    origin,
    'x-omnis-csrf': ownerCsrf,
    'idempotency-key': `mock-run-idempotency-key-${randomBytes(16).toString('hex')}`,
    'content-type': 'application/json',
  };
  const runResponse = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: runHeaders,
    body: JSON.stringify({ taskId: task.id }),
  });
  assert.equal(runResponse.status, 201);
  const run = await runResponse.json();
  assert.equal(run.runtimeKind, 'mock');
  assert.equal(run.synthetic, true);

  const retryResponse = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: runHeaders,
    body: JSON.stringify({ taskId: task.id }),
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
    [...sequences].sort((a, b) => a - b),
  );

  const finalRun = await fetch(`${baseUrl}/api/v1/runs/${run.id}`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal((await finalRun.json()).status, 'cancelled');
  const unauthorizedStop = await fetch(`${baseUrl}/api/v1/runs/${run.id}/stop`, { method: 'POST' });
  assert.equal(unauthorizedStop.status, 401);

  await stopProcess(api);
  api = startApi(envPath);
  await waitForHealth(baseUrl, `http://127.0.0.1:${workerPort}`, internalToken, worker, api);
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
  assert.equal(new Set(replayEvents.map((event) => event.id)).size, replayEvents.length);

  await stopProcess(worker);
  worker = startWorker(envPath);
  await waitForHealth(baseUrl, `http://127.0.0.1:${workerPort}`, internalToken, worker, api);
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
  const interruptedAdmission = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-omnis-csrf': ownerCsrf,
      'idempotency-key': `restart-recovery-${randomBytes(16).toString('hex')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: interruptedTask.id }),
  });
  assert.equal(interruptedAdmission.status, 201);
  const interruptedRun = await interruptedAdmission.json();
  await waitForRunStatus(baseUrl, interruptedRun.id, 'running', ownerCookie, worker, api);
  await stopProcess(worker);
  worker = startWorker(envPath);
  await waitForHealth(baseUrl, `http://127.0.0.1:${workerPort}`, internalToken, worker, api);
  await delay(500);
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
    worker = startWorker(envPath);
    await waitForHealth(baseUrl, `http://127.0.0.1:${workerPort}`, internalToken, worker, api);
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
        envPath,
        workerUrl: `http://127.0.0.1:${workerPort}`,
        internalToken,
        worker,
        api,
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
  await unlink(envPath).catch(() => undefined);
}

function startWorker(envFile) {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', `--env-file=${envFile}`, 'src/server.ts'],
    {
      cwd: new URL('../../apps/worker/', import.meta.url),
      env:
        process.env.OMNIS_RECOVERY_INTEGRATION === '1'
          ? { ...process.env, NODE_ENV: 'test', OMNIS_MOCK_TEST_DELAY_MS: '1000' }
          : process.env,
      stdio: process.env.OMNIS_TEST_DEBUG === '1' ? 'inherit' : 'ignore',
    },
  );
}

function startApi(envFile) {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', `--env-file=${envFile}`, 'src/server.ts'],
    {
      cwd: new URL('../../apps/api/', import.meta.url),
      stdio: process.env.OMNIS_TEST_DEBUG === '1' ? 'inherit' : 'ignore',
    },
  );
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

async function waitForHealth(apiUrl, workerUrl, internalToken, workerProcess, apiProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (workerProcess.exitCode !== null || apiProcess.exitCode !== null) {
      throw new Error('The mock API or worker exited before becoming healthy.');
    }
    try {
      const [apiHealth, workerHealth] = await Promise.all([
        fetch(`${apiUrl}/api/v1/health`),
        fetch(`${workerUrl}/internal/v1/health`, {
          headers: { 'x-omnis-internal-token': internalToken },
        }),
      ]);
      if (apiHealth.ok && workerHealth.ok) return;
    } catch {
      await delay(80);
    }
  }
  throw new Error('The mock API did not become healthy within eight seconds.');
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
  const runResponse = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'x-omnis-csrf': csrf,
      'idempotency-key': `r1-g3-${randomBytes(16).toString('hex')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: task.id }),
  });
  assert.equal(runResponse.status, 201);
  return runResponse.json();
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
  envPath,
  workerUrl,
  internalToken,
  worker,
  api,
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
      body: JSON.stringify({ taskId: recoveryTask.id }),
    });
    assert.equal(admissionResponse.status, 500);
    assert.equal((await fetch(`${baseUrl}/api/v1/health`)).status, 200);
  } finally {
    docker(['start', container]);
  }

  await waitForPostgresContainer(container);
  if (worker.exitCode !== null) worker = startWorker(envPath);
  await waitForHealth(baseUrl, workerUrl, internalToken, worker, api);
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
    body: JSON.stringify({ taskId: recoveryTask.id }),
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

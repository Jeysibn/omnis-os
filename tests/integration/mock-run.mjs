import assert from 'node:assert/strict';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const scrypt = promisify(scryptCallback);
const password = 'test-owner-password-2026';
const origin = 'http://127.0.0.1:5173';
const databaseUrl = process.env.OMNIS_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set OMNIS_TEST_DATABASE_URL to a disposable PostgreSQL database.');
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
  const replayEvents = [...replayText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
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
  const interruptedEventText = await readAll(interruptedEventsResponse.body);
  const interruptedEvents = [...interruptedEventText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  assert.equal(interruptedEvents.filter((event) => event.type === 'run.started').length, 1);
  assert.equal(interruptedEvents.filter((event) => event.type === 'run.interrupted').length, 1);

  console.log(
    'PostgreSQL-backed mock lifecycle passed: auth/CSRF, task, idempotent admission, durable SSE replay, cancellation, API/worker restarts, and interrupted-run non-replay.',
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

async function waitForRunStatus(baseUrl, runId, expectedStatus, cookie, workerProcess, apiProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
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

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
const tempDirectory = await mkdtemp(join(tmpdir(), 'omnis-os-mock-smoke-'));
const envPath = join(tempDirectory, 'local.env');
const apiPort = await freePort();
const workerPort = await freePort();
const salt = randomBytes(16);
const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
const envLines = [
  `OMNIS_OWNER_PASSWORD_HASH=${salt.toString('hex')}:${passwordHash}`,
  `OMNIS_SESSION_SECRET=${randomBytes(48).toString('hex')}`,
  `OMNIS_INTERNAL_TOKEN=${randomBytes(48).toString('hex')}`,
  `OMNIS_API_HOST=127.0.0.1`,
  `OMNIS_API_PORT=${apiPort}`,
  `OMNIS_WORKER_HOST=127.0.0.1`,
  `OMNIS_WORKER_PORT=${workerPort}`,
  `OMNIS_ALLOWED_ORIGIN=${origin}`,
  'OMNIS_SECURE_COOKIES=false',
];
await writeFile(envPath, `${envLines.join('\n')}\n`, { mode: 0o600 });

const worker = spawn(
  process.execPath,
  ['--experimental-strip-types', `--env-file=${envPath}`, 'src/server.ts'],
  { cwd: new URL('../../apps/worker/', import.meta.url), stdio: 'ignore' },
);
const api = spawn(
  process.execPath,
  ['--experimental-strip-types', `--env-file=${envPath}`, 'src/server.ts'],
  { cwd: new URL('../../apps/api/', import.meta.url), stdio: 'ignore' },
);

try {
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  await waitForHealth(baseUrl, worker, api);

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

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      cookie: anonCookie,
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
    'idempotency-key': 'mock-run-idempotency-key-0001',
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

  console.log(
    'Mock API integration passed: owner session, CSRF/origin rejection, task, idempotent run, SSE ordering, stop, and terminal reconciliation.',
  );
} finally {
  await stopProcess(api);
  await stopProcess(worker);
  await unlink(envPath).catch(() => undefined);
}

async function freePort() {
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
  return port;
}

function cookieValue(response) {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'Expected the API to set its local owner session cookie.');
  return cookie;
}

async function waitForHealth(url, workerProcess, apiProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (workerProcess.exitCode !== null || apiProcess.exitCode !== null) {
      throw new Error('The mock API or worker exited before becoming healthy.');
    }
    try {
      const response = await fetch(`${url}/api/v1/health`);
      if (response.ok) return;
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

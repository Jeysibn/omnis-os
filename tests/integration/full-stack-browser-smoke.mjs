import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  buildBrowserEnvironment,
  freePort,
  startMockServices,
  stopProcess,
} from './support/mock-services.mjs';

const diagnosticsPath = process.env.OMNIS_TEST_DIAGNOSTICS_PATH;
const startedAt = Date.now();
const stages = [];
let services;
let browserRunner;
let timedOut = false;
let interrupted = false;
const handleParentSignal = () => {
  interrupted = true;
  void stopBrowserRunner(browserRunner);
};
process.on('SIGINT', handleParentSignal);
process.on('SIGTERM', handleParentSignal);

try {
  stages.push('postgres-migration');
  const frontendPort = await freePort();
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  services = await startMockServices({
    origin: frontendOrigin,
    reservedPorts: [frontendPort],
    requireAuditPool: true,
    enableSyntheticBrokerTestMode: true,
  });
  if (interrupted) throw new Error('The full-stack smoke was interrupted during service startup.');
  stages.push('api-worker-authorizer-launcher-ready');
  const syntheticProjectId = await createActiveSyntheticProject(services);

  const browserEnvironment = buildBrowserEnvironment(process.env, {
    apiTarget: services.apiUrl,
    frontendOrigin,
    frontendPort,
    ownerPassword: services.password,
    syntheticProjectId,
  });

  browserRunner = spawn('pnpm', ['--filter', '@omnis/web', 'test:e2e:integration'], {
    cwd: new URL('../../', import.meta.url),
    env: browserEnvironment,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });

  const exit = await waitForBrowserRunner(browserRunner, 180_000);
  if (exit.timedOut) {
    timedOut = true;
    throw new Error('The full-stack browser test exceeded its 180-second limit.');
  }
  if (exit.signal) throw new Error(`The full-stack browser runner exited from ${exit.signal}.`);
  if (exit.code !== 0)
    throw new Error(`The full-stack browser runner exited with code ${exit.code}.`);
  stages.push('real-browser-standard-and-synthetic-run-smoke-passed');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown integration smoke failure.';
  process.stderr.write(
    `Full-stack smoke failed during ${stages.at(-1) ?? 'startup'}: ${message}\n`,
  );
  process.exitCode = 1;
} finally {
  await stopBrowserRunner(browserRunner);
  await services?.cleanup();
  process.off('SIGINT', handleParentSignal);
  process.off('SIGTERM', handleParentSignal);
  await writeSafeDiagnostics(diagnosticsPath, {
    passed: process.exitCode !== 1,
    elapsedMs: Date.now() - startedAt,
    stages,
    timedOut,
    interrupted,
  });
}

async function createActiveSyntheticProject(services) {
  const anonymousCsrf = await fetch(`${services.apiUrl}/api/v1/auth/csrf`);
  const anonymousCookie = cookieFrom(anonymousCsrf);
  const anonymousToken = (await anonymousCsrf.json()).csrfToken;
  const login = await fetch(`${services.apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      cookie: anonymousCookie,
      origin: services.origin,
      'x-omnis-csrf': anonymousToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password: services.password }),
  });
  if (!login.ok)
    throw new Error('Disposable owner login failed while creating the synthetic fixture.');
  const ownerCookie = cookieFrom(login);
  const ownerCsrfResponse = await fetch(`${services.apiUrl}/api/v1/auth/csrf`, {
    headers: { cookie: ownerCookie },
  });
  const ownerCsrf = (await ownerCsrfResponse.json()).csrfToken;
  const project = await fetch(`${services.apiUrl}/api/v1/projects`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin: services.origin,
      'x-omnis-csrf': ownerCsrf,
      'idempotency-key': randomUUID(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      key: `SYNTH-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      name: 'Synthetic broker integration fixture',
      objective: 'Exercise the test-only owner-authorized broker path.',
    }),
  });
  if (!project.ok) throw new Error('Disposable synthetic project creation failed.');
  const value = await project.json();
  await services.auditPool.query("UPDATE omnis.projects SET status='active' WHERE id=$1", [
    value.id,
  ]);
  return value.id;
}

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Disposable owner session cookie was not set.');
  return cookie;
}

async function waitForBrowserRunner(child, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const exited = new Promise((resolve) => {
    child.once('error', () => resolve({ error: true }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  if (result.error) throw new Error('The Playwright browser test process failed to start.');
  return result;
}

async function stopBrowserRunner(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    if (!(await waitForExit(child, 1_500))) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      if (!(await waitForExit(child, 1_500))) {
        throw new Error('The Playwright test process group did not stop after forced termination.');
      }
    }
    return;
  }
  await stopProcess(child);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function writeSafeDiagnostics(path, details) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const lines = [
    `result=${details.passed ? 'success' : 'failure'}`,
    `elapsed_ms=${details.elapsedMs}`,
    `stages=${details.stages.join(',') || 'none'}`,
    `timed_out=${details.timedOut}`,
    `interrupted=${details.interrupted}`,
  ];
  await writeFile(path, `${lines.join('\n')}\n`, { mode: 0o600 });
}

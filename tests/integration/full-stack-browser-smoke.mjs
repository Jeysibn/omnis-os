import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  freePort,
  startMockServices,
  stopProcess,
  withoutDatabaseSecrets,
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
  services = await startMockServices({ origin: frontendOrigin, reservedPorts: [frontendPort] });
  if (interrupted) throw new Error('The full-stack smoke was interrupted during service startup.');
  stages.push('api-worker-authorizer-launcher-ready');

  const browserEnvironment = withoutDatabaseSecrets(process.env);
  const forbiddenBrowserEnvironment = [
    'OMNIS_TEST_DATABASE_URL',
    'OMNIS_TEST_MIGRATION_DATABASE_URL',
    'OMNIS_TEST_ADMIN_DATABASE_URL',
    'OMNIS_TEST_AUTHORIZER_DATABASE_URL',
    'OMNIS_TEST_LAUNCHER_DATABASE_URL',
    'OMNIS_API_AUTHORIZER_TOKEN',
    'OMNIS_OWNER_PASSWORD_HASH',
    'OMNIS_SESSION_SECRET',
    'OMNIS_INTERNAL_TOKEN',
  ];
  if (forbiddenBrowserEnvironment.some((name) => name in browserEnvironment)) {
    throw new Error('Sensitive service configuration reached the browser test process.');
  }
  browserEnvironment.OMNIS_TEST_API_PROXY_TARGET = services.apiUrl;
  browserEnvironment.OMNIS_TEST_FRONTEND_ORIGIN = frontendOrigin;
  browserEnvironment.OMNIS_TEST_FRONTEND_PORT = String(frontendPort);

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
  stages.push('real-browser-task-create-and-reload-passed');
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

async function waitForBrowserRunner(child, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  if (result.error) throw result.error;
  return result;
}

async function stopBrowserRunner(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1_500)]);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    return;
  }
  await stopProcess(child);
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

import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../../../packages/db/src/index.ts';

const scrypt = promisify(scryptCallback);

export const testOwnerPassword = 'test-owner-password-2026';

export async function startMockServices({ origin, requireAuditPool = false, reservedPorts = [] }) {
  const databaseUrl = requiredDatabaseUrl('OMNIS_TEST_DATABASE_URL', 'omnis_runtime');
  const migrationUrl = requiredDatabaseUrl('OMNIS_TEST_MIGRATION_DATABASE_URL', 'omnis_migrator');
  const authorizerUrl = requiredDatabaseUrl(
    'OMNIS_TEST_AUTHORIZER_DATABASE_URL',
    'omnis_authorizer',
  );
  const launcherUrl = requiredDatabaseUrl('OMNIS_TEST_LAUNCHER_DATABASE_URL', 'omnis_launcher');
  const adminAuditUrl = requireAuditPool ? process.env.OMNIS_TEST_ADMIN_DATABASE_URL : undefined;
  if (requireAuditPool && (!adminAuditUrl || urlUsername(adminAuditUrl) !== 'omnis')) {
    throw new Error('Set OMNIS_TEST_ADMIN_DATABASE_URL to the disposable test administrator URL.');
  }

  const parsedOrigin = parseLoopbackOrigin(origin);
  const excludedPorts = new Set(reservedPorts);
  if (parsedOrigin.port) excludedPorts.add(Number(parsedOrigin.port));

  const migration = spawnSync(process.execPath, ['--experimental-strip-types', 'src/migrate.ts'], {
    cwd: new URL('../../../apps/worker/', import.meta.url),
    env: { ...withoutDatabaseSecrets(process.env), OMNIS_MIGRATION_DATABASE_URL: migrationUrl },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (migration.error || migration.status !== 0) {
    throw new Error('Disposable PostgreSQL migrations did not complete successfully.');
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), 'omnis-os-test-services-'));
  const workerEnvPath = join(tempDirectory, 'worker.env');
  const apiEnvPath = join(tempDirectory, 'api.env');
  const authorizerEnvPath = join(tempDirectory, 'authorizer.env');
  const launcherEnvPath = join(tempDirectory, 'sandbox-launcher.env');
  const canaryName = `OMNIS_DUMMY_PROVIDER_SECRET_${randomBytes(12).toString('hex')}`;
  const canary = `OMNIS_SYNTHETIC_CANARY_${randomBytes(24).toString('hex')}`;
  const apiPort = await freePort(excludedPorts);
  excludedPorts.add(apiPort);
  const workerPort = await freePort(excludedPorts);
  const authorizerSocket = join(tempDirectory, 'authorizer.sock');
  const launcherSocket = join(tempDirectory, 'launcher.sock');
  const salt = randomBytes(16);
  const internalToken = randomBytes(48).toString('hex');
  const authorizerToken = randomBytes(48).toString('hex');
  const passwordHash = (await scrypt(testOwnerPassword, salt, 64)).toString('hex');
  const sharedEnvLines = [
    `OMNIS_OWNER_PASSWORD_HASH=${salt.toString('hex')}:${passwordHash}`,
    `OMNIS_SESSION_SECRET=${randomBytes(48).toString('hex')}`,
    `OMNIS_INTERNAL_TOKEN=${internalToken}`,
    `OMNIS_API_AUTHORIZER_TOKEN=${authorizerToken}`,
    'OMNIS_API_HOST=127.0.0.1',
    `OMNIS_API_PORT=${apiPort}`,
    'OMNIS_WORKER_HOST=127.0.0.1',
    `OMNIS_WORKER_PORT=${workerPort}`,
    `OMNIS_AUTHORIZER_SOCKET=${authorizerSocket}`,
    `OMNIS_ALLOWED_ORIGIN=${parsedOrigin.origin}`,
    'OMNIS_SECURE_COOKIES=false',
  ];

  try {
    await writeFile(apiEnvPath, `${sharedEnvLines.join('\n')}\n`, { mode: 0o600 });
    await writeFile(
      workerEnvPath,
      `${[
        ...sharedEnvLines.filter(
          (line) =>
            !/^(?:OMNIS_API_AUTHORIZER_TOKEN|OMNIS_OWNER_PASSWORD_HASH|OMNIS_SESSION_SECRET|OMNIS_ALLOWED_ORIGIN|OMNIS_SECURE_COOKIES)=/.test(
              line,
            ),
        ),
        `OMNIS_DATABASE_URL=${databaseUrl}`,
        `OMNIS_SANDBOX_LAUNCHER_SOCKET=${launcherSocket}`,
      ].join('\n')}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      authorizerEnvPath,
      [
        `OMNIS_API_AUTHORIZER_TOKEN=${authorizerToken}`,
        `OMNIS_AGENT_IDEMPOTENCY_KEY=${randomBytes(32).toString('hex')}`,
        'OMNIS_AGENT_IDEMPOTENCY_KEY_VERSION=1',
        `OMNIS_AUTHORIZER_DATABASE_URL=${authorizerUrl}`,
        `OMNIS_AUTHORIZER_SOCKET=${authorizerSocket}`,
        'OMNIS_AUTHORIZER_SOCKET_MODE=600',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    await writeFile(
      launcherEnvPath,
      [
        `OMNIS_LAUNCHER_DATABASE_URL=${launcherUrl}`,
        `OMNIS_SANDBOX_LAUNCHER_SOCKET=${launcherSocket}`,
        'OMNIS_SANDBOX_LAUNCHER_SOCKET_MODE=600',
        `OMNIS_SANDBOX_WORKSPACE_ROOT=${join(tempDirectory, 'workspaces')}`,
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  let auditPool;
  let worker;
  let authorizer;
  let launcher;
  let api;
  let cleanupPromise;
  const startWorker = () => {
    const env = withoutDatabaseSecrets(process.env);
    delete env.OMNIS_TEST_DATABASE_URL;
    delete env.OMNIS_TEST_MIGRATION_DATABASE_URL;
    delete env.OMNIS_TEST_ADMIN_DATABASE_URL;
    env[canaryName] = canary;
    if (process.env.OMNIS_RECOVERY_INTEGRATION === '1') {
      env.NODE_ENV = 'test';
      env.OMNIS_MOCK_TEST_DELAY_MS = '1000';
    }
    return startService('apps/worker', workerEnvPath, env);
  };
  const startApi = () => {
    const env = withoutDatabaseSecrets(process.env);
    delete env[canaryName];
    return startService('apps/api', apiEnvPath, env);
  };
  const startAuthorizer = () => {
    const env = withoutDatabaseSecrets(process.env);
    delete env.OMNIS_TEST_DATABASE_URL;
    delete env.OMNIS_TEST_MIGRATION_DATABASE_URL;
    delete env.OMNIS_TEST_ADMIN_DATABASE_URL;
    return startService('apps/authorizer', authorizerEnvPath, env);
  };
  const startLauncher = () =>
    startService('apps/sandbox-launcher', launcherEnvPath, withoutDatabaseSecrets(process.env));
  const cleanup = (processes = {}) => {
    cleanupPromise ??= (async () => {
      const stopped = await Promise.allSettled(
        [
          processes.api ?? api,
          processes.worker ?? worker,
          processes.launcher ?? launcher,
          processes.authorizer ?? authorizer,
        ]
          .filter(Boolean)
          .map((child) => stopProcess(child)),
      );
      try {
        await auditPool?.end();
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
      const failure = stopped.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return cleanupPromise;
  };

  try {
    if (adminAuditUrl) {
      auditPool = createPool({
        connectionString: adminAuditUrl,
        max: 1,
        application_name: 'omnis-canary-check',
      });
    }
    worker = startWorker();
    authorizer = startAuthorizer();
    launcher = startLauncher();
    api = startApi();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const workerUrl = `http://127.0.0.1:${workerPort}`;
    await waitForHealth({
      apiUrl,
      workerUrl,
      internalToken,
      workerProcess: worker,
      apiProcess: api,
      authorizerSocket,
      authorizerProcess: authorizer,
      launcherSocket,
      launcherProcess: launcher,
    });
    return {
      password: testOwnerPassword,
      origin: parsedOrigin.origin,
      databaseUrl,
      migrationUrl,
      authorizerUrl,
      launcherUrl,
      apiPort,
      workerPort,
      apiUrl,
      workerUrl,
      internalToken,
      authorizerSocket,
      launcherSocket,
      workerEnvPath,
      apiEnvPath,
      authorizerEnvPath,
      launcherEnvPath,
      canaryName,
      canary,
      auditPool,
      api,
      worker,
      authorizer,
      launcher,
      startWorker,
      startApi,
      startAuthorizer,
      startLauncher,
      waitForHealth: (
        _apiUrl,
        _workerUrl,
        _internalToken,
        currentWorker,
        currentApi,
        _authorizerSocket,
        currentAuthorizer,
        _launcherSocket,
        currentLauncher = launcher,
      ) =>
        waitForHealth({
          apiUrl,
          workerUrl,
          internalToken,
          workerProcess: currentWorker,
          apiProcess: currentApi,
          authorizerSocket,
          authorizerProcess: currentAuthorizer,
          launcherSocket,
          launcherProcess: currentLauncher,
        }),
      waitForAuthorizer: (_socket, currentAuthorizer) =>
        waitForAuthorizer(authorizerSocket, currentAuthorizer),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function withoutDatabaseSecrets(environment) {
  const clean = { ...environment };
  for (const key of [
    'OMNIS_DB_PASSWORD',
    'OMNIS_RUNTIME_DB_PASSWORD',
    'OMNIS_AUTHORIZER_DB_PASSWORD',
    'OMNIS_LAUNCHER_DB_PASSWORD',
    'OMNIS_MIGRATION_DB_PASSWORD',
    'OMNIS_MIGRATION_DATABASE_URL',
    'OMNIS_DATABASE_URL',
    'OMNIS_AUTHORIZER_DATABASE_URL',
    'OMNIS_LAUNCHER_DATABASE_URL',
    'OMNIS_ADMIN_DATABASE_URL',
    'OMNIS_API_AUTHORIZER_TOKEN',
    'OMNIS_OWNER_PASSWORD_HASH',
    'OMNIS_SESSION_SECRET',
    'OMNIS_INTERNAL_TOKEN',
    'OMNIS_ALLOWED_ORIGIN',
    'OMNIS_SECURE_COOKIES',
    'OMNIS_TEST_DATABASE_URL',
    'OMNIS_TEST_MIGRATION_DATABASE_URL',
    'OMNIS_TEST_ADMIN_DATABASE_URL',
    'OMNIS_TEST_AUTHORIZER_DATABASE_URL',
    'OMNIS_TEST_LAUNCHER_DATABASE_URL',
    'OMNIS_TEST_API_PROXY_TARGET',
    'OMNIS_TEST_FRONTEND_ORIGIN',
    'OMNIS_TEST_FRONTEND_PORT',
    'OMNIS_TEST_DIAGNOSTICS_PATH',
    'OMNIS_TEST_DEBUG',
  ]) {
    delete clean[key];
  }
  return clean;
}

export async function freePort(excluded = new Set()) {
  while (true) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not reserve an ephemeral port.');
    }
    const { port } = address;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (!excluded.has(port)) return port;
  }
}

export async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(1500).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

export function socketRequest(socketPath, requestPath, init = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path: requestPath,
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.once('end', () => resolve(new Response(body, { status: res.statusCode ?? 503 })));
      },
    );
    req.once('error', reject);
    req.setTimeout(3_000, () => req.destroy(new Error('unix_socket_request_timeout')));
    req.end(init.body);
  });
}

function requiredDatabaseUrl(name, username) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point to a disposable PostgreSQL database.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid PostgreSQL connection URL.`);
  }
  if (parsed.protocol !== 'postgresql:' || parsed.username !== username) {
    throw new Error(`${name} must use its restricted Omnis database role.`);
  }
  if (
    name === 'OMNIS_TEST_DATABASE_URL' &&
    !/(?:^|[_-])test(?:s)?$/i.test(parsed.pathname.slice(1))
  ) {
    throw new Error('OMNIS_TEST_DATABASE_URL must name a disposable test database.');
  }
  if (!['127.0.0.1', '::1', 'localhost', 'postgres'].includes(parsed.hostname)) {
    throw new Error(`${name} must use the isolated PostgreSQL service.`, { cause: undefined });
  }
  return value;
}

function urlUsername(value) {
  try {
    return new URL(value).username;
  } catch {
    return undefined;
  }
}

function parseLoopbackOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The integration frontend Origin must be a loopback HTTP URL.');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
    throw new Error('The integration frontend Origin must use an explicit 127.0.0.1 port.');
  }
  return parsed;
}

function startService(appDirectory, envFile, env) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', `--env-file=${envFile}`, 'src/server.ts'],
    {
      cwd: new URL(`../../../${appDirectory}/`, import.meta.url),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.capturedLogs = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      child.capturedLogs = `${child.capturedLogs}${chunk.toString('utf8')}`.slice(-262_144);
    });
  }
  return child;
}

async function waitForHealth({
  apiUrl,
  workerUrl,
  internalToken,
  workerProcess,
  apiProcess,
  authorizerSocket,
  authorizerProcess,
  launcherSocket,
  launcherProcess,
}) {
  const startedAt = Date.now();
  let health = { api: false, worker: false, authorizer: false, launcher: false };
  while (Date.now() - startedAt < 8_000) {
    if (
      workerProcess.exitCode !== null ||
      apiProcess.exitCode !== null ||
      authorizerProcess.exitCode !== null ||
      launcherProcess.exitCode !== null
    ) {
      throw new Error('A mock service exited before readiness completed.');
    }
    try {
      const [apiHealth, workerHealth, authorizerHealth, launcherHealth] = await Promise.all([
        fetch(`${apiUrl}/api/v1/health`),
        fetch(`${workerUrl}/internal/v1/health`, {
          headers: { 'x-omnis-internal-token': internalToken },
        }),
        socketRequest(authorizerSocket, '/internal/v1/health'),
        socketRequest(launcherSocket, '/health'),
      ]);
      health = {
        api: apiHealth.ok,
        worker: workerHealth.ok,
        authorizer: authorizerHealth.ok,
        launcher: launcherHealth.ok,
      };
      if (Object.values(health).every(Boolean)) return;
    } catch {
      await delay(80);
    }
  }
  const missing = Object.entries(health)
    .filter(([, healthy]) => !healthy)
    .map(([service]) => service)
    .join(', ');
  throw new Error(`Mock service readiness timed out for: ${missing || 'unknown service'}.`);
}

async function waitForAuthorizer(authorizerSocket, authorizerProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    if (authorizerProcess.exitCode !== null) {
      throw new Error('The mock authorizer exited before becoming healthy.');
    }
    try {
      if ((await socketRequest(authorizerSocket, '/internal/v1/health')).ok) return;
    } catch {
      await delay(80);
    }
  }
  throw new Error('The mock authorizer did not become healthy within eight seconds.');
}

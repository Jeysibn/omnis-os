import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../../../packages/db/src/index.ts';

const scrypt = promisify(scryptCallback);

export const testOwnerPassword = 'test-owner-password-2026';

export async function startMockServices({
  origin,
  requireAuditPool = false,
  reservedPorts = [],
  enableSyntheticBrokerTestMode = false,
}) {
  const databaseConfig = validateTestDatabaseConfiguration(process.env, {
    requireAdmin: requireAuditPool,
  });
  const {
    urls: {
      OMNIS_TEST_DATABASE_URL: databaseUrl,
      OMNIS_TEST_MIGRATION_DATABASE_URL: migrationUrl,
      OMNIS_TEST_AUTHORIZER_DATABASE_URL: authorizerUrl,
      OMNIS_TEST_LAUNCHER_DATABASE_URL: launcherUrl,
      OMNIS_TEST_ADMIN_DATABASE_URL: adminAuditUrl,
    },
  } = databaseConfig;
  const queueName = process.env.OMNIS_QUEUE_NAME ?? 'omnis-mock-run';
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(queueName)) {
    throw new Error('The disposable worker queue name is invalid.');
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

  const queueGuardPool = createPool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'omnis-test-queue-safety-check',
  });
  try {
    await assertNoExecutableWork(queueGuardPool, queueName);
  } finally {
    await queueGuardPool.end();
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
  const brokerAuthorizerSocket = join(tempDirectory, 'broker-authorizer.sock');
  const syntheticBrokerSocket = join(tempDirectory, 'synthetic-broker.sock');
  const launcherSocket = join(tempDirectory, 'launcher.sock');
  const salt = randomBytes(16);
  const internalToken = randomBytes(48).toString('hex');
  const authorizerToken = randomBytes(48).toString('hex');
  const brokerAuthorizerToken = randomBytes(48).toString('hex');
  const syntheticBrokerTestToken = randomBytes(48).toString('hex');
  const sessionSecret = randomBytes(48).toString('hex');
  const agentIdempotencyKey = randomBytes(32).toString('hex');
  const sensitiveLogCanaries = [
    canary,
    testOwnerPassword,
    databaseUrl,
    migrationUrl,
    authorizerUrl,
    launcherUrl,
    adminAuditUrl,
    internalToken,
    authorizerToken,
    brokerAuthorizerToken,
    syntheticBrokerTestToken,
    sessionSecret,
    agentIdempotencyKey,
    passwordHash,
  ];
  const decisionKeyFile = join(tempDirectory, 'authorizer-ed25519.pem');
  const decisionKeyNotBefore = new Date(Date.now() - 5_000).toISOString();
  const decisionKeyNotAfter = new Date(Date.now() + 60 * 60_000).toISOString();
  const decisionKeyPair = enableSyntheticBrokerTestMode
    ? generateKeyPairSync('ed25519')
    : undefined;
  const passwordHash = (await scrypt(testOwnerPassword, salt, 64)).toString('hex');
  const sharedEnvLines = [
    `OMNIS_OWNER_PASSWORD_HASH=${salt.toString('hex')}:${passwordHash}`,
    `OMNIS_SESSION_SECRET=${sessionSecret}`,
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
    await writeFile(
      apiEnvPath,
      `${[
        ...sharedEnvLines,
        ...(enableSyntheticBrokerTestMode ? ['OMNIS_SYNTHETIC_BROKER_TEST_MODE=1'] : []),
      ].join('\n')}\n`,
      { mode: 0o600 },
    );
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
        ...(enableSyntheticBrokerTestMode
          ? [
              'OMNIS_SYNTHETIC_BROKER_TEST_MODE=1',
              `OMNIS_SYNTHETIC_BROKER_SOCKET=${syntheticBrokerSocket}`,
              `OMNIS_SYNTHETIC_BROKER_TEST_TOKEN=${syntheticBrokerTestToken}`,
            ]
          : []),
      ].join('\n')}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      authorizerEnvPath,
      [
        `OMNIS_API_AUTHORIZER_TOKEN=${authorizerToken}`,
        `OMNIS_AGENT_IDEMPOTENCY_KEY=${agentIdempotencyKey}`,
        'OMNIS_AGENT_IDEMPOTENCY_KEY_VERSION=1',
        `OMNIS_AUTHORIZER_DATABASE_URL=${authorizerUrl}`,
        `OMNIS_AUTHORIZER_SOCKET=${authorizerSocket}`,
        'OMNIS_AUTHORIZER_SOCKET_MODE=600',
        ...(enableSyntheticBrokerTestMode
          ? [
              `OMNIS_BROKER_AUTHORIZER_SOCKET=${brokerAuthorizerSocket}`,
              `OMNIS_BROKER_AUTHORIZER_TOKEN=${brokerAuthorizerToken}`,
              `OMNIS_CONNECTOR_DECISION_KEY_FILE=${decisionKeyFile}`,
              'OMNIS_CONNECTOR_DECISION_KEY_ID=disposable-test-key-v1',
              `OMNIS_CONNECTOR_DECISION_KEY_NOT_BEFORE=${decisionKeyNotBefore}`,
              `OMNIS_CONNECTOR_DECISION_KEY_NOT_AFTER=${decisionKeyNotAfter}`,
            ]
          : []),
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    if (decisionKeyPair) {
      await writeFile(
        decisionKeyFile,
        decisionKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        { mode: 0o600 },
      );
    }
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
  let syntheticBrokerFixture;
  let syntheticBrokerProcess;
  let cleanupPromise;
  const startWorker = async () => {
    const env = withoutDatabaseSecrets(process.env);
    delete env.OMNIS_TEST_DATABASE_URL;
    delete env.OMNIS_TEST_MIGRATION_DATABASE_URL;
    delete env.OMNIS_TEST_ADMIN_DATABASE_URL;
    env[canaryName] = canary;
    if (process.env.OMNIS_RECOVERY_INTEGRATION === '1' || enableSyntheticBrokerTestMode) {
      env.NODE_ENV = 'test';
    }
    if (process.env.OMNIS_RECOVERY_INTEGRATION === '1') {
      env.OMNIS_MOCK_TEST_DELAY_MS = '1000';
    }
    return startService('apps/worker', workerEnvPath, env, sensitiveLogCanaries);
  };
  const startApi = async () => {
    const env = withoutDatabaseSecrets(process.env);
    delete env[canaryName];
    if (enableSyntheticBrokerTestMode) env.NODE_ENV = 'test';
    return startService('apps/api', apiEnvPath, env, sensitiveLogCanaries);
  };
  const startAuthorizer = async () => {
    const env = withoutDatabaseSecrets(process.env);
    delete env.OMNIS_TEST_DATABASE_URL;
    delete env.OMNIS_TEST_MIGRATION_DATABASE_URL;
    delete env.OMNIS_TEST_ADMIN_DATABASE_URL;
    return startService('apps/authorizer', authorizerEnvPath, env, sensitiveLogCanaries);
  };
  const startLauncher = async () =>
    startService(
      'apps/sandbox-launcher',
      launcherEnvPath,
      withoutDatabaseSecrets(process.env),
      sensitiveLogCanaries,
    );
  const cleanup = (processes = {}) => {
    cleanupPromise ??= (async () => {
      const stopped = await Promise.allSettled(
        [
          processes.api ?? api,
          processes.worker ?? worker,
          processes.launcher ?? launcher,
          processes.authorizer ?? authorizer,
          syntheticBrokerProcess,
        ]
          .filter(Boolean)
          .map((child) => stopProcess(child)),
      );
      try {
        await auditPool?.end();
      } finally {
        await syntheticBrokerFixture?.close();
        await rm(tempDirectory, { recursive: true, force: true });
      }
      const failure = stopped.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return cleanupPromise;
  };

  try {
    if (enableSyntheticBrokerTestMode) {
      syntheticBrokerFixture = await startSyntheticBrokerFixture({
        socketPath: syntheticBrokerSocket,
        testToken: syntheticBrokerTestToken,
        authorizerSocket: brokerAuthorizerSocket,
        authorizerToken: brokerAuthorizerToken,
        sensitiveValues: sensitiveLogCanaries,
      });
      syntheticBrokerProcess = syntheticBrokerFixture.process;
    }
    if (adminAuditUrl) {
      auditPool = createPool({
        connectionString: adminAuditUrl,
        max: 1,
        application_name: 'omnis-canary-check',
      });
    }
    const started = await startServicesWithCleanup(
      [startWorker, startAuthorizer, startLauncher, startApi],
      async (children) => {
        [worker, authorizer, launcher, api] = children;
        await cleanup({ worker, authorizer, launcher, api });
      },
    );
    [worker, authorizer, launcher, api] = started;
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
      syntheticBrokerFixture,
      syntheticBrokerProcess,
      assertSensitiveValuesAbsentFromLogs: () =>
        assertSensitiveValuesAbsentFromLogs(sensitiveLogCanaries, [
          { name: 'API', process: api },
          { name: 'worker', process: worker },
          { name: 'authorizer', process: authorizer },
          { name: 'synthetic broker', process: syntheticBrokerProcess },
        ]),
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
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Mock service startup failed and cleanup was incomplete.',
      );
    }
    throw error;
  }
}

export function validateTestDatabaseConfiguration(environment, { requireAdmin = false } = {}) {
  const definitions = [
    ['OMNIS_TEST_DATABASE_URL', 'omnis_runtime', true],
    ['OMNIS_TEST_MIGRATION_DATABASE_URL', 'omnis_migrator', true],
    ['OMNIS_TEST_AUTHORIZER_DATABASE_URL', 'omnis_authorizer', true],
    ['OMNIS_TEST_LAUNCHER_DATABASE_URL', 'omnis_launcher', true],
    ['OMNIS_TEST_ADMIN_DATABASE_URL', 'omnis', requireAdmin],
  ];
  const urls = {};
  const parsedUrls = [];

  for (const [name, username, required] of definitions) {
    const value = environment[name];
    if (!value) {
      if (required) throw new Error(`${name} must be configured for the disposable test database.`);
      continue;
    }
    const parsed = parseTestDatabaseUrl(name, value, username);
    urls[name] = value;
    parsedUrls.push({ name, ...parsed });
  }

  const intended = parsedUrls.find(({ name }) => name === 'OMNIS_TEST_DATABASE_URL');
  if (!intended?.isTestDatabase) {
    throw new Error('OMNIS_TEST_DATABASE_URL must name a disposable test database.');
  }
  if (
    parsedUrls.some(
      ({ databaseName, host, port }) =>
        databaseName !== intended.databaseName || host !== intended.host || port !== intended.port,
    )
  ) {
    throw new Error(
      'All configured database URLs must target the same disposable test database and local PostgreSQL endpoint.',
    );
  }

  return {
    urls,
    databaseName: intended.databaseName,
    host: intended.host,
    port: intended.port,
  };
}

function parseTestDatabaseUrl(name, value, expectedUsername) {
  if (/%(?![0-9a-fA-F]{2})/.test(value)) {
    throw new Error(`${name} uses an unsupported PostgreSQL URL form.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid PostgreSQL connection URL.`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const pathname = parsed.pathname;
  const databaseName = pathname.startsWith('/') ? pathname.slice(1) : '';
  const isLoopback = host === '127.0.0.1' || host === '::1';
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (
    parsed.protocol !== 'postgresql:' ||
    parsed.username !== expectedUsername ||
    !parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^[A-Za-z0-9_-]+$/.test(databaseName) ||
    !isLoopback ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      `${name} must use a supported PostgreSQL URL, the expected restricted role, and a loopback PostgreSQL endpoint.`,
    );
  }
  return {
    databaseName,
    host,
    port,
    isTestDatabase: /(?:^|[_-])test(?:s)?$/i.test(databaseName),
  };
}

export function buildBrowserEnvironment(
  source,
  { apiTarget, frontendOrigin, frontendPort, ownerPassword, syntheticProjectId },
) {
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'CI',
    'PLAYWRIGHT_BROWSERS_PATH',
  ];
  const environment = {};
  for (const name of allowed) {
    if (typeof source[name] === 'string' && source[name].length > 0) {
      environment[name] = source[name];
    }
  }
  if (!environment.PATH || !environment.HOME) {
    throw new Error('The isolated browser runner requires PATH and HOME.');
  }
  if (!apiTarget || !frontendOrigin || !Number.isInteger(frontendPort) || !ownerPassword) {
    throw new Error('The isolated browser runner is missing required test configuration.');
  }
  Object.assign(environment, {
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    OMNIS_TEST_API_PROXY_TARGET: apiTarget,
    OMNIS_TEST_FRONTEND_ORIGIN: frontendOrigin,
    OMNIS_TEST_FRONTEND_PORT: String(frontendPort),
    OMNIS_TEST_OWNER_PASSWORD: ownerPassword,
    ...(syntheticProjectId ? { OMNIS_TEST_SYNTHETIC_PROJECT_ID: syntheticProjectId } : {}),
  });
  return environment;
}

export async function assertNoExecutableWork(pool, queueName = 'omnis-mock-run') {
  let result;
  try {
    result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM omnis.runs
          WHERE status IN ('queued', 'running', 'stopping', 'unknown')) AS active_runs,
         (SELECT count(*)::int FROM pgboss.job
          WHERE name = $1 AND state IN ('created', 'retry', 'active')) AS queued_jobs`,
      [queueName],
    );
  } catch {
    throw new Error('Could not verify that the disposable test database has no executable work.');
  }
  const row = result.rows[0];
  if (!row || Number(row.active_runs) !== 0 || Number(row.queued_jobs) !== 0) {
    throw new Error(
      'The disposable test database contains existing executable work; refusing to start the worker.',
    );
  }
}

export async function startServicesWithCleanup(starters, cleanup) {
  const started = [];
  try {
    for (const start of starters) started.push(await start());
    return started;
  } catch (error) {
    try {
      await cleanup(started);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'A required test service failed to start and cleanup was incomplete.',
      );
    }
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
  if (!child || child.spawned === false || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = waitForExit(child, 1_500);
  child.kill('SIGTERM');
  if (!(await exited)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (!(await waitForExit(child, 1_500))) {
      throw new Error('A disposable test service did not exit after forced termination.');
    }
  }
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

export function appendCapturedLogChunk(child, chunk, values, maxBytes = 262_144) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const previousTail = child.sensitiveLogOverlap ?? '';
  const searchable = `${previousTail}${text}`;
  const maxCanaryLength = values.reduce(
    (length, value) => (typeof value === 'string' ? Math.max(length, value.length) : length),
    0,
  );
  child.sensitiveCanaryDetected ||= values.some(
    (value) => typeof value === 'string' && value.length > 0 && searchable.includes(value),
  );
  child.sensitiveLogOverlap = maxCanaryLength > 1 ? searchable.slice(-(maxCanaryLength - 1)) : '';
  child.capturedLogs = `${child.capturedLogs ?? ''}${text}`.slice(-maxBytes);
}

export function assertSensitiveValuesAbsentFromLogs(values, processes) {
  for (const { name, process: child } of processes) {
    const logs = child?.capturedLogs ?? '';
    if (
      child?.sensitiveCanaryDetected ||
      values.some((value) => typeof value === 'string' && value.length > 0 && logs.includes(value))
    ) {
      throw new Error(`A sensitive test value was written to ${name} logs.`);
    }
  }
}

export async function startSyntheticBrokerFixture({
  socketPath,
  testToken,
  authorizerSocket,
  authorizerToken,
  sensitiveValues = [],
}) {
  const inherited = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    if (typeof process.env[name] === 'string') inherited[name] = process.env[name];
  }
  const child = await startManagedProcess(
    process.execPath,
    [fileURLToPath(new URL('./fake-synthetic-broker.mjs', import.meta.url))],
    {
      env: {
        ...inherited,
        NODE_ENV: 'test',
        OMNIS_TEST_BROKER_SOCKET: socketPath,
        OMNIS_TEST_BROKER_TOKEN: testToken,
        OMNIS_TEST_BROKER_AUTHORIZER_SOCKET: authorizerSocket,
        OMNIS_TEST_BROKER_AUTHORIZER_TOKEN: authorizerToken,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  child.capturedLogs = '';
  child.sensitiveCanaryDetected = false;
  child.sensitiveLogOverlap = '';
  child.stderr?.on('data', (chunk) =>
    appendCapturedLogChunk(child, chunk, sensitiveValues, 65_536),
  );
  const timeoutAt = Date.now() + 5_000;
  let ready = false;
  while (Date.now() < timeoutAt && !ready) {
    if (child.exitCode !== null) throw new Error('Synthetic broker fixture exited during startup.');
    try {
      const response = await socketRequest(socketPath, '/health');
      ready = response.ok;
    } catch {
      await delay(50);
    }
  }
  if (!ready) {
    await stopProcess(child);
    throw new Error('Synthetic broker fixture health check did not become ready.');
  }
  return { process: child, close: () => stopProcess(child) };
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

async function startService(appDirectory, envFile, env, sensitiveValues) {
  const child = await startManagedProcess(
    process.execPath,
    ['--experimental-strip-types', `--env-file=${envFile}`, 'src/server.ts'],
    {
      cwd: new URL(`../../../${appDirectory}/`, import.meta.url),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.capturedLogs = '';
  child.sensitiveCanaryDetected = false;
  child.sensitiveLogOverlap = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      appendCapturedLogChunk(child, chunk, sensitiveValues);
    });
  }
  return child;
}

export async function startManagedProcess(command, args, options = {}) {
  let child;
  try {
    child = spawn(command, args, options);
  } catch {
    throw new Error('A required disposable test service failed to start.');
  }
  child.spawned = false;
  await new Promise((resolve, reject) => {
    let settled = false;
    const onSpawn = () => {
      child.spawned = true;
      settled = true;
      resolve();
    };
    const onError = () => {
      child.spawnError = true;
      child.removeListener('spawn', onSpawn);
      if (!settled) {
        settled = true;
        reject(new Error('A required disposable test service failed to start.'));
      }
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  child.spawnError ??= false;
  return child;
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
    const failedService = [
      ['worker', workerProcess],
      ['api', apiProcess],
      ['authorizer', authorizerProcess],
      ['launcher', launcherProcess],
    ].find(([, child]) => child.spawnError);
    if (failedService) throw new Error(`The mock ${failedService[0]} failed to spawn.`);
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

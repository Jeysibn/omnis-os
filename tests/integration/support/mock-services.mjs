import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PostgresAuthorizationStore,
  PostgresRunStore,
  createPool,
} from '../../../packages/db/src/index.ts';

const scrypt = promisify(scryptCallback);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export const testOwnerPassword = 'test-owner-password-2026';

export async function startMockServices({
  origin,
  requireAuditPool = false,
  composeManagedApplication = false,
  databaseSocketDirectory,
  reservedPorts = [],
  enableSyntheticBrokerTestMode = false,
  enableSyntheticBrokerProcessTestMode = false,
  syntheticLostAckRequestId,
  syntheticCancellationRequestId,
}) {
  if (enableSyntheticBrokerProcessTestMode && !enableSyntheticBrokerTestMode) {
    throw new Error('The synthetic broker process test requires the owner-authorized test mode.');
  }
  const databaseConfig = validateTestDatabaseConfiguration(process.env, {
    requireAdmin: requireAuditPool,
    unixSocketDirectory: composeManagedApplication ? databaseSocketDirectory : undefined,
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
  const authorizerSocket = join(
    composeManagedApplication ? join(tempDirectory, 'authorizer') : tempDirectory,
    'authorizer.sock',
  );
  const brokerSocketDirectory = enableSyntheticBrokerProcessTestMode
    ? join(tempDirectory, 'broker-runtime')
    : tempDirectory;
  const brokerAuthorizerDirectory = enableSyntheticBrokerProcessTestMode
    ? join(tempDirectory, 'broker-authorizer')
    : tempDirectory;
  const brokerSecretDirectory = join(tempDirectory, 'broker-secrets');
  const brokerAuthorizerSocket = join(brokerAuthorizerDirectory, 'broker-authorizer.sock');
  const syntheticBrokerSocket = join(brokerSocketDirectory, 'broker.sock');
  const launcherSocket = join(
    composeManagedApplication ? join(tempDirectory, 'launcher') : tempDirectory,
    'launcher.sock',
  );
  const salt = randomBytes(16);
  const internalToken = randomBytes(48).toString('hex');
  const authorizerToken = randomBytes(48).toString('hex');
  const brokerAuthorizerToken = randomBytes(48).toString('hex');
  const syntheticBrokerTestToken = randomBytes(48).toString('hex');
  const sessionSecret = randomBytes(48).toString('hex');
  const agentIdempotencyKey = randomBytes(32).toString('hex');
  const decisionKeyFile = join(tempDirectory, 'authorizer-ed25519.pem');
  const decisionKeyNotBefore = new Date(Date.now() - 5_000).toISOString();
  const decisionKeyNotAfter = new Date(Date.now() + 60 * 60_000).toISOString();
  const fakeProviderToken = randomBytes(48).toString('hex');
  const decisionKeyPair = enableSyntheticBrokerTestMode
    ? generateKeyPairSync('ed25519')
    : undefined;
  const passwordHash = (await scrypt(testOwnerPassword, salt, 64)).toString('hex');
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
    fakeProviderToken,
  ];
  const sharedEnvLines = [
    `OMNIS_OWNER_PASSWORD_HASH=${salt.toString('hex')}:${passwordHash}`,
    `OMNIS_SESSION_SECRET=${sessionSecret}`,
    `OMNIS_INTERNAL_TOKEN=${internalToken}`,
    `OMNIS_API_AUTHORIZER_TOKEN=${authorizerToken}`,
    'OMNIS_API_HOST=127.0.0.1',
    `OMNIS_API_PORT=${apiPort}`,
    'OMNIS_WORKER_HOST=127.0.0.1',
    `OMNIS_WORKER_PORT=${workerPort}`,
    `OMNIS_AUTHORIZER_SOCKET=${composeManagedApplication ? '/run/omnis-authorizer/authorizer.sock' : authorizerSocket}`,
    `OMNIS_ALLOWED_ORIGIN=${parsedOrigin.origin}`,
    'OMNIS_SECURE_COOKIES=false',
  ];

  try {
    if (enableSyntheticBrokerProcessTestMode) {
      await Promise.all([
        mkdir(brokerSocketDirectory, { mode: 0o770 }),
        mkdir(brokerAuthorizerDirectory, { mode: 0o770 }),
        mkdir(brokerSecretDirectory, { mode: 0o750 }),
      ]);
      await chmod(brokerSocketDirectory, 0o770);
      await chmod(brokerAuthorizerDirectory, 0o770);
      await chmod(brokerSecretDirectory, 0o750);
      await Promise.all([
        writeFile(join(brokerSecretDirectory, 'caller.token'), syntheticBrokerTestToken, {
          mode: 0o440,
        }),
        writeFile(join(brokerSecretDirectory, 'authorizer.token'), brokerAuthorizerToken, {
          mode: 0o440,
        }),
        writeFile(join(brokerSecretDirectory, 'provider.token'), fakeProviderToken, {
          mode: 0o444,
        }),
      ]);
    }
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
        `OMNIS_SANDBOX_LAUNCHER_SOCKET=${composeManagedApplication ? '/run/omnis-sandbox/launcher.sock' : launcherSocket}`,
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
        `OMNIS_AUTHORIZER_SOCKET_MODE=${composeManagedApplication ? '660' : '600'}`,
        ...(enableSyntheticBrokerTestMode
          ? [
              `OMNIS_BROKER_AUTHORIZER_SOCKET=${brokerAuthorizerSocket}`,
              `OMNIS_BROKER_AUTHORIZER_TOKEN=${brokerAuthorizerToken}`,
              ...(enableSyntheticBrokerProcessTestMode
                ? ['OMNIS_BROKER_AUTHORIZER_SOCKET_MODE=660']
                : []),
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
        `OMNIS_SANDBOX_LAUNCHER_SOCKET_MODE=${composeManagedApplication ? '660' : '600'}`,
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
  let syntheticBrokerCompose;
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
        await syntheticBrokerCompose?.close();
        await syntheticBrokerFixture?.close();
        await rm(tempDirectory, { recursive: true, force: true });
      }
      const failure = stopped.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return cleanupPromise;
  };

  try {
    if (composeManagedApplication) {
      await Promise.all([
        mkdir(dirname(authorizerSocket), { mode: 0o770 }),
        mkdir(dirname(launcherSocket), { mode: 0o770 }),
      ]);
      await Promise.all([
        chmod(dirname(authorizerSocket), 0o770),
        chmod(dirname(launcherSocket), 0o770),
      ]);
    }
    if (enableSyntheticBrokerTestMode && !enableSyntheticBrokerProcessTestMode) {
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
    const starters = composeManagedApplication
      ? [startAuthorizer, startLauncher]
      : [startWorker, startAuthorizer, startLauncher, startApi];
    const started = await startServicesWithCleanup(starters, async (children) => {
      if (composeManagedApplication) [authorizer, launcher] = children;
      else [worker, authorizer, launcher, api] = children;
      await cleanup({ worker, authorizer, launcher, api });
    });
    if (composeManagedApplication) [authorizer, launcher] = started;
    else [worker, authorizer, launcher, api] = started;
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const workerUrl = `http://127.0.0.1:${workerPort}`;
    if (!composeManagedApplication)
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
    else {
      await waitForAuthorizer(authorizerSocket, authorizer);
      await waitForLauncher(launcherSocket, launcher);
    }
    if (enableSyntheticBrokerProcessTestMode) {
      const trustAnchors = JSON.stringify([
        {
          keyId: 'disposable-test-key-v1',
          publicKeyPem: decisionKeyPair.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
          notBefore: decisionKeyNotBefore,
          notAfter: decisionKeyNotAfter,
        },
      ]);
      syntheticBrokerCompose = await startSyntheticBrokerCompose({
        brokerSocketPath: syntheticBrokerSocket,
        brokerSocketDirectory,
        brokerAuthorizerDirectory,
        brokerSecretDirectory,
        trustAnchors,
        providerTokenPath: join(brokerSecretDirectory, 'provider.token'),
        sensitiveValues: sensitiveLogCanaries,
        lostAckRequestId: syntheticLostAckRequestId,
        cancellationRequestId: syntheticCancellationRequestId,
        restartProjectionServices: async () => {
          // These are disposable test children; preserve canary evidence before replacement.
          await stopProcess(worker);
          await stopProcess(authorizer);
          assertSensitiveValuesAbsentFromLogs(sensitiveLogCanaries, [
            { name: 'worker before restart', process: worker },
            { name: 'authorizer before restart', process: authorizer },
          ]);
          worker = await startWorker();
          authorizer = await startAuthorizer();
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
        },
      });
    }
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

      syntheticBrokerCompose,
      async createAcceptedTaskReconciliationFixture() {
        return createAcceptedTaskReconciliationFixture({ databaseUrl, authorizerUrl, auditPool });
      },
      async assertAcceptedTaskReconciliation(fixture) {
        return assertAcceptedTaskReconciliation({ auditPool, fixture });
      },

      assertSensitiveValuesAbsentFromLogs: () => {
        assertSensitiveValuesAbsentFromLogs(sensitiveLogCanaries, [
          { name: 'API', process: api },
          { name: 'worker', process: worker },
          { name: 'authorizer', process: authorizer },
          { name: 'sandbox launcher', process: launcher },
          { name: 'synthetic broker', process: syntheticBrokerProcess },
        ]);
        syntheticBrokerCompose?.assertSensitiveValuesAbsentFromLogs();
      },

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

export function validateTestDatabaseConfiguration(
  environment,
  { requireAdmin = false, unixSocketDirectory } = {},
) {
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
    const parsed = parseTestDatabaseUrl(name, value, username, { unixSocketDirectory });
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

function parseTestDatabaseUrl(name, value, expectedUsername, { unixSocketDirectory } = {}) {
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
  const socketHost = parsed.searchParams.get('host');
  const usesAllowedUnixSocket =
    typeof unixSocketDirectory === 'string' &&
    unixSocketDirectory.startsWith('/') &&
    host === 'localhost' &&
    socketHost === unixSocketDirectory &&
    parsed.searchParams.size === 1;
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (
    parsed.protocol !== 'postgresql:' ||
    parsed.username !== expectedUsername ||
    !parsed.password ||
    (parsed.search && !usesAllowedUnixSocket) ||
    parsed.hash ||
    !/^[A-Za-z0-9_-]+$/.test(databaseName) ||
    (!isLoopback && !usesAllowedUnixSocket) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      `${name} must use a supported PostgreSQL URL, the expected restricted role, and a loopback PostgreSQL endpoint or explicitly approved test Unix-socket endpoint.`,
    );
  }
  return {
    databaseName,
    host: usesAllowedUnixSocket ? socketHost : host,
    port,
    isTestDatabase: /(?:^|[_-])test(?:s)?$/i.test(databaseName),
  };
}

export function buildBrowserEnvironment(
  source,
  {
    apiTarget,
    frontendOrigin,
    frontendPort,
    ownerPassword,
    syntheticProjectId,
    lostAckRequestId,
    cancellationRequestId,
  },
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
    ...(lostAckRequestId ? { OMNIS_TEST_SYNTHETIC_LOST_ACK_REQUEST_ID: lostAckRequestId } : {}),
    ...(cancellationRequestId
      ? { OMNIS_TEST_SYNTHETIC_CANCELLATION_REQUEST_ID: cancellationRequestId }
      : {}),
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

async function startSyntheticBrokerCompose({
  brokerSocketPath,
  brokerSocketDirectory,
  brokerAuthorizerDirectory,
  brokerSecretDirectory,
  trustAnchors,
  providerTokenPath,
  sensitiveValues,
  lostAckRequestId,
  cancellationRequestId,
  restartProjectionServices,
}) {
  const projectName = `omnis-broker-e2e-${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const compose = [
    'compose',
    '--profile',
    'process-e2e',
    '--project-name',
    projectName,
    '--file',
    'infra/compose/synthetic-egress.yml',
  ];
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
    OMNIS_FAKE_PROVIDER_TOKEN_FILE: providerTokenPath,
    OMNIS_BROKER_TEST_PROVIDER_FIXTURES: JSON.stringify({
      default: 'delayed-events',
      ...(cancellationRequestId
        ? { [cancellationRequestId]: 'delayed-cancel-confirmed-events' }
        : {}),
      ...(lostAckRequestId ? { [lostAckRequestId]: 'lost-ack' } : {}),
    }),
    OMNIS_BROKER_TEST_TRUST_ANCHORS: trustAnchors,
    OMNIS_BROKER_TEST_SOCKET_DIRECTORY: brokerSocketDirectory,
    OMNIS_BROKER_TEST_AUTHORIZER_DIRECTORY: brokerAuthorizerDirectory,
    OMNIS_BROKER_TEST_SECRET_DIRECTORY: brokerSecretDirectory,
    OMNIS_BROKER_TEST_GROUP_ID: String(process.getgid?.() ?? 1001),
  };
  const runCompose = (arguments_) =>
    spawnSync('docker', [...compose, ...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  const started = runCompose(['up', '--build', '--detach', 'broker-process']);
  if (started.error || started.status !== 0) {
    runCompose(['down', '--volumes', '--remove-orphans']);
    throw new Error('Disposable synthetic broker Compose service did not start.');
  }

  try {
    const timeoutAt = Date.now() + 30_000;
    while (Date.now() < timeoutAt) {
      try {
        const response = await socketRequest(brokerSocketPath, '/health');
        if ([401, 404].includes(response.status)) {
          return {
            async interruptAfterAcceptedAttempt(auditPool, createdAfter) {
              const acceptedDeadline = Date.now() + 30_000;
              let attemptId;
              while (Date.now() < acceptedDeadline) {
                const accepted = await auditPool.query(
                  `SELECT attempt.id
                     FROM omnis.connector_execution_attempts AS attempt
                     JOIN omnis.connector_authorization_audit AS audit
                       ON audit.attempt_id = attempt.id
                      AND audit.event_type = 'connector.submission_accepted'
                    WHERE attempt.status = 'accepted'
                      AND attempt.provider_submission_id IS NOT NULL
                      AND audit.occurred_at >= $1
                    ORDER BY audit.occurred_at DESC
                    LIMIT 1`,
                  [createdAfter],
                );
                attemptId = accepted.rows[0]?.id;
                if (attemptId) break;
                await delay(20);
              }
              if (!attemptId) {
                const logs = runCompose(['logs', 'fake-provider']);
                const fixtures = logs.stdout
                  ?.match(/synthetic_fake_provider_fixture_selected:[a-z-]+/g)
                  ?.join(',');
                throw new Error(
                  `No accepted synthetic attempt appeared before the broker restart deadline${fixtures ? `; ${fixtures}` : ''}.`,
                );
              }

              const killed = runCompose(['kill', '--signal', 'SIGKILL', 'broker-process']);
              if (killed.error || killed.status !== 0)
                throw new Error('Disposable synthetic broker process could not be interrupted.');
              // Keep the broker unavailable beyond the real worker recovery deadline.
              const unknownDeadline = Date.now() + 65_000;
              let sawUnknown = false;
              while (Date.now() < unknownDeadline) {
                const projection = await auditPool.query(
                  `SELECT run.status, attempt.status AS attempt_status FROM omnis.runs AS run JOIN omnis.connector_execution_attempts AS attempt
                   ON attempt.authorization_id=run.connector_authorization_id WHERE attempt.id=$1`,
                  [attemptId],
                );
                if (projection.rows[0]?.status === 'unknown') {
                  if (!['accepted', 'completed'].includes(projection.rows[0].attempt_status))
                    throw new Error(
                      'Attempt left the recoverable state before late broker recovery.',
                    );
                  sawUnknown = true;
                  break;
                }
                await delay(100);
              }
              if (!sawUnknown)
                throw new Error('Worker did not persist unknown before late broker recovery.');

              await restartProjectionServices?.();

              const restarted = runCompose(['up', '--detach', '--no-deps', 'broker-process']);
              if (restarted.error || restarted.status !== 0)
                throw new Error('Disposable synthetic broker process did not restart.');

              const recoveryDeadline = Date.now() + 20_000;
              while (Date.now() < recoveryDeadline) {
                const response = await socketRequest(brokerSocketPath, '/health').catch(
                  () => undefined,
                );
                if (response && [401, 404].includes(response.status)) break;
                await delay(100);
              }
              const attemptDeadline = Date.now() + 50_000;
              while (Date.now() < attemptDeadline) {
                const recovered = await auditPool.query(
                  `SELECT attempt.status, run.status AS run_status,
                    (SELECT count(*)::int FROM omnis.connector_authorization_audit WHERE attempt_id=attempt.id AND event_type='connector.submission_started') AS submissions,
                    (SELECT count(*)::int FROM omnis.run_events WHERE run_id=run.id AND event_type='run.completed') AS completions
                   FROM omnis.connector_execution_attempts AS attempt JOIN omnis.runs AS run ON run.connector_authorization_id=attempt.authorization_id WHERE attempt.id=$1`,
                  [attemptId],
                );
                if (
                  recovered.rows[0]?.status === 'completed' &&
                  recovered.rows[0]?.run_status === 'completed'
                ) {
                  if (recovered.rows[0].submissions !== 1 || recovered.rows[0].completions !== 1)
                    throw new Error('Late recovery duplicated submission or completion.');
                  return;
                }
                await delay(100);
              }
              throw new Error('Broker restart did not reconcile the accepted synthetic attempt.');
            },
            async restartAfterLostAcknowledgement(auditPool, requestId) {
              const attemptDeadline = Date.now() + 60_000;
              let attemptId;
              while (Date.now() < attemptDeadline) {
                const result = await auditPool.query(
                  `SELECT id FROM omnis.connector_execution_attempts
                    WHERE request_id = $1 AND status = 'submitting'
                    ORDER BY created_at DESC LIMIT 1`,
                  [requestId],
                );
                attemptId = result.rows[0]?.id;
                if (attemptId) break;
                await delay(100);
              }
              if (!attemptId)
                throw new Error('Lost-ack synthetic attempt did not enter durable submission.');

              const acceptanceDeadline = Date.now() + 10_000;
              let acceptanceRecorded = false;
              while (Date.now() < acceptanceDeadline) {
                const logs = runCompose(['logs', 'fake-provider']);
                if (logs.error || logs.status !== 0)
                  throw new Error('Fake-provider acceptance evidence could not be read.');
                if (logs.stdout.includes('synthetic_fake_provider_lost_ack_acceptance_recorded')) {
                  acceptanceRecorded = true;
                  break;
                }
                await delay(100);
              }
              if (!acceptanceRecorded)
                throw new Error(
                  'Fake provider did not record acceptance before the lost-ack restart.',
                );

              const current = await auditPool.query(
                `SELECT status, provider_submission_id
                   FROM omnis.connector_execution_attempts WHERE id = $1`,
                [attemptId],
              );
              if (
                current.rows[0]?.status !== 'submitting' ||
                current.rows[0]?.provider_submission_id !== null
              )
                throw new Error('Lost-ack precondition changed before broker interruption.');

              const killed = runCompose(['kill', '--signal', 'SIGKILL', 'broker-process']);
              if (killed.error || killed.status !== 0)
                throw new Error('Broker could not be interrupted after fake-provider acceptance.');
              const restarted = runCompose(['up', '--detach', '--no-deps', 'broker-process']);
              if (restarted.error || restarted.status !== 0)
                throw new Error('Broker did not restart after lost acknowledgement.');

              const terminalDeadline = Date.now() + 60_000;
              while (Date.now() < terminalDeadline) {
                const state = await auditPool.query(
                  `SELECT attempt.status AS attempt_status,
                          attempt.provider_submission_id,
                          attempt.usage_provenance,
                          run.status AS run_status,
                          (SELECT count(*) FROM omnis.connector_execution_attempts AS same_auth
                            WHERE same_auth.authorization_id = attempt.authorization_id) AS attempt_count
                     FROM omnis.connector_execution_attempts AS attempt
                     JOIN omnis.runs AS run
                       ON run.connector_authorization_id = attempt.authorization_id
                    WHERE attempt.id = $1`,
                  [attemptId],
                );
                const row = state.rows[0];
                if (row?.attempt_status === 'unknown' && row.run_status === 'unknown') {
                  if (
                    row.provider_submission_id !== null ||
                    row.attempt_count !== '1' ||
                    row.usage_provenance?.kind !== 'unknown'
                  )
                    throw new Error('Lost-ack recovery violated unknown-outcome invariants.');
                  return;
                }
                await delay(150);
              }
              throw new Error('Broker restart did not persist the lost-ack outcome as unknown.');
            },
            async restartAfterAcceptedCancellation(auditPool, createdAfter) {
              const cancellationDeadline = Date.now() + 60_000;
              let attemptId;
              let runId;
              while (Date.now() < cancellationDeadline) {
                const cancellation = await auditPool.query(
                  `SELECT attempt.id, run.id AS run_id
                     FROM omnis.connector_execution_attempts AS attempt
                     JOIN omnis.runs AS run
                       ON run.connector_authorization_id = attempt.authorization_id
                    WHERE attempt.status = 'accepted'
                      AND attempt.provider_submission_id IS NOT NULL
                      AND attempt.cancel_requested_at IS NOT NULL
                      AND run.status = 'stopping'
                      AND attempt.created_at >= $1
                    ORDER BY attempt.created_at DESC
                    LIMIT 1`,
                  [createdAfter],
                );
                attemptId = cancellation.rows[0]?.id;
                runId = cancellation.rows[0]?.run_id;
                if (attemptId && runId) break;
                await delay(100);
              }
              if (!attemptId || !runId)
                throw new Error('No accepted, owner-cancelled attempt appeared before restart.');

              const killed = runCompose(['kill', '--signal', 'SIGKILL', 'broker-process']);
              if (killed.error || killed.status !== 0)
                throw new Error(
                  'Disposable broker process could not be interrupted during cancellation.',
                );
              const restarted = runCompose(['up', '--detach', '--no-deps', 'broker-process']);
              if (restarted.error || restarted.status !== 0)
                throw new Error('Disposable broker process did not restart during cancellation.');

              const recoveryDeadline = Date.now() + 20_000;
              while (Date.now() < recoveryDeadline) {
                const response = await socketRequest(brokerSocketPath, '/health').catch(
                  () => undefined,
                );
                if (response && [401, 404].includes(response.status)) break;
                await delay(100);
              }
              const terminalDeadline = Date.now() + 50_000;
              while (Date.now() < terminalDeadline) {
                const recovered = await auditPool.query(
                  `SELECT attempt.status AS attempt_status, run.status AS run_status
                     FROM omnis.connector_execution_attempts AS attempt
                     JOIN omnis.runs AS run
                       ON run.connector_authorization_id = attempt.authorization_id
                    WHERE attempt.id = $1 AND run.id = $2`,
                  [attemptId, runId],
                );
                if (
                  recovered.rows[0]?.attempt_status === 'interrupted' &&
                  recovered.rows[0]?.run_status === 'cancelled'
                )
                  return;
                await delay(100);
              }
              throw new Error('Broker restart did not reconcile the owner cancellation.');
            },
            close() {
              const stopped = runCompose(['down', '--volumes', '--remove-orphans']);
              if (stopped.error || stopped.status !== 0) {
                throw new Error('Disposable synthetic broker Compose cleanup failed.');
              }
            },
            safeFailureDiagnostics() {
              assertComposeLogsContainNoSensitiveValues(runCompose, sensitiveValues);
              const logs = runCompose(['logs', 'broker-process', 'fake-provider']);
              if (logs.error || logs.status !== 0)
                return 'broker logs unavailable after integration failure';
              const markers = logs.stdout
                .split('\n')
                .filter((line) =>
                  /synthetic_fake_provider_(?:fixture_selected:[a-z-]+|lost_ack_acceptance_recorded|delayed_event_lookup)/.test(
                    line,
                  ),
                );
              return markers.length
                ? markers.slice(-8).join(',')
                : 'no fake-provider marker observed';
            },
            assertSensitiveValuesAbsentFromLogs() {
              assertComposeLogsContainNoSensitiveValues(runCompose, sensitiveValues);
            },
          };
        }
      } catch {
        // The broker socket may appear before the process accepts connections.
      }
      await delay(100);
    }
    throw new Error('Synthetic broker process socket did not become ready.');
  } catch (error) {
    runCompose(['down', '--volumes', '--remove-orphans']);
    throw error;
  }
}

async function createAcceptedTaskReconciliationFixture({ databaseUrl, authorizerUrl, auditPool }) {
  if (!auditPool)
    throw new Error('The disposable acceptance fixture requires its admin audit pool.');
  const runtime = createPool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'omnis-test-accepted-task-fixture',
  });
  const authorizer = createPool({
    connectionString: authorizerUrl,
    max: 1,
    application_name: 'omnis-test-accepted-task-fixture',
  });
  let task;
  let staleRunId;
  let runId;
  let acceptance;
  try {
    const store = new PostgresRunStore(runtime);
    const authorizationStore = new PostgresAuthorizationStore(runtime, authorizer);
    task = await store.createTask({
      title: `Synthetic accepted-task reconciliation ${randomUUID()}`,
      detail: 'Disposable PostgreSQL fixture for owner receipt reconciliation.',
    });
    const completeSyntheticRun = async (workerId) => {
      const request = await authorizationStore.request(task.id, 'owner');
      const authorization = await authorizationStore.decide(request.id, 'owner', 'approve');
      const admitted = await store.admitRun(
        task.id,
        workerId,
        authorization.id,
        async () => `fixture-job-${workerId}`,
      );
      const claim = await store.beginExecution(admitted.run.id, workerId, 30);
      await store.completeRun(
        admitted.run.id,
        workerId,
        claim.generation,
        `Synthetic completion ${workerId}.`,
        [],
      );
      return admitted.run.id;
    };

    staleRunId = await completeSyntheticRun(`acceptance-fixture-${randomUUID()}`);
    await transitionTaskWithRuntime(runtime, task.id, 'in_review', 'in_progress');
    runId = await completeSyntheticRun(`acceptance-fixture-${randomUUID()}`);
    acceptance = await new PostgresRunStore(authorizer).acceptTaskResult(
      task.id,
      { runId },
      randomUUID(),
    );
    assert.equal(acceptance.created, true);
    assert.equal(acceptance.acceptance.acceptedBy, 'owner');
    assert.equal(acceptance.acceptance.runId, runId);

    await transitionTaskWithRuntime(runtime, task.id, 'completed', 'in_progress');
    await transitionTaskWithRuntime(runtime, task.id, 'in_progress', 'in_review');
    await assertRuntimeCannotForgeAcceptance(runtime, task.id, runId);
  } finally {
    await runtime.end();
    await authorizer.end();
  }

  const state = await readAcceptanceFixtureState(auditPool, task.id, runId);
  assert.equal(state.taskStatus, 'in_review');
  assert.equal(state.runStatus, 'completed');
  assert.equal(state.latestRunId, runId);
  assert.equal(state.receipt?.acceptedBy, 'owner');
  assert.equal(state.receipt?.runId, runId);
  assert.deepEqual(
    state.receipt,
    acceptance.acceptance,
    'reopening the accepted task must leave its immutable owner receipt unchanged',
  );
  assert.deepEqual(state.counts, { receipts: '1', ownerEvents: '1' });
  return {
    taskId: task.id,
    runId,
    staleRunId,
    receipt: state.receipt,
    initialCounts: state.counts,
  };
}

async function transitionTaskWithRuntime(runtime, taskId, from, to) {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT omnis.acquire_mission_lane_admission(false, 3000)');
    const update = await client.query(
      'UPDATE omnis.tasks SET status=$3 WHERE id=$1 AND status=$2',
      [taskId, from, to],
    );
    assert.equal(update.rowCount, 1, `fixture must transition task ${from} to ${to}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertRuntimeCannotForgeAcceptance(runtime, taskId, runId) {
  const completionClient = await runtime.connect();
  try {
    await completionClient.query('BEGIN');
    await completionClient.query('SELECT omnis.acquire_mission_lane_admission(false, 3000)');
    await assert.rejects(
      completionClient.query(
        `UPDATE omnis.tasks SET status='completed'
          WHERE id=$1 AND status='in_review'`,
        [taskId],
      ),
      /requires the owner authorizer/,
      'runtime credentials must not directly complete an accepted task',
    );
    await completionClient.query('ROLLBACK');
  } catch (error) {
    await completionClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    completionClient.release();
  }

  await assert.rejects(
    runtime.query(
      `INSERT INTO omnis.task_result_acceptances(task_id, run_id, request_id)
       VALUES ($1, $2, $3)`,
      [taskId, runId, randomUUID()],
    ),
    /permission denied/,
    'runtime credentials must not insert owner acceptance receipts',
  );
}

async function assertAcceptedTaskReconciliation({ auditPool, fixture }) {
  const { taskId, runId, receipt, initialCounts } = fixture ?? {};
  if (
    !auditPool ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(taskId ?? '') ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(runId ?? '') ||
    !receipt
  ) {
    throw new Error('The accepted-task reconciliation verification input is malformed.');
  }
  const state = await readAcceptanceFixtureState(auditPool, taskId, runId);
  assert.equal(state.taskStatus, 'completed', 'owner API reconciliation must complete the task');
  assert.equal(state.runStatus, 'completed');
  assert.equal(state.latestRunId, runId);
  assert.deepEqual(
    state.receipt,
    receipt,
    'owner API reconciliation must preserve the original receipt',
  );
  assert.deepEqual(state.counts, {
    receipts: '1',
    ownerEvents: String(Number(initialCounts?.ownerEvents) + 1),
  });
  return state;
}

async function readAcceptanceFixtureState(auditPool, taskId, runId) {
  const { rows } = await auditPool.query(
    `SELECT task.status AS task_status, run.status AS run_status,
            receipt.run_id AS receipt_run_id, receipt.accepted_by,
            to_char(receipt.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at,
            receipt.request_id,
            (SELECT latest.id FROM omnis.runs AS latest WHERE latest.task_id=task.id
              ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS latest_run_id,
            (SELECT count(*)::text FROM omnis.task_result_acceptances WHERE task_id=task.id) AS receipts,
            (SELECT count(*)::text FROM omnis.mission_lane_events
              WHERE task_id=task.id AND event_type='task.status_changed' AND actor='owner') AS owner_events
       FROM omnis.tasks AS task
       JOIN omnis.runs AS run ON run.id=$2 AND run.task_id=task.id
       LEFT JOIN omnis.task_result_acceptances AS receipt
         ON receipt.task_id=task.id AND receipt.run_id=run.id
      WHERE task.id=$1`,
    [taskId, runId],
  );
  assert.equal(rows.length, 1, 'fixture task and run must exist and belong together');
  const row = rows[0];
  return {
    taskStatus: row.task_status,
    runStatus: row.run_status,
    latestRunId: row.latest_run_id,
    receipt: row.receipt_run_id
      ? {
          runId: row.receipt_run_id,
          acceptedBy: row.accepted_by,
          acceptedAt: new Date(row.accepted_at).toISOString(),
          requestId: row.request_id,
        }
      : null,
    counts: { receipts: row.receipts, ownerEvents: row.owner_events },
  };
}

export function appendCapturedLogChunk(child, chunk, values, maxBytes = 262_144) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const previousTail = child.sensitiveLogOverlap ?? '';
  const searchable = `${previousTail}${text}`;
  const maxCanaryLength = values.reduce(
    (length, value) => (typeof value === 'string' ? Math.max(length, value.length) : length),
    0,
  );
  if (maxCanaryLength > 4_096) {
    throw new Error('A test log canary exceeds the bounded scan limit.');
  }
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

export function assertComposeLogsContainNoSensitiveValues(runCompose, sensitiveValues) {
  const logs = runCompose(['logs', '--no-color']);
  if (logs.error || logs.status !== 0) {
    throw new Error('Disposable synthetic broker logs could not be checked safely.');
  }
  assertSensitiveValuesAbsentFromLogs(sensitiveValues, [
    {
      name: 'synthetic broker Docker services',
      process: { capturedLogs: `${logs.stdout ?? ''}${logs.stderr ?? ''}` },
    },
  ]);
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

async function waitForLauncher(socketPath, process) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error('Disposable host boundary process exited before its socket became ready.');
    }
    try {
      if ((await socketRequest(socketPath, '/health')).ok) return;
    } catch {
      // The socket may not have been bound yet.
    }
    await delay(100);
  }
  throw new Error('Disposable host boundary socket did not become ready before the deadline.');
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

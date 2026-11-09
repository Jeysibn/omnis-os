import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { createConnection, createServer, isIPv4 } from 'node:net';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import { spawnSync } from 'node:child_process';
import {
  buildBrowserEnvironment,
  startMockServices,
  testOwnerPassword,
} from '../../tests/integration/support/mock-services.mjs';

const scrypt = promisify(scryptCallback);
const root = process.cwd();
const dockerEnvironment = Object.fromEntries(
  [
    'PATH',
    'HOME',
    'TMPDIR',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ]
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
const suffix = randomBytes(5).toString('hex');
const project = `omnis-compose-${process.pid}-${suffix}`;
const dbName = `omnis_compose_${suffix}_test`;
const directory = await mkdtemp(join(tmpdir(), 'omnis-compose-smoke-'));
const composeEnvPath = join(directory, 'compose.env');
const apiEnvPath = join(directory, 'api.env');
const workerEnvPath = join(directory, 'worker.env');
const postgresSocketDirectory = join(directory, 'postgres-socket');
const dbPassword = randomBytes(32).toString('hex');
const migrationPassword = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex');
const authorizerPassword = randomBytes(32).toString('hex');
const launcherPassword = randomBytes(32).toString('hex');
const occupiedPorts = new Set();
const dbPort = 5432;
const webPort = await freePort(occupiedPorts);
const origin = `http://127.0.0.1:${webPort}`;
const databaseHost = 'localhost';
let dbAdminUrl;
const redactions = [
  dbPassword,
  migrationPassword,
  runtimePassword,
  authorizerPassword,
  launcherPassword,
  testOwnerPassword,
];
let fixtures;
let stackStarted = false;
let failed = false;
const auxiliaryProjects = new Set();

function dbUrl(user, password) {
  return `postgresql://${user}:${encodeURIComponent(password)}@${databaseHost}:${dbPort}/${dbName}?host=${encodeURIComponent(postgresSocketDirectory)}`;
}

function configureDatabaseUrls() {
  dbAdminUrl = dbUrl('omnis', dbPassword);
  Object.assign(process.env, {
    OMNIS_TEST_ADMIN_DATABASE_URL: dbAdminUrl,
    OMNIS_TEST_MIGRATION_DATABASE_URL: dbUrl('omnis_migrator', migrationPassword),
    OMNIS_TEST_DATABASE_URL: dbUrl('omnis_runtime', runtimePassword),
    OMNIS_TEST_AUTHORIZER_DATABASE_URL: dbUrl('omnis_authorizer', authorizerPassword),
    OMNIS_TEST_LAUNCHER_DATABASE_URL: dbUrl('omnis_launcher', launcherPassword),
    OMNIS_DB_PASSWORD: dbPassword,
    OMNIS_DB_NAME: dbName,
    OMNIS_DB_PORT: String(dbPort),
    OMNIS_MIGRATION_DB_PASSWORD: migrationPassword,
    OMNIS_RUNTIME_DB_PASSWORD: runtimePassword,
    OMNIS_AUTHORIZER_DB_PASSWORD: authorizerPassword,
    OMNIS_LAUNCHER_DB_PASSWORD: launcherPassword,
  });
}

function runDocker(_command, args, options = {}) {
  return spawnSync('docker', args, {
    ...options,
    env: { ...dockerEnvironment, ...options.env },
  });
}

function dockerIds(args, description) {
  const result = runDocker('docker', args, { encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not verify ${description}: ${redact(result.stderr || result.error?.message || 'Docker returned no status')}`,
    );
  }
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function compose(args, { env = {}, timeout = 120_000, allowFailure = false } = {}) {
  const result = runDocker(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '--env-file',
      composeEnvPath,
      '-f',
      'infra/compose/docker-compose.yml',
      '-f',
      'infra/compose/docker-compose.app.yml',
      '-f',
      'infra/compose/docker-compose.ci.yml',
      ...args,
    ],
    {
      cwd: root,
      env: { ...dockerEnvironment, ...env },
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `Docker Compose ${args[0]} failed: ${redact(result.stderr || result.stdout || result.error?.message || 'unknown error')}`,
    );
  }
  return result;
}

function redact(value) {
  let safe = String(value);
  for (const secret of redactions) if (secret) safe = safe.replaceAll(secret, '[redacted]');
  return safe;
}

function assertComposeLogsContainNoSecrets() {
  const logs = compose(['logs', '--no-color']);
  const output = `${logs.stdout}\n${logs.stderr}`;
  assert.ok(
    !redactions.some((secret) => secret && output.includes(secret)),
    'generated Compose test credentials are absent from service logs',
  );
}

function writeEnv(path, entries) {
  return writeFile(path, `${entries.map(([name, value]) => `${name}=${value}`).join('\n')}\n`, {
    mode: 0o600,
  });
}

try {
  await Promise.all([
    mkdir(join(directory, 'authorizer-fixture'), { mode: 0o770 }),
    mkdir(join(directory, 'launcher-fixture'), { mode: 0o770 }),
    mkdir(postgresSocketDirectory, { mode: 0o2770 }),
  ]);
  await chmod(postgresSocketDirectory, 0o2770);
  const socketDirectoryStat = await lstat(postgresSocketDirectory);
  assert.equal(socketDirectoryStat.gid, Number(process.getgid?.() ?? 1001));
  assert.equal(socketDirectoryStat.mode & 0o7777, 0o2770);
  const temporaryOwnerSalt = randomBytes(16);
  const temporaryOwnerHash = (await scrypt(testOwnerPassword, temporaryOwnerSalt, 64)).toString(
    'hex',
  );
  await writeEnv(apiEnvPath, [
    ['OMNIS_OWNER_PASSWORD_HASH', `${temporaryOwnerSalt.toString('hex')}:${temporaryOwnerHash}`],
    ['OMNIS_SESSION_SECRET', randomBytes(48).toString('hex')],
    ['OMNIS_INTERNAL_TOKEN', randomBytes(48).toString('hex')],
    ['OMNIS_API_AUTHORIZER_TOKEN', randomBytes(48).toString('hex')],
    ['OMNIS_ALLOWED_ORIGIN', origin],
    ['OMNIS_SECURE_COOKIES', 'false'],
    ['OMNIS_API_HOST', '0.0.0.0'],
    ['OMNIS_API_PORT', '4100'],
    ['OMNIS_WORKER_HOST', 'worker'],
    ['OMNIS_WORKER_PORT', '4101'],
    ['OMNIS_AUTHORIZER_SOCKET', '/run/omnis-authorizer/authorizer.sock'],
  ]);
  await writeEnv(workerEnvPath, [
    ['OMNIS_INTERNAL_TOKEN', randomBytes(48).toString('hex')],
    [
      'OMNIS_DATABASE_URL',
      `postgresql://omnis_runtime:${encodeURIComponent(runtimePassword)}@postgres:5432/${dbName}`,
    ],
    ['OMNIS_SANDBOX_LAUNCHER_SOCKET', '/run/omnis-sandbox/launcher.sock'],
    ['OMNIS_WORKER_HOST', '0.0.0.0'],
    ['OMNIS_WORKER_PORT', '4101'],
  ]);
  const gid = String(process.getgid?.() ?? 1001);
  if ((process.getuid?.() ?? 0) === 0 || gid === '0') {
    throw new Error(
      'Compose smoke requires a non-root CI host identity with a non-root primary group.',
    );
  }
  await writeEnv(composeEnvPath, [
    ['OMNIS_DB_NAME', dbName],
    ['OMNIS_DB_PASSWORD', dbPassword],
    ['OMNIS_DB_PORT', String(dbPort)],
    ['OMNIS_WEB_PORT', String(webPort)],
    ['OMNIS_AUTHORIZER_SOCKET_GID', gid],
    ['OMNIS_LAUNCHER_SOCKET_GID', gid],
    ['OMNIS_CI_POSTGRES_SOCKET_GID', gid],
    ['OMNIS_CI_POSTGRES_SOCKET_DIRECTORY', postgresSocketDirectory],
    ['OMNIS_API_ENV_FILE', apiEnvPath],
    ['OMNIS_WORKER_ENV_FILE', workerEnvPath],
    ['OMNIS_CI_AUTHORIZER_SOCKET_DIRECTORY', join(directory, 'authorizer-fixture')],
    ['OMNIS_CI_LAUNCHER_SOCKET_DIRECTORY', join(directory, 'launcher-fixture')],
  ]);

  const renderedConfig = JSON.parse(compose(['config', '--format', 'json']).stdout);
  assert.deepEqual(
    renderedConfig.services.postgres.ports ?? [],
    [],
    'disposable PostgreSQL must remain unpublished outside its internal data network',
  );

  const postgresImagePull = runDocker('docker', ['pull', renderedConfig.services.postgres.image], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(
    postgresImagePull.status,
    0,
    `could not pull disposable PostgreSQL image: ${redact(postgresImagePull.stderr || 'unknown Docker error')}`,
  );
  const postgresIdentity = runDocker(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--read-only',
      '--entrypoint',
      'sh',
      renderedConfig.services.postgres.image,
      '-c',
      'id -u postgres; id -g postgres',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(
    postgresIdentity.status,
    0,
    `could not inspect disposable PostgreSQL image identity: ${redact(postgresIdentity.stderr || 'unknown Docker error')}`,
  );
  const [postgresUid, postgresGid] = postgresIdentity.stdout.trim().split(/\s+/).map(Number);
  assert.ok(Number.isInteger(postgresUid) && postgresUid > 0);
  assert.ok(Number.isInteger(postgresGid) && postgresGid > 0);
  await replaceEnv(
    composeEnvPath,
    await readFile(composeEnvPath, 'utf8').then((value) => value.split(/\r?\n/)),
    {
      OMNIS_CI_POSTGRES_UID: String(postgresUid),
      OMNIS_CI_POSTGRES_GID: String(postgresGid),
    },
  );

  stackStarted = true;
  compose(['up', '--detach', '--wait', '--wait-timeout', '90', 'postgres'], { timeout: 120_000 });
  assert.equal(
    compose([
      'exec',
      '-T',
      'postgres',
      'pg_isready',
      '-h',
      '/run/omnis-postgres-socket',
      '-U',
      'omnis',
      '-d',
      dbName,
    ]).status,
    0,
  );
  const postgresId = compose(['ps', '-q', 'postgres']).stdout.trim();
  assert.ok(postgresId, 'running disposable PostgreSQL container has an ID');
  const postgresNetworkInspection = runDocker(
    'docker',
    ['inspect', postgresId, '--format', '{{json .NetworkSettings.Networks}}'],
    { encoding: 'utf8' },
  );
  assert.equal(
    postgresNetworkInspection.status,
    0,
    `could not inspect disposable PostgreSQL networks: ${redact(postgresNetworkInspection.stderr || 'unknown Docker error')}`,
  );
  const postgresNetworks = Object.values(JSON.parse(postgresNetworkInspection.stdout));
  assert.equal(postgresNetworks.length, 1, 'PostgreSQL joins only the internal data network');
  const postgresAddress = postgresNetworks[0]?.IPAddress;
  assert.ok(isIPv4(postgresAddress), 'PostgreSQL has a data-network IPv4 address');
  const postgresSocket = join(postgresSocketDirectory, '.s.PGSQL.5432');
  const socketStat = await lstat(postgresSocket);
  assert.ok(socketStat.isSocket(), 'PostgreSQL Unix socket is available to host test fixtures');
  assert.equal(
    socketStat.gid,
    Number(gid),
    'PostgreSQL socket is group-owned by the CI runner group',
  );
  assert.equal(
    socketStat.mode & 0o777,
    0o770,
    'PostgreSQL socket grants access only to owner and CI group',
  );
  configureDatabaseUrls();
  const postgresPortInspection = runDocker(
    'docker',
    [
      'inspect',
      postgresId,
      '--format',
      '{{json .Config.ExposedPorts}}|{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Ports}}',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(
    postgresPortInspection.status,
    0,
    `could not inspect disposable PostgreSQL port binding: ${redact(postgresPortInspection.stderr || 'unknown Docker error')}`,
  );
  const [imageExposedPorts, hostPortBindings, postgresPorts] = postgresPortInspection.stdout
    .trim()
    .split('|')
    .map((value) => JSON.parse(value));
  const postgresBindingEvidence = {
    imageExposedPorts,
    hostPortBindings,
    runtimeNetworkPorts: postgresPorts,
  };
  const runtimePortBindings = Object.values(postgresPorts ?? {}).flatMap(
    (bindings) => bindings ?? [],
  );
  const hostPortBindingEntries = Object.values(hostPortBindings ?? {}).flatMap(
    (bindings) => bindings ?? [],
  );
  assert.equal(
    runtimePortBindings.length + hostPortBindingEntries.length,
    0,
    `PostgreSQL must have no host port publication: ${JSON.stringify(postgresBindingEvidence)}`,
  );
  const provision = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'packages/db/src/provision.ts'],
    {
      cwd: root,
      env: {
        ...Object.fromEntries(
          ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
            .filter((name) => process.env[name])
            .map((name) => [name, process.env[name]]),
        ),
        OMNIS_ADMIN_DATABASE_URL: dbAdminUrl,
        OMNIS_MIGRATION_DB_PASSWORD: migrationPassword,
        OMNIS_RUNTIME_DB_PASSWORD: runtimePassword,
        OMNIS_AUTHORIZER_DB_PASSWORD: authorizerPassword,
        OMNIS_LAUNCHER_DB_PASSWORD: launcherPassword,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  if (provision.error || provision.status !== 0) {
    throw new Error(
      `Disposable database role provisioning failed: ${redact(provision.stderr || provision.stdout || 'unknown error')}`,
    );
  }

  fixtures = await startMockServices({
    origin,
    requireAuditPool: true,
    composeManagedApplication: true,
    databaseSocketDirectory: postgresSocketDirectory,
  });
  // Host fixtures use the group-restricted socket; application containers use internal TCP.
  await writeEnv(composeEnvPath, [
    ['OMNIS_DB_NAME', dbName],
    ['OMNIS_DB_PASSWORD', dbPassword],
    ['OMNIS_DB_PORT', String(dbPort)],
    ['OMNIS_WEB_PORT', String(webPort)],
    ['OMNIS_AUTHORIZER_SOCKET_GID', gid],
    ['OMNIS_LAUNCHER_SOCKET_GID', gid],
    ['OMNIS_CI_POSTGRES_SOCKET_GID', gid],
    ['OMNIS_CI_POSTGRES_SOCKET_DIRECTORY', postgresSocketDirectory],
    ['OMNIS_API_ENV_FILE', apiEnvPath],
    ['OMNIS_WORKER_ENV_FILE', workerEnvPath],
    ['OMNIS_CI_AUTHORIZER_SOCKET_DIRECTORY', dirname(fixtures.authorizerSocket)],
    ['OMNIS_CI_LAUNCHER_SOCKET_DIRECTORY', dirname(fixtures.launcherSocket)],
  ]);
  const generatedApi = (await readFile(fixtures.apiEnvPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const generatedWorker = (await readFile(fixtures.workerEnvPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean);
  await replaceEnv(apiEnvPath, generatedApi, {
    OMNIS_API_HOST: '0.0.0.0',
    OMNIS_API_PORT: '4100',
    OMNIS_WORKER_HOST: 'worker',
    OMNIS_WORKER_PORT: '4101',
    OMNIS_ALLOWED_ORIGIN: origin,
    OMNIS_AUTHORIZER_SOCKET: '/run/omnis-authorizer/authorizer.sock',
  });
  await replaceEnv(workerEnvPath, generatedWorker, {
    OMNIS_WORKER_HOST: '0.0.0.0',
    OMNIS_WORKER_PORT: '4101',
    OMNIS_SANDBOX_LAUNCHER_SOCKET: '/run/omnis-sandbox/launcher.sock',
    OMNIS_DATABASE_URL: `postgresql://omnis_runtime:${encodeURIComponent(runtimePassword)}@postgres:5432/${dbName}`,
  });
  for (const envPath of [
    apiEnvPath,
    workerEnvPath,
    fixtures.authorizerEnvPath,
    fixtures.launcherEnvPath,
  ]) {
    for (const line of (await readFile(envPath, 'utf8')).split(/\r?\n/).filter(Boolean)) {
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const name = line.slice(0, separator);
      if (/(?:PASSWORD|HASH|SECRET|TOKEN|DATABASE_URL)/.test(name))
        redactions.push(line.slice(separator + 1));
    }
  }

  if (process.env.OMNIS_CI_PREBUILT_IMAGES === '1') {
    for (const image of ['omnis-api:ci', 'omnis-worker:ci', 'omnis-web:ci']) {
      const inspected = runDocker('docker', ['image', 'inspect', image], { encoding: 'utf8' });
      assert.equal(inspected.status, 0, `prebuilt Compose image is present: ${image}`);
    }
  } else {
    compose(['build', 'api', 'worker', 'web'], { timeout: 600_000 });
  }
  compose(['up', '--detach', '--wait', '--wait-timeout', '180', 'api', 'worker', 'web'], {
    timeout: 600_000,
  });
  await probeWebPath(false);
  await assertRuntimeRestrictions();
  await assertSocketPermissionDenials();
  await assertDeniedEgress();
  await assertMissingSocketFailsClosed();
  await probeWebPath(true);

  const browserEnvironment = buildBrowserEnvironment(process.env, {
    apiTarget: 'http://api:4100',
    frontendOrigin: origin,
    frontendPort: webPort,
    ownerPassword: testOwnerPassword,
  });
  browserEnvironment.OMNIS_TEST_EXTERNAL_WEB = '1';
  const browser = spawnSync('pnpm', ['--filter', '@omnis/web', 'test:e2e:integration'], {
    cwd: root,
    env: browserEnvironment,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (browser.error || browser.status !== 0) {
    const browserOutput = `${browser.stdout ?? ''}\n${browser.stderr ?? ''}`.trim();
    throw new Error(
      `Compose browser journey failed: ${redact(browserOutput || browser.error?.message || 'unknown error')}`,
    );
  }

  const run = await runMockJourney(origin, testOwnerPassword);
  const persistedBeforeRestart = await getRun(origin, run.id, run.cookie);
  assert.equal(persistedBeforeRestart.status, 'completed');
  const eventsBeforeRestart = await getEvents(origin, run.id, run.cookie);
  assert.ok(eventsBeforeRestart.length > 0);
  assert.ok(
    eventsBeforeRestart.every((event) => event.synthetic === true && event.source === 'mock'),
  );

  compose(['restart', 'worker']);
  await waitForHealthy('worker', 60_000);
  compose(['restart', 'api']);
  await waitForHealthy('api', 60_000);
  const ownerAfterApiRestart = await signInOwner(origin, testOwnerPassword);
  run.cookie = ownerAfterApiRestart.cookie;
  const persistedAfterRestart = await getRun(origin, run.id, run.cookie);
  assert.equal(persistedAfterRestart.status, 'completed');
  assert.deepEqual(await getEvents(origin, run.id, run.cookie), eventsBeforeRestart);

  compose(['restart', 'postgres']);
  await waitForHealthy('postgres', 60_000);
  await waitForHttp(`${origin}/api/v1/health`, 30_000);
  const afterDatabaseRestart = await waitForRunAvailable(origin, run.id, run.cookie, 30_000);
  assert.equal(afterDatabaseRestart.status, 'completed');
  assert.deepEqual(await getEvents(origin, run.id, run.cookie), eventsBeforeRestart);
  const taskList = await globalThis.fetch(`${origin}/api/v1/tasks`, {
    headers: { cookie: run.cookie },
  });
  assert.equal(taskList.status, 200);
  const persistedTask = (await taskList.json()).find((task) => task.id === run.taskId);
  assert.equal(persistedTask?.runtimeId, 'mock');
  assert.ok(persistedTask?.agentId);
  const postDatabaseRun = await runMockJourney(origin, testOwnerPassword);
  assert.equal(
    (await getRun(origin, postDatabaseRun.id, postDatabaseRun.cookie)).status,
    'completed',
  );
  assertComposeLogsContainNoSecrets();
  fixtures.assertSensitiveValuesAbsentFromLogs();
  process.stdout.write(
    'Disposable Compose smoke passed: health, browser owner flow, mock Run persistence, restart recovery, network policy, and fail-closed socket mount.\n',
  );
} catch (error) {
  failed = true;
  if (stackStarted) {
    const status = compose(['ps', '--all'], { allowFailure: true });
    const logs = compose(['logs', '--no-color', '--tail=100'], { allowFailure: true });
    const rawLogs = logs.stdout || logs.stderr || '';
    if (redactions.some((secret) => secret && rawLogs.includes(secret))) {
      process.stderr.write('A generated test credential appeared in Compose service logs.\n');
    }
    const diagnostics = [
      'Compose status:',
      redact(status.stdout || status.stderr || 'unavailable'),
      'Compose logs:',
      redact(logs.stdout || logs.stderr || 'unavailable'),
    ].join('\n');
    process.stderr.write(`${diagnostics}\n`);
    if (process.env.OMNIS_COMPOSE_DIAGNOSTICS_PATH) {
      await writeFile(process.env.OMNIS_COMPOSE_DIAGNOSTICS_PATH, `${diagnostics}\n`, {
        mode: 0o600,
      });
    }
    try {
      fixtures?.assertSensitiveValuesAbsentFromLogs();
    } catch {
      process.stderr.write(
        'A generated fixture credential appeared in host boundary process logs.\n',
      );
    }
  }
  process.stderr.write(`${redact(error?.stack ?? error)}\n`);
} finally {
  const down = compose(['down', '--volumes', '--remove-orphans'], {
    allowFailure: true,
    timeout: 60_000,
  });
  if (down.error || down.status !== 0) {
    failed = true;
    process.stderr.write(
      `Compose cleanup reported an error: ${redact(down.stderr || down.stdout || down.error?.message)}\n`,
    );
  }
  try {
    cleanupScopedResources();
  } catch (error) {
    failed = true;
    process.stderr.write(`Scoped Docker cleanup failed: ${redact(error)}\n`);
  } finally {
    if (fixtures) {
      try {
        await fixtures.cleanup();
      } catch (error) {
        failed = true;
        process.stderr.write(`Host fixture cleanup failed: ${redact(error)}\n`);
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
if (failed) process.exitCode = 1;

async function replaceEnv(path, sourceLines, overrides) {
  const entries = new Map();
  for (const line of sourceLines) {
    const separator = line.indexOf('=');
    if (separator > 0) entries.set(line.slice(0, separator), line.slice(separator + 1));
  }
  for (const [name, value] of Object.entries(overrides)) entries.set(name, value);
  await writeEnv(path, [...entries.entries()]);
}

async function freePort(excluded) {
  const server = createServer();
  for (;;) {
    await new Promise((resolve, reject) =>
      server.listen(0, '127.0.0.1', resolve).once('error', reject),
    );
    const address = server.address();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (!excluded.has(address.port)) {
      excluded.add(address.port);
      return address.port;
    }
  }
}

function cleanupScopedResources() {
  const scopeId = createHash('sha256').update(`/${dbName}`).digest('hex').slice(0, 24);
  const sandboxIds = dockerIds(
    [
      'ps',
      '-aq',
      '--filter',
      'label=com.omnis.os.sandbox=true',
      '--filter',
      `label=com.omnis.os.scope=${scopeId}`,
    ],
    'test-scoped mock sandbox containers',
  );
  if (sandboxIds.length) {
    const result = runDocker('docker', ['rm', '-f', ...sandboxIds], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0) {
      failed = true;
      process.stderr.write('Failed to remove test-scoped mock sandbox container(s).\n');
    }
  }
  if (
    dockerIds(
      [
        'ps',
        '-aq',
        '--filter',
        'label=com.omnis.os.sandbox=true',
        '--filter',
        `label=com.omnis.os.scope=${scopeId}`,
      ],
      'remaining test-scoped mock sandbox containers',
    ).length
  ) {
    failed = true;
    process.stderr.write('Test-scoped mock sandbox containers remain after cleanup.\n');
  }
  for (const projectName of [project, ...auxiliaryProjects]) {
    for (const [kind, args] of [
      ['container', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${projectName}`]],
      [
        'volume',
        ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`],
      ],
      [
        'network',
        ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`],
      ],
    ]) {
      const ids = dockerIds(args, `test-scoped Compose ${kind} resources for ${projectName}`);
      if (!ids.length) continue;
      const removeArgs =
        kind === 'container'
          ? ['rm', '-f', ...ids]
          : kind === 'volume'
            ? ['volume', 'rm', '-f', ...ids]
            : ['network', 'rm', ...ids];
      const result = runDocker('docker', removeArgs, { encoding: 'utf8', timeout: 30_000 });
      if (result.status !== 0) {
        failed = true;
        process.stderr.write(`Failed to clean test-scoped Compose ${kind} resources.\n`);
      }
    }
  }
  for (const projectName of [project, ...auxiliaryProjects]) {
    for (const [kind, args] of [
      ['container', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${projectName}`]],
      [
        'volume',
        ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`],
      ],
      [
        'network',
        ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`],
      ],
    ]) {
      const remaining = dockerIds(
        args,
        `remaining test-scoped Compose ${kind} resources for ${projectName}`,
      );
      if (remaining.length) {
        failed = true;
        process.stderr.write(`Test-scoped Compose ${kind} resources remain for ${projectName}.\n`);
      }
    }
  }
}

async function waitForHealthy(service, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = compose(['ps', '--all', '--format', 'json', service], { allowFailure: true });
    const rows = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((row) => {
        try {
          return [JSON.parse(row)];
        } catch {
          return [];
        }
      });
    if (rows.length && rows.every((row) => /healthy/i.test(row.Health ?? row.Status ?? ''))) return;
    if (rows.some((row) => /exited|dead|unhealthy/i.test(row.Status ?? ''))) {
      throw new Error(`${service} failed during restart; Compose status: ${redact(result.stdout)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${service} did not become healthy within ${timeout}ms.`);
}

async function waitForHttp(url, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if ((await globalThis.fetch(url)).ok) return;
    } catch {
      /* service is reconnecting */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`HTTP health endpoint did not recover before ${timeout}ms: ${url}`);
}

async function assertRuntimeRestrictions() {
  for (const service of ['api', 'worker', 'web']) {
    const id = compose(['ps', '-q', service]).stdout.trim();
    assert.ok(id, `${service} container id is available`);
    const inspected = JSON.parse(
      runDocker('docker', ['inspect', id], { encoding: 'utf8' }).stdout,
    )[0];
    assert.equal(inspected.Config.User, '10001:10001');
    assert.equal(inspected.HostConfig.Privileged, false);
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspected.HostConfig.RestartPolicy.Name, 'unless-stopped');
    assert.equal(inspected.HostConfig.Init, true);
    assert.ok(inspected.HostConfig.CapDrop.includes('ALL'));
    assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.ok(inspected.HostConfig.PidsLimit > 0);
    assert.ok(inspected.HostConfig.Memory > 0);
    assert.ok(inspected.HostConfig.NanoCpus > 0);
    assert.ok(!inspected.Mounts.some((mount) => /docker\.sock$/.test(mount.Source)));
    assert.ok(
      !inspected.Config.Env.some((value) =>
        /(?:OPENAI|ANTHROPIC|GOOGLE|PROVIDER)_API_KEY=/i.test(value),
      ),
    );
  }
  const postgresId = compose(['ps', '-q', 'postgres']).stdout.trim();
  const postgresInspect = JSON.parse(
    runDocker('docker', ['inspect', postgresId], { encoding: 'utf8' }).stdout,
  )[0];
  const postgresUid = Number(postgresInspect.Config.User.split(':')[0]);
  assert.ok(Number.isInteger(postgresUid) && postgresUid > 0);
  assert.equal(postgresInspect.HostConfig.Privileged, false);
  assert.ok(!postgresInspect.Mounts.some((mount) => /docker\.sock$/.test(mount.Source)));
  for (const service of ['api', 'worker']) {
    const id = compose(['ps', '-q', service]).stdout.trim();
    const ports = JSON.parse(
      runDocker('docker', ['inspect', id, '--format', '{{json .NetworkSettings.Ports}}'], {
        encoding: 'utf8',
      }).stdout,
    );
    assert.ok(
      Object.values(ports).every((bindings) => !bindings?.some((binding) => binding?.HostPort)),
    );
  }
  const webId = compose(['ps', '-q', 'web']).stdout.trim();
  const webInspect = JSON.parse(
    runDocker('docker', ['inspect', webId], { encoding: 'utf8' }).stdout,
  )[0];
  const webBindings = Object.values(webInspect.HostConfig.PortBindings ?? {}).flatMap(
    (value) => value ?? [],
  );
  assert.ok(webBindings.length > 0, 'web has a host port binding');
  assert.ok(
    webBindings.every(
      (binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === String(webPort),
    ),
    'web is published only on the selected loopback port',
  );
  const config = JSON.parse(compose(['config', '--format', 'json']).stdout);
  assert.equal(config.networks.edge.internal, true);
  assert.equal(config.networks.data.internal, true);
  assert.equal(config.services.api.ports?.length ?? 0, 0);
  assert.equal(config.services.worker.ports?.length ?? 0, 0);
  const networksByService = {};
  for (const service of ['api', 'worker', 'web', 'postgres']) {
    const id = compose(['ps', '-q', service]).stdout.trim();
    const inspect = JSON.parse(
      runDocker('docker', ['inspect', id], { encoding: 'utf8' }).stdout,
    )[0];
    networksByService[service] = Object.keys(inspect.NetworkSettings.Networks)
      .map((name) => name.replace(`${project}_`, ''))
      .sort();
  }
  assert.deepEqual(networksByService.api, ['data', 'edge']);
  assert.deepEqual(networksByService.worker, ['data']);
  assert.deepEqual(networksByService.web, ['edge']);
  assert.deepEqual(networksByService.postgres, ['data']);
  for (const network of ['edge', 'data']) {
    const inspect = JSON.parse(
      runDocker('docker', ['network', 'inspect', `${project}_${network}`], {
        encoding: 'utf8',
      }).stdout,
    )[0];
    assert.equal(inspect.Internal, true, `${network} network is internal at runtime`);
  }
  for (const [service, hiddenService] of [
    ['web', 'worker'],
    ['worker', 'web'],
  ]) {
    const id = compose(['ps', '-q', service]).stdout.trim();
    const probe = runDocker(
      'docker',
      [
        'exec',
        id,
        'node',
        '-e',
        `require('node:dns').promises.lookup('${hiddenService}').then(()=>process.exit(9)).catch(()=>process.exit(0))`,
      ],
      { encoding: 'utf8', timeout: 8_000 },
    );
    assert.equal(
      probe.status,
      0,
      `${service} cannot resolve the network-isolated ${hiddenService} service`,
    );
  }
}

async function assertDeniedEgress() {
  const apiId = compose(['ps', '-q', 'api']).stdout.trim();
  const probe = runDocker(
    'docker',
    [
      'exec',
      apiId,
      'node',
      '-e',
      "const net=require('node:net');const socket=net.createConnection({host:'1.1.1.1',port:443});socket.setTimeout(3000);socket.on('connect',()=>process.exit(9));socket.on('error',()=>process.exit(0));socket.on('timeout',()=>{socket.destroy();process.exit(0)})",
    ],
    { encoding: 'utf8', timeout: 8_000 },
  );
  assert.equal(probe.status, 0, 'API outbound Internet request must fail on internal networks');
}

async function assertSocketPermissionDenials() {
  for (const [source, socketName] of [
    [dirname(fixtures.authorizerSocket), 'authorizer.sock'],
    [dirname(fixtures.launcherSocket), 'launcher.sock'],
  ]) {
    const probe = runDocker(
      'docker',
      [
        'run',
        '--rm',
        '--label',
        `com.docker.compose.project=${project}`,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true',
        '--user=20000:20000',
        '--mount',
        `type=bind,source=${source},target=/socket,readonly`,
        '--entrypoint=node',
        'omnis-api:ci',
        '-e',
        `const net=require('node:net');const socket=net.createConnection({path:'/socket/${socketName}'});socket.on('connect',()=>process.exit(9));socket.on('error',e=>process.exit(e.code==='EACCES'?0:8))`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(
      probe.status,
      0,
      'a container outside the configured socket group is denied access to the host boundary socket',
    );
  }
}

async function assertMissingSocketFailsClosed() {
  const missingProject = `${project}-missing`;
  auxiliaryProjects.add(missingProject);
  const missingDir = join(directory, 'missing-authorizer');
  const missingOverlay = join(directory, 'missing-socket.yml');
  await writeFile(
    missingOverlay,
    `services:\n  api:\n    volumes:\n      - type: bind\n        source: ${missingDir}\n        target: /run/omnis-authorizer\n        read_only: true\n        bind:\n          create_host_path: false\n`,
  );
  const result = runDocker(
    'docker',
    [
      'compose',
      '--project-name',
      missingProject,
      '--env-file',
      composeEnvPath,
      '-f',
      'infra/compose/docker-compose.yml',
      '-f',
      'infra/compose/docker-compose.app.yml',
      '-f',
      'infra/compose/docker-compose.ci.yml',
      '-f',
      missingOverlay,
      'up',
      '--no-deps',
      '--detach',
      'api',
    ],
    { cwd: root, env: dockerEnvironment, encoding: 'utf8', timeout: 60_000 },
  );
  runDocker(
    'docker',
    [
      'compose',
      '--project-name',
      missingProject,
      '--env-file',
      composeEnvPath,
      '-f',
      'infra/compose/docker-compose.yml',
      '-f',
      'infra/compose/docker-compose.app.yml',
      '-f',
      'infra/compose/docker-compose.ci.yml',
      '-f',
      missingOverlay,
      'down',
      '--volumes',
      '--remove-orphans',
    ],
    { cwd: root, env: dockerEnvironment, encoding: 'utf8', timeout: 30_000 },
  );
  assert.ok(
    !result.error && result.status !== 0,
    'API must refuse a missing authorizer socket bind',
  );
  const failureText = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  assert.match(failureText, /no such file|does not exist|not found|bind source/i);
}

async function runMockJourney(origin, password) {
  const { cookie, ownerCsrf } = await signInOwner(origin, password);
  assert.equal(
    (await globalThis.fetch(`${origin}/api/v1/me`, { headers: { cookie } })).status,
    200,
  );
  const deniedCsrf = await globalThis.fetch(`${origin}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'x-omnis-csrf': 'invalid-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: 'Denied mutation', detail: 'CSRF protection remains enabled.' }),
  });
  assert.equal(deniedCsrf.status, 403);
  const headers = { cookie, origin, 'x-omnis-csrf': ownerCsrf, 'content-type': 'application/json' };
  const taskResponse = await globalThis.fetch(`${origin}/api/v1/tasks`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      title: `Compose synthetic ${randomUUID()}`,
      detail: 'CI-only deterministic mock execution.',
    }),
  });
  assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
  const task = await taskResponse.json();
  const agentResponse = await globalThis.fetch(`${origin}/api/v1/agents`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      name: 'Compose smoke agent',
      slug: `compose-${randomUUID().slice(0, 8)}`,
      departmentId: null,
    }),
  });
  assert.equal(agentResponse.status, 201, await agentResponse.clone().text());
  const agentId = (await agentResponse.json()).agentId;
  const profile = {
    profession: 'Synthetic integration assistant',
    seniority: null,
    specialties: ['CI validation'],
    personality: { traits: ['careful'], tone: 'plain', principles: ['report only fixture data'] },
    behavior: { autonomy: 'No external actions.', escalation: null },
    instructions: 'Return the deterministic mock result.',
  };
  const draft = await globalThis.fetch(`${origin}/api/v1/agents/${agentId}/draft-profile`, {
    method: 'PUT',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedDraftRevision: 0, baseVersionNo: null, profile }),
  });
  assert.equal(draft.status, 200, await draft.clone().text());
  const publish = await globalThis.fetch(`${origin}/api/v1/agents/${agentId}/publish`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersionNo: null, expectedDraftRevision: 1 }),
  });
  assert.equal(publish.status, 201, await publish.clone().text());
  const assignment = await globalThis.fetch(
    `${origin}/api/v1/tasks/${task.id}/execution-assignment`,
    {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        agentId,
        profileVersion: 1,
        runtimeId: 'mock',
        expectedAssignmentRevision: task.assignmentRevision,
      }),
    },
  );
  assert.equal(assignment.status, 200, await assignment.clone().text());
  const assignedTask = await assignment.json();
  assert.equal(assignedTask.agentId, agentId);
  assert.equal(assignedTask.runtimeId, 'mock');
  const requestKey = randomUUID();
  const requested = await globalThis.fetch(`${origin}/api/v1/authorizations`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': requestKey },
    body: JSON.stringify({ taskId: task.id }),
  });
  assert.equal(requested.status, 201, await requested.clone().text());
  const authorization = await requested.json();
  assert.equal(authorization.status, 'pending');
  const decision = await globalThis.fetch(
    `${origin}/api/v1/authorizations/${authorization.id}/decision`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approve' }),
    },
  );
  assert.equal(decision.status, 200, await decision.clone().text());
  const approved = await decision.json();
  const runKey = randomUUID();
  const runBody = JSON.stringify({ taskId: task.id, authorizationId: approved.id });
  const admitted = await globalThis.fetch(`${origin}/api/v1/runs`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': runKey },
    body: runBody,
  });
  assert.equal(admitted.status, 201, await admitted.clone().text());
  const run = await admitted.json();
  assert.equal(run.runtimeKind, 'mock');
  assert.equal(run.synthetic, true);
  const replay = await globalThis.fetch(`${origin}/api/v1/runs`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': runKey },
    body: runBody,
  });
  assert.ok([200, 201].includes(replay.status));
  assert.equal((await replay.json()).id, run.id);
  const deadline = Date.now() + 45_000;
  let current = run;
  while (current.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    current = await getRun(origin, run.id, cookie);
    assert.ok(
      !['unknown', 'failed'].includes(current.status),
      `unexpected synthetic Run status ${current.status}`,
    );
  }
  assert.equal(current.status, 'completed', 'deterministic mock Run reaches completed state');
  return { id: run.id, taskId: task.id, cookie };
}

async function signInOwner(origin, password) {
  const csrfResponse = await globalThis.fetch(`${origin}/api/v1/auth/csrf`);
  assert.equal(csrfResponse.status, 200);
  const anonymousCookie = cookieHeader(csrfResponse);
  const csrf = (await csrfResponse.json()).csrfToken;
  const login = await globalThis.fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      cookie: anonymousCookie,
      origin,
      'x-omnis-csrf': csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = mergeCookies(anonymousCookie, cookieHeader(login));
  const ownerCsrfResponse = await globalThis.fetch(`${origin}/api/v1/auth/csrf`, {
    headers: { cookie },
  });
  assert.equal(ownerCsrfResponse.status, 200);
  return { cookie, ownerCsrf: (await ownerCsrfResponse.json()).csrfToken };
}

async function getRun(origin, id, cookie) {
  const response = await globalThis.fetch(`${origin}/api/v1/runs/${id}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForRunAvailable(origin, id, cookie, timeout) {
  const deadline = Date.now() + timeout;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`${origin}/api/v1/runs/${id}`, {
        headers: { cookie },
      });
      lastStatus = String(response.status);
      if (response.status === 200) return response.json();
      if (response.status < 500 || response.status > 504) {
        throw new Error(`Run read failed with non-retryable HTTP ${response.status}.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Run read failed')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Run read did not recover after PostgreSQL restart before the deadline (last HTTP status: ${lastStatus}).`,
  );
}

async function getEvents(origin, id, cookie) {
  const controller = new globalThis.AbortController();
  const response = await globalThis.fetch(`${origin}/api/v1/runs/${id}/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const events = [];
  let buffer = '';
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 1_000)),
      ]);
      if ('timeout' in result) break;
      if (result.done) break;
      buffer += new TextDecoder().decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        events.push(JSON.parse(line.slice(6)));
      }
      if (events.some((event) => event.type === 'run.completed')) break;
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  assert.ok(
    events.some((event) => event.type === 'run.completed'),
    'persisted SSE history includes the terminal Run event',
  );
  const sequences = events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1),
  );
  return events;
}

function cookieHeader(response) {
  return (
    response.headers
      .getSetCookie?.()
      .map((value) => value.split(';', 1)[0])
      .join('; ') ??
    response.headers.get('set-cookie')?.split(';', 1)[0] ??
    ''
  );
}

function mergeCookies(first, second) {
  const values = new Map(
    `${first}; ${second}`
      .split('; ')
      .filter(Boolean)
      .map((item) => item.split('=', 2)),
  );
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function probeWebPath(required) {
  const id = compose(['ps', '-q', 'web']).stdout.trim();
  const inspected = JSON.parse(
    runDocker('docker', ['inspect', id], { encoding: 'utf8' }).stdout,
  )[0];
  const internal = runDocker(
    'docker',
    [
      'exec',
      id,
      'node',
      '-e',
      "fetch('http://127.0.0.1:8080/health',{signal:AbortSignal.timeout(3000)}).then(r=>{console.log('HTTP',r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))",
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  const listeners = runDocker(
    'docker',
    [
      'exec',
      id,
      'node',
      '-e',
      "const fs=require('node:fs');for(const p of ['/proc/net/tcp','/proc/net/tcp6'])console.log(fs.readFileSync(p,'utf8').split('\\n').filter(l=>l.trim().split(/\\s+/)[1]?.endsWith(':1F90')).join('\\n'))",
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  const tcp = await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: webPort, family: 4 });
    socket.setTimeout(3000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error) => resolve(error.code));
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
  });
  let http;
  try {
    http = (
      await globalThis.fetch(`${origin}/health`, { signal: globalThis.AbortSignal.timeout(3000) })
    ).status;
  } catch (error) {
    http = error.cause?.code ?? error.name;
  }
  process.stdout.write(
    `${JSON.stringify({ phase: required ? 'after-security-probes' : 'before-security-probes', destination: origin, port: webPort, health: inspected.State.Health?.Status, restartCount: inspected.RestartCount, configuredPorts: inspected.HostConfig.PortBindings, effectivePorts: inspected.NetworkSettings.Ports, internalHttp: internal.stdout.trim(), internalStatus: internal.status, listeners: listeners.stdout.trim(), runnerTcp: tcp, runnerHttp: http })}\n`,
  );
  if (required && tcp !== 'connected') await reproducePublication();
  if (required) {
    assert.equal(internal.status, 0, 'web internal HTTP failed');
    assert.equal(
      tcp,
      'connected',
      'runner IPv4 TCP cannot reach Docker publication; inspect preceding path diagnostics',
    );
    assert.equal(http, 200, 'runner HTTP must succeed before Playwright');
  }
}

async function reproducePublication() {
  const diagnosticProject = `${project}-publication`;
  auxiliaryProjects.add(diagnosticProject);
  const path = join(directory, 'publication.yml');
  const ports = [await freePort(occupiedPorts), await freePort(occupiedPorts)];
  const services = Object.fromEntries(
    ['isolated', 'control'].map((name, index) => [
      name,
      {
        image: 'omnis-web:ci',
        user: '10001:10001',
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        pids_limit: 64,
        mem_limit: '256m',
        cpus: 0.5,
        environment: { OMNIS_WEB_PORT: '8080', OMNIS_API_URL: 'http://api:4100' },
        ports: [`127.0.0.1:${ports[index]}:8080`],
        networks: [name],
        healthcheck: {
          test: [
            'CMD',
            'node',
            '-e',
            "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          interval: '1s',
          timeout: '3s',
          retries: 10,
        },
      },
    ]),
  );
  await writeFile(
    path,
    JSON.stringify({
      services,
      networks: { isolated: { internal: true }, control: { internal: false } },
    }),
  );
  const args = ['compose', '--project-name', diagnosticProject, '-f', path];
  const invoke = (extra) =>
    runDocker('docker', [...args, ...extra], { encoding: 'utf8', timeout: 60000 });
  try {
    const startup = invoke(['up', '-d', '--wait', '--wait-timeout', '30']);
    assert.equal(
      startup.status,
      0,
      `publication reproduction startup: ${startup.stderr} ${startup.stdout}`,
    );
    process.stdout.write(
      `Publication reproduction Docker server: ${runDocker('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 5000 }).stdout.trim()}\n`,
    );
    for (const [index, name] of ['isolated', 'control'].entries()) {
      const id = invoke(['ps', '-q', name]).stdout.trim();
      const inspected = JSON.parse(
        runDocker('docker', ['inspect', id], { encoding: 'utf8', timeout: 5000 }).stdout,
      )[0];
      let http;
      try {
        http = (
          await globalThis.fetch(`http://127.0.0.1:${ports[index]}/health`, {
            signal: globalThis.AbortSignal.timeout(3000),
          })
        ).status;
      } catch (error) {
        http = error.cause?.code ?? error.name;
      }
      process.stdout.write(
        `${JSON.stringify({ reproduction: name, networkInternal: JSON.parse(runDocker('docker', ['network', 'inspect', `${diagnosticProject}_${name}`], { encoding: 'utf8', timeout: 5000 }).stdout)[0].Internal, health: inspected.State.Health?.Status, configuredPorts: inspected.HostConfig.PortBindings, effectivePorts: inspected.NetworkSettings.Ports, runnerHttp: http })}\n`,
      );
    }
  } finally {
    assert.equal(
      invoke(['down', '--volumes', '--remove-orphans']).status,
      0,
      'publication reproduction cleanup',
    );
  }
}

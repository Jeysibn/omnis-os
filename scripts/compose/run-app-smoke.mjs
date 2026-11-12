import assert from 'node:assert/strict';
import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { createConnection, createServer, isIPv4 } from 'node:net';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';
import {
  startMockServices,
  testOwnerPassword,
} from '../../tests/integration/support/mock-services.mjs';
import { canRemoveBrowserBridgeGuard } from './firewall-guard-policy.mjs';

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
const browserEnvPath = join(directory, 'browser.env');
const browserResultsDirectory = join(directory, 'browser-results');
const acceptedTaskReconciliationPath = join(
  browserResultsDirectory,
  'accepted-task-reconciliation.json',
);
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
const browserOrigin = 'http://web:8080';
const browserImage =
  'mcr.microsoft.com/playwright@sha256:ee15712262f017b8157421b212b12099146645f44b1bc5c0514cbbe6a229b1d0';
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
let hostGatewayGuard;
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

function runIptables(args, { allowFailure = false } = {}) {
  return runFirewall('iptables', args, { allowFailure });
}

function runIp6tables(args, { allowFailure = false } = {}) {
  return runFirewall('ip6tables', args, { allowFailure });
}

function runFirewall(binary, args, { allowFailure = false } = {}) {
  const result = spawnSync('sudo', [binary, '-w', '5', ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `Could not manage the test-scoped CI host gateway rule: ${redact(result.stderr || result.error?.message || 'iptables returned no status')}`,
    );
  }
  return result;
}

function installRunnerHostGatewayGuard() {
  if (process.env.OMNIS_CI_HOST_GATEWAY_GUARD !== '1') {
    throw new Error(
      'The disposable Compose browser test requires its test-scoped CI host gateway guard.',
    );
  }
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'host gateway guard is CI-only');
  assert.equal(
    process.env.RUNNER_OS,
    'Linux',
    'host gateway guard requires the disposable Linux runner',
  );
  assert.equal(
    process.env.RUNNER_ENVIRONMENT,
    'github-hosted',
    'host gateway guard must never mutate a self-hosted runner firewall',
  );
  const inspection = runDocker('docker', ['network', 'inspect', `${project}_browser_web`], {
    encoding: 'utf8',
  });
  assert.equal(inspection.status, 0, 'browser network is inspectable before guard setup');
  const inspected = JSON.parse(inspection.stdout)[0];
  assert.equal(inspected.Internal, true, 'host gateway guard applies only to an internal network');
  assert.equal(inspected.Labels?.['com.docker.compose.project'], project);
  assert.equal(inspected.Labels?.['com.docker.compose.network'], 'browser_web');
  const config = inspected.IPAM?.Config?.find((entry) => isIPv4(entry.Gateway));
  const bridge =
    inspected.Options?.['com.docker.network.bridge.name'] ?? `br-${inspected.Id.slice(0, 12)}`;
  if (!config?.Subnet || !isIPv4(config.Gateway) || !/^br-[a-f0-9]{12}$/.test(bridge)) {
    throw new Error(
      'Browser network does not expose the expected disposable IPv4 bridge metadata.',
    );
  }
  const ipv4Chain = `OMC${suffix.toUpperCase()}`;
  const ipv6Chain = `OMV${suffix.toUpperCase()}`;
  hostGatewayGuard = {
    bridge,
    ipv4Chain,
    ipv6Chain,
    gateway: config.Gateway,
    subnet: config.Subnet,
  };
  runIptables(['-N', ipv4Chain]);
  runIptables(['-A', ipv4Chain, '-s', config.Subnet, '-j', 'DROP']);
  runIptables(['-I', 'INPUT', '1', '-i', bridge, '-j', ipv4Chain]);
  assert.equal(
    runIptables(['-C', 'INPUT', '-i', bridge, '-j', ipv4Chain], { allowFailure: true }).status,
    0,
    'the temporary IPv4 INPUT guard is installed only for the browser network bridge',
  );
  runIp6tables(['-N', ipv6Chain]);
  runIp6tables(['-A', ipv6Chain, '-j', 'DROP']);
  runIp6tables(['-I', 'INPUT', '1', '-i', bridge, '-j', ipv6Chain]);
  assert.equal(
    runIp6tables(['-C', 'INPUT', '-i', bridge, '-j', ipv6Chain], { allowFailure: true }).status,
    0,
    'the temporary IPv6 INPUT guard is installed only for the browser network bridge',
  );
  const bridgeIpv6 = spawnSync('ip', ['-o', '-6', 'addr', 'show', 'dev', bridge, 'scope', 'link'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const hostGatewayIpv6 =
    bridgeIpv6.status === 0
      ? bridgeIpv6.stdout.match(/\binet6\s+(fe80:[0-9a-f:]+)/i)?.[1]
      : undefined;
  hostGatewayGuard.hostGatewayIpv6 = hostGatewayIpv6;
  process.stdout.write(
    `Installed disposable CI INPUT rules for browser-network traffic to the Docker host gateway (IPv4) and host (IPv6); bridge IPv6 ${hostGatewayIpv6 ? 'available for probing' : 'not configured'}.\n`,
  );
}

function removeRunnerHostGatewayGuard() {
  if (!hostGatewayGuard) return;
  const { bridge, ipv4Chain, ipv6Chain } = hostGatewayGuard;
  const cleanupErrors = [];
  for (const [binary, chain] of [
    ['iptables', ipv4Chain],
    ['ip6tables', ipv6Chain],
  ]) {
    try {
      const run = (args, options) => runFirewall(binary, args, options);
      const exists = run(['-S', chain], { allowFailure: true });
      if (exists.error) throw exists.error;
      if (exists.status === 1 && /no chain|does not exist/i.test(exists.stderr ?? '')) continue;
      if (exists.status !== 0) {
        throw new Error(`could not determine whether chain ${chain} exists`);
      }
      const attached = run(['-C', 'INPUT', '-i', bridge, '-j', chain], { allowFailure: true });
      if (
        attached.error ||
        (attached.status !== 0 && (attached.status !== 1 || (attached.stderr ?? '').trim()))
      ) {
        throw new Error(`could not determine whether ${chain} is attached to INPUT`);
      }
      if (attached.status === 0) run(['-D', 'INPUT', '-i', bridge, '-j', chain]);
      run(['-F', chain]);
      run(['-X', chain]);
      const removed = run(['-S', chain], { allowFailure: true });
      if (removed.error) throw removed.error;
      if (removed.status === 0 || !/no chain|does not exist/i.test(removed.stderr ?? '')) {
        throw new Error(`the test-scoped CI ${binary} chain remains or its status is uncertain`);
      }
    } catch (error) {
      cleanupErrors.push(`${binary}: ${error.message}`);
    }
  }
  if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
  hostGatewayGuard = undefined;
  process.stdout.write('Removed the disposable CI host gateway INPUT rule and chain.\n');
}

try {
  await Promise.all([
    mkdir(join(directory, 'authorizer-fixture'), { mode: 0o770 }),
    mkdir(join(directory, 'launcher-fixture'), { mode: 0o770 }),
    mkdir(postgresSocketDirectory, { mode: 0o2770 }),
    mkdir(browserResultsDirectory, { mode: 0o700 }),
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
    ['OMNIS_ALLOWED_ORIGIN', browserOrigin],
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
  const uid = String(process.getuid?.() ?? 0);
  if (uid === '0' || gid === '0') {
    throw new Error(
      'Compose smoke requires a non-root CI host identity with a non-root primary group.',
    );
  }
  await writeEnv(browserEnvPath, [
    ['OMNIS_TEST_FRONTEND_ORIGIN', browserOrigin],
    ['OMNIS_TEST_OWNER_PASSWORD', testOwnerPassword],
    ['OMNIS_COMPOSE_JOURNEY_RESULT_PATH', '/results/compose-journey.json'],
    ['OMNIS_TEST_OUTPUT_DIR', '/tmp/playwright-output'],
    [
      'OMNIS_COMPOSE_ACCEPTED_TASK_RECONCILIATION_PATH',
      '/results/accepted-task-reconciliation.json',
    ],
  ]);
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
    ['OMNIS_CI_BROWSER_UID', uid],
    ['OMNIS_CI_BROWSER_GID', gid],
    ['OMNIS_CI_BROWSER_ENV_FILE', browserEnvPath],
    ['OMNIS_CI_BROWSER_WORKSPACE', root],
    ['OMNIS_CI_BROWSER_RESULTS_DIRECTORY', browserResultsDirectory],
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
    ['OMNIS_CI_POSTGRES_UID', String(postgresUid)],
    ['OMNIS_CI_POSTGRES_GID', String(postgresGid)],
    ['OMNIS_CI_BROWSER_UID', uid],
    ['OMNIS_CI_BROWSER_GID', gid],
    ['OMNIS_CI_BROWSER_ENV_FILE', browserEnvPath],
    ['OMNIS_CI_BROWSER_WORKSPACE', root],
    ['OMNIS_CI_BROWSER_RESULTS_DIRECTORY', browserResultsDirectory],
  ]);
  const generatedApi = (await readFile(fixtures.apiEnvPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const generatedWorker = (await readFile(fixtures.workerEnvPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean);
  const composeApiOverrides = {
    OMNIS_API_HOST: '0.0.0.0',
    OMNIS_API_PORT: '4100',
    OMNIS_WORKER_HOST: 'worker',
    OMNIS_WORKER_PORT: '4101',
    OMNIS_ALLOWED_ORIGIN: browserOrigin,
    OMNIS_AUTHORIZER_SOCKET: '/run/omnis-authorizer/authorizer.sock',
  };
  await replaceEnv(apiEnvPath, generatedApi, composeApiOverrides);
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
  const pulledBrowserImage = runDocker('docker', ['pull', browserImage], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(
    pulledBrowserImage.status,
    0,
    `could not pull the digest-pinned Playwright browser image: ${redact(pulledBrowserImage.stderr || 'unknown Docker error')}`,
  );
  compose(['up', '--no-start', 'api', 'worker', 'web', 'browser'], { timeout: 600_000 });
  installRunnerHostGatewayGuard();
  compose(['up', '--detach', '--wait', '--wait-timeout', '180', 'api', 'worker', 'web'], {
    timeout: 600_000,
  });
  compose(['up', '--detach', '--wait', '--wait-timeout', '60', 'browser'], { timeout: 120_000 });
  await probeWebPath();
  await assertRuntimeRestrictions();
  await assertSocketPermissionDenials();
  await assertDeniedEgress();
  await assertMissingSocketFailsClosed();
  await assertBrowserNetworkIsolation();

  runBrowserPlaywright();
  const reconciliationFixture = await fixtures.createAcceptedTaskReconciliationFixture();
  await writeFile(acceptedTaskReconciliationPath, JSON.stringify(reconciliationFixture), {
    mode: 0o600,
  });
  await replaceEnv(apiEnvPath, generatedApi, {
    ...composeApiOverrides,
    OMNIS_CI_DISPOSABLE: 'true',
    OMNIS_TEST_SESSION_MAX_AGE_SECONDS: '60',
  });
  compose(['up', '--detach', '--force-recreate', '--no-deps', 'api']);
  await waitForHealthy('api', 30_000);
  runBrowserPlaywright(false, true);
  await fixtures.assertAcceptedTaskReconciliation(reconciliationFixture);
  await replaceEnv(apiEnvPath, generatedApi, composeApiOverrides);
  compose(['up', '--detach', '--force-recreate', '--no-deps', 'api']);
  await waitForHealthy('api', 30_000);
  const browserJourney = JSON.parse(
    await readFile(join(browserResultsDirectory, 'compose-journey.json'), 'utf8'),
  );
  assert.ok(browserJourney.taskId && browserJourney.runId);
  assert.ok(browserJourney.events.length > 0);
  assert.ok(
    browserJourney.events.every((event) => event.synthetic === true && event.source === 'mock'),
    'durable browser journey events retain mock provenance',
  );

  compose(['restart', 'worker']);
  await waitForHealthy('worker', 60_000);
  runBrowserRecovery();
  compose(['restart', 'api']);
  await waitForHealthy('api', 60_000);
  runBrowserRecovery();

  compose(['restart', 'postgres']);
  await waitForHealthy('postgres', 60_000);
  await waitForHealthy('api', 30_000);
  runBrowserRecovery();
  assertComposeLogsContainNoSecrets();
  fixtures.assertSensitiveValuesAbsentFromLogs();
  process.stdout.write(
    'CI-INTERNAL-BROWSER-INTEGRATION=PASS: health, authenticated mock owner flow, Task/Run/event persistence, worker/API/PostgreSQL restart recovery, network denial probes, and fail-closed socket mount.\n',
  );
  process.stdout.write(
    'HOST-LOOPBACK-INGRESS=NOT VERIFIED BY THIS OPTION C RUN; historical Docker Engine 28.0.4 run 42543015445 recorded ECONNREFUSED, and target WSL2 ingress remains NOT VERIFIED.\n',
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
  let browserStopped = !down.error && down.status === 0;
  if (down.error || down.status !== 0) {
    failed = true;
    process.stderr.write(
      `Compose cleanup reported an error: ${redact(down.stderr || down.stdout || down.error?.message)}\n`,
    );
    const stopEndpoints = compose(['stop', 'browser', 'web'], {
      allowFailure: true,
      timeout: 15_000,
    });
    browserStopped = !stopEndpoints.error && stopEndpoints.status === 0;
    if (!browserStopped) {
      browserStopped = isBrowserBridgeQuiescent();
    }
  }
  if (browserStopped) browserStopped = isBrowserBridgeQuiescent();
  if (browserStopped) {
    try {
      removeRunnerHostGatewayGuard();
    } catch (error) {
      failed = true;
      process.stderr.write(`Test-scoped CI firewall cleanup failed: ${redact(error)}\n`);
    }
  } else if (hostGatewayGuard) {
    failed = true;
    process.stderr.write(
      'Browser stop could not be verified; its host-gateway firewall guard is retained until disposable runner teardown.\n',
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

function isBrowserBridgeQuiescent() {
  const inspection = runDocker('docker', ['network', 'inspect', `${project}_browser_web`], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (inspection.error) return false;
  if (inspection.status !== 0) {
    const networkMissing = /network .+ not found/i.test(inspection.stderr ?? '');
    return canRemoveBrowserBridgeGuard({
      networkExists: false,
      inspectionSucceeded: networkMissing,
      endpoints: [],
    });
  }
  try {
    const network = JSON.parse(inspection.stdout)[0];
    const endpoints = Object.keys(network.Containers ?? {}).map((id) => {
      const container = runDocker('docker', ['inspect', id], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (container.error || container.status !== 0) return { id, running: undefined };
      return { id, running: JSON.parse(container.stdout)[0]?.State?.Running };
    });
    return canRemoveBrowserBridgeGuard({
      networkExists: true,
      inspectionSucceeded: true,
      endpoints,
    });
  } catch {
    return false;
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
  const browserId = compose(['ps', '-q', 'browser']).stdout.trim();
  assert.ok(browserId, 'isolated Playwright browser container is running');
  const browserInspect = JSON.parse(
    runDocker('docker', ['inspect', browserId], { encoding: 'utf8' }).stdout,
  )[0];
  assert.equal(browserInspect.Config.User, `${process.getuid()}:${process.getgid()}`);
  assert.equal(browserInspect.Config.Image, browserImage);
  assert.equal(browserInspect.HostConfig.Privileged, false);
  assert.equal(browserInspect.HostConfig.NetworkMode, `${project}_browser_web`);
  assert.equal(browserInspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(browserInspect.HostConfig.RestartPolicy.Name, 'no');
  assert.deepEqual(browserInspect.HostConfig.CapAdd ?? [], []);
  assert.deepEqual(browserInspect.HostConfig.Devices ?? [], []);
  assert.deepEqual(browserInspect.HostConfig.DeviceRequests ?? [], []);
  assert.ok(browserInspect.HostConfig.CapDrop.includes('ALL'));
  assert.ok(browserInspect.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.ok(browserInspect.HostConfig.PidsLimit > 0);
  assert.ok(browserInspect.HostConfig.Memory > 0);
  assert.ok(browserInspect.HostConfig.NanoCpus > 0);
  assert.deepEqual(
    browserInspect.Mounts.map((mount) => mount.Destination).sort(),
    ['/results', '/workspace'],
    'browser sees only its read-only workspace and disposable result directory',
  );
  assert.equal(
    browserInspect.Mounts.find((mount) => mount.Destination === '/workspace')?.RW,
    false,
  );
  assert.equal(browserInspect.Mounts.find((mount) => mount.Destination === '/results')?.RW, true);
  assert.ok(
    Object.values(browserInspect.NetworkSettings.Ports ?? {}).every(
      (bindings) => !bindings?.some((binding) => binding?.HostPort),
    ),
    'browser container has no host-published ports',
  );
  assert.ok(!browserInspect.Mounts.some((mount) => /docker\.sock$/.test(mount.Source)));
  assert.ok(
    !browserInspect.Config.Env.some((value) => value.startsWith('OMNIS_TEST_API_PROXY_TARGET=')),
    'browser receives no direct API target configuration',
  );
  assert.ok(
    !browserInspect.Config.Env.some((value) =>
      /(?:OPENAI|ANTHROPIC|GOOGLE|PROVIDER)_API_KEY=/i.test(value),
    ),
  );
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
  assert.equal(config.networks.browser_web.internal, true);
  assert.deepEqual(Object.keys(config.services.browser.networks), ['browser_web']);
  assert.deepEqual(Object.keys(config.services.web.networks).sort(), ['browser_web', 'edge']);
  assert.equal(config.services.api.ports?.length ?? 0, 0);
  assert.equal(config.services.worker.ports?.length ?? 0, 0);
  const networksByService = {};
  for (const service of ['api', 'worker', 'web', 'postgres', 'browser']) {
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
  assert.deepEqual(networksByService.web, ['browser_web', 'edge']);
  assert.deepEqual(networksByService.postgres, ['data']);
  assert.deepEqual(networksByService.browser, ['browser_web']);
  for (const network of ['edge', 'data', 'browser_web']) {
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

async function assertBrowserNetworkIsolation() {
  const addresses = {};
  for (const service of ['api', 'worker', 'postgres']) {
    const id = compose(['ps', '-q', service]).stdout.trim();
    const inspected = JSON.parse(
      runDocker('docker', ['inspect', id, '--format', '{{json .NetworkSettings.Networks}}'], {
        encoding: 'utf8',
      }).stdout,
    );
    addresses[service] = Object.values(inspected)
      .map((network) => network.IPAddress)
      .find((value) => isIPv4(value));
    assert.ok(addresses[service], `${service} IPv4 address is available for direct-denial probe`);
  }
  const browserNetwork = JSON.parse(
    runDocker('docker', ['network', 'inspect', `${project}_browser_web`], {
      encoding: 'utf8',
    }).stdout,
  )[0];
  assert.equal(browserNetwork.Internal, true, 'browser-to-web network is internal at runtime');
  const attachedIds = Object.keys(browserNetwork.Containers ?? {}).sort();
  const expectedIds = [
    compose(['ps', '-q', 'browser']).stdout.trim(),
    compose(['ps', '-q', 'web']).stdout.trim(),
  ].sort();
  assert.deepEqual(attachedIds, expectedIds, 'only browser and web join browser_web');
  const gateway = browserNetwork.IPAM.Config?.[0]?.Gateway;
  assert.ok(isIPv4(gateway), 'internal browser network gateway is inspected at runtime');
  const beforeProbe = JSON.parse(
    runDocker('docker', ['inspect', compose(['ps', '-q', 'web']).stdout.trim()], {
      encoding: 'utf8',
    }).stdout,
  )[0];
  const beforeBrowser = JSON.parse(
    runDocker('docker', ['inspect', compose(['ps', '-q', 'browser']).stdout.trim()], {
      encoding: 'utf8',
    }).stdout,
  )[0];
  assert.equal(beforeProbe.State.Health?.Status, 'healthy');
  assert.equal(beforeBrowser.State.Health?.Status, 'healthy');
  const browserNetworkProbe = runDocker(
    'docker',
    [
      'exec',
      compose(['ps', '-q', 'browser']).stdout.trim(),
      'node',
      '-e',
      "console.log(JSON.stringify(Object.entries(require('node:os').networkInterfaces()).filter(([,addresses])=>addresses?.some(address=>address.family==='IPv6'&&address.address.toLowerCase().startsWith('fe80:'))).map(([name])=>name)))",
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
  assert.equal(browserNetworkProbe.status, 0, 'browser IPv6 interface support is inspectable');
  const browserIpv6Interfaces = JSON.parse(browserNetworkProbe.stdout.trim());
  const ipv6ControlEnabled =
    Boolean(hostGatewayGuard.hostGatewayIpv6) && browserIpv6Interfaces.length > 0;
  const hostControlServer = createServer((socket) => socket.on('error', () => {}));
  let ipv6ControlServer;
  let ipv6ControlPort = '';
  let hostControlPort;
  try {
    await new Promise((resolve, reject) =>
      hostControlServer.listen(0, gateway, resolve).once('error', reject),
    );
    hostControlPort = hostControlServer.address().port;
    const hostPositiveControl = await new Promise((resolve) => {
      const socket = createConnection({ host: gateway, port: hostControlPort, family: 4 });
      socket.setTimeout(2_000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    assert.equal(
      hostPositiveControl,
      true,
      'the disposable host gateway listener accepts a host-side connection',
    );
    if (ipv6ControlEnabled) {
      ipv6ControlServer = createServer((socket) => socket.on('error', () => {}));
      await new Promise((resolve, reject) =>
        ipv6ControlServer
          .listen(0, `${hostGatewayGuard.hostGatewayIpv6}%${hostGatewayGuard.bridge}`, resolve)
          .once('error', reject),
      );
      ipv6ControlPort = String(ipv6ControlServer.address().port);
      const ipv6HostPositiveControl = await new Promise((resolve) => {
        const socket = createConnection({
          host: `${hostGatewayGuard.hostGatewayIpv6}%${hostGatewayGuard.bridge}`,
          port: Number(ipv6ControlPort),
          family: 6,
        });
        socket.setTimeout(2_000);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
      });
      assert.equal(
        ipv6HostPositiveControl,
        true,
        'the disposable IPv6 host gateway listener accepts a host-side connection',
      );
    }
    const probe = compose(
      [
        'exec',
        '-T',
        'browser',
        'node',
        'scripts/compose/assert-browser-network.mjs',
        addresses.api,
        addresses.worker,
        addresses.postgres,
        gateway,
        String(hostControlPort),
        ipv6ControlEnabled ? hostGatewayGuard.hostGatewayIpv6 : '',
        ipv6ControlPort,
      ],
      { timeout: 45_000 },
    );
    process.stdout.write(redact(probe.stdout));
  } finally {
    for (const server of [hostControlServer, ipv6ControlServer]) {
      if (!server?.listening) continue;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  const ruleCounters = runIptables(['-L', hostGatewayGuard.ipv4Chain, '-n', '-v', '-x']);
  const dropPackets = Number(ruleCounters.stdout.match(/^\s*(\d+)\s+\d+\s+DROP\b/m)?.[1] ?? 0);
  assert.ok(
    dropPackets > 0,
    'browser positive-control traffic increments the scoped IPv4 DROP rule',
  );
  process.stdout.write(
    `Browser-to-host positive control was dropped by the scoped runner rule (${dropPackets} packet(s)).\n`,
  );
  if (ipv6ControlPort) {
    const ipv6RuleCounters = runIp6tables(['-L', hostGatewayGuard.ipv6Chain, '-n', '-v', '-x']);
    const ipv6DropPackets = Number(
      ipv6RuleCounters.stdout.match(/^\s*(\d+)\s+\d+\s+DROP\b/m)?.[1] ?? 0,
    );
    assert.ok(
      ipv6DropPackets > 0,
      'browser IPv6 positive-control traffic increments the scoped DROP rule',
    );
    process.stdout.write(
      `Browser-to-host IPv6 positive control was dropped by the scoped runner rule (${ipv6DropPackets} packet(s)).\n`,
    );
  }
  for (const [service, id] of [
    ['web', compose(['ps', '-q', 'web']).stdout.trim()],
    ['browser', compose(['ps', '-q', 'browser']).stdout.trim()],
  ]) {
    const after = JSON.parse(runDocker('docker', ['inspect', id], { encoding: 'utf8' }).stdout)[0];
    assert.equal(
      after.State.Health?.Status,
      'healthy',
      `${service} health remains after denial probes`,
    );
    assert.equal(after.RestartCount, 0, `${service} did not restart during denial probes`);
  }
}

function runBrowserPlaywright(recovery = false, acceptanceReconciliation = false) {
  const args = [
    'exec',
    '-T',
    ...(recovery ? ['-e', 'OMNIS_COMPOSE_RECOVERY=1'] : []),
    ...(acceptanceReconciliation ? ['-e', 'OMNIS_COMPOSE_ACCEPTANCE_RECONCILIATION=1'] : []),
    'browser',
    'node',
    'apps/web/node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'apps/web/playwright.integration.config.ts',
    ...(acceptanceReconciliation
      ? ['--grep', 'Compose reconciles a restored accepted task through the owner API']
      : []),
    ...(recovery ? ['--grep', 'Compose recovery preserves'] : []),
  ];
  const browser = compose(args, { timeout: 240_000, allowFailure: true });
  if (browser.error || browser.status !== 0) {
    const output = redact(`${browser.stdout ?? ''}\n${browser.stderr ?? ''}`.trim());
    throw new Error(
      `Isolated Compose Playwright ${acceptanceReconciliation ? 'acceptance reconciliation' : recovery ? 'recovery' : 'journey'} failed: ${output}`,
    );
  }
  process.stdout.write(redact(browser.stdout));
}

function runBrowserRecovery() {
  runBrowserPlaywright(true);
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
  assert.equal(
    probe.status,
    0,
    'API TCP connection to the sampled 1.1.1.1:443 endpoint must fail on internal networks',
  );
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

async function probeWebPath() {
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
    `${JSON.stringify({ phase: 'ci-runner-host-publication-observation', destination: origin, port: webPort, health: inspected.State.Health?.Status, restartCount: inspected.RestartCount, configuredPorts: inspected.HostConfig.PortBindings, effectivePorts: inspected.NetworkSettings.Ports, internalHttp: internal.stdout.trim(), internalStatus: internal.status, listeners: listeners.stdout.trim(), runnerTcp: tcp, runnerHttp: http })}\n`,
  );
  assert.equal(internal.status, 0, 'web container responds on its internal health endpoint');
}

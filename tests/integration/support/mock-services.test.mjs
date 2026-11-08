import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertSensitiveValuesAbsentFromLogs,
  assertNoExecutableWork,
  buildBrowserEnvironment,
  startManagedProcess,
  startSyntheticBrokerFixture,
  startServicesWithCleanup,
  socketRequest,
  stopProcess,
  validateTestDatabaseConfiguration,
} from './mock-services.mjs';

test('checks test credential canaries across isolated service logs without echoing values', () => {
  const canary = 'synthetic-canary-value-for-test-only';
  assert.doesNotThrow(() =>
    assertSensitiveValuesAbsentFromLogs(
      [canary],
      [
        { name: 'API', process: { capturedLogs: 'request rejected' } },
        { name: 'worker', process: { capturedLogs: 'run completed' } },
        { name: 'authorizer', process: { capturedLogs: 'attempt persisted' } },
        { name: 'synthetic broker', process: { capturedLogs: 'provider outcome recorded' } },
      ],
    ),
  );
  assert.throws(
    () =>
      assertSensitiveValuesAbsentFromLogs(
        [canary],
        [{ name: 'synthetic broker', process: { capturedLogs: `request ${canary}` } }],
      ),
    (error) =>
      error instanceof Error &&
      error.message === 'A sensitive test value was written to synthetic broker logs.' &&
      !error.message.includes(canary),
  );
});

const goodUrls = {
  OMNIS_TEST_DATABASE_URL: 'postgresql://omnis_runtime:runtime-synthetic@127.0.0.1:5432/omnis_test',
  OMNIS_TEST_MIGRATION_DATABASE_URL:
    'postgresql://omnis_migrator:migration-synthetic@127.0.0.1:5432/omnis_test',
  OMNIS_TEST_AUTHORIZER_DATABASE_URL:
    'postgresql://omnis_authorizer:authorizer-synthetic@127.0.0.1:5432/omnis_test',
  OMNIS_TEST_LAUNCHER_DATABASE_URL:
    'postgresql://omnis_launcher:launcher-synthetic@127.0.0.1:5432/omnis_test',
  OMNIS_TEST_ADMIN_DATABASE_URL: 'postgresql://omnis:admin-synthetic@127.0.0.1:5432/omnis_test',
};

test('validates all restricted roles share the same loopback test database', () => {
  const config = validateTestDatabaseConfiguration(goodUrls, { requireAdmin: true });
  assert.equal(config.databaseName, 'omnis_test');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 5432);
  assert.deepEqual(Object.keys(config.urls).sort(), Object.keys(goodUrls).sort());
});

test('rejects each configured service URL when it points at another database', () => {
  for (const name of Object.keys(goodUrls)) {
    const environment = {
      ...goodUrls,
      [name]: goodUrls[name].replace('/omnis_test', '/customer_live'),
    };
    assert.throws(
      () => validateTestDatabaseConfiguration(environment, { requireAdmin: true }),
      /disposable test database|same disposable test database/,
      name,
    );
  }
});

test('rejects database host and port mismatches without exposing credentials', () => {
  const hostMismatch = {
    ...goodUrls,
    OMNIS_TEST_MIGRATION_DATABASE_URL: goodUrls.OMNIS_TEST_MIGRATION_DATABASE_URL.replace(
      '127.0.0.1',
      '10.10.0.8',
    ),
  };
  assert.throws(
    () => validateTestDatabaseConfiguration(hostMismatch),
    (error) => !error.message.includes('migration-synthetic'),
  );

  const loopbackHostMismatch = {
    ...goodUrls,
    OMNIS_TEST_MIGRATION_DATABASE_URL: goodUrls.OMNIS_TEST_MIGRATION_DATABASE_URL.replace(
      '127.0.0.1',
      '[::1]',
    ),
  };
  assert.throws(
    () => validateTestDatabaseConfiguration(loopbackHostMismatch),
    /same disposable test database and local PostgreSQL endpoint/,
  );

  const portMismatch = {
    ...goodUrls,
    OMNIS_TEST_LAUNCHER_DATABASE_URL: goodUrls.OMNIS_TEST_LAUNCHER_DATABASE_URL.replace(
      ':5432/',
      ':5544/',
    ),
  };
  assert.throws(
    () => validateTestDatabaseConfiguration(portMismatch),
    /same disposable test database and local PostgreSQL endpoint/,
  );
});

test('rejects malformed, remote, and unsupported database URL forms', () => {
  for (const value of [
    'not-a-url',
    'postgresql://omnis_runtime:synthetic@db.example.invalid:5432/omnis_test',
    'postgresql://omnis_runtime:synthetic@127.0.0.1:5432/omnis_test?sslmode=require',
    'postgresql://omnis_runtime:synthetic@127.0.0.1:5432/omnis_test#fragment',
  ]) {
    assert.throws(
      () => validateTestDatabaseConfiguration({ ...goodUrls, OMNIS_TEST_DATABASE_URL: value }),
      (error) => !error.message.includes('synthetic'),
    );
  }
});

test('requires and validates an optional administrator URL when requested or configured', () => {
  const withoutAdmin = { ...goodUrls };
  delete withoutAdmin.OMNIS_TEST_ADMIN_DATABASE_URL;
  assert.throws(
    () => validateTestDatabaseConfiguration(withoutAdmin, { requireAdmin: true }),
    /OMNIS_TEST_ADMIN_DATABASE_URL must be configured/,
  );
  assert.throws(
    () =>
      validateTestDatabaseConfiguration({
        ...goodUrls,
        OMNIS_TEST_ADMIN_DATABASE_URL: goodUrls.OMNIS_TEST_ADMIN_DATABASE_URL.replace(
          '127.0.0.1',
          'db.example.invalid',
        ),
      }),
    /loopback PostgreSQL endpoint/,
  );
});

test('browser environment allowlists only explicit runtime and test values', () => {
  const environment = buildBrowserEnvironment(
    {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/test-home',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      CI: 'true',
      PLAYWRIGHT_BROWSERS_PATH: '/tmp/pw-browsers',
      GH_TOKEN: 'SENTINEL_GITHUB_SECRET',
      OPENAI_API_KEY: 'SENTINEL_PROVIDER_SECRET',
      OMNIS_TEST_DATABASE_URL: 'SENTINEL_DATABASE_URL',
      OMNIS_INTERNAL_TOKEN: 'SENTINEL_INTERNAL_TOKEN',
      NPM_CONFIG_REGISTRY: 'SENTINEL_REGISTRY_CONFIG',
    },
    {
      apiTarget: 'http://127.0.0.1:4100',
      frontendOrigin: 'http://127.0.0.1:5174',
      frontendPort: 5174,
      ownerPassword: 'SYNTHETIC_OWNER_PASSWORD',
    },
  );
  assert.deepEqual(
    Object.keys(environment).sort(),
    [
      'CI',
      'HOME',
      'LANG',
      'NPM_CONFIG_GLOBALCONFIG',
      'NPM_CONFIG_USERCONFIG',
      'OMNIS_TEST_API_PROXY_TARGET',
      'OMNIS_TEST_FRONTEND_ORIGIN',
      'OMNIS_TEST_FRONTEND_PORT',
      'OMNIS_TEST_OWNER_PASSWORD',
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'TMPDIR',
    ].sort(),
  );
  const serialized = JSON.stringify(environment);
  for (const sentinel of [
    'SENTINEL_GITHUB_SECRET',
    'SENTINEL_PROVIDER_SECRET',
    'SENTINEL_DATABASE_URL',
    'SENTINEL_INTERNAL_TOKEN',
    'SENTINEL_REGISTRY_CONFIG',
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `process.stdout.write(String(${[
        'GH_TOKEN',
        'OPENAI_API_KEY',
        'OMNIS_TEST_DATABASE_URL',
        'OMNIS_INTERNAL_TOKEN',
        'NPM_CONFIG_REGISTRY',
      ]
        .map((name) => `process.env[${JSON.stringify(name)}] === undefined`)
        .join(' && ')}))`,
    ],
    { env: environment, encoding: 'utf8' },
  );
  assert.equal(probe.status, 0);
  assert.equal(probe.stdout, 'true');
  assert.equal(environment.OMNIS_TEST_OWNER_PASSWORD, 'SYNTHETIC_OWNER_PASSWORD');
  assert.equal(environment.NPM_CONFIG_USERCONFIG, '/dev/null');
  assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, '/dev/null');
});

test('fails closed when runs or executable queue jobs already exist', async () => {
  const cleanPool = { query: async () => ({ rows: [{ active_runs: 0, queued_jobs: 0 }] }) };
  await assert.doesNotReject(assertNoExecutableWork(cleanPool));

  for (const row of [
    { active_runs: 1, queued_jobs: 0 },
    { active_runs: 0, queued_jobs: 1 },
  ]) {
    const pool = { query: async () => ({ rows: [row] }) };
    await assert.rejects(assertNoExecutableWork(pool), /existing executable work/);
  }
});

test('a required service spawn error cleans up already-started services and temp files', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'omnis-startup-failure-test-'));
  const envFile = join(tempDirectory, 'service.env');
  await writeFile(envFile, 'SYNTHETIC_TEST=1\n', { mode: 0o600 });
  let firstProcess;

  await assert.rejects(
    startServicesWithCleanup(
      [
        async () => {
          firstProcess = await startManagedProcess(process.execPath, [
            '-e',
            'setInterval(() => {}, 1000)',
          ]);
          return firstProcess;
        },
        async () => startManagedProcess('/no/such/omnis-test-service', []),
      ],
      async (started) => {
        await Promise.all(started.map((child) => stopProcess(child)));
        await rm(tempDirectory, { recursive: true, force: true });
      },
    ),
    /failed to start/,
  );

  assert.ok(firstProcess);
  assert.ok(firstProcess.exitCode !== null || firstProcess.signalCode !== null);
  await assert.rejects(readFile(envFile));
});

test('runs the synthetic broker fixture in a separate process with authenticated bounded socket access', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'omnis-broker-fixture-test-'));
  const socketPath = join(tempDirectory, 'broker.sock');
  const fixture = await startSyntheticBrokerFixture({
    socketPath,
    testToken: 'a'.repeat(64),
    authorizerSocket: join(tempDirectory, 'authorizer.sock'),
    authorizerToken: 'b'.repeat(64),
  });
  try {
    assert.equal(fixture.process.spawned, true);
    assert.notEqual(fixture.process.pid, process.pid);
    assert.equal((await socketRequest(socketPath, '/health')).status, 200);
    const denied = await socketRequest(socketPath, '/internal/broker/v1/submit', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 401);
  } finally {
    await fixture.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

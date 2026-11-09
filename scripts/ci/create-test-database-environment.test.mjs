import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { Writable } from 'node:stream';
import test from 'node:test';
import {
  createTestDatabaseEnvironment,
  registerTestDatabaseEnvironment,
} from './create-test-database-environment.mjs';

test('creates isolated per-run PostgreSQL passwords and a scoped container name', () => {
  let call = 0;
  const environment = createTestDatabaseEnvironment({
    runId: '12345',
    runAttempt: '2',
    job: 'platform-security',
    createRandomBytes: (size) => Buffer.alloc(size, ++call),
  });

  assert.equal(
    environment.OMNIS_CI_POSTGRES_CONTAINER_NAME,
    'omnis-ci-pg-12345-2-platform-security',
  );
  const passwords = Object.entries(environment)
    .filter(([name]) => name.endsWith('_PASSWORD'))
    .map(([, password]) => password);
  assert.equal(passwords.length, 5);
  assert.ok(passwords.every((password) => /^[0-9a-f]{64}$/.test(password)));
  assert.equal(new Set(passwords).size, passwords.length);
});

test('masks passwords before writing a mode-0600 file and exposes only its path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnis-ci-db-env-'));
  const githubEnvPath = join(directory, 'github-env');
  const credentialsFilePath = join(directory, 'database.env');
  const environment = {
    OMNIS_CI_POSTGRES_CONTAINER_NAME: 'omnis-ci-pg-12345-2-platform-security',
    OMNIS_CI_POSTGRES_ADMIN_PASSWORD: 'a'.repeat(64),
    OMNIS_CI_POSTGRES_MIGRATION_PASSWORD: 'b'.repeat(64),
  };
  let output = '';
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk;
      callback();
    },
  });

  try {
    registerTestDatabaseEnvironment(environment, githubEnvPath, credentialsFilePath, stdout);
    assert.deepEqual(output.split('\n').filter(Boolean), [
      `::add-mask::${environment.OMNIS_CI_POSTGRES_ADMIN_PASSWORD}`,
      `::add-mask::${environment.OMNIS_CI_POSTGRES_MIGRATION_PASSWORD}`,
    ]);
    assert.equal(
      readFileSync(githubEnvPath, 'utf8'),
      `OMNIS_CI_POSTGRES_CONTAINER_NAME=${environment.OMNIS_CI_POSTGRES_CONTAINER_NAME}\nOMNIS_CI_POSTGRES_ENV_FILE=${credentialsFilePath}\n`,
    );
    assert.ok(
      Object.entries(environment)
        .filter(([name]) => name.endsWith('_PASSWORD'))
        .every(([, password]) => !readFileSync(githubEnvPath, 'utf8').includes(password)),
    );
    assert.equal(statSync(credentialsFilePath).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(credentialsFilePath, 'utf8'),
      `OMNIS_CI_POSTGRES_ADMIN_PASSWORD=${environment.OMNIS_CI_POSTGRES_ADMIN_PASSWORD}\nOMNIS_CI_POSTGRES_MIGRATION_PASSWORD=${environment.OMNIS_CI_POSTGRES_MIGRATION_PASSWORD}\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects unsafe run identifiers before deriving a container name', () => {
  assert.throws(() =>
    createTestDatabaseEnvironment({ runId: 'bad/name', runAttempt: '1', job: 'api' }),
  );
  assert.throws(() =>
    createTestDatabaseEnvironment({ runId: '123', runAttempt: '1', job: 'api;docker' }),
  );
});

test('disposable PostgreSQL uses loopback, bounded health readiness, and exact cleanup', () => {
  const startup = readFileSync(new URL('./start-test-postgres.sh', import.meta.url), 'utf8');
  const cleanup = readFileSync(new URL('./cleanup-test-postgres.sh', import.meta.url), 'utf8');
  const databaseEnvironment = readFileSync(
    new URL('./export-test-database-environment.sh', import.meta.url),
    'utf8',
  );

  assert.match(
    startup,
    /postgres:17\.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94/,
  );
  assert.match(startup, /--publish 127\.0\.0\.1:5432:5432/);
  assert.match(startup, /deadline=\$\(\(SECONDS \+ 60\)\)/);
  assert.doesNotMatch(startup, /--privileged|docker\.sock|0\.0\.0\.0/);
  assert.match(cleanup, /docker rm --force --volumes "\$container_name"/);
  assert.match(cleanup, /expected_environment_file=/);
  assert.match(cleanup, /rm -f -- "\$environment_file"/);
  assert.doesNotMatch(cleanup, /prune/);
  assert.match(databaseEnvironment, /127\.0\.0\.1:5432\/omnis_test/);
  assert.match(databaseEnvironment, /source "\$expected_environment_file"/);
  assert.match(databaseEnvironment, /stat -c '%a'/);
});

test('startup keeps the password out of action environment, Docker arguments, and output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnis-ci-db-start-'));
  const binDirectory = join(directory, 'bin');
  const dockerLog = join(directory, 'docker-arguments.log');
  const dockerEnvironmentLog = join(directory, 'docker-environment-names.log');
  const dockerPath = join(binDirectory, 'docker');
  const githubEnvPath = join(directory, 'github-env');
  const credentialsFilePath = join(directory, 'omnis-ci-db-12345-2-database-integration.env');
  const password = 'fixture-password-that-must-not-appear-in-logs';
  const containerName = 'omnis-ci-pg-12345-2-database-integration';
  const startScript = new URL('./start-test-postgres.sh', import.meta.url);
  const cleanupScript = new URL('./cleanup-test-postgres.sh', import.meta.url);

  try {
    mkdirSync(binDirectory);
    writeFileSync(
      credentialsFilePath,
      `OMNIS_CI_POSTGRES_ADMIN_PASSWORD=${password}\nOMNIS_CI_POSTGRES_MIGRATION_PASSWORD=${'m'.repeat(64)}\nOMNIS_CI_POSTGRES_RUNTIME_PASSWORD=${'r'.repeat(64)}\nOMNIS_CI_POSTGRES_AUTHORIZER_PASSWORD=${'a'.repeat(64)}\nOMNIS_CI_POSTGRES_LAUNCHER_PASSWORD=${'l'.repeat(64)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" >> "$OMNIS_FAKE_DOCKER_LOG"\nif [[ "$1" == run ]]; then env | cut -d= -f1 | sort > "$OMNIS_FAKE_DOCKER_ENV_LOG"; fi\nif [[ "$1" == inspect && "$2" == --format ]]; then echo healthy; fi\nif [[ "$1" == rm && "${OMNIS_FAKE_DOCKER_FAIL_RM:-false}" == true ]]; then exit 1; fi\n',
    );
    chmodSync(dockerPath, 0o755);

    const start = spawnSync('bash', [startScript.pathname], {
      encoding: 'utf8',
      env: {
        PATH: `${binDirectory}:${process.env.PATH}`,
        OMNIS_FAKE_DOCKER_LOG: dockerLog,
        OMNIS_FAKE_DOCKER_ENV_LOG: dockerEnvironmentLog,
        OMNIS_CI_POSTGRES_CONTAINER_NAME: containerName,
        OMNIS_CI_POSTGRES_ENV_FILE: credentialsFilePath,
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_JOB: 'database-integration',
        RUNNER_TEMP: directory,
        GITHUB_ENV: githubEnvPath,
      },
    });
    assert.equal(start.status, 0, start.stderr);
    assert.doesNotMatch(`${start.stdout}\n${start.stderr}`, new RegExp(password));

    const dockerArguments = readFileSync(dockerLog, 'utf8');
    assert.match(dockerArguments, /--publish 127\.0\.0\.1:5432:5432/);
    assert.match(dockerArguments, /--env POSTGRES_PASSWORD/);
    assert.doesNotMatch(dockerArguments, new RegExp(password));
    const dockerEnvironmentNames = readFileSync(dockerEnvironmentLog, 'utf8');
    assert.match(dockerEnvironmentNames, /^POSTGRES_PASSWORD$/m);
    assert.doesNotMatch(dockerEnvironmentNames, /OMNIS_CI_POSTGRES_.*PASSWORD/);
    assert.doesNotMatch(dockerEnvironmentNames, /OMNIS_(ADMIN|TEST_.*DATABASE_URL)/);

    const cleanup = spawnSync('bash', [cleanupScript.pathname], {
      encoding: 'utf8',
      env: {
        PATH: `${binDirectory}:${process.env.PATH}`,
        OMNIS_FAKE_DOCKER_LOG: dockerLog,
        OMNIS_CI_POSTGRES_CONTAINER_NAME: containerName,
        OMNIS_CI_POSTGRES_ENV_FILE: credentialsFilePath,
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_JOB: 'database-integration',
        RUNNER_TEMP: directory,
      },
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(
      readFileSync(dockerLog, 'utf8'),
      /rm --force --volumes omnis-ci-pg-12345-2-database-integration/,
    );
    assert.equal(existsSync(credentialsFilePath), false);

    writeFileSync(credentialsFilePath, `PASSWORD=${password}\n`, { mode: 0o600 });
    const failedCleanup = spawnSync('bash', [cleanupScript.pathname], {
      encoding: 'utf8',
      env: {
        PATH: `${binDirectory}:${process.env.PATH}`,
        OMNIS_FAKE_DOCKER_LOG: dockerLog,
        OMNIS_CI_POSTGRES_CONTAINER_NAME: containerName,
        OMNIS_CI_POSTGRES_ENV_FILE: credentialsFilePath,
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_JOB: 'database-integration',
        RUNNER_TEMP: directory,
        OMNIS_FAKE_DOCKER_FAIL_RM: 'true',
      },
    });
    assert.notEqual(failedCleanup.status, 0);
    assert.equal(existsSync(credentialsFilePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

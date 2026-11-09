import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('masks each password before persisting only the run-scoped environment values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnis-ci-db-env-'));
  const githubEnvPath = join(directory, 'github-env');
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
    registerTestDatabaseEnvironment(environment, githubEnvPath, stdout);
    assert.deepEqual(output.split('\n').filter(Boolean), [
      `::add-mask::${environment.OMNIS_CI_POSTGRES_ADMIN_PASSWORD}`,
      `::add-mask::${environment.OMNIS_CI_POSTGRES_MIGRATION_PASSWORD}`,
    ]);
    assert.equal(
      readFileSync(githubEnvPath, 'utf8'),
      Object.entries(environment)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n') + '\n',
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

test('disposable PostgreSQL uses loopback, bounded health readiness, and exact-name cleanup', () => {
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
  assert.doesNotMatch(cleanup, /prune/);
  assert.match(databaseEnvironment, /127\.0\.0\.1:5432\/omnis_test/);
});

test('startup passes the password by environment name without echoing its value', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnis-ci-db-start-'));
  const binDirectory = join(directory, 'bin');
  const dockerLog = join(directory, 'docker-arguments.log');
  const dockerPath = join(binDirectory, 'docker');
  const password = 'fixture-password-that-must-not-appear-in-logs';
  const containerName = 'omnis-ci-pg-12345-2-database-integration';
  const startScript = new URL('./start-test-postgres.sh', import.meta.url);
  const cleanupScript = new URL('./cleanup-test-postgres.sh', import.meta.url);

  try {
    mkdirSync(binDirectory);
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" >> "$OMNIS_FAKE_DOCKER_LOG"\nif [[ "$1" == inspect && "$2" == --format ]]; then echo healthy; fi\n',
    );
    chmodSync(dockerPath, 0o755);

    const start = spawnSync('bash', [startScript.pathname], {
      encoding: 'utf8',
      env: {
        PATH: `${binDirectory}:${process.env.PATH}`,
        OMNIS_FAKE_DOCKER_LOG: dockerLog,
        OMNIS_CI_POSTGRES_CONTAINER_NAME: containerName,
        OMNIS_CI_POSTGRES_ADMIN_PASSWORD: password,
        GITHUB_RUN_ID: '12345',
        GITHUB_JOB: 'database-integration',
      },
    });
    assert.equal(start.status, 0, start.stderr);
    assert.doesNotMatch(`${start.stdout}\n${start.stderr}`, new RegExp(password));

    const dockerArguments = readFileSync(dockerLog, 'utf8');
    assert.match(dockerArguments, /--publish 127\.0\.0\.1:5432:5432/);
    assert.match(dockerArguments, /--env POSTGRES_PASSWORD/);
    assert.doesNotMatch(dockerArguments, new RegExp(password));

    const cleanup = spawnSync('bash', [cleanupScript.pathname], {
      encoding: 'utf8',
      env: {
        PATH: `${binDirectory}:${process.env.PATH}`,
        OMNIS_FAKE_DOCKER_LOG: dockerLog,
        OMNIS_CI_POSTGRES_CONTAINER_NAME: containerName,
      },
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(
      readFileSync(dockerLog, 'utf8'),
      /rm --force --volumes omnis-ci-pg-12345-2-database-integration/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const provisionScript = path.join(repositoryRoot, 'packages/db/src/provision-restricted.ts');
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('restricted database bootstrap CLI', () => {
  it('runs configuration preflight without printing secret values', () => {
    const fixture = createFiles();
    const result = runPreflight(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed preflight/);
    for (const secret of fixture.secrets) {
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    }
  });

  it('fails before database access for a wrong target and withholds values', () => {
    const fixture = createFiles({ databaseName: 'omnis' });
    const result = runPreflight(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /omnis_restricted_dev/);
    for (const secret of fixture.secrets) {
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    }
  });

  it('rejects a mismatched restricted Compose project identity', () => {
    const fixture = createFiles({ project: 'omnis-os' });
    const result = runPreflight(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /omnis-os-restricted-dev/);
    for (const secret of fixture.secrets) {
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    }
  });

  it('rejects unexpected provider, Authorizer, and launcher variables without echoing values', () => {
    for (const name of [
      'AWS_SECRET_ACCESS_KEY',
      'OMNIS_AUTHORIZER_DB_PASSWORD',
      'OMNIS_LAUNCHER_DATABASE_URL',
    ]) {
      const fixture = createFiles({ extra: `${name}=secret-sentinel-value\n` });
      const result = runPreflight(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name));
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-sentinel-value/);
    }
  });
});

function createFiles(options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omnis-restricted-bootstrap-cli-'));
  directories.push(directory);
  const bootstrap = path.join(directory, 'restricted-db-bootstrap.env');
  const worker = path.join(directory, 'restricted-worker.env');
  const adminPassword = 'a'.repeat(64);
  const migrationPassword = 'c'.repeat(64);
  const runtimePassword = 'b'.repeat(64);
  const databaseName = options.databaseName ?? 'omnis_restricted_dev';
  writeFileSync(
    bootstrap,
    [
      'OMNIS_RESTRICTED_DEVELOPMENT=true',
      'OMNIS_EXECUTION_MODE=disabled',
      `OMNIS_RESTRICTED_COMPOSE_PROJECT=${options.project ?? 'omnis-os-restricted-dev'}`,
      `OMNIS_RESTRICTED_DB_NAME=${databaseName}`,
      `OMNIS_RESTRICTED_PG_SYSTEM_IDENTIFIER=${options.systemIdentifier ?? '7656119800000000000'}`,
      `OMNIS_RESTRICTED_ADMIN_DATABASE_URL=postgresql://omnis:${adminPassword}@127.0.0.1:5432/omnis_restricted_dev`,
      `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=postgresql://omnis_migrator:${migrationPassword}@127.0.0.1:5432/omnis_restricted_dev`,
      `OMNIS_RESTRICTED_MIGRATOR_PASSWORD=${migrationPassword}`,
      `OMNIS_RESTRICTED_RUNTIME_PASSWORD=${runtimePassword}`,
      options.extra ?? '',
    ].join('\n'),
  );
  writeFileSync(worker, `OMNIS_RUNTIME_DB_PASSWORD=${runtimePassword}\n`);
  chmodSync(bootstrap, 0o600);
  chmodSync(worker, 0o600);
  return {
    bootstrap,
    worker,
    secrets: [adminPassword, migrationPassword, runtimePassword],
  };
}

function runPreflight(fixture) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      provisionScript,
      'preflight',
      '--bootstrap-env',
      fixture.bootstrap,
      '--worker-env',
      fixture.worker,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    },
  );
}

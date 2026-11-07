import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRuntimeDatabaseUrl, validateWorkerBindHost } from './deployment-config.ts';

describe('worker deployment configuration', () => {
  it('keeps loopback listener defaults and gates wildcard binds to private Compose mode', () => {
    assert.doesNotThrow(() => validateWorkerBindHost('127.0.0.1', false));
    assert.doesNotThrow(() => validateWorkerBindHost('0.0.0.0', true));
    assert.throws(() => validateWorkerBindHost('0.0.0.0', false));
    assert.throws(() => validateWorkerBindHost('192.0.2.10', true));
  });

  it('builds a restricted-role URL with encoded credentials for the private postgres service', () => {
    const connection = createRuntimeDatabaseUrl({
      password: 'fixture@with:reserved/characters',
      host: 'postgres',
      privateCompose: true,
    });
    const parsed = new URL(connection);
    assert.equal(parsed.username, 'omnis_runtime');
    assert.equal(decodeURIComponent(parsed.password), 'fixture@with:reserved/characters');
    assert.equal(parsed.hostname, 'postgres');
    assert.equal(parsed.pathname, '/omnis');
  });

  it('rejects external database hosts and elevated database identities', () => {
    assert.throws(() =>
      createRuntimeDatabaseUrl({
        password: 'fixture',
        host: 'db.example.test',
        privateCompose: true,
      }),
    );
    assert.throws(() =>
      createRuntimeDatabaseUrl({
        databaseUrl: 'postgresql://postgres:password@postgres:5432/omnis',
        privateCompose: true,
      }),
    );
    assert.throws(() =>
      createRuntimeDatabaseUrl({
        databaseUrl: 'postgresql://omnis_runtime:password@postgres:5432/omnis',
        privateCompose: false,
      }),
    );
  });
});

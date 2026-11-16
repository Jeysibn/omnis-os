import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import {
  loadRestrictedBootstrapConfig,
  loadRestrictedMigrationConfig,
  RESTRICTED_MIGRATION_ENV_ALLOWLIST,
} from './restricted-bootstrap.ts';
import { provisionRestrictedDatabaseRoles } from './provision-roles.ts';

const directories: string[] = [];
const SYSTEM_IDENTIFIER = '7656119800000000000';

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('restricted database bootstrap configuration', () => {
  it('accepts only disabled mode, the exact target, and the two restricted roles', () => {
    const fixture = files();
    const config = loadRestrictedBootstrapConfig(fixture.bootstrap, fixture.worker);
    assert.equal(config.databaseName, 'omnis_restricted_dev');
    assert.equal(config.adminUrl, fixture.adminUrl);
    assert.equal(config.migrationUrl, fixture.migrationUrl);
    assert.equal(config.systemIdentifier, SYSTEM_IDENTIFIER);
    assert.equal(config.migratorPassword, 'a'.repeat(64));
    assert.equal(config.runtimePassword, 'b'.repeat(64));
  });

  it('does not require internal API-to-Worker credentials for database bootstrap', () => {
    const fixture = files({ omitInternalToken: true });
    assert.equal(
      loadRestrictedBootstrapConfig(fixture.bootstrap, fixture.worker).databaseName,
      'omnis_restricted_dev',
    );
  });

  it('rejects missing, default, and unexpected database names', () => {
    for (const options of [
      { omitDatabaseName: true },
      { databaseName: 'omnis' },
      { databaseName: 'omnis_other' },
      { project: 'omnis-os' },
      { systemIdentifier: 'not-a-system-identifier' },
    ]) {
      const fixture = files(options);
      assert.throws(
        () => loadRestrictedBootstrapConfig(fixture.bootstrap, fixture.worker),
        /omnis_restricted_dev|OMNIS_RESTRICTED_DB_NAME|omnis-os-restricted-dev|system identifier/,
      );
    }
  });

  it('rejects missing migration or runtime credentials and authorizer/launcher coupling', () => {
    const missingMigrator = files({ omitMigratorPassword: true });
    assert.throws(
      () => loadRestrictedBootstrapConfig(missingMigrator.bootstrap, missingMigrator.worker),
      /OMNIS_RESTRICTED_MIGRATOR_PASSWORD/,
    );

    const missingRuntime = files({ omitRuntimePassword: true });
    assert.throws(
      () => loadRestrictedBootstrapConfig(missingRuntime.bootstrap, missingRuntime.worker),
      /OMNIS_RESTRICTED_RUNTIME_PASSWORD/,
    );

    const privileged = files({ extra: 'OMNIS_AUTHORIZER_DB_PASSWORD=do-not-print\n' });
    assert.throws(
      () => loadRestrictedBootstrapConfig(privileged.bootstrap, privileged.worker),
      /disallowed variable OMNIS_AUTHORIZER_DB_PASSWORD/,
    );
  });

  it('rejects wrong or conflicting URLs, roles, hosts, and unsupported mode', () => {
    for (const fixture of [
      files({ adminDatabase: 'omnis' }),
      files({ migrationDatabase: 'omnis' }),
      files({ migrationUser: 'omnis_runtime' }),
      files({ migrationHost: 'db.example.invalid' }),
      files({ migrationPassword: 'x'.repeat(64) }),
      files({ mode: 'mock' }),
      files({ restricted: 'false' }),
      files({ extra: 'OMNIS_DB_NAME=omnis\n' }),
    ]) {
      assert.throws(() => loadRestrictedBootstrapConfig(fixture.bootstrap, fixture.worker));
    }
  });

  it('requires runtime credential equality with the restricted Worker file', () => {
    const fixture = files({ workerPassword: 'c'.repeat(64) });
    assert.throws(
      () => loadRestrictedBootstrapConfig(fixture.bootstrap, fixture.worker),
      /credentials must match/,
    );
  });

  it('accepts a migration-only file without administrative or runtime credentials', () => {
    const fixture = files();
    const migrationPath = path.join(path.dirname(fixture.bootstrap), 'restricted-migration.env');
    const values = [
      'OMNIS_RESTRICTED_DEVELOPMENT=true',
      'OMNIS_EXECUTION_MODE=disabled',
      'OMNIS_RESTRICTED_COMPOSE_PROJECT=omnis-os-restricted-dev',
      'OMNIS_RESTRICTED_DB_NAME=omnis_restricted_dev',
      `OMNIS_RESTRICTED_PG_SYSTEM_IDENTIFIER=${SYSTEM_IDENTIFIER}`,
      `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=${fixture.migrationUrl}`,
    ].join('\n');
    writeFileSync(migrationPath, values);
    chmodSync(migrationPath, 0o600);
    const config = loadRestrictedMigrationConfig(migrationPath);
    assert.equal(config.databaseName, 'omnis_restricted_dev');
    assert.equal(config.migrationUrl, fixture.migrationUrl);
    assert.equal(
      RESTRICTED_MIGRATION_ENV_ALLOWLIST.has('OMNIS_RESTRICTED_ADMIN_DATABASE_URL'),
      false,
    );
    assert.equal(
      RESTRICTED_MIGRATION_ENV_ALLOWLIST.has('OMNIS_RESTRICTED_RUNTIME_PASSWORD'),
      false,
    );
  });

  it('rejects administrative credentials in the migration-only env file without echoing values', () => {
    const fixture = files();
    const migrationPath = path.join(path.dirname(fixture.bootstrap), 'restricted-migration.env');
    const secret = 'administrative-secret-sentinel';
    writeFileSync(
      migrationPath,
      [
        'OMNIS_RESTRICTED_DEVELOPMENT=true',
        'OMNIS_EXECUTION_MODE=disabled',
        'OMNIS_RESTRICTED_COMPOSE_PROJECT=omnis-os-restricted-dev',
        'OMNIS_RESTRICTED_DB_NAME=omnis_restricted_dev',
        `OMNIS_RESTRICTED_PG_SYSTEM_IDENTIFIER=${SYSTEM_IDENTIFIER}`,
        `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=${fixture.migrationUrl}`,
        `OMNIS_RESTRICTED_ADMIN_DATABASE_URL=postgresql://omnis:${secret}@127.0.0.1:5432/omnis_restricted_dev`,
      ].join('\n'),
    );
    chmodSync(migrationPath, 0o600);
    assert.throws(() => loadRestrictedMigrationConfig(migrationPath), /disallowed variable/);
    assert.doesNotMatch(
      (() => {
        try {
          loadRestrictedMigrationConfig(migrationPath);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return '';
      })(),
      new RegExp(secret),
    );
  });
});

describe('restricted database target preflight', () => {
  it('verifies the live database and role before any mutating query', async () => {
    const queries: string[] = [];
    const pool = fakePool(async (sql) => {
      queries.push(sql);
      return {
        rows: [{ database_name: 'omnis', current_user: 'omnis', is_superuser: true }],
      };
    });

    await assert.rejects(
      provisionRestrictedDatabaseRoles(
        pool,
        { migration: 'a'.repeat(64), runtime: 'b'.repeat(64) },
        SYSTEM_IDENTIFIER,
      ),
      /omnis_restricted_dev/,
    );
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /current_database\(\)/);
  });

  it('rejects a live role or privilege mismatch before provisioning SQL', async () => {
    for (const identity of [
      {
        database_name: 'omnis_restricted_dev',
        role_name: 'omnis_runtime',
        is_superuser: false,
        system_identifier: SYSTEM_IDENTIFIER,
      },
      {
        database_name: 'omnis_restricted_dev',
        role_name: 'omnis',
        is_superuser: false,
        system_identifier: SYSTEM_IDENTIFIER,
      },
      {
        database_name: 'omnis_restricted_dev',
        role_name: 'omnis',
        is_superuser: true,
        system_identifier: '7656119800000000001',
      },
    ]) {
      const queries: string[] = [];
      const pool = fakePool(async (sql) => {
        queries.push(sql);
        return {
          rows: [
            {
              database_name: identity.database_name,
              current_user: identity.role_name,
              is_superuser: identity.is_superuser,
            },
          ],
        };
      });
      await assert.rejects(
        provisionRestrictedDatabaseRoles(
          pool,
          { migration: 'a'.repeat(64), runtime: 'b'.repeat(64) },
          SYSTEM_IDENTIFIER,
        ),
      );
      assert.equal(queries.length, 1);
    }
  });

  it('rejects an already provisioned cluster before changing cluster-global role passwords', async () => {
    const queries: string[] = [];
    const pool = fakePool(async (sql) => {
      queries.push(sql);
      if (sql.includes('current_database()')) {
        return {
          rows: [
            {
              database_name: 'omnis_restricted_dev',
              current_user: 'omnis',
              is_superuser: true,
              system_identifier: SYSTEM_IDENTIFIER,
            },
          ],
        };
      }
      if (sql.includes('pg_roles')) return { rows: [{ role_name: 'omnis_runtime' }] };
      return { rows: [], rowCount: 0 };
    });

    await assert.rejects(
      provisionRestrictedDatabaseRoles(
        pool,
        { migration: 'a'.repeat(64), runtime: 'b'.repeat(64) },
        SYSTEM_IDENTIFIER,
      ),
      /fresh PostgreSQL application role set/,
    );
    assert.ok(queries.length > 1);
    assert.doesNotMatch(queries.join('\n'), /\b(?:ALTER|CREATE|GRANT|REVOKE)\b/i);
  });

  it('provisions only runtime and migrator roles with scoped grants', async () => {
    const queries: string[] = [];
    const pool = fakePool(async (sql) => {
      queries.push(sql);
      if (sql.includes('current_database()')) {
        return {
          rows: [
            {
              database_name: 'omnis_restricted_dev',
              current_user: 'omnis',
              is_superuser: true,
              system_identifier: SYSTEM_IDENTIFIER,
            },
          ],
        };
      }
      if (sql.includes('quote_literal')) return { rows: [{ literal: "'synthetic'" }] };
      return { rows: [], rowCount: 0 };
    });

    await provisionRestrictedDatabaseRoles(
      pool,
      { migration: 'a'.repeat(64), runtime: 'b'.repeat(64) },
      SYSTEM_IDENTIFIER,
    );

    const sql = queries.join('\n');
    assert.match(sql, /ALTER ROLE omnis_migrator WITH LOGIN NOINHERIT NOSUPERUSER/);
    assert.match(sql, /ALTER ROLE omnis_runtime WITH LOGIN NOINHERIT NOSUPERUSER/);
    assert.match(
      sql,
      /GRANT CONNECT ON DATABASE "omnis_restricted_dev" TO omnis_migrator, omnis_runtime/,
    );
    assert.match(
      sql,
      /CREATE ROLE omnis_authorizer WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
    );
    assert.match(
      sql,
      /CREATE ROLE omnis_launcher WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
    );
    assert.doesNotMatch(sql, /ALTER ROLE omnis_(?:authorizer|launcher)/);
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION pg_catalog\.pg_control_system\(\) TO omnis_migrator/,
    );
    assert.doesNotMatch(
      sql,
      /GRANT EXECUTE ON FUNCTION pg_catalog\.pg_control_system\(\) TO omnis_runtime/,
    );
    assert.doesNotMatch(sql, /GRANT (?:ALL|CREATE|UPDATE|DELETE) ON DATABASE .* TO omnis_runtime/);
  });

  it('rejects conflicting inherited targets without exposing values', async () => {
    const { assertNoRestrictedBootstrapOverrides } = await import('./restricted-bootstrap.ts');
    for (const key of [
      'OMNIS_DB_NAME',
      'OMNIS_DATABASE_URL',
      'OMNIS_MIGRATION_DATABASE_URL',
      'OMNIS_AUTHORIZER_DB_PASSWORD',
      'OMNIS_LAUNCHER_DB_PASSWORD',
      'PGHOST',
      'PGDATABASE',
      'DATABASE_URL',
      'NODE_OPTIONS',
      'NODE_PATH',
    ]) {
      assert.throws(
        () => assertNoRestrictedBootstrapOverrides({ [key]: 'secret-sentinel' }),
        new RegExp(key),
      );
      assert.doesNotMatch(
        (() => {
          try {
            assertNoRestrictedBootstrapOverrides({ [key]: 'secret-sentinel' });
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
          return '';
        })(),
        /secret-sentinel/,
      );
    }
  });
});

function files(
  options: {
    databaseName?: string | undefined;
    omitDatabaseName?: boolean | undefined;
    adminDatabase?: string | undefined;
    migrationDatabase?: string | undefined;
    migrationUser?: string | undefined;
    migrationHost?: string | undefined;
    migrationPassword?: string | undefined;
    migratorPassword?: string | undefined;
    runtimePassword?: string | undefined;
    workerPassword?: string | undefined;
    omitMigratorPassword?: boolean | undefined;
    omitRuntimePassword?: boolean | undefined;
    omitInternalToken?: boolean | undefined;
    restricted?: string | undefined;
    mode?: string | undefined;
    project?: string | undefined;
    systemIdentifier?: string | undefined;
    extra?: string | undefined;
  } = {},
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omnis-restricted-db-'));
  directories.push(directory);
  const adminUrl = `postgresql://omnis:${'a'.repeat(64)}@127.0.0.1:5432/${options.adminDatabase ?? 'omnis_restricted_dev'}`;
  const migrationUser = options.migrationUser ?? 'omnis_migrator';
  const migrationPassword = options.migrationPassword ?? 'a'.repeat(64);
  const migrationUrl = `postgresql://${migrationUser}:${migrationPassword}@${options.migrationHost ?? '127.0.0.1'}:5432/${options.migrationDatabase ?? 'omnis_restricted_dev'}`;
  const bootstrap = path.join(directory, 'restricted-db-bootstrap.env');
  const worker = path.join(directory, 'restricted-worker.env');
  writeFileSync(
    bootstrap,
    [
      `OMNIS_RESTRICTED_DEVELOPMENT=${options.restricted ?? 'true'}`,
      `OMNIS_EXECUTION_MODE=${options.mode ?? 'disabled'}`,
      `OMNIS_RESTRICTED_COMPOSE_PROJECT=${options.project ?? 'omnis-os-restricted-dev'}`,
      `OMNIS_RESTRICTED_PG_SYSTEM_IDENTIFIER=${options.systemIdentifier ?? SYSTEM_IDENTIFIER}`,
      ...(options.omitDatabaseName
        ? []
        : [`OMNIS_RESTRICTED_DB_NAME=${options.databaseName ?? 'omnis_restricted_dev'}`]),
      `OMNIS_RESTRICTED_ADMIN_DATABASE_URL=${adminUrl}`,
      `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=${migrationUrl}`,
      ...(options.omitMigratorPassword
        ? []
        : [`OMNIS_RESTRICTED_MIGRATOR_PASSWORD=${options.migratorPassword ?? 'a'.repeat(64)}`]),
      ...(options.omitRuntimePassword
        ? []
        : [`OMNIS_RESTRICTED_RUNTIME_PASSWORD=${options.runtimePassword ?? 'b'.repeat(64)}`]),
      options.extra ?? '',
    ].join('\n'),
  );
  writeFileSync(
    worker,
    `${options.omitInternalToken ? '' : `OMNIS_INTERNAL_TOKEN=${'d'.repeat(96)}\n`}` +
      `OMNIS_RUNTIME_DB_PASSWORD=${options.workerPassword ?? 'b'.repeat(64)}\n`,
  );
  chmodSync(bootstrap, 0o600);
  chmodSync(worker, 0o600);
  return { bootstrap, worker, adminUrl, migrationUrl };
}

function fakePool(query: (sql: string) => Promise<{ rows: unknown[]; rowCount?: number }>): Pool {
  return { query } as unknown as Pool;
}

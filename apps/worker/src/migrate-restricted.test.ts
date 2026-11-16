import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { migrate } from '@omnis/db';
import { loadRestrictedMigrationConfig } from '@omnis/db';
import {
  applyRestrictedMigrations,
  parseRestrictedMigrationArguments,
} from './migrate-restricted.ts';

type Pool = Parameters<typeof migrate>[0];

const directories: string[] = [];
const SYSTEM_IDENTIFIER = '7656119800000000000';

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('restricted migrations', () => {
  it('requires one explicit migration-only env file', () => {
    assert.deepEqual(
      parseRestrictedMigrationArguments(['--migration-env', '/private/migration.env']),
      {
        migrationPath: '/private/migration.env',
      },
    );
    assert.throws(() =>
      parseRestrictedMigrationArguments(['--bootstrap-env', '/private/bootstrap.env']),
    );
    assert.throws(() =>
      parseRestrictedMigrationArguments([
        '--migration-env',
        '/private/migration.env',
        '--migration-env',
        '/private/other.env',
      ]),
    );
  });

  it('does not construct PgBoss or run migrations before live target identity passes', async () => {
    const config = fixture();
    const calls: string[] = [];
    const pool = fakePool(async (sql) => {
      calls.push(sql);
      return {
        rows: [
          {
            database_name: 'omnis',
            role_name: 'omnis_migrator',
            is_superuser: false,
            system_identifier: SYSTEM_IDENTIFIER,
          },
        ],
      };
    });

    await assert.rejects(
      applyRestrictedMigrations(config.config, pool, {
        migrateSchema: async () => {
          calls.push('MIGRATE');
        },
        createBoss: () => {
          calls.push('PGBOSS');
          return fakeBoss(calls);
        },
      }),
      /omnis_restricted_dev/,
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /current_database\(\)/);
  });

  it('does not run migrations on a same-name database in a different PostgreSQL cluster', async () => {
    const { config, cleanup } = fixture();
    try {
      const calls: string[] = [];
      const pool = fakePool(async (sql) => {
        calls.push(sql);
        return {
          rows: [
            {
              database_name: 'omnis_restricted_dev',
              role_name: 'omnis_migrator',
              is_superuser: false,
              system_identifier: '7656119800000000001',
            },
          ],
        };
      });

      await assert.rejects(
        applyRestrictedMigrations(config, pool, {
          migrateSchema: async () => {
            calls.push('MIGRATE');
          },
          createBoss: () => {
            calls.push('PGBOSS');
            return fakeBoss(calls);
          },
        }),
        /verified PostgreSQL system identifier/,
      );
      assert.equal(calls.length, 1);
      assert.match(calls[0]!, /pg_control_system/);
    } finally {
      cleanup();
    }
  });

  it('uses the migrator connection after readonly identity verification and never the runtime role', async () => {
    const { config, cleanup } = fixture();
    try {
      const calls: string[] = [];
      const pool = fakePool(async (sql) => {
        calls.push(sql);
        if (sql.includes('current_database()')) {
          return {
            rows: [
              {
                database_name: 'omnis_restricted_dev',
                role_name: 'omnis_migrator',
                is_superuser: false,
                system_identifier: SYSTEM_IDENTIFIER,
              },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      });
      await applyRestrictedMigrations(config, pool, {
        migrateSchema: async () => {
          calls.push('MIGRATE');
        },
        createBoss: (connectionString) => {
          assert.equal(connectionString, config.migrationUrl);
          calls.push('PGBOSS');
          return fakeBoss(calls);
        },
      });

      assert.equal(calls[0]?.includes('current_database()'), true);
      assert.equal(calls[1], 'MIGRATE');
      assert.equal(calls[2], 'PGBOSS');
      assert.ok(calls.some((sql) => sql.includes('GRANT USAGE ON SCHEMA pgboss TO omnis_runtime')));
      assert.ok(!config.migrationUrl.includes('omnis_runtime'));
    } finally {
      cleanup();
    }
  });

  it('stops PgBoss even when its primary start operation fails', async () => {
    const { config, cleanup } = fixture();
    try {
      const calls: string[] = [];
      const pool = fakePool(async () => ({
        rows: [
          {
            database_name: 'omnis_restricted_dev',
            role_name: 'omnis_migrator',
            is_superuser: false,
            system_identifier: SYSTEM_IDENTIFIER,
          },
        ],
      }));

      await assert.rejects(
        applyRestrictedMigrations(config, pool, {
          migrateSchema: async () => undefined,
          createBoss: () => ({
            async start() {
              calls.push('START');
              throw new Error('synthetic start failure');
            },
            async createQueue() {
              calls.push('CREATE_QUEUE');
            },
            async stop() {
              calls.push('STOP');
            },
          }),
        }),
        /synthetic start failure/,
      );
      assert.deepEqual(calls, ['START', 'STOP']);
    } finally {
      cleanup();
    }
  });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omnis-restricted-migrate-'));
  directories.push(directory);
  const migration = path.join(directory, 'restricted-db-migration.env');
  const migratorPassword = 'a'.repeat(64);
  const migrationUrl = `postgresql://omnis_migrator:${migratorPassword}@127.0.0.1:5432/omnis_restricted_dev`;
  writeFileSync(
    migration,
    [
      'OMNIS_RESTRICTED_DEVELOPMENT=true',
      'OMNIS_EXECUTION_MODE=disabled',
      'OMNIS_RESTRICTED_COMPOSE_PROJECT=omnis-os-restricted-dev',
      `OMNIS_RESTRICTED_PG_SYSTEM_IDENTIFIER=${SYSTEM_IDENTIFIER}`,
      'OMNIS_RESTRICTED_DB_NAME=omnis_restricted_dev',
      `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=${migrationUrl}`,
    ].join('\n'),
  );
  chmodSync(migration, 0o600);
  return {
    config: loadRestrictedMigrationConfig(migration),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function fakePool(
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>,
) {
  return { query } as unknown as Pool;
}

function fakeBoss(calls: string[]) {
  return {
    async start() {
      calls.push('BOSS_START');
    },
    async createQueue() {
      calls.push('CREATE_QUEUE');
    },
    async stop() {
      calls.push('BOSS_STOP');
    },
  };
}

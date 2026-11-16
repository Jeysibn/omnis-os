import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { migrate } from '@omnis/db';
import { loadRestrictedBootstrapConfig } from '@omnis/db';
import { applyRestrictedMigrations } from './migrate-restricted.ts';

type Pool = Parameters<typeof migrate>[0];

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('restricted migrations', () => {
  it('does not construct PgBoss or run migrations before live target identity passes', async () => {
    const config = fixture();
    const calls: string[] = [];
    const pool = fakePool(async (sql) => {
      calls.push(sql);
      return {
        rows: [{ database_name: 'omnis', role_name: 'omnis_migrator', is_superuser: false }],
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
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omnis-restricted-migrate-'));
  directories.push(directory);
  const bootstrap = path.join(directory, 'restricted-db-bootstrap.env');
  const worker = path.join(directory, 'restricted-worker.env');
  const migratorPassword = 'a'.repeat(64);
  const runtimePassword = 'b'.repeat(64);
  const migrationUrl = `postgresql://omnis_migrator:${migratorPassword}@127.0.0.1:5432/omnis_restricted_dev`;
  writeFileSync(
    bootstrap,
    [
      'OMNIS_RESTRICTED_DEVELOPMENT=true',
      'OMNIS_EXECUTION_MODE=disabled',
      'OMNIS_RESTRICTED_COMPOSE_PROJECT=omnis-os-restricted-dev',
      'OMNIS_RESTRICTED_DB_NAME=omnis_restricted_dev',
      `OMNIS_RESTRICTED_ADMIN_DATABASE_URL=postgresql://omnis:${'a'.repeat(64)}@127.0.0.1:5432/omnis_restricted_dev`,
      `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=${migrationUrl}`,
      `OMNIS_RESTRICTED_MIGRATOR_PASSWORD=${migratorPassword}`,
      `OMNIS_RESTRICTED_RUNTIME_PASSWORD=${runtimePassword}`,
    ].join('\n'),
  );
  writeFileSync(
    worker,
    `OMNIS_INTERNAL_TOKEN=${'d'.repeat(96)}\nOMNIS_RUNTIME_DB_PASSWORD=${runtimePassword}\n`,
  );
  chmodSync(bootstrap, 0o600);
  chmodSync(worker, 0o600);
  return {
    config: loadRestrictedBootstrapConfig(bootstrap, worker),
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

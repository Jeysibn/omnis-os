import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgBoss } from 'pg-boss';
import {
  assertNoRestrictedBootstrapOverrides,
  assertRestrictedDatabaseTarget,
  loadRestrictedMigrationConfig,
  type RestrictedMigrationConfig,
} from '@omnis/db';
import { createPool, migrate } from '@omnis/db';

type Pool = Parameters<typeof migrate>[0];

interface Arguments {
  migrationPath: string;
}

interface MigrationBoss {
  start(options: { attempts: number }): Promise<unknown>;
  createQueue(name: string, options: { retryLimit: number; retryDelay: number }): Promise<unknown>;
  stop(): Promise<unknown>;
}

interface MigrationDependencies {
  migrateSchema(pool: Pool): Promise<void>;
  createBoss(connectionString: string): MigrationBoss;
}

export function parseRestrictedMigrationArguments(args: readonly string[]): Arguments {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--migration-env' || options.has(flag)) {
      throw new Error('Usage: migrate-restricted.ts --migration-env <path>');
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error('A restricted migration env-file path is required.');
    options.set(flag, value);
    index += 1;
  }
  const migrationPath = options.get('--migration-env');
  if (!migrationPath || options.size !== 1) {
    throw new Error('Usage: migrate-restricted.ts --migration-env <path>');
  }
  return { migrationPath };
}

export async function applyRestrictedMigrations(
  config: RestrictedMigrationConfig,
  pool: Pool,
  dependencies: MigrationDependencies = {
    migrateSchema: migrate,
    createBoss: (connectionString) =>
      new PgBoss({
        connectionString,
        schema: 'pgboss',
        application_name: 'omnis-restricted-pgboss-migrator',
        max: 2,
        supervise: false,
        migrate: true,
        createSchema: false,
      }),
  },
): Promise<void> {
  await assertRestrictedDatabaseTarget(pool, 'omnis_migrator', false, config.systemIdentifier);
  await dependencies.migrateSchema(pool);

  const boss = dependencies.createBoss(config.migrationUrl);
  try {
    await boss.start({ attempts: 5 });
    await boss.createQueue('omnis-mock-run', { retryLimit: 0, retryDelay: 0 });
    await pool.query(`
      GRANT USAGE ON SCHEMA pgboss TO omnis_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO omnis_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO omnis_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
        GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;
    `);
  } finally {
    await boss.stop();
  }
}

async function main(): Promise<void> {
  let args: Arguments;
  let config: RestrictedMigrationConfig;
  try {
    args = parseRestrictedMigrationArguments(process.argv.slice(2));
    assertNoRestrictedBootstrapOverrides(process.env);
    config = loadRestrictedMigrationConfig(args.migrationPath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Restricted migration preflight failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  const pool = createPool({
    connectionString: config.migrationUrl,
    max: 2,
    application_name: 'omnis-restricted-schema-migrator',
  });
  try {
    await applyRestrictedMigrations(config, pool);
    process.stdout.write('Restricted database migrations completed.\n');
  } catch {
    process.stderr.write(
      'Restricted migration failed; details were withheld. Preserve the database and review its exact target.\n',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

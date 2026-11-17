import { PgBoss } from 'pg-boss';
import { createPool, migrate } from '@omnis/db';
import { createPgBossDatabase } from './migration-database.ts';

const connectionString = getMigrationDatabaseUrl();
const pool = createPool({
  connectionString,
  max: 2,
  application_name: 'omnis-schema-migrator',
});
const boss = new PgBoss({
  db: createPgBossDatabase(pool),
  schema: 'pgboss',
  supervise: false,
  migrate: true,
  createSchema: false,
});

try {
  await verifyMigrationConnection(pool, connectionString);
  await migrate(pool);
  await boss.start({ attempts: 5 });
  await boss.createQueue(process.env.OMNIS_QUEUE_NAME ?? 'omnis-mock-run', {
    retryLimit: 0,
    retryDelay: 0,
  });
  await pool.query(`
    GRANT USAGE ON SCHEMA pgboss TO omnis_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO omnis_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO omnis_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
      GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;
  `);
  process.stdout.write('Omnis application and pg-boss schema migrations completed.\n');
} finally {
  await boss.stop().catch(() => undefined);
  await pool.end();
}

async function verifyMigrationConnection(
  pool: ReturnType<typeof createPool>,
  configuredConnectionString: string,
): Promise<void> {
  const configured = new URL(configuredConnectionString);
  const result = await pool.query<{ current_user: string; database_name: string }>(
    'SELECT current_user, current_database() AS database_name',
  );
  const identity = result.rows[0];
  if (
    !identity ||
    identity.current_user !== decodeURIComponent(configured.username) ||
    identity.database_name !== decodeURIComponent(configured.pathname.slice(1))
  ) {
    throw new Error('Migration pool identity does not match the configured PostgreSQL target.');
  }
}

function getMigrationDatabaseUrl(): string {
  const configured = process.env.OMNIS_MIGRATION_DATABASE_URL;
  if (configured) {
    const parsed = new URL(configured);
    if (!['127.0.0.1', '::1', 'localhost', 'postgres'].includes(parsed.hostname)) {
      throw new Error('The initial migration database must use approved local networking.');
    }
    if (parsed.username !== 'omnis_migrator') {
      throw new Error('Schema migrations must connect as omnis_migrator.');
    }
    return configured;
  }
  const password = process.env.OMNIS_MIGRATION_DB_PASSWORD;
  if (!password) throw new Error('OMNIS_MIGRATION_DB_PASSWORD must be configured.');
  return `postgresql://omnis_migrator:${encodeURIComponent(password)}@127.0.0.1:5432/omnis`;
}

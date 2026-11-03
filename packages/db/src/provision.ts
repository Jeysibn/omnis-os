import { createPool } from './database.ts';
import { provisionDatabaseRoles } from './provision-roles.ts';

const adminUrl = process.env.OMNIS_ADMIN_DATABASE_URL ?? databaseUrl('omnis', 'OMNIS_DB_PASSWORD');
const migrationPassword = required('OMNIS_MIGRATION_DB_PASSWORD');
const runtimePassword = required('OMNIS_RUNTIME_DB_PASSWORD');
const authorizerPassword = required('OMNIS_AUTHORIZER_DB_PASSWORD');
const launcherPassword = required('OMNIS_LAUNCHER_DB_PASSWORD');
const pool = createPool({
  connectionString: adminUrl,
  max: 1,
  application_name: 'omnis-db-provision',
});

try {
  await provisionDatabaseRoles(pool, {
    migration: migrationPassword,
    runtime: runtimePassword,
    authorizer: authorizerPassword,
    launcher: launcherPassword,
  });
  process.stdout.write(
    'Omnis migration and runtime roles provisioned with scoped schema privileges.\n',
  );
} finally {
  await pool.end();
}

function databaseUrl(user: string, passwordName: string): string {
  const password = required(passwordName);
  const port = process.env.OMNIS_DB_PORT ?? '5432';
  const database = process.env.OMNIS_DB_NAME ?? 'omnis';
  return `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured for database role provisioning.`);
  return value;
}

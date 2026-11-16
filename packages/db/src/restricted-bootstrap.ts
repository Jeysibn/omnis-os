import { lstatSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import type { Pool } from 'pg';

export const RESTRICTED_DATABASE_NAME = 'omnis_restricted_dev';
export const RESTRICTED_COMPOSE_PROJECT = 'omnis-os-restricted-dev';

export const RESTRICTED_BOOTSTRAP_ENV_ALLOWLIST = new Set([
  'OMNIS_RESTRICTED_DEVELOPMENT',
  'OMNIS_EXECUTION_MODE',
  'OMNIS_RESTRICTED_COMPOSE_PROJECT',
  'OMNIS_RESTRICTED_DB_NAME',
  'OMNIS_RESTRICTED_ADMIN_DATABASE_URL',
  'OMNIS_RESTRICTED_MIGRATION_DATABASE_URL',
  'OMNIS_RESTRICTED_MIGRATOR_PASSWORD',
  'OMNIS_RESTRICTED_RUNTIME_PASSWORD',
]);

export const RESTRICTED_WORKER_DATABASE_ENV_ALLOWLIST = new Set([
  'OMNIS_INTERNAL_TOKEN',
  'OMNIS_RUNTIME_DB_PASSWORD',
]);

const SECRET_HEX = /^[a-f\d]{64,}$/i;

export interface RestrictedBootstrapConfig {
  readonly databaseName: typeof RESTRICTED_DATABASE_NAME;
  readonly adminUrl: string;
  readonly migrationUrl: string;
  readonly migratorPassword: string;
  readonly runtimePassword: string;
}

export function loadRestrictedBootstrapConfig(
  bootstrapPath: string,
  workerPath: string,
): RestrictedBootstrapConfig {
  const bootstrap = readPrivateEnvFile(
    bootstrapPath,
    'restricted database bootstrap',
    RESTRICTED_BOOTSTRAP_ENV_ALLOWLIST,
    [...RESTRICTED_BOOTSTRAP_ENV_ALLOWLIST],
  );
  const worker = readPrivateEnvFile(
    workerPath,
    'restricted Worker',
    RESTRICTED_WORKER_DATABASE_ENV_ALLOWLIST,
    ['OMNIS_RUNTIME_DB_PASSWORD'],
  );

  if (bootstrap.OMNIS_RESTRICTED_DEVELOPMENT !== 'true') {
    throw new Error(
      'Restricted bootstrap configuration must set OMNIS_RESTRICTED_DEVELOPMENT=true.',
    );
  }
  if (bootstrap.OMNIS_EXECUTION_MODE !== 'disabled') {
    throw new Error('Restricted bootstrap configuration must set OMNIS_EXECUTION_MODE=disabled.');
  }
  if (bootstrap.OMNIS_RESTRICTED_COMPOSE_PROJECT !== RESTRICTED_COMPOSE_PROJECT) {
    throw new Error(`Restricted bootstrap project must be ${RESTRICTED_COMPOSE_PROJECT}.`);
  }
  if (bootstrap.OMNIS_RESTRICTED_DB_NAME !== RESTRICTED_DATABASE_NAME) {
    throw new Error(`Restricted bootstrap target must be ${RESTRICTED_DATABASE_NAME}.`);
  }

  const adminUrl = bootstrap.OMNIS_RESTRICTED_ADMIN_DATABASE_URL!;
  const migrationUrl = bootstrap.OMNIS_RESTRICTED_MIGRATION_DATABASE_URL!;
  const migratorPassword = bootstrap.OMNIS_RESTRICTED_MIGRATOR_PASSWORD!;
  const runtimePassword = bootstrap.OMNIS_RESTRICTED_RUNTIME_PASSWORD!;
  if (!SECRET_HEX.test(migratorPassword) || !SECRET_HEX.test(runtimePassword)) {
    throw new Error(
      'Restricted migration and runtime database credentials must be 64+ hex characters.',
    );
  }
  if (worker.OMNIS_INTERNAL_TOKEN !== undefined && !SECRET_HEX.test(worker.OMNIS_INTERNAL_TOKEN)) {
    throw new Error('Restricted Worker env file has an invalid OMNIS_INTERNAL_TOKEN.');
  }
  if (worker.OMNIS_RUNTIME_DB_PASSWORD !== runtimePassword) {
    throw new Error('Restricted bootstrap and Worker runtime credentials must match.');
  }

  const admin = validateConnectionUrl(adminUrl, 'omnis');
  const migration = validateConnectionUrl(migrationUrl, 'omnis_migrator');
  if (!SECRET_HEX.test(admin.password)) {
    throw new Error('Restricted admin database URL has an invalid password format.');
  }
  if (migration.password !== migratorPassword) {
    throw new Error('Restricted migration URL must use the configured migrator password.');
  }

  return {
    databaseName: RESTRICTED_DATABASE_NAME,
    adminUrl,
    migrationUrl,
    migratorPassword,
    runtimePassword,
  };
}

export function assertNoRestrictedBootstrapOverrides(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  const conflicting = Object.keys(environment)
    .filter(
      (name) =>
        name.startsWith('OMNIS_') ||
        name.startsWith('PG') ||
        ['DATABASE_URL', 'NODE_OPTIONS', 'NODE_PATH'].includes(name),
    )
    .sort();
  if (conflicting.length > 0) {
    throw new Error(
      `Restricted bootstrap refuses inherited database or mode variables: ${conflicting.join(', ')}.`,
    );
  }
}

export async function assertRestrictedDatabaseTarget(
  pool: Pick<Pool, 'query'>,
  expectedRole: 'omnis' | 'omnis_migrator',
  expectedSuperuser: boolean,
): Promise<void> {
  const result = await pool.query<{
    database_name: string;
    role_name: string;
    is_superuser: boolean;
  }>(`
    SELECT current_database() AS database_name,
           current_user AS role_name,
           current_setting('is_superuser')::boolean AS is_superuser
  `);
  const identity = result.rows[0];
  if (
    identity?.database_name !== RESTRICTED_DATABASE_NAME ||
    identity.role_name !== expectedRole ||
    identity.is_superuser !== expectedSuperuser
  ) {
    throw new Error(
      `Restricted database connection must report ${RESTRICTED_DATABASE_NAME}, role ${expectedRole}, and superuser=${expectedSuperuser}.`,
    );
  }
}

function validateConnectionUrl(raw: string, expectedRole: 'omnis' | 'omnis_migrator') {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Restricted ${expectedRole} database URL is invalid.`);
  }

  let username: string;
  let password: string;
  let databaseName: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error(`Restricted ${expectedRole} database URL has invalid encoding.`);
  }

  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.port !== '5432' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname.slice(1).includes('/') ||
    databaseName !== RESTRICTED_DATABASE_NAME ||
    username !== expectedRole ||
    password.length < 64
  ) {
    throw new Error(
      `Restricted ${expectedRole} database URL must target loopback:5432/${RESTRICTED_DATABASE_NAME} with role ${expectedRole}.`,
    );
  }
  return { password };
}

function readPrivateEnvFile(
  filePath: string,
  label: string,
  allowlist: ReadonlySet<string>,
  requiredKeys: readonly string[],
): Record<string, string> {
  let metadata;
  try {
    metadata = lstatSync(filePath);
  } catch {
    throw new Error(`${label} env file is unavailable.`);
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o177) !== 0 ||
    (metadata.mode & 0o400) === 0 ||
    (process.getuid && metadata.uid !== process.getuid())
  ) {
    throw new Error(`${label} env file must be private, regular, and owned by the current user.`);
  }

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const contents = readFileSync(filePath, 'utf8');
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`${label} env file has unsupported syntax on line ${index + 1}.`);
    const [, key, value] = match;
    if (!allowlist.has(key!)) throw new Error(`${label} env file has disallowed variable ${key}.`);
    if (Object.hasOwn(values, key!)) throw new Error(`${label} env file repeats variable ${key}.`);
    if (!value || value !== value.trim() || /[\0\r\n'"`]/.test(value)) {
      throw new Error(`${label} env file has an invalid value for ${key}.`);
    }
    values[key!] = value;
  }

  for (const key of requiredKeys) {
    if (!Object.hasOwn(values, key)) throw new Error(`${label} env file is missing ${key}.`);
  }
  return values;
}

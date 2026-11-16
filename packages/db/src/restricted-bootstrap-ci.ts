import { closeSync, fchmodSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createPool } from './database.ts';

const DATABASE_NAME = 'omnis_restricted_dev';
const PROJECT = 'omnis-os-restricted-dev';
const POSTGRES_IMAGE =
  'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94';
const APP_ROLES = ['omnis_migrator', 'omnis_runtime', 'omnis_authorizer', 'omnis_launcher'];
let failureStage = 'GitHub Actions runner and fixture identity';

async function main(): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '';
  const job = process.env.GITHUB_JOB ?? '';
  const containerName = `omnis-ci-pg-${runId}-${runAttempt}-${job}`;
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    job !== 'database-integration' ||
    !/^\d+$/.test(runId) ||
    !/^\d+$/.test(runAttempt) ||
    process.env.OMNIS_CI_POSTGRES_CONTAINER_NAME !== containerName
  ) {
    throw new Error(
      'Restricted database integration requires its exact disposable hosted-CI fixture.',
    );
  }

  failureStage = 'administrator credential availability';
  const adminPassword = required('OMNIS_CI_POSTGRES_ADMIN_PASSWORD');
  failureStage = 'migration credential availability';
  const migratorPassword = required('OMNIS_CI_POSTGRES_MIGRATION_PASSWORD');
  failureStage = 'runtime credential availability';
  const runtimePassword = required('OMNIS_CI_POSTGRES_RUNTIME_PASSWORD');
  failureStage = 'restricted credential format validation';
  for (const password of [adminPassword, migratorPassword, runtimePassword]) {
    if (!/^[a-f\d]{64}$/i.test(password)) {
      throw new Error('Restricted CI database credentials failed format validation.');
    }
  }

  failureStage = 'disposable PostgreSQL fixture inspection';
  const systemIdentifier = inspectFixture(containerName, runId, job);
  const rootAdminUrl = databaseUrl('omnis', adminPassword, 'omnis_test');
  const rootAdmin = createPool({ connectionString: rootAdminUrl, max: 1 });
  let bootstrapPath: string | undefined;
  let workerPath: string | undefined;
  let migrationPath: string | undefined;
  const createdCredentialFiles: string[] = [];
  try {
    failureStage = 'PostgreSQL identity and freshness verification';
    const identity = await rootAdmin.query<{
      current_user: string;
      current_database: string;
      is_superuser: boolean;
      system_identifier: string;
    }>(`
      SELECT current_user,
             current_database() AS current_database,
             current_setting('is_superuser')::boolean AS is_superuser,
             system_identifier::text AS system_identifier
        FROM pg_catalog.pg_control_system()
    `);
    const row = identity.rows[0];
    if (
      row?.current_user !== 'omnis' ||
      row.current_database !== 'omnis_test' ||
      row.is_superuser !== true ||
      row.system_identifier !== systemIdentifier
    ) {
      throw new Error('Disposable PostgreSQL SQL identity did not match its exact CI container.');
    }

    const existingTarget = await rootAdmin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      DATABASE_NAME,
    ]);
    const existingRoles = await rootAdmin.query(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
      [APP_ROLES],
    );
    if (existingTarget.rowCount !== 0 || existingRoles.rowCount !== 0) {
      throw new Error('Disposable PostgreSQL fixture was not fresh for restricted bootstrap.');
    }

    // This mutation is limited to the run-scoped CI container validated above.
    failureStage = 'restricted database and credential-file preparation';
    await rootAdmin.query(`CREATE DATABASE ${DATABASE_NAME}`);
    const runnerTemp = required('RUNNER_TEMP');
    const suffix = `-${runId}-${runAttempt}-database-integration`;
    bootstrapPath = join(runnerTemp, `omnis-restricted-bootstrap${suffix}.env`);
    workerPath = join(runnerTemp, `omnis-restricted-worker${suffix}.env`);
    migrationPath = join(runnerTemp, `omnis-restricted-migration${suffix}.env`);
    writePrivateFile(
      bootstrapPath,
      [
        'OMNIS_RESTRICTED_DEVELOPMENT=true',
        'OMNIS_EXECUTION_MODE=disabled',
        `OMNIS_RESTRICTED_COMPOSE_PROJECT=${PROJECT}`,
        `OMNIS_RESTRICTED_DB_NAME=${DATABASE_NAME}`,
        `OMNIS_RESTRICTED_PG_SYSTEM_IDENTIFIER=${systemIdentifier}`,
        `OMNIS_RESTRICTED_ADMIN_DATABASE_URL=${databaseUrl('omnis', adminPassword, DATABASE_NAME)}`,
        `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=${databaseUrl('omnis_migrator', migratorPassword, DATABASE_NAME)}`,
        `OMNIS_RESTRICTED_MIGRATOR_PASSWORD=${migratorPassword}`,
        `OMNIS_RESTRICTED_RUNTIME_PASSWORD=${runtimePassword}`,
      ].join('\n') + '\n',
      createdCredentialFiles,
    );
    writePrivateFile(
      workerPath,
      `OMNIS_RUNTIME_DB_PASSWORD=${runtimePassword}\n`,
      createdCredentialFiles,
    );
    writePrivateFile(
      migrationPath,
      [
        'OMNIS_RESTRICTED_DEVELOPMENT=true',
        'OMNIS_EXECUTION_MODE=disabled',
        `OMNIS_RESTRICTED_COMPOSE_PROJECT=${PROJECT}`,
        `OMNIS_RESTRICTED_DB_NAME=${DATABASE_NAME}`,
        `OMNIS_RESTRICTED_PG_SYSTEM_IDENTIFIER=${systemIdentifier}`,
        `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=${databaseUrl('omnis_migrator', migratorPassword, DATABASE_NAME)}`,
      ].join('\n') + '\n',
      createdCredentialFiles,
    );

    failureStage = 'restricted bootstrap preflight';
    runRestrictedCli(
      'packages/db/src/provision-restricted.ts',
      'preflight',
      bootstrapPath,
      workerPath,
    );
    failureStage = 'restricted role provisioning';
    runRestrictedCli('packages/db/src/provision-restricted.ts', 'roles', bootstrapPath, workerPath);
    failureStage = 'restricted migrations';
    runRestrictedMigration(migrationPath);
    failureStage = 'post-migration privilege and identity verification';
    await verifyRestrictedDatabase(
      databaseUrl('omnis', adminPassword, DATABASE_NAME),
      databaseUrl('omnis_runtime', runtimePassword, DATABASE_NAME),
      databaseUrl('omnis_migrator', migratorPassword, DATABASE_NAME),
      systemIdentifier,
    );
    process.stdout.write(
      'Restricted bootstrap CI fixture passed target, role-isolation, and migration verification.\n',
    );
  } finally {
    try {
      await rootAdmin.end();
    } finally {
      for (const filePath of createdCredentialFiles) unlinkSync(filePath);
    }
  }
}

function inspectFixture(containerName: string, runId: string, job: string): string {
  let info: {
    Name?: string;
    Config?: {
      Image?: string;
      Labels?: Record<string, string>;
    };
    State?: { Running?: boolean };
    HostConfig?: {
      PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
      Privileged?: boolean;
      NetworkMode?: string;
    };
    Mounts?: Array<{ Type?: string; Destination?: string }>;
  };
  try {
    const json = execFileSync('docker', ['inspect', '--format', '{{json .}}', containerName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    info = JSON.parse(json) as typeof info;
  } catch {
    throw new Error('Exact disposable PostgreSQL container could not be inspected.');
  }
  const hostPort = info.HostConfig?.PortBindings?.['5432/tcp'];
  const mounts = info.Mounts;
  if (
    info.Name !== `/${containerName}` ||
    info.Config?.Image !== POSTGRES_IMAGE ||
    info.State?.Running !== true ||
    info.Config?.Labels?.['omnis.ci.run'] !== runId ||
    info.Config?.Labels?.['omnis.ci.job'] !== job ||
    info.HostConfig?.Privileged !== false ||
    info.HostConfig?.NetworkMode === 'host' ||
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0]?.Type !== 'volume' ||
    mounts[0]?.Destination !== '/var/lib/postgresql/data' ||
    !Array.isArray(hostPort) ||
    hostPort.length !== 1 ||
    hostPort[0]?.HostIp !== '127.0.0.1' ||
    hostPort[0]?.HostPort !== '5432'
  ) {
    throw new Error(
      'Disposable PostgreSQL container does not match its expected isolated CI shape.',
    );
  }

  let controlData: string;
  try {
    controlData = execFileSync(
      'docker',
      ['exec', '--user', 'postgres', containerName, 'sh', '-c', 'pg_controldata "$PGDATA"'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    throw new Error('PostgreSQL cluster identity could not be read from the exact CI container.');
  }
  const match = /Database system identifier:\s*(\d+)/.exec(controlData);
  if (!match?.[1]) throw new Error('PostgreSQL cluster identity was absent from CI control data.');
  return match[1];
}

async function verifyRestrictedDatabase(
  adminUrl: string,
  runtimeUrl: string,
  migratorUrl: string,
  systemIdentifier: string,
): Promise<void> {
  const admin = createPool({ connectionString: adminUrl, max: 1 });
  const runtime = createPool({ connectionString: runtimeUrl, max: 1 });
  const migrator = createPool({ connectionString: migratorUrl, max: 1 });
  try {
    failureStage = 'runtime database identity verification';
    const identity = await runtime.query<{
      current_user: string;
      current_database: string;
    }>('SELECT current_user, current_database()');
    if (
      identity.rows[0]?.current_user !== 'omnis_runtime' ||
      identity.rows[0]?.current_database !== DATABASE_NAME
    ) {
      throw new Error('Runtime role did not connect to the restricted database.');
    }

    failureStage = 'privilege snapshot SQL query';
    const checks = await admin.query<{
      runtime_superuser: boolean;
      runtime_createdb: boolean;
      runtime_createrole: boolean;
      runtime_bypassrls: boolean;
      runtime_login: boolean;
      runtime_inherit: boolean;
      runtime_accept_result: boolean;
      migrator_control_system: boolean;
      admin_system_identifier: string;
      migrator_schema_owner: string;
      pgboss_schema_owner: string;
      migration_count: number;
      role_membership_count: number;
    }>(
      `SELECT runtime.rolsuper AS runtime_superuser,
              runtime.rolcreatedb AS runtime_createdb,
              runtime.rolcreaterole AS runtime_createrole,
              runtime.rolbypassrls AS runtime_bypassrls,
              runtime.rolcanlogin AS runtime_login,
              runtime.rolinherit AS runtime_inherit,
              has_function_privilege('omnis_runtime', 'omnis.accept_task_result(text,text,uuid)', 'EXECUTE') AS runtime_accept_result,
              has_function_privilege('omnis_migrator', 'pg_catalog.pg_control_system()', 'EXECUTE') AS migrator_control_system,
              (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS admin_system_identifier,
              (SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'omnis') AS migrator_schema_owner,
              (SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'pgboss') AS pgboss_schema_owner,
              (SELECT count(*)::integer FROM omnis.schema_migrations) AS migration_count,
              (SELECT count(*)::integer FROM pg_auth_members m
                JOIN pg_roles granted ON granted.oid = m.roleid
                JOIN pg_roles member ON member.oid = m.member
               WHERE granted.rolname = ANY(ARRAY['omnis_migrator','omnis_runtime','omnis_authorizer','omnis_launcher'])
                  OR member.rolname = ANY(ARRAY['omnis_migrator','omnis_runtime','omnis_authorizer','omnis_launcher'])) AS role_membership_count
         FROM pg_roles runtime
        WHERE runtime.rolname = 'omnis_runtime'`,
    );
    const row = checks.rows[0];
    failureStage = 'runtime role privilege attributes';
    if (
      !row ||
      row.runtime_superuser ||
      row.runtime_createdb ||
      row.runtime_createrole ||
      row.runtime_bypassrls ||
      !row.runtime_login ||
      row.runtime_inherit
    ) {
      throw new Error('Restricted runtime role attributes are not least-privilege.');
    }

    failureStage = 'runtime acceptance-function privilege denial';
    if (row.runtime_accept_result) {
      throw new Error('Runtime role retains owner-acceptance function access.');
    }

    failureStage = 'runtime cluster-inspection access denial';
    let runtimeClusterInspectionDenied = false;
    try {
      await runtime.query('SELECT system_identifier FROM pg_catalog.pg_control_system()');
    } catch (error) {
      if (!hasPostgresErrorCode(error, '42501')) throw error;
      runtimeClusterInspectionDenied = true;
    }
    if (!runtimeClusterInspectionDenied) {
      throw new Error('Runtime role can inspect PostgreSQL cluster identity.');
    }

    failureStage = 'migration cluster-inspection privilege';
    if (!row.migrator_control_system) {
      throw new Error('Migration role lacks the required cluster identity inspection grant.');
    }

    failureStage = 'PostgreSQL cluster identity consistency';
    if (row.admin_system_identifier !== systemIdentifier) {
      throw new Error('PostgreSQL cluster identity differs from the inspected fixture.');
    }

    failureStage = 'migration schema ownership and history';
    if (
      row.migrator_schema_owner !== 'omnis_migrator' ||
      row.pgboss_schema_owner !== 'omnis_migrator' ||
      row.migration_count < 1
    ) {
      throw new Error('Restricted schema ownership or migration history checks failed.');
    }

    failureStage = 'restricted application-role membership isolation';
    if (row.role_membership_count !== 0) {
      throw new Error('Restricted application roles have unexpected role membership.');
    }

    failureStage = 'Authorizer and launcher ACL-principal verification';
    const auxiliaryRoles = await admin.query<{
      role_name: string;
      can_login: boolean;
      is_superuser: boolean;
      createdb: boolean;
      createrole: boolean;
    }>(
      `SELECT rolname AS role_name, rolcanlogin AS can_login, rolsuper AS is_superuser,
              rolcreatedb AS createdb, rolcreaterole AS createrole
         FROM pg_roles
        WHERE rolname IN ('omnis_authorizer', 'omnis_launcher')`,
    );
    if (
      auxiliaryRoles.rowCount !== 2 ||
      auxiliaryRoles.rows.some(
        (role) => role.can_login || role.is_superuser || role.createdb || role.createrole,
      )
    ) {
      throw new Error('Restricted ACL-only Authorizer/launcher database roles are not inert.');
    }

    failureStage = 'migration database identity verification';
    const migrationIdentity = await migrator.query<{
      current_user: string;
      current_database: string;
    }>('SELECT current_user, current_database()');
    if (
      migrationIdentity.rows[0]?.current_user !== 'omnis_migrator' ||
      migrationIdentity.rows[0]?.current_database !== DATABASE_NAME
    ) {
      throw new Error('Migration role did not connect to the restricted database.');
    }
  } finally {
    await Promise.all([admin.end(), runtime.end(), migrator.end()]);
  }
}

function runRestrictedCli(
  script: string,
  command: 'preflight' | 'roles' | undefined,
  bootstrapPath: string,
  workerPath: string,
): void {
  const args = [
    '--experimental-strip-types',
    script,
    ...(command ? [command] : []),
    '--bootstrap-env',
    bootstrapPath,
    '--worker-env',
    workerPath,
  ];
  let result: string;
  try {
    result = execFileSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      `Restricted database CI command failed: ${script}${command ? ` ${command}` : ''}.`,
    );
  }
  const secrets = [
    process.env.OMNIS_CI_POSTGRES_ADMIN_PASSWORD,
    process.env.OMNIS_CI_POSTGRES_MIGRATION_PASSWORD,
    process.env.OMNIS_CI_POSTGRES_RUNTIME_PASSWORD,
  ].filter((value): value is string => Boolean(value));
  if (secrets.some((secret) => result.includes(secret))) {
    throw new Error('Restricted database CI command output contained a credential.');
  }
}

function runRestrictedMigration(migrationPath: string): void {
  try {
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'apps/worker/src/migrate-restricted.ts',
        '--migration-env',
        migrationPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    throw new Error('Restricted database CI migration command failed.');
  }
}

function databaseUrl(role: string, password: string, database: string): string {
  return `postgresql://${role}:${encodeURIComponent(password)}@127.0.0.1:5432/${database}`;
}

function writePrivateFile(filePath: string, contents: string, createdFiles: string[]): void {
  const descriptor = openSync(filePath, 'wx', 0o600);
  createdFiles.push(filePath);
  try {
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required CI variable ${name} is unavailable.`);
  return value;
}

function hasPostgresErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

void main().catch(() => {
  process.stderr.write(
    `Restricted database CI verification failed during ${failureStage}; credentials and driver details withheld.\n`,
  );
  process.exitCode = 1;
});

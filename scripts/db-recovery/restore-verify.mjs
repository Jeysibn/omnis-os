import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidMetrics, metricsMatch, metricsQuery } from './metrics.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const composeArgs = createComposeArgs();
const sourceDatabase = process.env.OMNIS_BACKUP_DATABASE ?? 'omnis';
if (!/^omnis(?:_[a-z0-9_]+)?$/.test(sourceDatabase)) {
  throw new Error(
    'OMNIS_BACKUP_DATABASE must be an Omnis database name such as omnis or omnis_r1g3_test.',
  );
}

const [archiveArgument, targetDatabase] = process.argv.slice(2);
if (!archiveArgument || !targetDatabase || process.argv.length !== 4) {
  throw new Error(
    'Usage: node scripts/db-recovery/restore-verify.mjs <private-backup.dump> <omnis_restore_name>',
  );
}
if (!/^omnis_restore_[a-z0-9_]{1,48}$/.test(targetDatabase)) {
  throw new Error('Restore target must use the reserved omnis_restore_ prefix.');
}

const archivePath = path.resolve(archiveArgument);
const manifestPath = `${archivePath}.manifest.json`;
const archiveInfo = await lstat(archivePath);
if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || (archiveInfo.mode & 0o077) !== 0) {
  throw new Error('Backup must be a private regular file readable only by its owner.');
}
const archive = await openArchiveMagic(archivePath);
if (archive !== 'PGDMP') throw new Error('Input is not a PostgreSQL custom-format archive.');
const manifestInfo = await lstat(manifestPath);
if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || (manifestInfo.mode & 0o077) !== 0) {
  throw new Error('Backup count manifest must be a private regular file.');
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (
  manifest.format !== 'postgres-custom' ||
  manifest.sourceDatabase !== sourceDatabase ||
  manifest.dumpBytes !== archiveInfo.size ||
  manifest.dumpSha256 !== (await sha256(archivePath)) ||
  !manifest.snapshotMetrics ||
  manifest.snapshotMetrics.unsafeRunStates !== 0
) {
  throw new Error('Backup archive/manifest mismatch or unsafe active run state; refusing restore.');
}
assertValidMetrics(manifest.snapshotMetrics);

const existence = await dockerOutput([
  ...composeArgs,
  'exec',
  '-T',
  'postgres',
  'psql',
  '-X',
  '--no-psqlrc',
  '--set=ON_ERROR_STOP=1',
  '--tuples-only',
  '--no-align',
  '--username=omnis',
  '--dbname=postgres',
  '--command',
  `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${targetDatabase}')`,
]);
if (existence.trim() !== 'f') {
  throw new Error(
    'Restore target already exists or could not be checked; refusing to overwrite it.',
  );
}

const restoreStartedAt = process.hrtime.bigint();
await dockerChecked([
  ...composeArgs,
  'exec',
  '-T',
  'postgres',
  'createdb',
  '--no-password',
  '--username=omnis',
  '--maintenance-db=postgres',
  '--template=template0',
  targetDatabase,
]);

try {
  await dockerChecked([
    ...composeArgs,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '--username=omnis',
    '--dbname=postgres',
    '--command',
    `GRANT CONNECT, CREATE ON DATABASE "${targetDatabase}" TO omnis_migrator; GRANT CONNECT ON DATABASE "${targetDatabase}" TO omnis_runtime;`,
  ]);

  await dockerFromFile(
    [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '--exit-on-error',
      '--role=omnis_migrator',
      '--no-owner',
      '--no-acl',
      '--username=omnis',
      `--dbname=${targetDatabase}`,
    ],
    archivePath,
  );

  await dockerChecked([
    ...composeArgs,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '--username=omnis',
    `--dbname=${targetDatabase}`,
    '--command',
    `GRANT USAGE ON SCHEMA omnis, pgboss TO omnis_runtime;
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA omnis, pgboss TO omnis_runtime;
     GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA omnis, pgboss TO omnis_runtime;
     ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
     ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;
     ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
     ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;`,
  ]);

  await dockerChecked([
    ...composeArgs,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '--username=omnis_runtime',
    `--dbname=${targetDatabase}`,
    '--command',
    `BEGIN;
     INSERT INTO omnis.tasks (id, title, detail, status)
     VALUES ('task-' || lpad(nextval('omnis.task_id_seq')::text, 4, '0'),
       'Restore permission probe', 'Synthetic rollback-only verification.', 'open');
     ROLLBACK;`,
  ]);

  const reportText = await dockerOutput([
    ...composeArgs,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '--tuples-only',
    '--no-align',
    '--username=omnis',
    `--dbname=${targetDatabase}`,
    '--command',
    metricsQuery,
  ]);
  const report = JSON.parse(reportText.trim());
  if (!metricsMatch(manifest.snapshotMetrics, report) || report.unsafeRunStates !== 0) {
    throw new Error(
      'Restored database failed count, sequence, runtime, active-run, or schema invariants.',
    );
  }
  process.stdout.write(
    `Restore verified in isolated database ${targetDatabase}; source and target counts match: ${JSON.stringify(report)}\n` +
      `Restore and validation duration: ${Number(process.hrtime.bigint() - restoreStartedAt) / 1_000_000} ms.\n` +
      'Runtime-role INSERT and sequence access passed in a rolled-back transaction; no worker was started against the target.\n',
  );
} catch (error) {
  process.stderr.write(
    `Restore verification failed. The isolated target ${targetDatabase} was created and may be partial; it was not dropped automatically.\n`,
  );
  throw error;
}

async function openArchiveMagic(filePath) {
  const descriptor = await open(filePath, fsConstants.O_RDONLY);
  try {
    const magic = Buffer.alloc(5);
    await descriptor.read(magic, 0, magic.length, 0);
    return magic.toString('ascii');
  } finally {
    await descriptor.close();
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function createComposeArgs() {
  const projectName = process.env.OMNIS_COMPOSE_PROJECT_NAME;
  if (projectName && !/^[a-z][a-z0-9_-]{0,62}$/.test(projectName)) {
    throw new Error('OMNIS_COMPOSE_PROJECT_NAME is invalid.');
  }
  const envFile = path.resolve(
    process.env.OMNIS_COMPOSE_ENV_FILE ?? path.join(repositoryRoot, '.env.db-admin'),
  );
  return [
    'compose',
    ...(projectName ? ['--project-name', projectName] : []),
    '--project-directory',
    repositoryRoot,
    '--env-file',
    envFile,
    '-f',
    path.join(repositoryRoot, 'infra/compose/docker-compose.yml'),
  ];
}

async function dockerChecked(args) {
  const child = spawn('/usr/bin/docker', args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.resume();
  const [code] = await once(child, 'close');
  if (code !== 0)
    throw new Error(`Docker/restore command failed with exit code ${code ?? 'unknown'}.`);
}

async function dockerOutput(args) {
  const child = spawn('/usr/bin/docker', args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString('utf8');
    if (output.length > 16 * 1024) child.kill('SIGKILL');
  });
  child.stderr?.resume();
  const [code] = await once(child, 'close');
  if (code !== 0)
    throw new Error(`Docker/PostgreSQL query failed with exit code ${code ?? 'unknown'}.`);
  return output;
}

async function dockerFromFile(args, inputPath) {
  const child = spawn('/usr/bin/docker', args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const exited = once(child, 'close');
  child.stderr?.resume();
  try {
    await pipeline(createReadStream(inputPath), child.stdin);
    const [code] = await exited;
    if (code !== 0)
      throw new Error(`Docker/pg_restore failed with exit code ${code ?? 'unknown'}.`);
  } catch (error) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw error;
  }
}

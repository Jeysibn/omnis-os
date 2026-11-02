import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidMetrics, metricsMatch, metricsQuery } from './metrics.mjs';
import {
  aclSnapshotQuery,
  assertRestoreDatabaseClosed,
  assertRuntimeAclPolicy,
  restoreAclSnapshotsMatch,
} from './acl-integrity.mjs';
import { assertRestoreRoleSecurity, restoreRoleSecurityQuery } from './role-integrity.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const legacyRestoreAclScript = path.join(
  repositoryRoot,
  'scripts/db-recovery/restore-legacy-acls.sql',
);
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
if (process.env.OMNIS_TRUSTED_ARCHIVE_ACKNOWLEDGED !== 'true') {
  throw new Error(
    'This verifier accepts only operator-vetted trusted archives. Its digest is not authentication; do not restore untrusted archives or use this path in production.',
  );
}
if (
  process.env.OMNIS_RESTORE_TEST_FAIL_CLEANUP === 'true' &&
  process.env.OMNIS_R1G3_DISPOSABLE !== 'true'
) {
  throw new Error(
    'Restore cleanup failure injection is allowed only for disposable integration tests.',
  );
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
  !['postgres-custom', 'postgres-custom-acl-v1'].includes(manifest.format) ||
  manifest.sourceDatabase !== sourceDatabase ||
  manifest.dumpBytes !== archiveInfo.size ||
  manifest.dumpSha256 !== (await sha256(archivePath)) ||
  !manifest.snapshotMetrics ||
  manifest.snapshotMetrics.unsafeRunStates !== 0 ||
  (manifest.format === 'postgres-custom-acl-v1' && !Array.isArray(manifest.aclSnapshot))
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
const restoreMarker = randomBytes(16).toString('hex');
const unverifiedComment = `omnis-restore:${restoreMarker}:unverified`;
let targetCreated = false;
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
    `CREATE DATABASE "${targetDatabase}" TEMPLATE template0 ALLOW_CONNECTIONS=false`,
  ]);
  targetCreated = true;

  // The database is born closed. Only the migrator can connect while the archive is applied.
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
    `COMMENT ON DATABASE "${targetDatabase}" IS '${unverifiedComment}'; REVOKE CONNECT ON DATABASE "${targetDatabase}" FROM PUBLIC, omnis_runtime; GRANT CONNECT, CREATE ON DATABASE "${targetDatabase}" TO omnis_migrator; ALTER DATABASE "${targetDatabase}" ALLOW_CONNECTIONS=true;`,
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
      '--username=omnis',
      `--dbname=${targetDatabase}`,
    ],
    archivePath,
  );

  if (manifest.format === 'postgres-custom') {
    await dockerFromFile(
      [
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
        '--file=-',
      ],
      legacyRestoreAclScript,
    );
  }

  const restoredAclText = await dockerOutput([
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
    aclSnapshotQuery,
  ]);
  const restoredAclSnapshot = JSON.parse(restoredAclText.trim());
  assertRestoreDatabaseClosed(restoredAclSnapshot);
  assertRuntimeAclPolicy(restoredAclSnapshot);
  if (
    manifest.format === 'postgres-custom-acl-v1' &&
    !restoreAclSnapshotsMatch(manifest.aclSnapshot, restoredAclSnapshot)
  ) {
    throw new Error('Restored PostgreSQL ACLs do not match the source ACL snapshot.');
  }

  const roleSecurityText = await dockerOutput([
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
    restoreRoleSecurityQuery,
  ]);
  assertRestoreRoleSecurity(JSON.parse(roleSecurityText.trim()));

  const restoredText = await dockerOutput([
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
  const restored = JSON.parse(restoredText.trim());
  if (!metricsMatch(manifest.snapshotMetrics, restored) || restored.unsafeRunStates !== 0) {
    throw new Error(
      'Restored database failed count, sequence, runtime, active-run, or schema invariants.',
    );
  }

  const probeTitle = `Restore verification task ${targetDatabase}_${randomBytes(8).toString('hex')}`;
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
    `SET ROLE omnis_runtime;
     DO $restore_probe$
     DECLARE task_identifier text; run_identifier text;
     BEGIN
       INSERT INTO omnis.tasks (id, title, detail)
       VALUES ('task-' || lpad(nextval('omnis.task_id_seq')::text, 4, '0'),
         '${probeTitle}', 'Committed synthetic post-restore verification.')
       RETURNING id INTO task_identifier;
       INSERT INTO omnis.runs (id, task_id, task_title)
       VALUES ('run-' || lpad(nextval('omnis.run_id_seq')::text, 4, '0'),
         task_identifier, '${probeTitle}')
       RETURNING id INTO run_identifier;
       UPDATE omnis.runs SET status = 'completed' WHERE id = run_identifier;
     END
     $restore_probe$;
     RESET ROLE;`,
  ]);

  const probeText = await dockerOutput([
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
    `SELECT json_build_object(
       'taskId', task.id,
       'runId', run.id,
       'status', run.status,
       'runtimeKind', run.runtime_kind,
       'synthetic', run.synthetic
     )
     FROM omnis.tasks task
     JOIN omnis.runs run ON run.task_id = task.id
     WHERE task.title = '${probeTitle}' AND run.task_title = '${probeTitle}'`,
  ]);
  const probe = JSON.parse(probeText.trim());
  if (
    !/^task-[0-9]+$/.test(probe.taskId) ||
    !/^run-[0-9]+$/.test(probe.runId) ||
    probe.status !== 'completed' ||
    probe.runtimeKind !== 'mock' ||
    probe.synthetic !== true
  ) {
    throw new Error('Restricted runtime could not persist a safe post-restore task and run.');
  }

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
  assertValidMetrics(report);
  if (
    report.tasks !== manifest.snapshotMetrics.tasks + 1 ||
    report.runs !== manifest.snapshotMetrics.runs + 1 ||
    report.events !== manifest.snapshotMetrics.events ||
    report.idempotencyRecords !== manifest.snapshotMetrics.idempotencyRecords ||
    report.unsafeRunStates !== 0
  ) {
    throw new Error('Post-restore task/run creation changed unexpected data or left active work.');
  }

  // Publish the verified state and open runtime access atomically. A crash before COMMIT leaves
  // the target unavailable to runtime clients and visibly marked unverified.
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
    `BEGIN; GRANT CONNECT ON DATABASE "${targetDatabase}" TO omnis_runtime; COMMENT ON DATABASE "${targetDatabase}" IS 'omnis-restore:${restoreMarker}:verified'; COMMIT;`,
  ]);

  process.stdout.write(
    `Restore verified in isolated database ${targetDatabase}; source counts and fingerprints matched before the runtime probe: ${JSON.stringify(restored)}\n` +
      `Post-restore runtime ACL policy passed; ${manifest.format === 'postgres-custom-acl-v1' ? 'source/restored ACL comparison matched' : 'legacy ACL-free baseline was rebuilt securely'}.\n` +
      `Restore and validation duration: ${Number(process.hrtime.bigint() - restoreStartedAt) / 1_000_000} ms.\n` +
      `Restricted runtime durably created task ${probe.taskId} and completed mock run ${probe.runId}; post-insert sequence invariants passed. No worker was started against the target.\n`,
  );
} catch (error) {
  if (!targetCreated) throw error;
  try {
    const disposition = await containFailedRestoreTarget(targetDatabase, restoreMarker);
    process.stderr.write(
      `Restore rejected. The target ${targetDatabase} was ${disposition}; no restored data or credentials were printed.\n`,
    );
  } catch (containmentError) {
    process.stderr.write(
      `CRITICAL: restore rejected and automatic cleanup did not complete for ${targetDatabase}. The target remains quarantined if the quarantine step succeeded; do not connect clients. Inspect it using the documented recovery procedure.\n`,
    );
    throw new AggregateError(
      [error, containmentError],
      'Restore failed and cleanup requires operator action.',
      { cause: containmentError },
    );
  }
  throw error;
}

async function containFailedRestoreTarget(database, marker) {
  const statusText = await dockerOutput([
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
    `SELECT COALESCE(shobj_description(oid, 'pg_database'), '') || '|' || datallowconn::text || '|' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${database}'`,
  ]);
  if (statusText.trim() === '') return 'already absent';
  const [ownership, allowConnections, owner] = statusText.trim().split('|');
  if (ownership !== `omnis-restore:${marker}:unverified`) {
    if (allowConnections === 'false' && owner === 'omnis')
      return 'quarantined (connections remain disabled)';
    throw new Error(
      'Restore target ownership marker was absent or changed; refusing to alter or delete it.',
    );
  }

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
    `ALTER DATABASE "${database}" ALLOW_CONNECTIONS=false; REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC, omnis_runtime, omnis_migrator; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();`,
  ]);

  if (process.env.OMNIS_RESTORE_TEST_FAIL_CLEANUP === 'true') {
    throw new Error('Injected failure after restore-target quarantine.');
  }

  await dockerChecked([
    ...composeArgs,
    'exec',
    '-T',
    'postgres',
    'dropdb',
    '--force',
    '--no-password',
    '--username=omnis',
    '--maintenance-db=postgres',
    database,
  ]);
  return 'quarantined and removed';
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
    if (output.length > 4 * 1024 * 1024) child.kill('SIGKILL');
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

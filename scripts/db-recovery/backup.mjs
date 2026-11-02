import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBackupSafe, metricsQuery, parseMetrics } from './metrics.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const composeArgs = createComposeArgs();

const [outputArgument] = process.argv.slice(2);
if (!outputArgument || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/db-recovery/backup.mjs <private-output-file.dump>');
}
const sourceDatabase = process.env.OMNIS_BACKUP_DATABASE ?? 'omnis';
if (!/^omnis(?:_[a-z0-9_]+)?$/.test(sourceDatabase)) {
  throw new Error(
    'OMNIS_BACKUP_DATABASE must be an Omnis database name such as omnis or omnis_r1g3_test.',
  );
}

const outputPath = path.resolve(outputArgument);
const manifestPath = `${outputPath}.manifest.json`;
assertOutsideRepository(outputPath);
const parentPath = path.dirname(outputPath);
await mkdir(parentPath, { recursive: true, mode: 0o700 });
assertOutsideRepository(await realpath(parentPath));
const parentInfo = await stat(parentPath);
if (!parentInfo.isDirectory() || (parentInfo.mode & 0o077) !== 0) {
  throw new Error('Backup directory must be private (mode 0700 or stricter).');
}
if (!outputPath.endsWith('.dump')) throw new Error('Backup output must use the .dump extension.');

let createdOutput = false;
let createdManifest = false;
let exportedSnapshot;
try {
  const exporter = await startSnapshotExport(sourceDatabase);
  exportedSnapshot = exporter;

  const file = await open(
    outputPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  await file.close();
  createdOutput = true;
  await chmod(outputPath, 0o600);

  await dockerToFile(
    [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--no-acl',
      `--snapshot=${exporter.snapshot}`,
      '--username=omnis',
      `--dbname=${sourceDatabase}`,
    ],
    outputPath,
  );

  const sourceReport = await querySnapshotMetrics(sourceDatabase, exporter.snapshot);
  assertBackupSafe(sourceReport);
  await finishSnapshotExport(exporter);
  exportedSnapshot = undefined;

  const descriptor = await open(outputPath, 'r');
  const magic = Buffer.alloc(5);
  await descriptor.read(magic, 0, magic.length, 0);
  await descriptor.close();
  if (magic.toString('ascii') !== 'PGDMP') {
    throw new Error('pg_dump did not produce a PostgreSQL custom-format archive.');
  }

  await fileToDocker(
    [...composeArgs, 'exec', '-T', 'postgres', 'pg_restore', '--list'],
    outputPath,
  );

  const fileInfo = await lstat(outputPath);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || (fileInfo.mode & 0o077) !== 0) {
    throw new Error('Backup artifact must be a private regular file.');
  }
  const hash = await sha256(outputPath);
  const manifest = {
    format: 'postgres-custom',
    sourceDatabase,
    dumpBytes: fileInfo.size,
    dumpSha256: hash,
    snapshotMetrics: sourceReport,
  };
  const manifestFile = await open(
    manifestPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  createdManifest = true;
  await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await manifestFile.close();
  await chmod(manifestPath, 0o600);
  process.stdout.write(
    `Backup verified: ${path.basename(outputPath)} (${fileInfo.size} bytes, sha256 ${hash}); private count manifest written.\n`,
  );
} catch (error) {
  if (exportedSnapshot) await finishSnapshotExport(exportedSnapshot).catch(() => undefined);
  if (createdManifest) await unlink(manifestPath).catch(() => undefined);
  if (createdOutput) await unlink(outputPath).catch(() => undefined);
  throw error;
}

async function startSnapshotExport(database) {
  const child = spawn(
    '/usr/bin/docker',
    [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-X',
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '--username=omnis',
      `--dbname=${database}`,
    ],
    { cwd: repositoryRoot, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stdin.on('error', () => undefined);
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 2_000) stderr += chunk.toString('utf8');
  });
  const closed = once(child, 'close');
  child.stdin.write(
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n',
  );
  const snapshot = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out creating a PostgreSQL backup snapshot.'));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const candidate = output
        .split(/\r?\n/)
        .find((line) => /^[0-9A-F]+-[0-9A-F]+-[0-9A-F]+$/i.test(line.trim()));
      if (candidate) {
        clearTimeout(timer);
        resolve(candidate.trim());
      }
    });
    closed.then(([code]) => {
      clearTimeout(timer);
      reject(
        new Error(
          `PostgreSQL snapshot export failed with exit code ${code ?? 'unknown'} (${stderr.length ? 'details redacted' : 'no details'}).`,
        ),
      );
    });
  });
  return { child, closed, snapshot };
}

async function finishSnapshotExport(exporter) {
  if (exporter.child.exitCode !== null || exporter.child.signalCode !== null) return;
  exporter.child.stdin.end('COMMIT;\n\\q\n');
  const [code] = await exporter.closed;
  if (code !== 0) throw new Error('Could not close the PostgreSQL snapshot transaction cleanly.');
}

async function querySnapshotMetrics(database, snapshot) {
  const sql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '${snapshot}';
${metricsQuery}
COMMIT;`;
  const result = await dockerOutput([
    ...composeArgs,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--set=ON_ERROR_STOP=1',
    '--username=omnis',
    `--dbname=${database}`,
    '--command',
    sql,
  ]);
  return parseMetrics(result);
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

async function dockerToFile(args, destination) {
  const child = spawn('/usr/bin/docker', args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  child.stderr?.resume();
  try {
    await pipeline(child.stdout, createWriteStream(destination, { flags: 'w', mode: 0o600 }));
    const [code] = await exited;
    if (code !== 0) throw new Error(`Docker/pg_dump failed with exit code ${code ?? 'unknown'}.`);
  } catch (error) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw error;
  }
}

async function fileToDocker(args, inputPath) {
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
      throw new Error(`Docker/pg_restore validation failed with exit code ${code ?? 'unknown'}.`);
  } catch (error) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw error;
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function assertOutsideRepository(filePath) {
  const relative = path.relative(repositoryRoot, filePath);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    throw new Error('Backups must be stored outside the repository.');
  }
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

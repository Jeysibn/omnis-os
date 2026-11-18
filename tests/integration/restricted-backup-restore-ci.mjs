import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aclSnapshotQuery, aclSnapshotsMatch } from '../../scripts/db-recovery/acl-integrity.mjs';
import { metricsMatch, metricsQuery, parseMetrics } from '../../scripts/db-recovery/metrics.mjs';

const project = 'omnis-os-restricted-dev';
const database = 'omnis_restricted_dev';
const context = 'default';
const endpoint = 'unix:///var/run/docker.sock';
const hosted =
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
assert.ok(
  hosted || process.env.OMNIS_TEST_RESTRICTED_RECOVERY === '1',
  'Use a disposable hosted runner or explicitly opt in on a disposable local Docker fixture.',
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(OMNIS_|PG|DATABASE_URL$)/.test(name)),
);
assert.ok(!env.DOCKER_HOST && !env.DOCKER_CONTEXT && !env.DOCKER_CONFIG);
const directory = await mkdtemp(join(tmpdir(), 'omnis-restricted-recovery-ci-'));
const compose = join(directory, 'compose.env');
const api = join(directory, 'api.env');
const worker = join(directory, 'worker.env');
const bootstrap = join(directory, 'bootstrap.env');
const migration = join(directory, 'migration.env');
const archive = join(directory, 'settled.dump');
const base = [context, endpoint, compose, api, worker];
const adminPassword = randomBytes(32).toString('hex');
const migrationPassword = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex');
const token = randomBytes(32).toString('hex');
const target = 'omnis_restore_restricted_verified';
let container;

function run(program, args, { allowFailure = false, commandEnv = env } = {}) {
  const result = spawnSync(program, args, { env: commandEnv, encoding: 'utf8', timeout: 240_000 });
  const output = result.stdout?.trim() ?? '';
  const diagnostics = result.stderr?.trim() ?? '';
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Disposable recovery command failed (${program}, exit ${result.status}): ${diagnostics
        .replaceAll(adminPassword, '[redacted]')
        .replaceAll(migrationPassword, '[redacted]')
        .replaceAll(runtimePassword, '[redacted]')
        .replaceAll(token, '[redacted]')}`,
    );
  }
  return { status: result.status, output, diagnostics };
}

function docker(...args) {
  return run('docker', ['--host', endpoint, ...args]).output;
}

function requireImage(image) {
  const result = run(
    'docker',
    ['--host', endpoint, 'image', 'inspect', '--format', '{{.Id}}', image],
    { allowFailure: true },
  );
  if (result.status !== 0) docker('pull', image);
}

function wrapper(...args) {
  return run('bash', ['scripts/compose/restricted-compose.sh', ...base, ...args]).output;
}

function sql(db, statement) {
  return docker(
    'exec',
    '--user',
    'postgres',
    container,
    'psql',
    '-XqAt',
    '--set=ON_ERROR_STOP=1',
    '--username=omnis',
    `--dbname=${db}`,
    '-c',
    statement,
  );
}

function recovery(
  action,
  args,
  { allowFailure = false, cluster = systemId, commandEnv = env } = {},
) {
  return run(
    process.execPath,
    ['scripts/db-recovery/restricted-recovery.mjs', action, ...base, container, cluster, ...args],
    { allowFailure, commandEnv },
  );
}

function privateFile(file, contents) {
  return writeFile(file, contents, { mode: 0o600, flag: 'wx' });
}

function projects(kind) {
  return docker(kind, 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`);
}

function targetState(db) {
  return sql(
    'postgres',
    `SELECT datallowconn::text || '|' || datconnlimit || '|' ||
    COALESCE(shobj_description(oid, 'pg_database'),'')
    FROM pg_database WHERE datname = '${db}'`,
  );
}

let systemId;
try {
  run('bash', ['scripts/compose/verify-docker-context.sh', context, endpoint]);
  assert.equal(
    docker('ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`),
    '',
  );
  assert.equal(projects('volume'), '');
  assert.equal(projects('network'), '');
  const conflicts = docker(
    'volume',
    'ls',
    '--quiet',
    '--filter',
    `name=${project}_omnis-postgres-data`,
  );
  assert.equal(conflicts, '');
  assert.equal(docker('network', 'ls', '--quiet', '--filter', `name=${project}_`), '');

  await privateFile(
    compose,
    [
      `OMNIS_RESTRICTED_DB_NAME=${database}`,
      `OMNIS_DB_PASSWORD=${adminPassword}`,
      `OMNIS_RESTRICTED_API_ENV_FILE=${api}`,
      `OMNIS_RESTRICTED_WORKER_ENV_FILE=${worker}`,
    ].join('\n') + '\n',
  );
  await privateFile(
    api,
    [
      `OMNIS_OWNER_PASSWORD_HASH=${'a'.repeat(32)}:${'b'.repeat(128)}`,
      `OMNIS_SESSION_SECRET=${randomBytes(32).toString('hex')}`,
      `OMNIS_INTERNAL_TOKEN=${token}`,
      'OMNIS_ALLOWED_ORIGIN=http://127.0.0.1:8080',
      'OMNIS_SECURE_COOKIES=false',
    ].join('\n') + '\n',
  );
  await privateFile(
    worker,
    `OMNIS_INTERNAL_TOKEN=${token}\nOMNIS_RUNTIME_DB_PASSWORD=${runtimePassword}\n`,
  );

  wrapper('config', '--quiet');
  const image =
    'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94';
  requireImage(image);
  wrapper('up', '--no-build', '--pull', 'never', '-d', 'postgres');
  container = docker(
    'ps',
    '--all',
    '--no-trunc',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  );
  assert.match(container, /^[a-f0-9]{64}$/);
  const deadline = Date.now() + 60_000;
  while (docker('inspect', '--format', '{{.State.Health.Status}}', container) !== 'healthy') {
    assert.ok(Date.now() < deadline, 'PostgreSQL fixture startup timed out.');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  systemId = sql(database, 'SELECT system_identifier::text FROM pg_control_system();');
  assert.match(systemId, /^[0-9]+$/);
  const locked =
    [
      'OMNIS_RESTRICTED_DEVELOPMENT=true',
      'OMNIS_EXECUTION_MODE=disabled',
      `OMNIS_RESTRICTED_COMPOSE_PROJECT=${project}`,
      `OMNIS_RESTRICTED_DB_NAME=${database}`,
      `OMNIS_RESTRICTED_PG_SYSTEM_IDENTIFIER=${systemId}`,
      `OMNIS_RESTRICTED_MIGRATION_DATABASE_URL=postgresql://omnis_migrator:${migrationPassword}@127.0.0.1:5432/${database}`,
    ].join('\n') + '\n';
  await privateFile(
    bootstrap,
    locked +
      `OMNIS_RESTRICTED_ADMIN_DATABASE_URL=postgresql://omnis:${adminPassword}@127.0.0.1:5432/${database}\n` +
      `OMNIS_RESTRICTED_MIGRATOR_PASSWORD=${migrationPassword}\nOMNIS_RESTRICTED_RUNTIME_PASSWORD=${runtimePassword}\n`,
  );
  await privateFile(migration, locked);
  const bootstrapWorker = join(directory, 'bootstrap-worker.env');
  await privateFile(bootstrapWorker, `OMNIS_RUNTIME_DB_PASSWORD=${runtimePassword}\n`);
  const nodeImage =
    'node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c';
  requireImage(nodeImage);
  // The restricted internal bridge may suppress host publication even when Compose requested it.
  // Use the fixture's own loopback for the same restricted bootstrap/migration CLIs.
  function fixtureNode(...args) {
    docker(
      'run',
      '--rm',
      '--pull=never',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--security-opt=label=disable',
      '--network',
      `container:${container}`,
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--volume',
      `${process.cwd()}:/audit:ro`,
      '--volume',
      `${directory}:/private:ro`,
      '--workdir',
      '/audit',
      nodeImage,
      'node',
      ...args,
    );
  }
  fixtureNode(
    'packages/db/src/provision-restricted.ts',
    'roles',
    '--bootstrap-env',
    '/private/bootstrap.env',
    '--worker-env',
    '/private/bootstrap-worker.env',
  );
  fixtureNode('apps/worker/src/migrate-restricted.ts', '--migration-env', '/private/migration.env');
  sql(
    database,
    `BEGIN;
    SET SESSION AUTHORIZATION omnis_runtime;
    SELECT omnis.acquire_mission_lane_admission(true, 3000);
    RESET SESSION AUTHORIZATION;
    INSERT INTO omnis.tasks (id,title,detail,status)
      VALUES ('task-20','Synthetic archive fixture','Settled fixture','open');
    INSERT INTO omnis.runs (id,task_id,task_title,status,runtime_kind,synthetic,usage,last_event_sequence)
      VALUES ('run-29','task-20','Synthetic archive fixture','interrupted','mock',true,
        '{"quality":"unknown","inputTokens":null,"outputTokens":null,"cost":null}',1);
    INSERT INTO omnis.run_events (id,run_id,sequence,event_type,source,synthetic,message)
      VALUES ('fixture-event','run-29',1,'run.interrupted','mock',true,'Synthetic fixture settled');
    SELECT setval('omnis.task_id_seq',41,true), setval('omnis.run_id_seq',43,false);
    COMMIT;`,
  );
  const priorMetrics = parseMetrics(sql(database, metricsQuery));
  const priorAcl = JSON.parse(sql(database, aclSnapshotQuery));
  assert.equal(priorMetrics.tasks, 1);
  assert.equal(priorMetrics.runs, 1);
  assert.equal(priorMetrics.events, 1);

  const backup = recovery('backup', [archive]).output;
  const [, digest] = /Restricted manifest SHA-256: ([a-f0-9]{64})/.exec(backup) ?? [];
  assert.ok(digest);
  printTiming(backup);
  const app = docker(
    'create',
    '--pull=never',
    '--label',
    `com.docker.compose.project=${project}`,
    '--label',
    'com.docker.compose.service=worker',
    '--entrypoint',
    'sleep',
    nodeImage,
    '300',
  );
  try {
    assert.equal(docker('inspect', '--format', '{{.State.Status}}', app), 'created');
    docker('start', app);
    docker('pause', app);
    assert.equal(docker('inspect', '--format', '{{.State.Status}}', app), 'paused');
    const listed = docker(
      'ps',
      '--all',
      '--no-trunc',
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    );
    assert.ok(listed.split('\n').includes(app));
    for (const state of ['paused', 'restarting']) {
      let commandEnv = env;
      if (state === 'restarting') {
        // Keep the real daemon inventory; substitute only the paused fixture's inspected state.
        await writeFile(
          join(directory, 'docker'),
          String.raw`#!/bin/sh
if [ "$3" = inspect ] && [ "$4" = --type ]; then
  result=$(/usr/bin/docker "$@") || exit $?
  printf '%s\n' "$result" | sed '/^${app}|/s/|paused|true|true|false|/|restarting|true|false|true|/'
else
  exec /usr/bin/docker "$@"
fi
`,
          { mode: 0o700, flag: 'wx' },
        );
        commandEnv = { ...env, PATH: `${directory}:${env.PATH}` };
        const inspected = run(
          'docker',
          [
            '--host',
            endpoint,
            'inspect',
            '--type',
            'container',
            '--format',
            '{{.Id}}|service|{{.State.Status}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Restarting}}|tail',
            app,
          ],
          { commandEnv },
        ).output;
        assert.match(inspected, /[|]restarting[|]true[|]false[|]true[|]/);
      }
      const rejectedArchive = join(directory, `${state}.dump`);
      for (const [action, args] of [
        ['backup', [rejectedArchive]],
        ['restore', [archive, `omnis_restore_${state}`, digest]],
      ]) {
        const result = recovery(action, args, { allowFailure: true, commandEnv });
        assert.equal(result.status, 1);
        assert.match(
          result.diagnostics,
          /restricted context, Compose configuration and PostgreSQL container/,
        );
      }
      await assert.rejects(lstat(rejectedArchive), { code: 'ENOENT' });
      await assert.rejects(lstat(`${rejectedArchive}.manifest.json`), { code: 'ENOENT' });
      assert.equal(targetState(`omnis_restore_${state}`), '');
      process.stdout.write(
        `Rejected ${state} application before backup publication or restore database creation.\n`,
      );
    }
  } finally {
    run('docker', ['--host', endpoint, 'unpause', app], { allowFailure: true });
    docker('container', 'rm', '-f', app);
  }
  const restored = recovery('restore', [archive, target, digest]).output;
  printTiming(restored);
  assert.match(targetState(target), /^false\|0\|omnis-restricted-restore:[a-f0-9]+:verified$/);
  // Inspect the isolated fixture as admin only. Connection limit remains zero.
  sql('postgres', `ALTER DATABASE ${target} ALLOW_CONNECTIONS true`);
  try {
    const metrics = parseMetrics(sql(target, metricsQuery));
    assert.ok(metricsMatch(priorMetrics, metrics));
    assert.deepEqual(metrics.idSequences, priorMetrics.idSequences);
    assert.ok(aclSnapshotsMatch(priorAcl, JSON.parse(sql(target, aclSnapshotQuery))));
    assert.equal(
      sql(
        target,
        `SELECT count(*) FROM pg_roles WHERE rolname IN
      ('omnis_authorizer','omnis_launcher') AND NOT rolcanlogin AND NOT rolsuper`,
      ),
      '2',
    );
    const runtime = run(
      'docker',
      [
        '--host',
        endpoint,
        'exec',
        '--user',
        'postgres',
        container,
        'psql',
        '-XqAt',
        '--username=omnis_runtime',
        `--dbname=${target}`,
        '-c',
        'SELECT 1',
      ],
      { allowFailure: true },
    );
    assert.notEqual(runtime.status, 0);
    assert.match(runtime.diagnostics, /too many connections for database/);
  } finally {
    sql('postgres', `ALTER DATABASE ${target} ALLOW_CONNECTIONS false`);
  }

  function expectRejected(args, stage, name, options = {}) {
    const result = recovery('restore', args, { allowFailure: true, ...options });
    assert.notEqual(result.status, 0);
    assert.match(result.diagnostics, stage);
    assert.equal(targetState(name), '');
  }
  const badChecksum = join(directory, 'checksum.dump');
  await copyFile(archive, badChecksum);
  await copyFile(`${archive}.manifest.json`, `${badChecksum}.manifest.json`);
  const altered = await open(badChecksum, 'r+');
  try {
    const byte = Buffer.alloc(1);
    await altered.read(byte, 0, 1, 30);
    byte[0] ^= 1;
    await altered.write(byte, 0, 1, 30);
  } finally {
    await altered.close();
  }
  const checksumTarget = 'omnis_restore_checksum';
  expectRejected([badChecksum, checksumTarget, digest], /archive checksum/, checksumTarget);
  const clusterTarget = 'omnis_restore_wrong_cluster';
  expectRejected([archive, clusterTarget, digest], /source database, cluster/, clusterTarget, {
    cluster: systemId === '1' ? '2' : '1',
  });
  const roleTarget = 'omnis_restore_wrong_role';
  sql('postgres', 'ALTER ROLE omnis_authorizer LOGIN');
  try {
    expectRejected([archive, roleTarget, digest], /connection role/, roleTarget);
  } finally {
    sql('postgres', 'ALTER ROLE omnis_authorizer NOLOGIN');
  }

  const before = targetState(target);
  const existing = recovery('restore', [archive, target, digest], { allowFailure: true });
  assert.notEqual(existing.status, 0);
  assert.match(existing.diagnostics, /target freshness/);
  assert.equal(targetState(target), before);

  const mismatched = join(directory, 'wrong-metrics.dump');
  await copyFile(archive, mismatched);
  const manifest = JSON.parse(await readFile(`${archive}.manifest.json`, 'utf8'));
  manifest.source.metrics.recordFingerprints.tasks = '0'.repeat(32);
  const changedManifest = JSON.stringify(manifest);
  await privateFile(`${mismatched}.manifest.json`, changedManifest);
  const changedDigest = createHash('sha256').update(changedManifest).digest('hex');
  const failedTarget = 'omnis_restore_failed_validation';
  const failed = recovery('restore', [mismatched, failedTarget, changedDigest], {
    allowFailure: true,
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.diagnostics, /retained in quarantine after restore verification/);
  assert.match(
    targetState(failedTarget),
    /^false\|0\|omnis-restricted-restore:[a-f0-9]+:quarantined$/,
  );
  assert.equal(targetState(target), before);
  assert.deepEqual(parseMetrics(sql(database, metricsQuery)), priorMetrics);
  assert.ok(aclSnapshotsMatch(priorAcl, JSON.parse(sql(database, aclSnapshotQuery))));
  process.stdout.write(
    'Restricted recovery rehearsal passed, including source and existing-target preservation.\n',
  );
} finally {
  if (container) {
    assert.equal(
      docker(
        'inspect',
        '--format',
        '{{index .Config.Labels "com.docker.compose.project"}}',
        container,
      ),
      project,
    );
    docker('container', 'rm', '-f', container);
    for (const name of projects('network').split('\n').filter(Boolean))
      docker('network', 'rm', name);
    for (const name of projects('volume').split('\n').filter(Boolean)) docker('volume', 'rm', name);
  }
  await rm(directory, { recursive: true, force: true });
}

function printTiming(output) {
  const timing = output
    .split('\n')
    .find((line) => /^Restricted (backup|restore) completed in \d+ ms\.$/.test(line));
  assert.ok(timing);
  process.stdout.write(`${timing}\n`);
}

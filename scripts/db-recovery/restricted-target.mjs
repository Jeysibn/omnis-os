import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const composeFiles = [
  'docker-compose.yml',
  'docker-compose.app.yml',
  'docker-compose.restricted-dev.yml',
]
  .map((file) => realpathSync(join(repository, 'infra/compose', file)))
  .join(',');
export const project = 'omnis-os-restricted-dev';
export const sourceDatabase = 'omnis_restricted_dev';

export function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
    ...options,
  });
  if (result.status !== 0) throw new Error('Restricted recovery command failed.');
  return result.stdout?.trim();
}

export function restrictedTarget([context, endpoint, compose, api, worker, container, systemId]) {
  if (!/^[a-f0-9]{64}$/.test(container) || !/^[1-9][0-9]{0,19}$/.test(systemId)) {
    throw new Error('Supply the full PostgreSQL container ID and system identifier.');
  }

  function checkContext() {
    command('bash', ['scripts/compose/verify-docker-context.sh', context, endpoint]);
  }

  function composeCheck(...args) {
    return command('bash', [
      'scripts/compose/restricted-compose.sh',
      context,
      endpoint,
      compose,
      api,
      worker,
      ...args,
    ]);
  }

  composeCheck('config', '--quiet');
  function verify() {
    checkContext();
    const ids = command('docker', [
      '--host',
      endpoint,
      'ps',
      '--all',
      '--no-trunc',
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ]).split('\n');
    if (!ids.includes(container) || !ids.every((id) => /^[a-f0-9]{64}$/.test(id))) {
      throw new Error('Restricted PostgreSQL container is missing from the project inventory.');
    }
    const rows = command('docker', [
      '--host',
      endpoint,
      'inspect',
      '--type',
      'container',
      '--format',
      '{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Restarting}}|{{.State.StartedAt}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}',
      ...ids,
    ]).split('\n');
    let postgresStart;
    for (const [index, row] of rows.entries()) {
      const [id, actualProject, service, state, running, paused, restarting, startedAt, files] =
        row.split('|');
      if (
        id !== ids[index] ||
        actualProject !== project ||
        paused !== 'false' ||
        restarting !== 'false'
      ) {
        throw new Error('Restricted project container identity or state is unsafe.');
      }
      if (id === container) {
        if (
          service !== 'postgres' ||
          state !== 'running' ||
          running !== 'true' ||
          files !== composeFiles ||
          !Number.isFinite(Date.parse(startedAt))
        ) {
          throw new Error('PostgreSQL container did not match the restricted Compose project.');
        }
        postgresStart = startedAt;
      } else if (
        !['api', 'worker', 'web'].includes(service) ||
        !['created', 'exited'].includes(state) ||
        running !== 'false'
      ) {
        throw new Error('Stop the application services and resolve unexpected project containers.');
      }
    }
    if (rows.length !== ids.length || !postgresStart) {
      throw new Error('Incomplete restricted project container inventory.');
    }
    return postgresStart;
  }

  const startedAt = verify();
  function dockerArgs(program, args) {
    if (verify() !== startedAt) throw new Error('PostgreSQL container restarted during recovery.');
    // The explicit socket prevents a context change from redirecting the exec.
    return [
      '--host',
      endpoint,
      'exec',
      '--user',
      'postgres',
      '-i',
      container,
      'env',
      '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'PGCONNECT_TIMEOUT=5',
      program,
      ...args,
    ];
  }

  function pgArgs(database) {
    return [
      '--host=/var/run/postgresql',
      '--no-password',
      '--username=omnis',
      `--dbname=${database}`,
    ];
  }

  function sqlArgs(database, args) {
    return dockerArgs('psql', ['-XqAt', '--set=ON_ERROR_STOP=1', ...pgArgs(database), ...args]);
  }

  function guard(database, extra = 'true') {
    // Database identifiers come only from constants or the validated restore name.
    return `DO $guard$ BEGIN
      IF session_user <> 'omnis' OR current_user <> 'omnis' OR
         NOT current_setting('is_superuser')::boolean OR current_database() <> '${database}' OR
         (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) <> '${systemId}' OR
         NOT COALESCE((${extra}), false) THEN
        RAISE EXCEPTION 'Restricted PostgreSQL identity mismatch';
      END IF;
    END $guard$;`;
  }

  return {
    systemId,
    container,
    guard,
    sql(database, sql, ...conditions) {
      return command(
        'docker',
        sqlArgs(database, ['-c', guard(database, ...conditions), '-c', sql]),
      );
    },
    snapshot() {
      return spawn('docker', sqlArgs(sourceDatabase, []), {
        cwd: repository,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    dump(snapshot, descriptor) {
      command(
        'docker',
        dockerArgs('pg_dump', [
          ...pgArgs(sourceDatabase),
          '--format=custom',
          `--snapshot=${snapshot}`,
        ]),
        { stdio: ['ignore', descriptor, 'ignore'], timeout: 0 },
      );
    },
    archiveList(descriptor) {
      command('docker', dockerArgs('pg_restore', ['--list']), {
        stdio: [descriptor, 'ignore', 'ignore'],
        timeout: 0,
      });
    },
    restore(database, descriptor) {
      command(
        'docker',
        dockerArgs('pg_restore', [...pgArgs(database), '--exit-on-error', '--single-transaction']),
        { stdio: [descriptor, 'ignore', 'ignore'], timeout: 0 },
      );
    },
  };
}

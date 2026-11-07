import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'omnis-compose-config-'));
try {
  const apiEnv = join(directory, 'api.env');
  const workerEnv = join(directory, 'worker.env');
  const composeEnv = join(directory, 'compose.env');
  writeFileSync(
    apiEnv,
    [
      `OMNIS_OWNER_PASSWORD_HASH=${'a'.repeat(32)}:${'b'.repeat(128)}`,
      `OMNIS_SESSION_SECRET=${'s'.repeat(64)}`,
      `OMNIS_INTERNAL_TOKEN=${'i'.repeat(64)}`,
      `OMNIS_API_AUTHORIZER_TOKEN=${'a'.repeat(64)}`,
      'OMNIS_ALLOWED_ORIGIN=https://omnis.example.invalid',
      'OMNIS_SECURE_COOKIES=true',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    workerEnv,
    [
      `OMNIS_INTERNAL_TOKEN=${'i'.repeat(64)}`,
      `OMNIS_RUNTIME_DB_PASSWORD=${'r'.repeat(48)}`,
      'OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    composeEnv,
    [
      'OMNIS_DB_NAME=omnis',
      `OMNIS_DB_PASSWORD=${'d'.repeat(48)}`,
      'OMNIS_WEB_PORT=18080',
      'OMNIS_AUTHORIZER_SOCKET_GID=10101',
      'OMNIS_LAUNCHER_SOCKET_GID=10102',
      `OMNIS_API_ENV_FILE=${apiEnv}`,
      `OMNIS_WORKER_ENV_FILE=${workerEnv}`,
    ].join('\n'),
    { mode: 0o600 },
  );
  const config = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        composeEnv,
        '-f',
        'infra/compose/docker-compose.yml',
        '-f',
        'infra/compose/docker-compose.app.yml',
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  const { api, postgres, web, worker } = config.services;
  assert.ok(api && postgres && web && worker);
  for (const service of [api, worker, web]) {
    assert.equal(service.read_only, true);
    assert.equal(service.privileged ?? false, false);
    assert.ok(service.cap_drop?.includes('ALL'));
    assert.ok(service.security_opt?.includes('no-new-privileges:true'));
    assert.ok(service.pids_limit > 0);
    assert.ok(service.mem_limit);
  }
  assert.equal(api.user, '10001:10001');
  assert.equal(worker.user, '10001:10001');
  assert.equal(web.user, '10001:10001');
  assert.equal(api.stop_grace_period, '30s');
  assert.equal(worker.stop_grace_period, '30s');
  assert.equal(web.stop_grace_period, '5s');
  assert.deepEqual(api.ports ?? [], []);
  assert.deepEqual(worker.ports ?? [], []);
  assert.equal(api.group_add[0], '10101');
  assert.equal(worker.group_add[0], '10102');
  assert.equal(api.environment.OMNIS_API_HOST, '0.0.0.0');
  assert.equal(api.environment.OMNIS_WORKER_HOST, 'worker');
  assert.equal(worker.environment.OMNIS_WORKER_HOST, '0.0.0.0');
  assert.equal(worker.environment.OMNIS_DB_HOST, 'postgres');
  assert.equal(web.environment.OMNIS_API_URL, 'http://api:4100');
  assert.equal(api.environment.OMNIS_SECURE_COOKIES, 'true');
  assert.equal(api.environment.OMNIS_ALLOWED_ORIGIN, 'https://omnis.example.invalid');
  assert.ok(api.environment.OMNIS_API_AUTHORIZER_TOKEN);
  assert.ok(worker.environment.OMNIS_RUNTIME_DB_PASSWORD);
  assert.ok(!Object.hasOwn(worker.environment, 'OMNIS_API_AUTHORIZER_TOKEN'));
  assert.ok(!Object.hasOwn(worker.environment, 'OMNIS_AUTHORIZER_DB_PASSWORD'));
  assert.ok(!Object.hasOwn(api.environment, 'OMNIS_RUNTIME_DB_PASSWORD'));
  assert.equal(web.ports[0].host_ip, '127.0.0.1');
  assert.equal(web.ports[0].published, '18080');
  assert.equal(postgres.ports[0].host_ip, '127.0.0.1');
  assert.equal(config.networks.edge.internal, true);
  assert.equal(config.networks.data.internal, true);
  assert.ok(Object.hasOwn(api.networks, 'edge') && Object.hasOwn(api.networks, 'data'));
  assert.ok(Object.hasOwn(worker.networks, 'data') && !Object.hasOwn(worker.networks, 'edge'));
  assert.ok(Object.hasOwn(web.networks, 'edge') && !Object.hasOwn(web.networks, 'data'));
  assert.ok(Object.hasOwn(postgres.networks, 'data'));
  for (const [service, source, target] of [
    [api, '/run/omnis-authorizer', '/run/omnis-authorizer'],
    [worker, '/run/omnis-sandbox', '/run/omnis-sandbox'],
  ]) {
    assert.equal(service.volumes?.length, 1);
    const [volume] = service.volumes;
    assert.equal(volume.type, 'bind');
    assert.equal(volume.source, source);
    assert.equal(volume.target, target);
    assert.equal(volume.read_only, true);
    assert.ok(!volume.bind || volume.bind.create_host_path === false);
  }

  const composeSource = readFileSync('infra/compose/docker-compose.app.yml', 'utf8');
  assert.equal((composeSource.match(/create_host_path:\s*false/g) ?? []).length, 2);
  assert.ok(!JSON.stringify(config).includes('/var/run/docker.sock'));
  process.stdout.write('Private Compose service topology and privilege settings verified.\n');
} finally {
  rmSync(directory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compose = ['compose', '--file', 'infra/compose/synthetic-egress.yml'];
const secretDir = mkdtempSync(path.join(tmpdir(), 'omnis-synthetic-egress-'));
const tokenFile = path.join(secretDir, 'provider.token');
writeFileSync(tokenFile, 'synthetic-only-egress-canary-00000000000000000000000000000000', {
  mode: 0o444,
});
const env = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  OMNIS_FAKE_PROVIDER_TOKEN_FILE: tokenFile,
};

try {
  const run = spawnSync(
    'docker',
    [
      ...compose,
      'up',
      '--build',
      '--abort-on-container-exit',
      '--exit-code-from',
      'broker-boundary-probe',
    ],
    {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0)
    throw new Error(`Disposable broker network probe failed (exit ${run.status ?? 'signal'}).`);

  const ids = execFileSync(
    'docker',
    [...compose, 'ps', '--all', '--quiet', 'broker-boundary-probe'],
    {
      cwd: root,
      env,
      encoding: 'utf8',
    },
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(ids.length, 1, 'must inspect exactly the completed boundary probe container');
  const container = JSON.parse(
    execFileSync('docker', ['inspect', ids[0]], { cwd: root, env, encoding: 'utf8' }),
  )[0];
  assert.equal(container.Config.User, '10001:10001');
  assert.equal(container.HostConfig.Privileged, false);
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(container.HostConfig.Devices ?? [], []);
  assert.ok(container.HostConfig.CapDrop?.includes('ALL'));
  assert.ok(container.HostConfig.SecurityOpt?.includes('no-new-privileges:true'));
  assert.ok(
    container.Mounts.every(
      (mount) =>
        mount.Type === 'tmpfs' ||
        ['/probe/egress-probe.mjs', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf'].includes(
          mount.Destination,
        ),
    ),
  );
  assert.ok(
    container.Mounts.every(
      (mount) =>
        !mount.Source.includes('docker.sock') && !mount.Destination.includes('docker.sock'),
    ),
  );
  const network = Object.values(container.NetworkSettings.Networks)[0];
  const networkInspect = JSON.parse(
    execFileSync('docker', ['network', 'inspect', network.NetworkID], {
      cwd: root,
      env,
      encoding: 'utf8',
    }),
  )[0];
  assert.equal(networkInspect.Internal, true);
  const networkPeers = Object.values(networkInspect.Containers);
  assert.ok(
    networkPeers.every(({ Name }) =>
      [
        'omnis-synthetic-egress-fake-provider-1',
        'omnis-synthetic-egress-private-service-canary-1',
      ].includes(Name),
    ),
    'internal broker network has no unexpected service peers',
  );
  process.stdout.write(
    'PASS runtime container metadata: non-root, no capabilities/devices/Docker socket, read-only filesystem, internal-only network\n',
  );
} finally {
  spawnSync('docker', [...compose, 'down', '--volumes', '--remove-orphans'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  rmSync(secretDir, { recursive: true, force: true });
}

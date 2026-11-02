import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { DockerSandboxExecutor, SandboxError, SANDBOX_IMAGE_REF } from './docker-sandbox.ts';

const enabled = process.env.OMNIS_SANDBOX_INTEGRATION === '1';

describe(
  'Docker mock sandbox security (requires the approved local Docker daemon)',
  { skip: !enabled, concurrency: 1 },
  () => {
    it('enforces filesystem, credential, identity, resource, process, and network boundaries', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'omnis-sandbox-security-'));
      const sandboxRoot = path.join(root, 'launcher-workspaces');
      const hostOnly = path.join(root, 'host-only');
      const otherRun = path.join(root, 'other-run');
      await mkdir(hostOnly);
      await mkdir(otherRun);
      const hostOnlyFile = path.join(hostOnly, 'host-file.txt');
      const dummyCredential = path.join(hostOnly, 'dummy-credential.txt');
      const otherRunFile = path.join(otherRun, 'unrelated-run.txt');
      await writeFile(hostOnlyFile, 'synthetic host-only fixture');
      await writeFile(dummyCredential, 'synthetic dummy credential');
      await writeFile(otherRunFile, 'synthetic unrelated run fixture');

      const hostLoopback = await listenOnLoopback();
      const postgresLoopback = await listenOnLoopback(5432);
      const peer = await createPeerContainer();
      const runId = `run-${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
      const hostSecretName = `OMNIS_DUMMY_SECRET_${randomUUID().replaceAll('-', '')}`;
      const previousHostSecret = process.env[hostSecretName];
      process.env[hostSecretName] = 'synthetic-test-only-secret';
      const executor = new DockerSandboxExecutor({ workspaceRoot: sandboxRoot });

      try {
        const script = securityProbeScript({
          hostOnlyFile,
          dummyCredential,
          otherRunFile,
          hostPid: process.pid,
          hostSecretName,
          hostLoopbackPort: hostLoopback.port,
          postgresPort: 5432,
          peerIp: peer.ip,
        });
        const result = await executor.execute({
          runId,
          argv: ['node', '-e', script],
          timeoutMs: 10_000,
          signal: new AbortController().signal,
        });
        const observation = JSON.parse(result.stdout.trim()) as Record<string, unknown>;

        assert.equal(result.exitCode, 0);
        assert.equal(observation.uid, process.getuid?.());
        assert.ok(Number(observation.uid) > 0, 'workload must not run as root');
        assert.equal(observation.noNewPrivs, '1');
        assert.equal(observation.seccomp, '2');
        assert.equal(observation.capEff, '0000000000000000');
        assert.equal(observation.capBnd, '0000000000000000');
        assert.equal(observation.rootWriteDenied, true);
        assert.equal(observation.workspaceWriteAllowed, true);
        assert.equal(observation.hostFileDenied, true);
        assert.equal(observation.credentialFileDenied, true);
        assert.equal(observation.otherRunDenied, true);
        assert.equal(observation.dockerSocketAbsent, true);
        assert.equal(observation.hostSecretAbsent, true);
        assert.equal(observation.hostProcessDenied, true);
        assert.equal(observation.privilegeEscalationDenied, true);
        assert.equal(observation.pidsMax, '32');
        assert.equal(observation.memoryMax, String(128 * 1024 * 1024));
        assert.equal(observation.cpuMax, '50000 100000');
        assert.equal(observation.devShmMax, String(16 * 1024 * 1024));

        const network = observation.network as Record<string, boolean>;
        assert.equal(network.publicInternet, false);
        assert.equal(network.sandboxLoopbackHostService, false);
        assert.equal(network.postgres, false);
        assert.equal(network.peerContainer, false);
        assert.equal(network.privateAddress, false);
        assert.equal(network.cloudMetadata, false);
        assert.equal(network.dns, false);
        assert.equal(network.defaultRoute, false);

        const workspaceEntries = await readdir(sandboxRoot).catch(() => []);
        assert.deepEqual(
          workspaceEntries,
          [],
          'per-run workspace and temporary Docker config must be removed',
        );
      } finally {
        if (previousHostSecret === undefined) delete process.env[hostSecretName];
        else process.env[hostSecretName] = previousHostSecret;
        hostLoopback.server?.close();
        postgresLoopback.server?.close();
        await destroyPeerContainer(peer);
        await rm(root, { recursive: true, force: true });
      }
    });

    it('enforces the container pids limit by rejecting excess child processes', async () => {
      const executor = new DockerSandboxExecutor();
      const script = `
      (async () => {
      const { spawn } = require('node:child_process');
      const children = [];
      let denied = false;
      for (let i = 0; i < 80; i += 1) {
        let child;
        try {
          child = spawn('/bin/busybox', ['sleep', '3'], { stdio: 'ignore' });
        } catch (error) {
          if (error.code === 'EAGAIN') {
            denied = true;
            break;
          }
          throw error;
        }
        children.push(child);
        try {
          await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
          });
        } catch (error) {
          if (error.code === 'EAGAIN') {
            denied = true;
            break;
          }
          throw error;
        }
      }
      for (const child of children) if (child.pid) child.kill('SIGKILL');
      await Promise.all(children.filter((child) => child.pid).map((child) => new Promise((resolve) => child.once('close', resolve))));
      console.log(JSON.stringify({ denied, count: children.length }));
      })().catch(() => process.exit(92));
    `;
      const result = await executor.execute({
        runId: nextRunId(),
        argv: ['node', '-e', script],
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      });
      const observation = JSON.parse(result.stdout.trim()) as { denied: boolean };
      assert.equal(observation.denied, true);
    });

    it('observes cgroup CPU throttling during a bounded busy loop', async () => {
      const executor = new DockerSandboxExecutor();
      const script = `
        const fs = require('node:fs');
        const before = fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
        const start = Date.now();
        while (Date.now() - start < 1200) {}
        const after = fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
        const value = (text, key) => Number(text.match(new RegExp('^' + key + ' (\\\\d+)$', 'm'))?.[1] ?? 0);
        console.log(JSON.stringify({ throttledPeriods: value(after, 'nr_throttled') - value(before, 'nr_throttled') }));
      `;
      const result = await executor.execute({
        runId: nextRunId(),
        argv: ['node', '-e', script],
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      });
      const observation = JSON.parse(result.stdout.trim()) as { throttledPeriods: number };
      assert.ok(observation.throttledPeriods > 0, 'cgroup must throttle the busy workload');
    });

    it('terminates a hung workload on timeout and on cancellation', async () => {
      const executor = new DockerSandboxExecutor();
      await assert.rejects(
        executor.execute({
          runId: nextRunId(),
          argv: ['node', '-e', 'while (true) {}'],
          timeoutMs: 700,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof SandboxError && error.code === 'timed_out',
      );

      const controller = new AbortController();
      const execution = executor.execute({
        runId: nextRunId(),
        argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 10_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 500);
      await assert.rejects(
        execution,
        (error: unknown) => error instanceof SandboxError && error.code === 'cancelled',
      );
    });

    it('preserves containers with active leases and removes orphaned run containers', async () => {
      const executor = new DockerSandboxExecutor();
      const controller = new AbortController();
      const runId = nextRunId();
      const execution = executor.execute({
        runId,
        argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 10_000,
        signal: controller.signal,
      });
      try {
        await waitForSandboxRun(runId);
        await executor.cleanupOrphanedContainers(async (candidateIds) =>
          candidateIds.includes(runId) ? [runId] : [],
        );
        assert.ok(await sandboxRunExists(runId), 'active lease container must be preserved');

        await executor.cleanupOrphanedContainers(async () => []);
        await assert.rejects(
          execution,
          (error: unknown) => error instanceof SandboxError && error.code === 'crashed',
        );
        assert.equal(await sandboxRunExists(runId), false);
      } finally {
        controller.abort();
        await execution.catch(() => undefined);
      }
    });

    it('classifies a crashed workload and bounds captured output', async () => {
      const executor = new DockerSandboxExecutor();
      await assert.rejects(
        executor.execute({
          runId: nextRunId(),
          argv: ['node', '-e', 'process.exit(17)'],
          timeoutMs: 5_000,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof SandboxError && error.code === 'crashed',
      );
      await assert.rejects(
        executor.execute({
          runId: nextRunId(),
          argv: ['node', '-e', "process.stdout.write('x'.repeat(70_000))"],
          timeoutMs: 5_000,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof SandboxError && error.code === 'output_limit',
      );
    });

    it('enforces the memory cgroup limit against an oversized allocation', async () => {
      const executor = new DockerSandboxExecutor();
      await assert.rejects(
        executor.execute({
          runId: nextRunId(),
          argv: [
            'node',
            '-e',
            'const buffer = Buffer.alloc(256 * 1024 * 1024); for (let i = 0; i < buffer.length; i += 4096) buffer[i] = 1; console.log("allocated");',
          ],
          timeoutMs: 5_000,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof SandboxError && error.code === 'crashed',
      );
    });

    it('rejects shell commands and unsafe run identifiers before container creation', async () => {
      const executor = new DockerSandboxExecutor();
      await assert.rejects(
        executor.execute({
          runId: nextRunId(),
          argv: ['/bin/sh', '-c', 'id'],
          timeoutMs: 5_000,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof SandboxError && error.code === 'launch_failed',
      );
      await assert.rejects(
        executor.execute({
          runId: 'run-../../tmp',
          argv: ['node', '-e', 'process.exit(0)'],
          timeoutMs: 5_000,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof SandboxError && error.code === 'launch_failed',
      );
    });
  },
);

function nextRunId(): string {
  return `run-${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
}

async function listenOnLoopback(
  port?: number,
): Promise<{ port: number; server?: ReturnType<typeof createServer> }> {
  const server = createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (port === 5432 && error.code === 'EADDRINUSE') {
        resolve({ port: 5432 });
        return;
      }
      reject(new Error('Could not create the loopback security test fixture.'));
    });
    server.listen(port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Loopback fixture did not receive a TCP address.'));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

async function createPeerContainer(): Promise<{ name: string; network: string; ip: string }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const network = `omnis-sandbox-peer-${suffix}`;
  const name = `omnis-sandbox-peer-${suffix}`;
  docker(['network', 'create', '--internal', network]);
  docker([
    'run',
    '--pull=never',
    '--detach',
    '--rm',
    '--name',
    name,
    '--network',
    network,
    '--user',
    '1000:1000',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=16',
    '--memory=64m',
    '--cpus=0.25',
    '--entrypoint',
    'node',
    SANDBOX_IMAGE_REF,
    '-e',
    "require('node:http').createServer((_, response) => response.end('controlled peer fixture')).listen(9999, '0.0.0.0')",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const inspect = docker([
    'inspect',
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    name,
  ]);
  const ip = inspect.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    await destroyPeerContainer({ name, network });
    throw new Error('The controlled peer fixture did not receive an address.');
  }
  return { name, network, ip };
}

async function destroyPeerContainer(peer: { name: string; network: string }): Promise<void> {
  docker(['rm', '--force', peer.name], true);
  docker(['network', 'rm', peer.network], true);
}

function docker(args: string[], allowFailure = false): string {
  const result = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
    cwd: '/tmp',
    env: {
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      PATH: '/usr/bin:/bin',
      HOME: '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error('Docker security test fixture command failed.');
  }
  return result.stdout;
}

async function waitForSandboxRun(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await sandboxRunExists(runId)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the isolated container test fixture.');
}

async function sandboxRunExists(runId: string): Promise<boolean> {
  const rows = docker([
    'ps',
    '--all',
    '--filter',
    'label=com.omnis.os.sandbox=true',
    '--filter',
    'label=com.omnis.os.scope=000000000000000000000000',
    '--format',
    '{{.Label "com.omnis.os.run-id"}}',
  ]);
  return rows.split(/\r?\n/).includes(runId);
}

function securityProbeScript(input: {
  hostOnlyFile: string;
  dummyCredential: string;
  otherRunFile: string;
  hostPid: number;
  hostSecretName: string;
  hostLoopbackPort: number;
  postgresPort: number;
  peerIp: string;
}): string {
  const serialized = JSON.stringify(input);
  return `
    const fs = require('node:fs');
    const net = require('node:net');
    const dns = require('node:dns/promises');
    const fixture = ${serialized};
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const field = (name) => status.match(new RegExp('^' + name + ':\\\\s*(.+)$', 'm'))?.[1]?.trim() ?? '';
    const denied = (action) => { try { action(); return false; } catch { return true; } };
    const canRead = (file) => { try { fs.readFileSync(file); return true; } catch { return false; } };
    const connect = (host, port) => new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      let done = false;
      const finish = (connected) => { if (done) return; done = true; socket.destroy(); resolve(connected); };
      socket.setTimeout(250, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    (async () => {
      let privilegeEscalationDenied = false;
      try { process.setuid(0); } catch { privilegeEscalationDenied = true; }
      let hostProcessDenied = false;
      try { process.kill(fixture.hostPid, 0); } catch { hostProcessDenied = true; }
      let hostSecretAbsent = true;
      try { hostSecretAbsent = process.env[fixture.hostSecretName] === undefined; } catch {}
      let dnsBlocked = false;
      try { await Promise.race([dns.lookup('example.com'), new Promise((_, reject) => setTimeout(() => reject(new Error('dns timeout')), 500))]); }
      catch { dnsBlocked = true; }
      const network = {
        publicInternet: await connect('1.1.1.1', 443),
        sandboxLoopbackHostService: await connect('127.0.0.1', fixture.hostLoopbackPort),
        postgres: await connect('127.0.0.1', fixture.postgresPort),
        peerContainer: await connect(fixture.peerIp, 9999),
        privateAddress: await connect('10.254.254.254', 80),
        cloudMetadata: await connect('169.254.169.254', 80),
        dns: !dnsBlocked,
        defaultRoute: fs.readFileSync('/proc/net/route', 'utf8').trim().split('\\n').slice(1).some((row) => row.trim().split(/\\s+/)[1] === '00000000'),
      };
      const cgroupValue = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
      let workspaceWriteAllowed = false;
      try { fs.writeFileSync('/workspace/inside-workspace.txt', 'allowed'); workspaceWriteAllowed = true; } catch {}
      const rootWriteDenied = denied(() => fs.writeFileSync('/etc/omnis-sandbox-write-denied.txt', 'blocked'));
      console.log(JSON.stringify({
        uid: process.getuid(),
        noNewPrivs: field('NoNewPrivs'),
        seccomp: field('Seccomp'),
        capEff: field('CapEff'),
        capBnd: field('CapBnd'),
        rootWriteDenied,
        workspaceWriteAllowed,
        hostFileDenied: !canRead(fixture.hostOnlyFile),
        credentialFileDenied: !canRead(fixture.dummyCredential),
        otherRunDenied: !canRead(fixture.otherRunFile),
        dockerSocketAbsent: !fs.existsSync('/var/run/docker.sock'),
        hostSecretAbsent,
        hostProcessDenied,
        privilegeEscalationDenied,
        pidsMax: cgroupValue('/sys/fs/cgroup/pids.max'),
        memoryMax: cgroupValue('/sys/fs/cgroup/memory.max'),
        cpuMax: cgroupValue('/sys/fs/cgroup/cpu.max'),
        devShmMax: cgroupValue('/dev/shm/..').length ? '' : String(fs.statfsSync('/dev/shm').bsize * fs.statfsSync('/dev/shm').blocks),
        network,
      }));
    })().catch(() => process.exit(91));
  `;
}

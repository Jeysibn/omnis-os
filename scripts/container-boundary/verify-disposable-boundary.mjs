import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runId = process.env.OMNIS_DOCKER_TEST_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{7,47}$/.test(runId)) {
  throw new Error('OMNIS_DOCKER_TEST_RUN_ID must be a unique lowercase test identifier.');
}
if (process.platform !== 'linux' || process.getuid?.() !== 0) {
  throw new Error('Docker boundary verification requires a disposable Linux CI runner as root.');
}

const apiImage = 'omnis-api:ci';
const workerImage = 'omnis-worker:ci';
const webImage = 'omnis-web-assets:ci';
const label = `com.omnis.docker-boundary.run=${runId}`;
const resourcePrefix = `omnis-boundary-${runId}`;
const root = mkdtempSync(join(tmpdir(), `${resourcePrefix}-`));
const apiSocketDir = join(root, 'api-authorizer');
const workerSocketDir = join(root, 'worker-launcher');
const nodeProbe = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
const socketPath = process.env.OMNIS_PROBE_SOCKET;
if (socketPath) {
  const result = await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('connect', () => socket.end('probe'));
    socket.once('end', () => resolve({ kind: 'connected', response }));
    socket.once('error', (error) => resolve({ kind: 'error', code: error.code }));
    setTimeout(() => { socket.destroy(); resolve({ kind: 'error', code: 'ETIMEDOUT' }); }, 2000).unref();
  });
  process.stdout.write(JSON.stringify(result));
  if (process.env.OMNIS_EXPECT_SOCKET === 'allow') assert.deepEqual(result, { kind: 'connected', response: 'ok' });
  else if (process.env.OMNIS_EXPECT_SOCKET === 'deny') {
    assert.equal(result.kind, 'error');
    if (process.env.OMNIS_EXPECT_SOCKET_ERROR) assert.equal(result.code, process.env.OMNIS_EXPECT_SOCKET_ERROR);
  }
}
if (process.env.OMNIS_PROBE_DIRECTORY) {
  let result;
  try { fs.readdirSync(process.env.OMNIS_PROBE_DIRECTORY); result = 'listed'; }
  catch (error) { result = error.code; }
  process.stdout.write(JSON.stringify({ directory: result }));
  if (process.env.OMNIS_EXPECT_NO_LIST === '1') assert.equal(result, 'EACCES');
}
if (process.env.OMNIS_EXPECT_GROUP || process.env.OMNIS_EXPECT_NO_GROUP) {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const groups = status.match(/^Groups:\\s*(.*)$/m)?.[1]?.trim().split(/\\s+/).filter(Boolean) ?? [];
  if (process.env.OMNIS_EXPECT_GROUP) assert.ok(groups.includes(process.env.OMNIS_EXPECT_GROUP));
  if (process.env.OMNIS_EXPECT_NO_GROUP) assert.ok(!groups.includes(process.env.OMNIS_EXPECT_NO_GROUP));
}
if (process.env.OMNIS_PROBE_WRITE_DIRECTORY) {
  let result;
  try { fs.writeFileSync(process.env.OMNIS_PROBE_WRITE_DIRECTORY + '/probe', 'x'); result = 'writable'; }
  catch (error) { result = error.code; }
  process.stdout.write(JSON.stringify({ mountWrite: result }));
  assert.equal(result, 'EROFS');
}
if (process.env.OMNIS_PROBE_WRITE_ROOT === '1') {
  let result;
  try { fs.writeFileSync('/omnis-boundary-write-probe', 'x'); result = 'writable'; }
  catch (error) { result = error.code; }
  process.stdout.write(JSON.stringify({ rootWrite: result }));
  assert.equal(result, 'EROFS');
}
if (process.env.OMNIS_PROBE_TMP === '1') {
  fs.writeFileSync('/tmp/omnis-boundary-tmp-probe', 'ok');
  fs.unlinkSync('/tmp/omnis-boundary-tmp-probe');
}
if (process.env.OMNIS_PROBE_NETWORK === 'positive') {
  const response = await fetch('http://local-positive:45678/health', { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  process.stdout.write('network-positive-ok');
}
if (process.env.OMNIS_PROBE_NETWORK === 'external-denial') {
  const result = await new Promise((resolve) => {
    const socket = net.createConnection({ host: '1.1.1.1', port: 443 });
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', (error) => resolve(error.code));
    setTimeout(() => { socket.destroy(); resolve('ETIMEDOUT'); }, 3000).unref();
  });
  process.stdout.write(JSON.stringify({ external: result }));
  assert.ok(['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(result), 'external TCP egress was not blocked by the internal Docker network');
}
if (process.env.OMNIS_PROBE_NETWORK === 'other-network-denial') {
  const address = process.env.OMNIS_OTHER_NETWORK_IP;
  const result = await new Promise((resolve) => {
    const socket = net.createConnection({ host: address, port: 45679 });
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', (error) => resolve(error.code));
    setTimeout(() => { socket.destroy(); resolve('ETIMEDOUT'); }, 3000).unref();
  });
  process.stdout.write(JSON.stringify({ otherNetwork: result }));
  assert.ok(['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(result), 'cross-network TCP connection was not denied');
}
if (process.env.OMNIS_PROBE_IDENTITY === '1') {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const groups = status.match(/^Groups:\\s*(.*)$/m)?.[1]?.trim().split(/\\s+/).filter(Boolean) ?? [];
  const capEff = status.match(/^CapEff:\\s*(\\S+)$/m)?.[1];
  const absent = ['/var/run/docker.sock', '/run/docker.sock', '/mnt/c', '/host'].every((path) => !fs.existsSync(path));
  assert.equal(process.getuid(), 10001);
  assert.equal(process.getgid(), 10001);
  assert.deepEqual(groups, []);
  assert.equal(capEff, '0000000000000000');
  assert.equal(absent, true);
  const modules = JSON.parse(process.env.OMNIS_PROBE_MODULES ?? '[]');
  for (const moduleName of modules) await import(moduleName);
  process.stdout.write('identity, capabilities, mount absence, and runtime dependencies verified');
}
`;

const activeServers = new Set();
let signalReceived = false;

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.code ?? `exit ${result.status}`;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .replace(/(password|token|secret|database_url)\s*[=:]\s*[^\s'"`]+/gi, '$1=<redacted>')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 500);
    throw new Error(`Docker command failed (${detail}) for ${args[0] ?? 'unknown'}: ${output}`);
  }
  return result.stdout.trim();
}

function dockerExpectedFailure(args) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    env: process.env,
  });
}

function createOwned(args) {
  const insertion = args.indexOf('--name');
  assert.notEqual(insertion, -1, 'owned container commands must have an explicit name');
  return docker([...args.slice(0, insertion), '--label', label, ...args.slice(insertion)]);
}

function inspectContainer(id) {
  return JSON.parse(docker(['inspect', id]))[0];
}

function probeContainer({
  image = apiImage,
  name,
  network = 'none',
  mounts = [],
  supplementaryGroups = [],
  environment = {},
  script = nodeProbe,
  detach = false,
}) {
  const args = [
    'run',
    ...(detach ? ['--detach'] : ['--rm']),
    '--name',
    name,
    '--label',
    label,
    '--user',
    '10001:10001',
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '64',
    '--memory',
    '128m',
    '--cpus',
    '0.5',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
  ];
  for (const group of supplementaryGroups) args.push('--group-add', String(group));
  for (const mount of mounts) args.push('--mount', mount);
  for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`);
  args.push('--entrypoint', 'node', image, '--input-type=module', '-e', script);
  return docker(args);
}

function createSocketDirectory(path, owner, group) {
  mkdirSync(path, { mode: 0o710 });
  chownSync(path, owner, group);
  chmodSync(path, 0o710);
  const info = lstatSync(path);
  assert.equal(info.uid, owner);
  assert.equal(info.gid, group);
  assert.equal(info.mode & 0o777, 0o710);
}

async function openSyntheticSocket(path, owner, group) {
  const server = net.createServer((socket) => socket.end('ok'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  chownSync(path, owner, group);
  chmodSync(path, 0o660);
  activeServers.add(server);
  const info = lstatSync(path);
  assert.equal(info.isSocket(), true);
  assert.equal(info.uid, owner);
  assert.equal(info.gid, group);
  assert.equal(info.mode & 0o777, 0o660);
  return server;
}

async function closeSyntheticSocket(server, path) {
  if (server) {
    activeServers.delete(server);
    await new Promise((resolve) => server.close(resolve));
  }
  rmSync(path, { force: true });
}

function socketMount(source, target) {
  return `type=bind,src=${source},dst=${target},readonly`;
}

function ownedResourceIds(kind, filters = [label]) {
  const args = kind === 'container' ? ['ps', '-aq'] : ['network', 'ls', '-q'];
  for (const filter of filters) args.push('--filter', `label=${filter}`);
  return docker(args).split('\n').filter(Boolean);
}

function cleanupOwnedResources(filters = [label]) {
  for (const id of ownedResourceIds('container', filters)) {
    const result = spawnSync('docker', ['rm', '-f', id], { encoding: 'utf8', timeout: 15_000 });
    if (result.status !== 0)
      throw new Error('Could not remove a container created by this test run.');
  }
  for (const id of ownedResourceIds('network', filters)) {
    const result = spawnSync('docker', ['network', 'rm', id], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.status !== 0)
      throw new Error('Could not remove a network created by this test run.');
  }
}

function assertRuntimeRestrictions(container) {
  const host = container.HostConfig;
  assert.equal(host.Privileged, false);
  assert.equal(host.ReadonlyRootfs, true);
  assert.ok(host.CapDrop?.includes('ALL'));
  assert.ok(host.SecurityOpt?.some((item) => item.startsWith('no-new-privileges')));
  assert.equal(host.PidsLimit, 64);
  assert.equal(host.Memory, 134217728);
  assert.equal(host.NanoCpus, 500000000);
  assert.deepEqual(host.Binds ?? [], []);
  assert.deepEqual(host.PortBindings ?? {}, {});
  assert.equal(container.Config.User, '10001:10001');
  assert.ok(!JSON.stringify(container.Mounts).includes('/var/run/docker.sock'));
  assert.ok(
    container.Mounts.every((mount) => mount.Type === 'tmpfs' && mount.Destination === '/tmp'),
    'workload containers must not receive host, developer-home, or Windows filesystem mounts',
  );
}

async function verifySocketBoundaries() {
  const authorizerGid = 45002;
  const launcherGid = 45003;
  createSocketDirectory(apiSocketDir, 40002, authorizerGid);
  createSocketDirectory(workerSocketDir, 40003, launcherGid);
  let authorizerServer = await openSyntheticSocket(
    join(apiSocketDir, 'authorizer.sock'),
    40002,
    authorizerGid,
  );
  let launcherServer = await openSyntheticSocket(
    join(workerSocketDir, 'launcher.sock'),
    40003,
    launcherGid,
  );
  const apiContainer = `${resourcePrefix}-api-socket`;
  const workerContainer = `${resourcePrefix}-worker-socket`;
  const apiMount = socketMount(apiSocketDir, '/run/omnis-authorizer');
  const workerMount = socketMount(workerSocketDir, '/run/omnis-launcher');
  const readOnlyDirectory = join(root, 'read-only-control');
  mkdirSync(readOnlyDirectory, { mode: 0o777 });
  chownSync(readOnlyDirectory, 10001, 10001);
  chmodSync(readOnlyDirectory, 0o777);

  probeContainer({
    name: apiContainer,
    supplementaryGroups: [authorizerGid],
    environment: {
      OMNIS_PROBE_SOCKET: '/run/omnis-authorizer/authorizer.sock',
      OMNIS_EXPECT_SOCKET: 'allow',
      OMNIS_EXPECT_GROUP: String(authorizerGid),
      OMNIS_PROBE_DIRECTORY: '/run/omnis-authorizer',
      OMNIS_EXPECT_NO_LIST: '1',
      OMNIS_PROBE_WRITE_DIRECTORY: '/run/read-only-control',
    },
    mounts: [apiMount, socketMount(readOnlyDirectory, '/run/read-only-control')],
  });
  probeContainer({
    name: `${resourcePrefix}-api-denied`,
    mounts: [apiMount],
    environment: {
      OMNIS_PROBE_SOCKET: '/run/omnis-authorizer/authorizer.sock',
      OMNIS_EXPECT_SOCKET: 'deny',
      OMNIS_EXPECT_SOCKET_ERROR: 'EACCES',
      OMNIS_EXPECT_NO_GROUP: String(authorizerGid),
    },
  });
  probeContainer({
    name: `${resourcePrefix}-api-cross-service`,
    mounts: [apiMount],
    environment: {
      OMNIS_PROBE_SOCKET: '/run/omnis-launcher/launcher.sock',
      OMNIS_EXPECT_SOCKET: 'deny',
      OMNIS_EXPECT_SOCKET_ERROR: 'ENOENT',
    },
  });
  probeContainer({
    image: workerImage,
    name: workerContainer,
    mounts: [workerMount],
    supplementaryGroups: [launcherGid],
    environment: {
      OMNIS_PROBE_SOCKET: '/run/omnis-launcher/launcher.sock',
      OMNIS_EXPECT_SOCKET: 'allow',
      OMNIS_EXPECT_GROUP: String(launcherGid),
    },
  });
  probeContainer({
    image: workerImage,
    name: `${resourcePrefix}-worker-denied`,
    mounts: [workerMount],
    environment: {
      OMNIS_PROBE_SOCKET: '/run/omnis-launcher/launcher.sock',
      OMNIS_EXPECT_SOCKET: 'deny',
      OMNIS_EXPECT_SOCKET_ERROR: 'EACCES',
      OMNIS_EXPECT_NO_GROUP: String(launcherGid),
    },
  });
  probeContainer({
    image: workerImage,
    name: `${resourcePrefix}-worker-cross-service`,
    mounts: [workerMount],
    environment: {
      OMNIS_PROBE_SOCKET: '/run/omnis-authorizer/authorizer.sock',
      OMNIS_EXPECT_SOCKET: 'deny',
      OMNIS_EXPECT_SOCKET_ERROR: 'ENOENT',
    },
  });

  const lifecycleContainer = `${resourcePrefix}-socket-lifecycle`;
  probeContainer({
    name: lifecycleContainer,
    mounts: [apiMount],
    supplementaryGroups: [authorizerGid],
    detach: true,
    script: 'setInterval(() => {}, 1000)',
  });
  const execProbe = (path, expected) =>
    docker([
      'exec',
      '--user',
      `10001:${authorizerGid}`,
      '--env',
      `OMNIS_PROBE_SOCKET=${path}`,
      '--env',
      `OMNIS_EXPECT_SOCKET=${expected}`,
      '--env',
      `OMNIS_EXPECT_GROUP=${authorizerGid}`,
      lifecycleContainer,
      'node',
      '--input-type=module',
      '-e',
      nodeProbe,
    ]);
  execProbe('/run/omnis-authorizer/authorizer.sock', 'allow');
  const stalePath = join(apiSocketDir, 'authorizer.sock');
  await closeSyntheticSocket(authorizerServer, stalePath);
  const stale = dockerExpectedFailure([
    'exec',
    '--user',
    `10001:${authorizerGid}`,
    '--env',
    'OMNIS_PROBE_SOCKET=/run/omnis-authorizer/authorizer.sock',
    '--env',
    'OMNIS_EXPECT_SOCKET=allow',
    lifecycleContainer,
    'node',
    '--input-type=module',
    '-e',
    nodeProbe,
  ]);
  assert.notEqual(stale.status, 0, 'a removed socket must not be treated as live');
  assert.ok(`${stale.stdout ?? ''}${stale.stderr ?? ''}`.includes('ENOENT'));

  authorizerServer = await openSyntheticSocket(stalePath, 40002, authorizerGid);
  execProbe('/run/omnis-authorizer/authorizer.sock', 'allow');

  await closeSyntheticSocket(authorizerServer, stalePath);
  rmSync(apiSocketDir, { recursive: true });
  createSocketDirectory(apiSocketDir, 40002, authorizerGid);
  authorizerServer = await openSyntheticSocket(stalePath, 40002, authorizerGid);
  const oldMount = dockerExpectedFailure([
    'exec',
    '--user',
    `10001:${authorizerGid}`,
    '--env',
    'OMNIS_PROBE_SOCKET=/run/omnis-authorizer/authorizer.sock',
    '--env',
    'OMNIS_EXPECT_SOCKET=allow',
    lifecycleContainer,
    'node',
    '--input-type=module',
    '-e',
    nodeProbe,
  ]);
  assert.notEqual(
    oldMount.status,
    0,
    'an existing bind mount must not silently follow a replaced source directory',
  );
  assert.ok(`${oldMount.stdout ?? ''}${oldMount.stderr ?? ''}`.includes('ENOENT'));

  docker(['rm', '-f', lifecycleContainer]);
  probeContainer({
    name: `${resourcePrefix}-socket-remounted`,
    mounts: [socketMount(apiSocketDir, '/run/omnis-authorizer')],
    supplementaryGroups: [authorizerGid],
    environment: {
      OMNIS_PROBE_SOCKET: '/run/omnis-authorizer/authorizer.sock',
      OMNIS_EXPECT_SOCKET: 'allow',
    },
  });

  const directoryMode = statSync(apiSocketDir).mode & 0o777;
  assert.equal(directoryMode, 0o710);
  const files = readdirSync(root);
  assert.deepEqual(files.sort(), ['api-authorizer', 'read-only-control', 'worker-launcher']);
  await closeSyntheticSocket(authorizerServer, stalePath);
  await closeSyntheticSocket(launcherServer, join(workerSocketDir, 'launcher.sock'));
}

function verifyApplicationImageFailsClosed(image, expectedMessage) {
  const result = dockerExpectedFailure([
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '10001:10001',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '64',
    '--memory',
    '128m',
    '--cpus',
    '0.5',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    image,
  ]);
  assert.notEqual(result.status, 0, `${image} unexpectedly started without required configuration`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const boundedOutput = output.replace(/[\r\n]+/g, ' ').slice(0, 400);
  assert.ok(
    output.includes(expectedMessage),
    `${image} did not fail for the expected missing configuration; bounded output: ${boundedOutput}`,
  );
  assert.ok(
    !/DATABASE_URL|password=|token=|secret=/i.test(output),
    `${image} failure output exposed configuration-like data`,
  );
}

function verifyRuntimeImageRestrictions() {
  for (const [image, name, modules] of [
    [apiImage, 'api-runtime-probe', ['fastify']],
    [workerImage, 'worker-runtime-probe', ['fastify', 'pg', 'pg-boss']],
  ]) {
    const id = createOwned([
      'create',
      '--name',
      `${resourcePrefix}-${name}`,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '64',
      '--memory',
      '128m',
      '--cpus',
      '0.5',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--env',
      'OMNIS_PROBE_IDENTITY=1',
      '--env',
      'OMNIS_PROBE_WRITE_ROOT=1',
      '--env',
      'OMNIS_PROBE_TMP=1',
      '--env',
      `OMNIS_PROBE_MODULES=${JSON.stringify(modules)}`,
      '--entrypoint',
      'node',
      image,
      '--input-type=module',
      '-e',
      nodeProbe,
    ]);
    const config = inspectContainer(id);
    assertRuntimeRestrictions(config);
    const output = docker(['start', '--attach', id]);
    assert.ok(
      output.includes('identity, capabilities, mount absence, and runtime dependencies verified'),
    );
    assert.equal(docker(['wait', id]), '0');
    docker(['rm', id]);
  }

  const [web] = JSON.parse(docker(['image', 'inspect', webImage]));
  assert.equal(web.Config.User, '65532:65532');
  assert.equal(web.Config.Cmd, null);
  assert.equal(web.Config.Entrypoint, null);
  assert.equal(web.Config.ExposedPorts, null);
}

async function verifyNetworkIsolation() {
  const positiveNetwork = `${resourcePrefix}-positive`;
  const separateNetwork = `${resourcePrefix}-separate`;
  docker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--label',
    label,
    positiveNetwork,
  ]);
  docker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--label',
    label,
    separateNetwork,
  ]);
  const positiveConfig = JSON.parse(docker(['network', 'inspect', positiveNetwork]))[0];
  const separateConfig = JSON.parse(docker(['network', 'inspect', separateNetwork]))[0];
  assert.equal(positiveConfig.Internal, true);
  assert.equal(separateConfig.Internal, true);

  const serviceId = createOwned([
    'run',
    '--detach',
    '--name',
    `${resourcePrefix}-positive-service`,
    '--network',
    positiveNetwork,
    '--network-alias',
    'local-positive',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '64',
    '--memory',
    '128m',
    '--cpus',
    '0.5',
    '--entrypoint',
    'node',
    apiImage,
    '--input-type=module',
    '-e',
    "const s=await import('node:http').then(({createServer})=>createServer((_,r)=>{r.end('ok')}));s.listen(45678,'0.0.0.0');setInterval(()=>{},1000)",
  ]);
  const service = inspectContainer(serviceId);
  const serviceIp = service.NetworkSettings.Networks[positiveNetwork].IPAddress;
  assert.ok(serviceIp);
  const external = probeContainer({
    name: `${resourcePrefix}-network-probe`,
    network: positiveNetwork,
    environment: { OMNIS_PROBE_NETWORK: 'positive' },
  });
  assert.ok(external.includes('ok'), 'positive same-network service control failed');
  const denial = probeContainer({
    name: `${resourcePrefix}-egress-denial`,
    network: positiveNetwork,
    environment: { OMNIS_PROBE_NETWORK: 'external-denial' },
  });
  assert.match(denial, /ENETUNREACH|EHOSTUNREACH|ETIMEDOUT/);

  const separateId = createOwned([
    'run',
    '--detach',
    '--name',
    `${resourcePrefix}-separate-service`,
    '--network',
    separateNetwork,
    '--network-alias',
    'isolated-service',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '64',
    '--memory',
    '128m',
    '--cpus',
    '0.5',
    '--entrypoint',
    'node',
    workerImage,
    '--input-type=module',
    '-e',
    "const s=await import('node:http').then(({createServer})=>createServer((_,r)=>r.end('isolated')));s.listen(45679,'0.0.0.0');setInterval(()=>{},1000)",
  ]);
  const separateService = inspectContainer(separateId);
  const separateIp = separateService.NetworkSettings.Networks[separateNetwork].IPAddress;
  assert.ok(separateIp);
  const crossDenied = probeContainer({
    image: workerImage,
    name: `${resourcePrefix}-cross-network-probe`,
    network: positiveNetwork,
    environment: {
      OMNIS_PROBE_NETWORK: 'other-network-denial',
      OMNIS_OTHER_NETWORK_IP: separateIp,
    },
  });
  assert.match(crossDenied, /ENETUNREACH|EHOSTUNREACH|ETIMEDOUT/);
  assert.notEqual(serviceIp, '127.0.0.1');
}

function verifyCleanupOnSyntheticFailure() {
  const failureLabels = [label, 'com.omnis.docker-boundary.phase=cleanup-probe'];
  const probeName = `${resourcePrefix}-cleanup-probe`;
  const id = docker([
    'create',
    '--name',
    probeName,
    '--label',
    label,
    '--label',
    'com.omnis.docker-boundary.phase=cleanup-probe',
    '--entrypoint',
    'node',
    apiImage,
    '--input-type=module',
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  let caught;
  try {
    caught = (() => {
      try {
        throw new Error('intentional synthetic cleanup-path failure');
      } catch (error) {
        return error.message === 'intentional synthetic cleanup-path failure';
      }
    })();
  } finally {
    cleanupOwnedResources(failureLabels);
  }
  assert.equal(caught, true);
  const inspect = spawnSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(inspect.status, 0, 'synthetic failure cleanup left its probe container behind');
}

async function cleanup() {
  for (const server of activeServers) {
    await new Promise((resolve) => server.close(resolve));
  }
  activeServers.clear();
  cleanupOwnedResources();
  rmSync(root, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    signalReceived = true;
    void cleanup().finally(() => process.exit(1));
  });
}

const failures = [];
async function runCheck(name, check) {
  try {
    await check();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    const detail = String(error)
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 500);
    failures.push(name);
    process.stderr.write(`FAIL ${name}: ${detail}\n`);
  }
}

try {
  await runCheck('API fails closed without required configuration', () =>
    verifyApplicationImageFailsClosed(apiImage, 'OMNIS_SESSION_SECRET must be generated'),
  );
  await runCheck('worker fails closed without required configuration', () =>
    verifyApplicationImageFailsClosed(workerImage, 'OMNIS_INTERNAL_TOKEN must be generated'),
  );
  await runCheck(
    'runtime image identity and privilege restrictions',
    verifyRuntimeImageRestrictions,
  );
  await runCheck('synthetic Unix socket ACL and lifecycle boundaries', verifySocketBoundaries);
  await runCheck('internal Docker network isolation', verifyNetworkIsolation);
  await runCheck('cleanup after an intentional synthetic failure', verifyCleanupOnSyntheticFailure);
  if (failures.length > 0) {
    throw new Error(
      `Docker boundary verification failed in ${failures.length} group(s): ${failures.join(', ')}`,
    );
  }
  process.stdout.write(
    'Disposable Docker boundary verification passed: runtime identity, dropped capabilities, read-only rootfs, resource limits, fail-closed configuration, synthetic socket ACLs/lifecycle, isolated networking, no Docker authority, and scoped cleanup.\n',
  );
} finally {
  if (!signalReceived) await cleanup();
}

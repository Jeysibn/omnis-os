import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';

const [apiAddress, workerAddress, postgresAddress, gateway] = process.argv.slice(2);
for (const [name, value] of Object.entries({
  apiAddress,
  workerAddress,
  postgresAddress,
  gateway,
})) {
  assert.ok(value, `${name} is required for the browser isolation probe`);
}

async function denied(host, port, label) {
  const result = await new Promise((resolve) => {
    const socket = createConnection({ host, port, family: host.includes(':') ? 6 : 4 });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error) => resolve(error.code ?? 'error'));
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
  });
  assert.notEqual(result, 'connected', `browser must not connect to ${label}`);
  return result;
}

async function deniedPublicDnsUdp() {
  const name = Buffer.concat([
    ...'omnis-integration.invalid'
      .split('.')
      .flatMap((label) => [Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)]),
    Buffer.from([0]),
  ]);
  const query = Buffer.concat([
    Buffer.from([0x4f, 0x4d, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    name,
    Buffer.from([0x00, 0x01, 0x00, 0x01]),
  ]);
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      resolve('timeout');
    }, 2_000);
    socket.once('message', () => {
      clearTimeout(timer);
      socket.close();
      resolve('received-response');
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.close();
      resolve(error.code ?? 'error');
    });
    socket.send(query, 53, '1.1.1.1', (error) => {
      if (!error) return;
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

const health = await globalThis.fetch('http://web:8080/health', {
  signal: globalThis.AbortSignal.timeout(3_000),
});
assert.equal(health.status, 200, 'browser reaches web through the dedicated internal network');
const csrf = await globalThis.fetch('http://web:8080/api/v1/auth/csrf', {
  signal: globalThis.AbortSignal.timeout(3_000),
});
assert.equal(csrf.status, 200, 'browser reaches the API only through the web gateway');
const anonymousOwner = await globalThis.fetch('http://web:8080/api/v1/me', {
  signal: globalThis.AbortSignal.timeout(3_000),
});
assert.equal(
  anonymousOwner.status,
  401,
  'owner endpoints remain authenticated through the gateway',
);

const directServices = {};
for (const [service, address, port] of [
  ['API', apiAddress, 4100],
  ['worker', workerAddress, 4101],
  ['PostgreSQL', postgresAddress, 5432],
]) {
  directServices[service] = await denied(address, port, `the ${service} container directly`);
}

const dns = {};
for (const service of ['web', 'api', 'worker', 'postgres', 'host.docker.internal']) {
  try {
    const records = await lookup(service, { all: true, verbatim: true });
    dns[service] = records.map(({ address, family }) => ({ address, family }));
  } catch (error) {
    dns[service] = error.code ?? 'lookup-failed';
  }
}
assert.ok(Array.isArray(dns.web), 'Docker DNS resolves the permitted web service');
for (const service of ['api', 'worker', 'postgres', 'host.docker.internal']) {
  assert.ok(
    !Array.isArray(dns[service]),
    `Docker DNS does not expose non-member service ${service}`,
  );
}

const gatewayPorts = {};
for (const port of [22, 80, 443, 2375, 2376, 4100, 4101, 5432, 8080]) {
  gatewayPorts[port] = await denied(gateway, port, `host gateway port ${port}`);
}
const metadata = await denied('169.254.169.254', 80, 'the IPv4 metadata endpoint');
const publicIpv4 = await denied('1.1.1.1', 443, 'public IPv4 egress');
const publicIpv4Http = await denied('1.1.1.1', 80, 'public IPv4 HTTP egress');
const publicDnsUdp = await deniedPublicDnsUdp();
assert.notEqual(publicDnsUdp, 'received-response', 'browser cannot use public UDP DNS directly');

let externalDns;
try {
  const resolved = await lookup('example.com', { all: true, verbatim: true });
  externalDns = resolved.map(({ address, family }) => ({ address, family }));
  for (const record of resolved) {
    await denied(record.address, 443, 'an externally resolved HTTPS endpoint');
  }
} catch (error) {
  externalDns = error.code ?? 'lookup-failed';
}
assert.ok(externalDns, 'external DNS probe reports either resolution or a bounded lookup failure');

const ipv6AddressAvailable = Object.values(networkInterfaces())
  .flat()
  .some(
    (address) =>
      address?.family === 'IPv6' &&
      !address.internal &&
      !address.address.startsWith('fe80:') &&
      !address.address.startsWith('fc') &&
      !address.address.startsWith('fd'),
  );
const ipv6Routes = await readFile('/proc/net/ipv6_route', 'utf8');
const ipv6DefaultRouteAvailable = ipv6Routes.split(/\r?\n/).some((line) => {
  const fields = line.trim().split(/\s+/);
  return fields[0] === '0'.repeat(32) && fields[1] === '00' && fields.at(-1) !== 'lo';
});
const ipv6Available = ipv6AddressAvailable && ipv6DefaultRouteAvailable;
const ipv6 = ipv6Available
  ? await denied('2606:4700:4700::1111', 443, 'public IPv6 egress')
  : 'not-tested-no-global-address-or-default-route';
const metadataIpv6 = ipv6Available
  ? await denied('fd00:ec2::254', 80, 'the IPv6 metadata endpoint')
  : 'not-tested-no-global-address-or-default-route';

process.stdout.write(
  `${JSON.stringify({
    allowed: {
      webHealth: health.status,
      webGatewayCsrf: csrf.status,
      anonymousOwnerStatus: anonymousOwner.status,
    },
    denied: {
      directServices,
      gatewayPorts,
      metadata,
      publicIpv4,
      publicIpv4Http,
      publicDnsUdp,
      publicIpv6: ipv6,
      metadataIpv6,
      ipv6DefaultRouteAvailable,
    },
    dns: { serviceRecords: dns, externalName: externalDns },
  })}\n`,
);

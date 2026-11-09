import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';

const [
  apiAddress,
  workerAddress,
  postgresAddress,
  gateway,
  hostControlPortValue,
  hostGatewayIpv6,
  hostIpv6ControlPortValue,
] = process.argv.slice(2);
for (const [name, value] of Object.entries({
  apiAddress,
  workerAddress,
  postgresAddress,
  gateway,
  hostControlPortValue,
})) {
  assert.ok(value, `${name} is required for the browser isolation probe`);
}

async function lookupBounded(hostname) {
  const resolveFamily = async (family) => {
    const resolver = new Resolver();
    let timer;
    const query = family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        resolver.cancel();
        const error = new Error('DNS query deadline exceeded');
        error.code = 'ETIMEOUT';
        reject(error);
      }, 2_500);
    });
    try {
      const records = await Promise.race([query, timeout]);
      return records.map((address) => ({ address, family }));
    } finally {
      clearTimeout(timer);
    }
  };
  const outcomes = await Promise.allSettled([resolveFamily(4), resolveFamily(6)]);
  const records = outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? outcome.value : [],
  );
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason.code ?? 'lookup-failed'] : [],
  );
  return { records, errors };
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
  return new Promise((resolve) => {
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
      resolve(error.code ?? 'send-failed');
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
const directServiceResults = await Promise.all(
  [
    ['API', apiAddress, 4100],
    ['worker', workerAddress, 4101],
    ['PostgreSQL', postgresAddress, 5432],
  ].map(async ([service, address, port]) => [
    service,
    await denied(address, port, `the ${service} container directly`),
  ]),
);
Object.assign(directServices, Object.fromEntries(directServiceResults));

const dns = {};
await Promise.all(
  ['web', 'api', 'worker', 'postgres', 'host.docker.internal'].map(async (service) => {
    try {
      dns[service] = await lookupBounded(service);
    } catch (error) {
      dns[service] = error.code ?? 'lookup-failed';
    }
  }),
);
assert.ok(dns.web.records.length > 0, 'Docker DNS resolves the permitted web service');
const protectedAddresses = new Set([apiAddress, workerAddress, postgresAddress]);
for (const service of ['api', 'worker', 'postgres']) {
  assert.ok(
    dns[service].records.every(({ address }) => !protectedAddresses.has(address)),
    `DNS for non-member service ${service} does not disclose a protected service address`,
  );
}
const hostAlias = dns['host.docker.internal'];
if (hostAlias.records.length > 0) {
  await Promise.all(
    hostAlias.records.flatMap(({ address }) =>
      [22, 80, 443, 2375, 2376, 5432].map((port) =>
        denied(address, port, `host.docker.internal address ${address} port ${port}`),
      ),
    ),
  );
}

const gatewayPorts = {};
const gatewayPortResults = await Promise.all(
  [22, 80, 443, 2375, 2376, 4100, 4101, 5432, 8080].map(async (port) => [
    port,
    await denied(gateway, port, `host gateway port ${port}`),
  ]),
);
Object.assign(gatewayPorts, Object.fromEntries(gatewayPortResults));
const hostControlPort = Number(hostControlPortValue);
assert.ok(Number.isSafeInteger(hostControlPort) && hostControlPort > 0);
const hostControl = await denied(
  gateway,
  hostControlPort,
  'the live host gateway positive-control listener',
);
const browserIpv6Interface = Object.entries(networkInterfaces()).find(([, addresses]) =>
  addresses?.some(
    (address) => address.family === 'IPv6' && address.address.toLowerCase().startsWith('fe80:'),
  ),
);
const ipv6HostGateway =
  hostGatewayIpv6 && hostIpv6ControlPortValue && browserIpv6Interface
    ? await denied(
        `${hostGatewayIpv6}%${browserIpv6Interface[0]}`,
        Number(hostIpv6ControlPortValue),
        'the live IPv6 host gateway positive-control listener',
      )
    : 'not-tested-no-IPv6-host-bridge-address-or-browser-link-local-interface';
const metadata = await denied('169.254.169.254', 80, 'the IPv4 metadata endpoint');
const publicIpv4 = await denied('1.1.1.1', 443, 'public IPv4 egress');
const publicIpv4Http = await denied('1.1.1.1', 80, 'public IPv4 HTTP egress');
const publicDnsUdp = await deniedPublicDnsUdp();
assert.notEqual(publicDnsUdp, 'received-response', 'browser cannot use public UDP DNS directly');

let externalDns;
externalDns = await lookupBounded('example.com');
await Promise.all(
  externalDns.records.map(({ address }) =>
    denied(address, 443, 'an externally resolved HTTPS endpoint'),
  ),
);

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
      liveHostGatewayPositiveControl: hostControl,
      ipv6HostGatewayPositiveControl: ipv6HostGateway,
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

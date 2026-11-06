import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import dgram from 'node:dgram';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';

const status = readFileSync('/proc/self/status', 'utf8');
const effectiveUid = status.match(/^Uid:\s+\d+\s+(\d+)/m)?.[1];
const effectiveGid = status.match(/^Gid:\s+\d+\s+(\d+)/m)?.[1];
const supplementaryGroups = status.match(/^Groups:\s*(.*)$/m)?.[1] ?? '';
assert.equal(effectiveUid, '10001');
assert.equal(effectiveGid, '10001');
assert.equal(supplementaryGroups.trim(), '');

const resolved = await lookup('omnis-synthetic-provider');
assert.equal(
  resolved.address,
  '172.29.87.10',
  'fixed fake-provider name resolves only to its synthetic address',
);
const response = await getHealth();
assert.equal(response.status, 200, 'positive control reaches deterministic fake provider');
assert.deepEqual(JSON.parse(response.body), { ok: true, synthetic: true });

for (const [host, port] of [
  ['1.1.1.1', 80],
  ['169.254.169.254', 80],
  ['172.29.87.1', 80],
  ['172.29.88.10', 8787],
]) {
  await assert.rejects(
    connect(host, port, 700),
    `${host}:${port} must be blocked by the Docker internal network`,
  );
}

await assert.rejects(
  lookup('example.com', { timeout: 700 }),
  'external DNS lookup must fail closed',
);
await assert.rejects(dnsProbe('8.8.8.8', 53), 'alternate DNS server must be unreachable');
process.stdout.write(
  `PASS uid=${effectiveUid} gid=${effectiveGid} groups=${supplementaryGroups || 'none'}; fake provider reachable; public, metadata, host gateway, isolated private-service, external DNS and alternate DNS denied\n`,
);

function connect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error('probe timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`unexpected connection to ${host}:${port}`));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function dnsProbe(host, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('alternate DNS was blocked'));
    }, 700);
    socket.once('message', () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error('alternate DNS unexpectedly responded'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(
      Buffer.from([
        0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0,
        0, 1, 0, 1,
      ]),
      port,
      host,
    );
  });
}

function getHealth() {
  return new Promise((resolve, reject) => {
    const probe = request(
      {
        hostname: 'omnis-synthetic-provider',
        port: 8787,
        path: '/healthz',
        method: 'GET',
        headers: { host: 'omnis-synthetic-provider:8787', connection: 'close' },
        timeout: 1_500,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    probe.on('timeout', () => probe.destroy(new Error('fake-provider positive control timed out')));
    probe.on('error', reject);
    probe.end();
  });
}

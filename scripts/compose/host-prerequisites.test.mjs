import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assertHostPrerequisites,
  validateComposeEnvironment,
  validateSocketEndpoint,
} from './host-prerequisites.mjs';

const safeApi = new Map([
  ['OMNIS_ALLOWED_ORIGIN', 'https://omnis.example.invalid'],
  ['OMNIS_SECURE_COOKIES', 'true'],
  ['OMNIS_AUTHORIZER_SOCKET', '/run/omnis-authorizer/authorizer.sock'],
]);
const safeWorker = new Map([['OMNIS_SANDBOX_LAUNCHER_SOCKET', '/run/omnis-sandbox/launcher.sock']]);

describe('private Compose host preflight policy', () => {
  it('requires HTTPS, secure cookies, and only the provisioned Unix socket endpoints', () => {
    assert.doesNotThrow(() => validateComposeEnvironment(safeApi, safeWorker));
    const insecureApi = new Map(safeApi).set('OMNIS_SECURE_COOKIES', 'false');
    assert.throws(() => validateComposeEnvironment(insecureApi, safeWorker));
    const externalSocketWorker = new Map(safeWorker).set(
      'OMNIS_SANDBOX_LAUNCHER_SOCKET',
      '/tmp/launcher.sock',
    );
    assert.throws(() => validateComposeEnvironment(safeApi, externalSocketWorker));
    const credentialBearingWorker = new Map(safeWorker).set(
      'OMNIS_API_AUTHORIZER_TOKEN',
      'synthetic-fixture',
    );
    assert.throws(() => validateComposeEnvironment(safeApi, credentialBearingWorker));
  });

  it('requires exact group IDs, active host services, and both private socket endpoints', () => {
    const calls = [];
    assert.doesNotThrow(() =>
      assertHostPrerequisites({
        platform: 'linux',
        uid: 0,
        groupIds: { authorizer: 1201, launcher: 1202 },
        compose: new Map([
          ['OMNIS_AUTHORIZER_SOCKET_GID', '1201'],
          ['OMNIS_LAUNCHER_SOCKET_GID', '1202'],
        ]),
        api: safeApi,
        worker: safeWorker,
        checkSocket: (...args) => calls.push(['socket', ...args]),
        checkService: (service) => calls.push(['service', service]),
        checkInactiveService: (service) => calls.push(['inactive', service]),
      }),
    );
    assert.equal(calls.filter(([kind]) => kind === 'socket').length, 2);
    assert.deepEqual(
      calls.filter(([kind]) => kind === 'service').map(([, service]) => service),
      ['omnis-authorizer.service', 'omnis-sandbox-launcher.service'],
    );
    assert.deepEqual(
      calls.filter(([kind]) => kind === 'inactive').map(([, service]) => service),
      ['omnis-api.service', 'omnis-worker.service'],
    );
    assert.throws(() =>
      assertHostPrerequisites({
        platform: 'linux',
        uid: 0,
        groupIds: {},
        compose: new Map(),
        api: safeApi,
        worker: safeWorker,
      }),
    );
  });

  it('accepts only group-connectable sockets inside non-world-accessible group-owned directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omnis-socket-check-'));
    const directory = join(root, 'runtime');
    const socketPath = join(directory, 'service.sock');
    const gid = process.getgid?.();
    assert.notEqual(gid, undefined);
    mkdirSync(directory, { mode: 0o750 });
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      chmodSync(socketPath, 0o660);
      assert.doesNotThrow(() => validateSocketEndpoint(directory, socketPath, gid));
      chmodSync(socketPath, 0o600);
      assert.throws(() => validateSocketEndpoint(directory, socketPath, gid));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

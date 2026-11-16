import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SandboxError } from '@omnis/runtime-adapters/sandbox-error';
import { UnixMockSandboxLauncherClient } from './sandbox-launcher-client.ts';

describe('worker sandbox launcher client', () => {
  it('sends only run fencing coordinates and validates the synthetic result', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'omnis-launch-client-'));
    const socketPath = path.join(directory, 'launcher.sock');
    let requestBody = '';
    const server = createServer((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk) => (requestBody += chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, stdout: 'synthetic', stderr: '', exitCode: 0 }));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const controller = new AbortController();
      const result = await new UnixMockSandboxLauncherClient(socketPath).execute({
        runId: 'run-1234',
        workerId: '5bd5ca09-8354-4e98-9bce-241fd1076043',
        generation: 2,
        signal: controller.signal,
      });
      assert.deepEqual(JSON.parse(requestBody), {
        runId: 'run-1234',
        workerId: '5bd5ca09-8354-4e98-9bce-241fd1076043',
        generation: 2,
      });
      assert.deepEqual(result, { stdout: 'synthetic', stderr: '', exitCode: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('turns malformed launcher responses into a controlled unavailable error', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'omnis-launch-client-'));
    const socketPath = path.join(directory, 'launcher.sock');
    const server = createServer((_request, response) => response.end('{not-json'));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await assert.rejects(
        new UnixMockSandboxLauncherClient(socketPath).execute({
          runId: 'run-1234',
          workerId: '5bd5ca09-8354-4e98-9bce-241fd1076043',
          generation: 2,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof SandboxError && error.code === 'unavailable',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a missing launcher socket as unavailable without fabricating output', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'omnis-missing-launcher-'));
    try {
      assert.equal(
        await new UnixMockSandboxLauncherClient(path.join(directory, 'missing.sock')).health(),
        false,
      );
      await assert.rejects(
        new UnixMockSandboxLauncherClient(path.join(directory, 'missing.sock')).execute({
          runId: 'run-1234',
          workerId: '5bd5ca09-8354-4e98-9bce-241fd1076043',
          generation: 2,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof SandboxError && error.code === 'unavailable',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('probes launcher health without creating a mock execution', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'omnis-launcher-health-'));
    const socketPath = path.join(directory, 'launcher.sock');
    let requestedPath = '';
    const server = createServer((request, response) => {
      requestedPath = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          product: 'Omnis OS',
          service: 'sandbox-launcher',
          synthetic: true,
        }),
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      assert.equal(await new UnixMockSandboxLauncherClient(socketPath).health(), true);
      assert.equal(requestedPath, '/health');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

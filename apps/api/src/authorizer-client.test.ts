import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

process.env.OMNIS_SESSION_SECRET = 'session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH = `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN = 'worker-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN = 'authorizer-token-'.padEnd(64, 'x');
process.env.OMNIS_AUTHORIZER_SOCKET = '/tmp/omnis-client-test-socket-not-used';

const { authorizerRequest, AuthorizerRequestError } = await import('./authorizer-client.ts');
const { env } = await import('./env.ts');

describe('authorizer transport outcome handling', () => {
  it('reports unknown when an accepted request commits and its response is lost', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'omnis-authorizer-client-'));
    const socketPath = path.join(directory, 'authorizer.sock');
    let committed = false;
    const server = createServer((request) => {
      request.resume();
      request.once('end', () => {
        committed = true;
        request.socket.destroy();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      env.authorizerSocket = socketPath;
      await assert.rejects(
        authorizerRequest(
          '/internal/v1/authorizations',
          {
            method: 'POST',
            headers: { 'idempotency-key': 'same-request-id' },
            body: JSON.stringify({ taskId: 'task-0001' }),
          },
          (value) => value,
        ),
        (error: unknown) => {
          assert.ok(error instanceof AuthorizerRequestError);
          assert.equal(error.body.error.code, 'authorization_outcome_unknown');
          assert.match(error.body.error.message, /may have committed/i);
          return true;
        },
      );
      assert.equal(committed, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('distinguishes a connection failure before submission from an uncertain commit', async () => {
    env.authorizerSocket = '/tmp/omnis-no-authorizer-socket';
    await assert.rejects(
      authorizerRequest(
        '/internal/v1/authorizations',
        {
          method: 'POST',
          headers: { 'idempotency-key': 'same-request-id' },
          body: JSON.stringify({ taskId: 'task-0001' }),
        },
        (value) => value,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizerRequestError);
        assert.equal(error.body.error.code, 'authorizer_unavailable');
        assert.match(error.body.error.message, /no decision was submitted/i);
        return true;
      },
    );
  });

  it('treats an invalid successful mutation response as uncertain instead of definite failure', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'omnis-authorizer-client-'));
    const socketPath = path.join(directory, 'authorizer.sock');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"unexpected":true}');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      env.authorizerSocket = socketPath;
      await assert.rejects(
        authorizerRequest(
          '/internal/v1/authorizations',
          { method: 'POST', body: JSON.stringify({ taskId: 'task-0001' }) },
          (value) => {
            if (typeof value !== 'object' || value === null || !('id' in value)) {
              throw new Error('invalid synthetic response');
            }
            return value;
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof AuthorizerRequestError);
          assert.equal(error.body.error.code, 'authorization_outcome_unknown');
          return true;
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

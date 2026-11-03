import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSandboxLauncherApp } from './service.ts';

const request = {
  runId: 'run-1234',
  workerId: '5bd5ca09-8354-4e98-9bce-241fd1076043',
  generation: 1,
};

describe('restricted sandbox-launcher protocol', () => {
  it('rejects arbitrary Docker configuration before authorization or execution', async () => {
    let authorized = 0;
    let executed = 0;
    const app = createSandboxLauncherApp({
      authorize: async () => {
        authorized += 1;
        return 'synthetic task';
      },
      checkDatabase: async () => undefined,
      executor: {
        execute: async () => {
          executed += 1;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/mock-executions',
        payload: { ...request, image: 'attacker/image', mounts: ['/etc:/host'], privileged: true },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(authorized, 0);
      assert.equal(executed, 0);
    } finally {
      await app.close();
    }
  });

  it('denies unknown or unleased runs without starting a sandbox', async () => {
    let executed = 0;
    const app = createSandboxLauncherApp({
      authorize: async () => undefined,
      checkDatabase: async () => undefined,
      executor: {
        execute: async () => {
          executed += 1;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/mock-executions',
        payload: request,
      });
      assert.equal(response.statusCode, 409);
      assert.equal(executed, 0);
    } finally {
      await app.close();
    }
  });

  it('constructs the synthetic command and task input inside the launcher', async () => {
    let observed:
      { runId: string; argv: readonly string[]; stdin: string; timeoutMs: number } | undefined;
    const app = createSandboxLauncherApp({
      authorize: async (runId, workerId, generation) => {
        assert.deepEqual({ runId, workerId, generation }, request);
        return 'Synthetic title';
      },
      checkDatabase: async () => undefined,
      testDelayMs: 1_000,
      executor: {
        execute: async (input) => {
          observed = input;
          return {
            stdout: '{"type":"run.output","message":"Synthetic output"}\n',
            stderr: '',
            exitCode: 0,
          };
        },
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/mock-executions',
        payload: request,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        ok: true,
        stdout: '{"type":"run.output","message":"Synthetic output"}\n',
        stderr: '',
        exitCode: 0,
      });
      assert.equal(observed?.runId, request.runId);
      assert.deepEqual(observed?.argv.slice(0, 2), ['node', '-e']);
      assert.match(observed?.argv[2] ?? '', /No provider was contacted/);
      assert.equal((observed?.argv[2]?.match(/setTimeout\(resolve, 1000\)/g) ?? []).length, 2);
      assert.equal(observed?.stdin, JSON.stringify({ title: 'Synthetic title' }));
      assert.equal(observed?.timeoutMs, 8_000);
    } finally {
      await app.close();
    }
  });
});

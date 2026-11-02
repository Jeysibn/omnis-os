import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DockerSandboxExecutor } from './docker-sandbox.ts';

const scopeA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const scopeB = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('Docker sandbox workspace scope cleanup', () => {
  it('isolates identical run IDs, preserves active workspaces, and removes expired local workspaces', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'omnis-sandbox-scope-'));
    const workspaces = path.join(root, 'workspaces');
    const docker = path.join(root, 'docker');
    const runWorkspace = `run-run-1234-abcdef`;
    const outside = path.join(root, 'outside');
    try {
      await mkdir(path.join(workspaces, scopeA), { recursive: true });
      await mkdir(path.join(workspaces, scopeB), { recursive: true });
      await mkdir(path.join(workspaces, scopeA, runWorkspace));
      await mkdir(path.join(workspaces, scopeA, 'run-run-5678-expire'));
      await mkdir(path.join(workspaces, scopeB, runWorkspace));
      await mkdir(outside);
      await writeFile(path.join(outside, 'keep.txt'), 'outside approved scope');
      await symlink(outside, path.join(workspaces, scopeA, 'run-run-9999-escape'));
      await writeFile(docker, '#!/bin/sh\nif [ "$4" = "ps" ]; then exit 0; fi\nexit 0\n', {
        mode: 0o700,
      });
      await chmod(docker, 0o700);

      const executor = new DockerSandboxExecutor({
        dockerPath: docker,
        workspaceRoot: workspaces,
        scopeId: scopeA,
      });
      let resolved: readonly string[] = [];
      await executor.cleanupOrphanedContainers(async (candidateIds) => {
        resolved = candidateIds;
        return candidateIds.includes('run-1234') ? ['run-1234'] : [];
      });

      assert.deepEqual(resolved, ['run-1234', 'run-5678']);
      assert.deepEqual(await readdir(path.join(workspaces, scopeA)), [
        runWorkspace,
        'run-run-9999-escape',
      ]);
      assert.deepEqual(await readdir(path.join(workspaces, scopeB)), [runWorkspace]);
      assert.deepEqual(await readdir(outside), ['keep.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

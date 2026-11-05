import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { PostgresRunStore, StoreError } from './run-store.ts';

const projectId = `prj_${'a'.repeat(32)}`;

function workspaceRow(
  id: string,
  createdAt: string,
  latestRunId: string | null = null,
  latestRunStatus: string | null = null,
) {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    created_at: new Date(createdAt),
    cursor_created_at: createdAt.replace('.000Z', '.000000Z'),
    association_revision: 1,
    latest_run_id: latestRunId,
    latest_run_status: latestRunStatus,
    latest_run_created_at: latestRunId ? new Date(createdAt) : null,
    latest_run_updated_at: latestRunId ? new Date(createdAt) : null,
    observed_total: '2',
  };
}

function fakePool(responses: Array<unknown[]>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: responses.shift() ?? [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('project workspace cursor and database projection', () => {
  it('returns bounded deterministic pages and signs a project-bound continuation cursor', async () => {
    const { pool, calls } = fakePool([
      [
        workspaceRow('task-0002', '2026-11-05T00:00:02.000Z', 'run-0002', 'failed'),
        workspaceRow('task-0001', '2026-11-05T00:00:01.000Z'),
      ],
      [workspaceRow('task-0001', '2026-11-05T00:00:01.000Z')],
    ]);
    const store = new PostgresRunStore(pool, 'project-workspace-test-token'.padEnd(64, 'x'));
    const first = await store.listProjectWorkspaceTasks(projectId, { limit: 1 });
    assert.equal(first.tasks.length, 1);
    assert.equal(first.tasks[0]?.latestRun?.status, 'failed');
    assert.equal(first.page.observedTotal, 2);
    assert.equal(first.page.complete, false);
    assert.ok(first.page.nextCursor);
    assert.match(calls[0]!.sql, /current_task\.project_id = \$1/);
    assert.match(calls[0]!.sql, /LEFT JOIN LATERAL/);
    assert.match(calls[0]!.sql, /ORDER BY run\.created_at DESC, run\.id DESC/);
    assert.doesNotMatch(calls[0]!.sql, /SELECT\s+\*/i);
    assert.equal(calls[0]!.values[3], 2);

    const second = await store.listProjectWorkspaceTasks(projectId, {
      cursor: first.page.nextCursor!,
      limit: 1,
    });
    assert.equal(second.tasks[0]?.id, 'task-0001');
    assert.deepEqual(second.page, { observedTotal: 2, complete: true, nextCursor: null });
    assert.equal(calls[1]!.values[1], '2026-11-05T00:00:02.000000Z');
    assert.equal(calls[1]!.values[2], 'task-0002');
  });

  it('rejects malformed, tampered, foreign-project, and rotated-key cursors before querying', async () => {
    const { pool, calls } = fakePool([
      [
        workspaceRow('task-0002', '2026-11-05T00:00:02.000Z'),
        workspaceRow('task-0001', '2026-11-05T00:00:01.000Z'),
      ],
    ]);
    const token = 'project-workspace-test-token'.padEnd(64, 'x');
    const store = new PostgresRunStore(pool, token);
    const page = await store.listProjectWorkspaceTasks(projectId, { limit: 1 });
    const cursor = page.page.nextCursor!;
    const callsAfterPage = calls.length;
    const rejectAsCursorError = (error: unknown) =>
      error instanceof StoreError && error.code === 'invalid_cursor' && error.statusCode === 422;

    await assert.rejects(
      store.listProjectWorkspaceTasks(projectId, { cursor: `${cursor.slice(0, -1)}x` }),
      rejectAsCursorError,
    );
    await assert.rejects(
      store.listProjectWorkspaceTasks(`prj_${'b'.repeat(32)}`, { cursor }),
      rejectAsCursorError,
    );
    const rotatedStore = new PostgresRunStore(
      pool,
      'rotated-project-workspace-token'.padEnd(64, 'y'),
    );
    await assert.rejects(
      rotatedStore.listProjectWorkspaceTasks(projectId, { cursor }),
      rejectAsCursorError,
    );
    await assert.rejects(
      store.listProjectWorkspaceTasks(projectId, { cursor: 'not-a-cursor' }),
      rejectAsCursorError,
    );
    assert.equal(calls.length, callsAfterPage);
  });

  it('rejects invalid input and requires cursor key configuration before database access', async () => {
    const { pool, calls } = fakePool([]);
    const store = new PostgresRunStore(pool);
    await assert.rejects(
      store.listProjectWorkspaceTasks('not-a-project', {}),
      (error: unknown) => error instanceof StoreError && error.code === 'invalid_input',
    );
    await assert.rejects(
      store.listProjectWorkspaceTasks(projectId, { limit: 101 }),
      (error: unknown) => error instanceof StoreError && error.code === 'invalid_input',
    );
    await assert.rejects(
      store.listProjectWorkspaceTasks(projectId, {}),
      /cursor key is not configured/,
    );
    assert.equal(calls.length, 0);
  });
});

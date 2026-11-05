import assert from 'node:assert/strict';
import { createHmac, hkdfSync } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { EpicStoreError, PostgresProjectEpicStore } from './project-epic-store.ts';

const projectId = 'prj_0123456789abcdef0123456789abcdef';
const otherProjectId = 'prj_abcdef0123456789abcdef0123456789';
const epicId = 'epc_0123456789abcdef0123456789abcdef';
const createdAt = '2026-11-05T00:00:00.123456Z';
const at = '2026-11-05T00:00:00.000000Z';
const key = Buffer.alloc(32, 12);
const taskId = 'task-0001';

function workspaceTask(id: string, timestamp: string, latestRun: unknown = null) {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    createdAt: timestamp,
    projectId,
    associationRevision: 2,
    latestRun,
  };
}

function epic(id: string, timestamp = createdAt, project = projectId) {
  return {
    id,
    projectId: project,
    title: 'First release',
    description: null,
    status: 'planned',
    revision: 1,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: at,
  };
}

function fakePool(
  handler: (query: string, values?: unknown[]) => unknown,
  calls: Array<{ query: string; values?: unknown[] }> = [],
): Pool {
  return {
    async query(query: string, values?: unknown[]) {
      calls.push({ query, ...(values === undefined ? {} : { values }) });
      const response = handler(query, values);
      if (response instanceof Error) throw response;
      return { rows: [{ result: response }] };
    },
  } as unknown as Pool;
}

function signCursor(payload: unknown, signingKey = key): string {
  const cursorKey = Buffer.from(
    hkdfSync(
      'sha256',
      signingKey,
      Buffer.from('omnis-os/ao-105/project-epics/cursor/v1'),
      Buffer.from('epic-page-signature'),
      32,
    ),
  );
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', cursorKey)
    .update('omnis-project-epics-cursor-v1:')
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

describe('project epic store boundary', () => {
  it('rejects malformed, oversized, and credential-like input before database access', async () => {
    const calls: Array<{ query: string; values?: unknown[] }> = [];
    const store = new PostgresProjectEpicStore(
      fakePool(() => null, calls),
      key,
    );
    await assert.rejects(
      store.create('bad-project', { title: 'A epic' }, crypto.randomUUID()),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_input',
    );
    await assert.rejects(
      store.create(
        projectId,
        { title: 'A epic', description: 'x'.repeat(2001) },
        crypto.randomUUID(),
      ),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_input',
    );
    await assert.rejects(
      store.create(
        projectId,
        { title: 'password: "synthetic-secret-123456"' },
        crypto.randomUUID(),
      ),
      (error: unknown) => error instanceof EpicStoreError && error.statusCode === 422,
    );
    await assert.rejects(
      store.update(
        projectId,
        epicId,
        { expectedRevision: 1, description: 'api_key: synthetic-secret-123456' },
        crypto.randomUUID(),
      ),
      (error: unknown) => error instanceof EpicStoreError && error.statusCode === 422,
    );
    assert.deepEqual(calls, []);
  });

  it('uses a project-bound signed keyset cursor and rejects tampered or foreign cursors', async () => {
    const calls: Array<{ query: string; values?: unknown[] }> = [];
    const firstRow = epic(epicId);
    const secondRow = epic('epc_abcdef0123456789abcdef0123456789', '2026-11-04T23:59:59.999999Z');
    const store = new PostgresProjectEpicStore(
      fakePool(() => ({ epics: [firstRow, secondRow], observedTotal: 2 }), calls),
      key,
    );
    const firstPage = await store.list(projectId, { limit: 1 });
    assert.deepEqual(
      firstPage.epics.map((item) => item.id),
      [epicId],
    );
    assert.equal(firstPage.page.observedTotal, 2);
    assert.equal(firstPage.page.complete, false);
    assert.ok(firstPage.page.nextCursor);

    await store.list(projectId, { limit: 1, cursor: firstPage.page.nextCursor! });
    assert.equal(calls[1]!.values?.[1], createdAt);
    assert.equal(calls[1]!.values?.[2], epicId);
    assert.equal(
      calls.every(
        ({ query }) => query === 'SELECT omnis.list_project_epics($1,$2,$3,$4) AS result',
      ),
      true,
    );
    await assert.rejects(
      store.list(otherProjectId, { cursor: firstPage.page.nextCursor! }),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_cursor',
    );
    await assert.rejects(
      store.list(projectId, { cursor: `${firstPage.page.nextCursor!.slice(0, -1)}x` }),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_cursor',
    );
    assert.equal(calls.length, 2);
  });

  it('maps safe database failures and fingerprints the scoped idempotent mutation', async () => {
    const calls: Array<{ query: string; values?: unknown[] }> = [];
    const store = new PostgresProjectEpicStore(
      fakePool((_query, values) => {
        calls.push({ query: 'fingerprint', ...(values === undefined ? {} : { values }) });
        return epic(epicId);
      }, calls),
      key,
    );
    const created = await store.create(
      projectId,
      { title: 'First release' },
      'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
    );
    assert.equal(created.id, epicId);
    assert.match(calls[0]!.query, /omnis\.create_project_epic\(\$1/);
    assert.equal(calls[0]!.values?.[1], projectId);
    assert.equal(calls[0]!.values?.[2], 'First release');
    const errorStore = new PostgresProjectEpicStore(
      fakePool(() => Object.assign(new Error('secret details must not escape'), { code: '40001' })),
      key,
    );
    await assert.rejects(
      errorStore.create(projectId, { title: 'Another' }, crypto.randomUUID()),
      (error: unknown) =>
        error instanceof EpicStoreError &&
        error.code === 'conflict' &&
        !error.message.includes('secret details'),
    );
  });

  it('rejects malformed signatures even when cursor payload JSON looks valid', async () => {
    const calls: Array<{ query: string; values?: unknown[] }> = [];
    const store = new PostgresProjectEpicStore(
      fakePool(() => null, calls),
      key,
    );
    const cursor = signCursor({
      version: 1,
      projectId,
      lastCreatedAt: createdAt,
      lastEpicId: epicId,
    });
    await assert.rejects(
      store.list(projectId, { cursor: `${cursor.slice(0, -1)}x` }),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_cursor',
    );
    assert.deepEqual(calls, []);
  });

  it('lists Epic tasks with bounded ordering and a cursor bound to both project and Epic', async () => {
    const calls: Array<{ query: string; values?: unknown[] }> = [];
    const store = new PostgresProjectEpicStore(
      fakePool(
        () => ({
          tasks: [
            workspaceTask(taskId, createdAt, {
              id: 'run-0003',
              status: 'cancelled',
              createdAt,
              updatedAt: at,
            }),
            workspaceTask('task-0002', '2026-11-04T23:59:59.999999Z'),
          ],
          observedTotal: 2,
        }),
        calls,
      ),
      key,
    );
    const first = await store.listTasks(projectId, epicId, { limit: 1 });
    assert.deepEqual(
      first.tasks.map((task) => task.id),
      [taskId],
    );
    assert.equal(first.tasks[0]?.latestRun?.status, 'cancelled');
    assert.equal(first.page.observedTotal, 2);
    assert.equal(first.page.complete, false);
    assert.ok(first.page.nextCursor);
    assert.equal(calls[0]!.query, 'SELECT omnis.list_project_epic_tasks($1,$2,$3,$4,$5) AS result');
    assert.deepEqual(calls[0]!.values, [projectId, epicId, null, null, 1]);

    await store.listTasks(projectId, epicId, { limit: 1, cursor: first.page.nextCursor! });
    assert.equal(calls[1]!.values?.[0], projectId);
    assert.equal(calls[1]!.values?.[1], epicId);
    assert.equal(calls[1]!.values?.[2], createdAt);
    assert.equal(calls[1]!.values?.[3], taskId);
    await assert.rejects(
      store.listTasks(otherProjectId, epicId, { cursor: first.page.nextCursor! }),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_cursor',
    );
    await assert.rejects(
      store.listTasks(projectId, 'epc_ffffffffffffffffffffffffffffffff', {
        cursor: first.page.nextCursor!,
      }),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_cursor',
    );
    await assert.rejects(
      store.listTasks(projectId, epicId, { cursor: `${first.page.nextCursor!.slice(0, -1)}x` }),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_cursor',
    );
    assert.equal(calls.length, 2);
  });

  it('validates task association reads and idempotent assignment receipts', async () => {
    const calls: Array<{ query: string; values?: unknown[] }> = [];
    const association = {
      taskId,
      projectId,
      epicId,
      associationRevision: 3,
    };
    const store = new PostgresProjectEpicStore(
      fakePool((_query, values) => {
        calls.push({ query: 'query', ...(values === undefined ? {} : { values }) });
        return association;
      }, calls),
      key,
    );
    const result = await store.setTaskEpic(
      taskId,
      { expectedAssociationRevision: 2, epicId },
      'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
    );
    assert.deepEqual(result, association);
    assert.match(calls[0]!.query, /omnis\.set_task_epic\(\$1/);
    assert.deepEqual(calls[0]!.values?.slice(0, 4), [
      taskId,
      2,
      epicId,
      'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
    ]);

    const readStore = new PostgresProjectEpicStore(
      fakePool(() => ({
        taskId,
        projectId,
        epic: epic(epicId, createdAt, projectId),
        associationRevision: 3,
      })),
      key,
    );
    assert.equal((await readStore.getTaskEpic(taskId))?.epic?.id, epicId);
    await assert.rejects(
      store.setTaskEpic(
        'bad\0task',
        { expectedAssociationRevision: 1, epicId: null },
        'b9d5fd0e-4681-4a41-90c0-50b120843aa5',
      ),
      (error: unknown) => error instanceof EpicStoreError && error.code === 'invalid_input',
    );
  });
});

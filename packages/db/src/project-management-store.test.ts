import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { PostgresProjectManagementStore, ProjectStoreError } from './project-management-store.ts';

const project = {
  id: 'prj_0123456789abcdef0123456789abcdef',
  ownerId: 'owner',
  key: 'OMNIS-OS',
  name: 'Omnis OS',
  objective: 'A synthetic objective.',
  status: 'proposed',
  priority: 'normal',
  revision: 1,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};

describe('project management store boundary', () => {
  it('calls only the constrained authorizer function and fingerprints canonical input', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        return { rows: [{ result: project }] };
      },
    } as unknown as Pool;
    const key = Buffer.alloc(32, 23);
    const store = new PostgresProjectManagementStore(pool, key, 4);
    const input = { key: 'OMNIS-OS', name: 'Omnis OS', objective: 'A synthetic objective.' };
    const created = await store.create(input, '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2');
    assert.equal(created.id, project.id);
    assert.match(calls[0]!.sql, /SELECT omnis\.create_project/);
    assert.doesNotMatch(calls[0]!.sql, /INSERT INTO omnis\.projects/);
    assert.equal(calls[0]!.values[6], 4);
    assert.deepEqual(
      calls[0]!.values[7],
      createHmac('sha256', key)
        .update('omnis-project-management-idempotency:v1\0')
        .update(
          JSON.stringify({ operation: 'project.created', input: { ...input, priority: 'normal' } }),
        )
        .digest(),
    );
  });

  it('rejects credential-like project text generically before any database write', async () => {
    let called = false;
    const pool = {
      async query() {
        called = true;
        return { rows: [] };
      },
    } as unknown as Pool;
    const store = new PostgresProjectManagementStore(pool, Buffer.alloc(32, 23));
    const rejected = 'password: "synthetic-secret-value-123"';
    await assert.rejects(
      store.create(
        { key: 'SAFE', name: 'Safe', objective: rejected },
        '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2',
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProjectStoreError);
        assert.equal(error.statusCode, 422);
        assert.doesNotMatch(error.message, /synthetic-secret-value/);
        return true;
      },
    );
    assert.equal(called, false);
  });

  it('updates metadata through the scoped function with a normalized fingerprint', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        return { rows: [{ result: { ...project, name: 'Updated name', revision: 2 } }] };
      },
    } as unknown as Pool;
    const key = Buffer.alloc(32, 23);
    const store = new PostgresProjectManagementStore(pool, key, 4);
    const input = { expectedRevision: 1, name: ' Updated name ' };
    const updated = await store.update(project.id, input, '1208f993-29f8-40ee-9d56-c2cbe4f63100');
    assert.equal(updated.revision, 2);
    assert.match(calls[0]!.sql, /SELECT omnis\.update_project/);
    assert.doesNotMatch(calls[0]!.sql, /UPDATE omnis\.projects/);
    assert.equal(calls[0]!.values[1], 1);
    assert.deepEqual(
      calls[0]!.values[7],
      createHmac('sha256', key)
        .update('omnis-project-management-idempotency:v1\0')
        .update(
          JSON.stringify({
            operation: 'project.updated',
            input: {
              projectId: project.id,
              input: { expectedRevision: 1, name: 'Updated name' },
            },
          }),
        )
        .digest(),
    );
  });

  it('archives through the scoped function and rejects unsafe text before database access', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        return { rows: [{ result: { ...project, status: 'archived', revision: 2 } }] };
      },
    } as unknown as Pool;
    const store = new PostgresProjectManagementStore(pool, Buffer.alloc(32, 23));
    const archived = await store.archive(
      project.id,
      { expectedRevision: 1 },
      '1208f993-29f8-40ee-9d56-c2cbe4f63101',
    );
    assert.equal(archived.status, 'archived');
    assert.match(calls[0]!.sql, /SELECT omnis\.archive_project/);
    assert.doesNotMatch(calls[0]!.sql, /UPDATE omnis\.projects/);

    calls.length = 0;
    await assert.rejects(
      store.update(
        project.id,
        { expectedRevision: 1, objective: 'password: "synthetic-secret-value-123456"' },
        '1208f993-29f8-40ee-9d56-c2cbe4f63102',
      ),
      (error: unknown) =>
        error instanceof ProjectStoreError &&
        error.statusCode === 422 &&
        !error.message.includes('synthetic-secret-value'),
    );
    assert.deepEqual(calls, []);
  });

  it('maps stale revisions and invalid lifecycle transitions to safe conflicts', async () => {
    const pool = {
      async query() {
        throw { code: '40001' };
      },
    } as unknown as Pool;
    const store = new PostgresProjectManagementStore(pool, Buffer.alloc(32, 23));
    await assert.rejects(
      store.update(
        project.id,
        { expectedRevision: 1, priority: 'high' },
        '1208f993-29f8-40ee-9d56-c2cbe4f63103',
      ),
      (error: unknown) =>
        error instanceof ProjectStoreError && error.statusCode === 409 && error.code === 'conflict',
    );
    const transitionPool = {
      async query() {
        throw { code: 'P0001' };
      },
    } as unknown as Pool;
    const transitionStore = new PostgresProjectManagementStore(
      transitionPool,
      Buffer.alloc(32, 23),
    );
    await assert.rejects(
      transitionStore.archive(
        project.id,
        { expectedRevision: 1 },
        '1208f993-29f8-40ee-9d56-c2cbe4f63104',
      ),
      (error: unknown) =>
        error instanceof ProjectStoreError &&
        error.statusCode === 409 &&
        error.code === 'invalid_transition',
    );
  });
});

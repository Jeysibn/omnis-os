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
});

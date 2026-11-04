import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DepartmentStoreError,
  PostgresDepartmentManagementStore,
} from './department-management-store.ts';

const timestamp = new Date('2026-11-04T00:00:00.000Z');

function department(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dep_engineering',
    slug: 'engineering',
    name: 'Engineering',
    archived_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function poolStub(options: { references?: boolean; archived?: boolean } = {}) {
  const statements: string[] = [];
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const selected = department(options.archived ? { archived_at: timestamp } : {});
  const pool = {
    async connect() {
      return {
        on() {},
        off() {},
        async query(sql: string, parameters: unknown[] = []) {
          statements.push(sql);
          queries.push({ sql, parameters });
          if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
          if (sql.includes('count(*)::text AS total')) return { rows: [{ total: '0' }] };
          if (sql.includes('FROM omnis.departments') && sql.includes('FOR UPDATE')) {
            return { rows: [selected] };
          }
          if (sql.includes('SELECT EXISTS'))
            return { rows: [{ exists: options.references ?? false }] };
          if (sql.includes('INSERT INTO omnis.departments'))
            return {
              rows: [department({ id: parameters[0], slug: parameters[1], name: parameters[2] })],
            };
          if (sql.includes('UPDATE omnis.departments')) {
            return {
              rows: [
                department({
                  slug: parameters[1] ?? selected.slug,
                  name: parameters[2] ?? selected.name,
                  archived_at: sql.includes('archived_at = now()') ? timestamp : null,
                }),
              ],
            };
          }
          if (sql.includes('INSERT INTO omnis.department_management_audit')) return { rows: [] };
          throw new Error(`Unexpected query ${sql}`);
        },
        release() {},
      };
    },
    async query(sql: string, parameters: unknown[] = []) {
      statements.push(sql);
      queries.push({ sql, parameters });
      if (sql.includes('archive_department')) {
        if (options.references) throw Object.assign(new Error('referenced'), { code: '23514' });
        return { rows: [department({ archived_at: timestamp })] };
      }
      return { rows: [department()] };
    },
  };
  return { pool, statements, queries };
}

describe('department management store', () => {
  it('creates and audits a department in the same transaction', async () => {
    const stub = poolStub();
    const store = new PostgresDepartmentManagementStore(stub.pool as never);
    const created = await store.create({ slug: 'engineering', name: 'Engineering' }, 'req-test-1');
    assert.match(created.id, /^dep_[A-Fa-f0-9]{32}$/);
    assert.deepEqual(
      stub.statements.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)),
      ['BEGIN', 'COMMIT'],
    );
    assert.ok(
      stub.queries.some((query) =>
        query.sql.includes('INSERT INTO omnis.department_management_audit'),
      ),
    );
  });

  it('rejects credential-like department text before opening a database transaction', async () => {
    const stub = poolStub();
    const store = new PostgresDepartmentManagementStore(stub.pool as never);
    await assert.rejects(
      store.create(
        { slug: 'engineering', name: 'password: "synthetic-secret-value-123456"' },
        'req-test-secret',
      ),
      (error: unknown) => {
        assert.ok(error instanceof DepartmentStoreError);
        assert.equal(error.code, 'invalid_input');
        assert.equal(error.statusCode, 422);
        assert.doesNotMatch(error.message, /synthetic-secret-value-123456/);
        return true;
      },
    );
    assert.deepEqual(stub.statements, []);
  });

  it('does not archive a department that is still assigned to an agent', async () => {
    const stub = poolStub({ references: true });
    const store = new PostgresDepartmentManagementStore(stub.pool as never);
    await assert.rejects(store.archive('dep_engineering', 'req-test-2'), (error: unknown) => {
      assert.ok(error instanceof DepartmentStoreError);
      assert.equal(error.code, 'invalid_transition');
      assert.equal(error.statusCode, 409);
      return true;
    });
    assert.equal(
      stub.queries.some((query) => query.sql.includes('UPDATE omnis.departments')),
      false,
    );
    assert.equal(
      stub.queries.some((query) => query.sql.includes('archive_department')),
      true,
    );
  });

  it('keeps archived departments immutable and does not add duplicate archive audit events', async () => {
    const stub = poolStub({ archived: true });
    const store = new PostgresDepartmentManagementStore(stub.pool as never);
    const archived = await store.archive('dep_engineering', 'req-test-3');
    assert.equal(archived.archivedAt, timestamp.toISOString());
    await assert.rejects(
      store.update('dep_engineering', { slug: 'eng', name: 'Eng' }, 'req-test-4'),
      (error: unknown) =>
        error instanceof DepartmentStoreError && error.code === 'invalid_transition',
    );
    assert.equal(
      stub.queries.some((query) => query.sql.includes('archive_department')),
      true,
    );
  });
});

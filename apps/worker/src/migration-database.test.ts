import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPgBossDatabase } from './migration-database.ts';

describe('pg-boss migration database adapter', () => {
  it('executes pg-boss statements through the verified pool', async () => {
    const calls: unknown[][] = [];
    const rows = [{ current_user: 'omnis_migrator', database_name: 'omnis' }];
    const pool = {
      query: async (...args: unknown[]) => {
        calls.push(args);
        return { rows };
      },
    };
    const adapter = createPgBossDatabase(pool);

    assert.deepEqual(await adapter.executeSql('SELECT $1', ['bound-value']), { rows });
    assert.deepEqual(calls, [['SELECT $1', ['bound-value']]]);
  });

  it('returns rows from every statement in pg-boss multi-statement queries', async () => {
    const pool = {
      query: async () => [{ rows: [{ setup: true }] }, { rows: [{ pg_advisory_xact_lock: null }] }],
    };
    const adapter = createPgBossDatabase(pool);

    assert.deepEqual(await adapter.executeSql('SELECT 1; SELECT pg_advisory_xact_lock(1)'), {
      rows: [{ setup: true }, { pg_advisory_xact_lock: null }],
    });
  });

  it('propagates denied pool access without opening another connection', async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls += 1;
        throw new Error('connection denied');
      },
    };
    const adapter = createPgBossDatabase(pool);

    await assert.rejects(adapter.executeSql('SELECT 1'), /connection denied/);
    assert.equal(calls, 1);
  });
});

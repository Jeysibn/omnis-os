import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

const migrationLock = '70463909136523';
const initialMigration = '0001_initial';

export type PgTransaction = Pick<PoolClient, 'query'>;
export type PgBossTransaction = {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
};

export function createPool(config: PoolConfig | string): Pool {
  return new Pool(typeof config === 'string' ? { connectionString: config, max: 8 } : config);
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [migrationLock]);
    await client.query('CREATE SCHEMA IF NOT EXISTS omnis');
    await client.query(`
      CREATE TABLE IF NOT EXISTS omnis.schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query('SELECT 1 FROM omnis.schema_migrations WHERE id = $1', [
      initialMigration,
    ]);
    if (applied.rowCount === 0) {
      await client.query(sql);
      await client.query('INSERT INTO omnis.schema_migrations (id) VALUES ($1)', [
        initialMigration,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function inTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function asPgBossTransaction(client: PoolClient): PgBossTransaction {
  return {
    async executeSql(text, values = []) {
      const result: QueryResult<QueryResultRow> = await client.query(text, values as unknown[]);
      return { rows: result.rows };
    },
  };
}

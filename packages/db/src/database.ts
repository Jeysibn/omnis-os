import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

const migrationLock = '70463909136523';
const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const legacyMigrationChecksums: Readonly<Record<string, string>> = {
  '0001_initial': '12ad77ec4b4fba51776074b09f92a88d9eb391dbc293337def3e2d0302379cd3',
};

export type PgTransaction = Pick<PoolClient, 'query'>;
export type PgBossTransaction = {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
};

export function createPool(config: PoolConfig | string): Pool {
  return new Pool(typeof config === 'string' ? { connectionString: config, max: 8 } : config);
}

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [migrationLock]);
    await client.query('BEGIN');
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS omnis');
      await client.query(`
        CREATE TABLE IF NOT EXISTS omnis.schema_migrations (
          id text PRIMARY KEY,
          checksum text,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        'ALTER TABLE omnis.schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const migrationFiles = (await readdir(migrationDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    for (const file of migrationFiles) {
      const id = path.basename(file, '.sql');
      const sql = await readFile(path.join(migrationDirectory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      await client.query('BEGIN');
      try {
        const applied = await client.query<{ checksum: string | null }>(
          'SELECT checksum FROM omnis.schema_migrations WHERE id = $1 FOR UPDATE',
          [id],
        );
        const previous = applied.rows[0]?.checksum;
        if (applied.rowCount) {
          if (previous && previous !== checksum) {
            throw new Error(`Applied database migration ${id} has been modified.`);
          }
          if (!previous) {
            const expectedLegacy = legacyMigrationChecksums[id];
            if (expectedLegacy && expectedLegacy !== checksum) {
              throw new Error(
                `Legacy database migration ${id} does not match its recorded baseline.`,
              );
            }
            // Upgrade the pre-checksum migration ledger in place without rebuilding application data.
            await client.query('UPDATE omnis.schema_migrations SET checksum = $2 WHERE id = $1', [
              id,
              checksum,
            ]);
          }
        } else {
          await client.query(sql);
          await client.query('INSERT INTO omnis.schema_migrations (id, checksum) VALUES ($1, $2)', [
            id,
            checksum,
          ]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1::bigint)', [migrationLock])
      .catch(() => undefined);
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

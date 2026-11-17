interface QueryPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[] } | Array<{ rows: unknown[] }>>;
}

interface PgBossDatabaseAdapter {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Route pg-boss schema migrations through the already verified PostgreSQL pool. */
export function createPgBossDatabase(pool: QueryPool): PgBossDatabaseAdapter {
  return {
    async executeSql(text, values) {
      const result = await pool.query(text, values);
      return {
        rows: Array.isArray(result) ? result.flatMap((statement) => statement.rows) : result.rows,
      };
    },
  };
}

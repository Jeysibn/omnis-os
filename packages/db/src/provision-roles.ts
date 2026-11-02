import type { Pool } from 'pg';

const databaseRoles = {
  migration: 'omnis_migrator',
  runtime: 'omnis_runtime',
} as const;

export async function provisionDatabaseRoles(
  admin: Pool,
  passwords: { migration: string; runtime: string },
): Promise<void> {
  for (const [name, password] of Object.entries(passwords)) {
    if (password.length < 32)
      throw new Error(`${name} database password must be at least 32 characters.`);
  }

  const { rows } = await admin.query<{ is_superuser: boolean; database_name: string }>(
    "SELECT current_setting('is_superuser')::boolean AS is_superuser, current_database() AS database_name",
  );
  if (!rows[0]?.is_superuser)
    throw new Error('Database role provisioning requires the administrative role.');
  const databaseName = rows[0].database_name;
  if (!/^omnis(?:_[a-z0-9_]+)?$/.test(databaseName)) {
    throw new Error('Role provisioning is restricted to an Omnis database name.');
  }

  for (const [key, role] of Object.entries(databaseRoles) as [
    keyof typeof databaseRoles,
    string,
  ][]) {
    const password = passwords[key];
    const quoted = await admin.query<{ literal: string }>('SELECT quote_literal($1) AS literal', [
      password,
    ]);
    await admin.query(`
      DO $provision$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role};
        END IF;
      END
      $provision$
    `);
    await admin.query(
      `ALTER ROLE ${role} WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${quoted.rows[0]!.literal}`,
    );
  }

  const memberships = await admin.query<{ granted_role: string; member_role: string }>(`
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
      FROM pg_auth_members memberships
      JOIN pg_roles granted ON granted.oid = memberships.roleid
      JOIN pg_roles member ON member.oid = memberships.member
     WHERE granted.rolname IN ('omnis_migrator', 'omnis_runtime')
        OR member.rolname IN ('omnis_migrator', 'omnis_runtime')
  `);
  for (const membership of memberships.rows) {
    await admin.query(
      `REVOKE ${quoteIdentifier(membership.granted_role)} FROM ${quoteIdentifier(membership.member_role)}`,
    );
  }

  await admin.query(
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO omnis_migrator, omnis_runtime`,
  );
  await admin.query(`GRANT CREATE ON DATABASE ${quoteIdentifier(databaseName)} TO omnis_migrator`);
  await admin.query('CREATE SCHEMA IF NOT EXISTS omnis AUTHORIZATION omnis_migrator');
  await admin.query('ALTER SCHEMA omnis OWNER TO omnis_migrator');
  await admin.query('CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION omnis_migrator');
  await admin.query('ALTER SCHEMA pgboss OWNER TO omnis_migrator');

  for (const schema of ['omnis', 'pgboss']) {
    const relations = await admin.query<{ name: string; kind: string }>(
      `SELECT c.relname AS name, c.relkind AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`,
      [schema],
    );
    for (const relation of relations.rows) {
      const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(relation.name)}`;
      const objectType = relation.kind === 'S' ? 'SEQUENCE' : 'TABLE';
      await admin.query(`ALTER ${objectType} ${qualified} OWNER TO omnis_migrator`);
    }
  }

  await admin.query('GRANT USAGE ON SCHEMA omnis, pgboss TO omnis_runtime');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA omnis, pgboss TO omnis_runtime',
  );
  await admin.query(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA omnis, pgboss TO omnis_runtime',
  );
  await admin.query(`
    ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis
      GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
      GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;
  `);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

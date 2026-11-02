export const restoreRoleSecurityQuery = `SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'name', roles.rolname,
  'login', roles.rolcanlogin,
  'inherit', roles.rolinherit,
  'superuser', roles.rolsuper,
  'createRole', roles.rolcreaterole,
  'createDatabase', roles.rolcreatedb,
  'replication', roles.rolreplication,
  'bypassRls', roles.rolbypassrls,
  'membershipCount', (
    SELECT count(*)::integer
      FROM pg_auth_members memberships
     WHERE memberships.member = roles.oid OR memberships.roleid = roles.oid
  )
) ORDER BY roles.rolname), '[]'::jsonb) AS role_security
FROM pg_roles roles
WHERE roles.rolname IN ('omnis', 'omnis_migrator', 'omnis_runtime')`;

const expectedRoles = {
  omnis: {
    login: true,
    superuser: true,
  },
  omnis_migrator: {
    login: true,
    inherit: false,
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    membershipCount: 0,
  },
  omnis_runtime: {
    login: true,
    inherit: false,
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    membershipCount: 0,
  },
};

export function assertRestoreRoleSecurity(roles) {
  if (!Array.isArray(roles)) throw new Error('PostgreSQL role security snapshot must be an array.');

  for (const [name, expected] of Object.entries(expectedRoles)) {
    const actual = roles.find((role) => role?.name === name);
    if (!actual) throw new Error(`Required PostgreSQL role ${name} is missing.`);
    for (const [attribute, value] of Object.entries(expected)) {
      if (actual[attribute] !== value) {
        throw new Error(`PostgreSQL role ${name} has unsafe ${attribute} attribute.`);
      }
    }
  }
}

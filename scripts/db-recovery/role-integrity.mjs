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
  ),
  'timeoutSettings', COALESCE((
    SELECT jsonb_object_agg(split_part(setting, '=', 1), split_part(setting, '=', 2))
      FROM pg_db_role_setting defaults
      CROSS JOIN LATERAL unnest(defaults.setconfig) AS entry(setting)
     WHERE defaults.setrole = roles.oid AND defaults.setdatabase = 0
       AND split_part(setting, '=', 1) = ANY(ARRAY[
         'lock_timeout', 'statement_timeout',
         'idle_in_transaction_session_timeout', 'idle_session_timeout'
       ])
  ), '{}'::jsonb),
  'databaseTimeoutOverrides', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'database', databases.datname,
      'scope', CASE WHEN overrides.setrole = 0 THEN 'database' ELSE 'role_database' END,
      'setting', split_part(setting, '=', 1),
      'value', split_part(setting, '=', 2)
    ) ORDER BY databases.datname, overrides.setrole, split_part(setting, '=', 1))
      FROM pg_db_role_setting overrides
      JOIN pg_database databases ON databases.oid = overrides.setdatabase
      CROSS JOIN LATERAL unnest(overrides.setconfig) AS entry(setting)
     WHERE overrides.setdatabase <> 0
       AND (overrides.setrole = roles.oid OR overrides.setrole = 0)
       AND split_part(setting, '=', 1) = ANY(ARRAY[
         'lock_timeout', 'statement_timeout',
         'idle_in_transaction_session_timeout', 'idle_session_timeout'
       ])
  ), '[]'::jsonb)
) ORDER BY roles.rolname), '[]'::jsonb) AS role_security
FROM pg_roles roles
WHERE roles.rolname IN ('omnis', 'omnis_migrator', 'omnis_runtime', 'omnis_authorizer', 'omnis_launcher')`;

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
  omnis_authorizer: {
    login: true,
    inherit: false,
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    membershipCount: 0,
  },
  omnis_launcher: {
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

const expectedTimeoutSettings = {
  // The superuser is an operator-managed recovery principal, not a pooled
  // application role with one repository-owned timeout profile.
  omnis: undefined,
  omnis_migrator: {},
  omnis_runtime: {
    lock_timeout: '3s',
    statement_timeout: '20s',
    idle_in_transaction_session_timeout: '20s',
  },
  omnis_authorizer: {
    lock_timeout: '3s',
    statement_timeout: '15s',
    idle_in_transaction_session_timeout: '20s',
  },
  omnis_launcher: {
    lock_timeout: '3s',
    statement_timeout: '10s',
    idle_in_transaction_session_timeout: '10s',
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
    if (
      expectedTimeoutSettings[name] &&
      !sameSettingMap(actual.timeoutSettings, expectedTimeoutSettings[name])
    ) {
      throw new Error(`PostgreSQL role ${name} timeout policy is missing or unsafe.`);
    }
    if (!Array.isArray(actual.databaseTimeoutOverrides)) {
      throw new Error(`PostgreSQL role ${name} database timeout settings are malformed.`);
    }
    if (name !== 'omnis' && actual.databaseTimeoutOverrides.length > 0) {
      throw new Error(`PostgreSQL role ${name} has database timeout overrides.`);
    }
  }
}

function sameSettingMap(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const actualNames = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  return (
    actualNames.length === expectedNames.length &&
    actualNames.every(
      (name, index) => name === expectedNames[index] && actual[name] === expected[name],
    )
  );
}

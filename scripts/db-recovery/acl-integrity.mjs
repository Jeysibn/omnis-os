export const aclSnapshotQuery = `WITH user_schemas AS (
  SELECT oid, nspname, nspowner, nspacl
    FROM pg_namespace
   WHERE nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
     AND nspname !~ '^pg_(toast_)?temp_[0-9]+$'
), acl_entries AS (
  SELECT 'schema'::text AS object_type, n.nspname AS schema_name, n.nspname AS object_name,
         NULL::text AS column_name, acl.grantee, acl.privilege_type AS privilege,
         acl.is_grantable AS grantable, NULL::boolean AS security_definer
    FROM user_schemas n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
  UNION ALL
  SELECT 'database', '', 'database', NULL::text, acl.grantee, acl.privilege_type,
         acl.is_grantable, NULL::boolean
    FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
   WHERE d.datname = current_database()
  UNION ALL
  SELECT CASE c.relkind
           WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
           WHEN 'f' THEN 'foreign_table' ELSE 'table'
         END,
         n.nspname, c.relname, NULL::text, acl.grantee, acl.privilege_type,
         acl.is_grantable, NULL::boolean
    FROM pg_class c
    JOIN user_schemas n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      c.relacl,
      CASE WHEN c.relkind = 'S' THEN acldefault('S', c.relowner)
           ELSE acldefault('r', c.relowner) END
    )) acl
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'column', n.nspname, c.relname, a.attname,
         acl.grantee, acl.privilege_type, acl.is_grantable, NULL::boolean
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN user_schemas n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(a.attacl) acl
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  UNION ALL
  SELECT 'routine', n.nspname,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         NULL::text, acl.grantee, acl.privilege_type, acl.is_grantable, p.prosecdef
    FROM pg_proc p
    JOIN user_schemas n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  UNION ALL
  SELECT 'type', n.nspname, t.typname, NULL::text,
         acl.grantee, acl.privilege_type, acl.is_grantable, NULL::boolean
    FROM pg_type t
    JOIN user_schemas n ON n.oid = t.typnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) acl
   WHERE t.typtype IN ('d', 'e', 'r', 'm')
  UNION ALL
  SELECT 'default:' || CASE d.defaclobjtype
           WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'routine'
           WHEN 'T' THEN 'type' WHEN 'n' THEN 'schema' ELSE d.defaclobjtype::text
         END,
         COALESCE(n.nspname, ''), '', NULL::text,
         acl.grantee, acl.privilege_type, acl.is_grantable, NULL::boolean
    FROM pg_default_acl d
    LEFT JOIN user_schemas n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
   WHERE d.defaclnamespace = 0 OR n.oid IS NOT NULL
  UNION ALL
  SELECT 'membership', '', member.rolname, NULL::text, runtime.oid,
         'ROLE_MEMBERSHIP', false, NULL::boolean
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles runtime ON runtime.rolname = 'omnis_runtime'
   WHERE granted.rolname = 'omnis_runtime' OR member.rolname = 'omnis_runtime'
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'objectType', object_type,
  'schema', schema_name,
  'object', object_name,
  'column', column_name,
  'grantee', CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END,
  'privilege', privilege,
  'grantable', grantable,
  'securityDefiner', security_definer
) ORDER BY schema_name, object_type, object_name, column_name, grantee, privilege, grantable), '[]'::jsonb)
  AS acl_snapshot
FROM acl_entries`;

const knownRoles = new Set([
  'omnis',
  'omnis_migrator',
  'omnis_runtime',
  'postgres',
  'pg_database_owner',
  'PUBLIC',
]);
const applicationReadTables = new Set(['tasks', 'runs', 'run_events', 'run_idempotency']);
const applicationColumnPrivileges = new Map([
  ['tasks', new Set(['INSERT:id', 'INSERT:title', 'INSERT:detail', 'UPDATE:status'])],
  [
    'runs',
    new Set([
      'INSERT:id',
      'INSERT:task_id',
      'INSERT:task_title',
      ...[
        'status',
        'execution_generation',
        'lease_owner',
        'lease_expires_at',
        'updated_at',
        'result_output',
        'result_evidence_refs',
        'pg_boss_job_id',
        'last_event_sequence',
      ].map((column) => `UPDATE:${column}`),
    ]),
  ],
  [
    'run_events',
    new Set(
      ['id', 'run_id', 'sequence', 'event_type', 'at', 'message'].map(
        (column) => `INSERT:${column}`,
      ),
    ),
  ],
  [
    'run_idempotency',
    new Set(
      ['idempotency_key', 'request_fingerprint', 'run_id'].map((column) => `INSERT:${column}`),
    ),
  ],
]);

export function normalizeAclSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) throw new Error('PostgreSQL ACL snapshot must be an array.');
  return snapshot
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.objectType !== 'string' ||
        typeof entry.schema !== 'string' ||
        typeof entry.object !== 'string' ||
        typeof entry.grantee !== 'string' ||
        typeof entry.privilege !== 'string' ||
        (entry.column != null && typeof entry.column !== 'string') ||
        typeof entry.grantable !== 'boolean' ||
        (entry.securityDefiner != null && typeof entry.securityDefiner !== 'boolean')
      ) {
        throw new Error('PostgreSQL ACL snapshot contains a malformed entry.');
      }
      return {
        objectType: entry.objectType,
        schema: entry.schema,
        object: entry.object,
        column: entry.column ?? null,
        grantee: entry.grantee,
        privilege: entry.privilege,
        grantable: entry.grantable,
        securityDefiner: entry.securityDefiner ?? null,
      };
    })
    .sort(compareAclEntries);
}

export function aclSnapshotsMatch(source, restored) {
  return (
    JSON.stringify(normalizeAclSnapshot(source)) === JSON.stringify(normalizeAclSnapshot(restored))
  );
}

export function runtimeAclSnapshotsMatch(source, restored) {
  const runtimeEntries = (snapshot) =>
    normalizeAclSnapshot(snapshot).filter((entry) => entry.grantee === 'omnis_runtime');
  return JSON.stringify(runtimeEntries(source)) === JSON.stringify(runtimeEntries(restored));
}

const deferredDatabaseConnectGrantees = new Set(['PUBLIC', 'omnis_runtime']);

export function assertRestoreDatabaseClosed(snapshot) {
  for (const entry of normalizeAclSnapshot(snapshot)) {
    if (
      entry.objectType === 'database' &&
      entry.privilege === 'CONNECT' &&
      deferredDatabaseConnectGrantees.has(entry.grantee)
    ) {
      throw new Error(
        `Unverified restore database grants CONNECT to ${entry.grantee}; target must remain closed.`,
      );
    }
  }
}

export function restoreAclSnapshotsMatch(source, restored) {
  const withoutDeferredConnect = (snapshot) =>
    normalizeAclSnapshot(snapshot).filter(
      (entry) =>
        !(
          entry.objectType === 'database' &&
          entry.privilege === 'CONNECT' &&
          deferredDatabaseConnectGrantees.has(entry.grantee)
        ),
    );
  return (
    JSON.stringify(withoutDeferredConnect(source)) ===
    JSON.stringify(withoutDeferredConnect(restored))
  );
}

export function assertRuntimeAclPolicy(snapshot) {
  for (const entry of normalizeAclSnapshot(snapshot)) {
    if (!knownRoles.has(entry.grantee)) {
      throw new Error(`Unexpected PostgreSQL ACL grantee ${entry.grantee}.`);
    }
    if (entry.objectType === 'membership') {
      throw new Error(
        `Direct membership involving the runtime role is prohibited: ${entry.object}.`,
      );
    }
    if (entry.grantee === 'PUBLIC') {
      if (
        entry.objectType === 'routine' &&
        entry.privilege === 'EXECUTE' &&
        entry.securityDefiner === false
      ) {
        continue;
      }
      if (entry.objectType === 'type' && entry.privilege === 'USAGE') continue;
      if (
        entry.objectType === 'schema' &&
        entry.schema === 'public' &&
        entry.privilege === 'USAGE'
      ) {
        continue;
      }
      if (entry.objectType === 'database' && ['CONNECT', 'TEMPORARY'].includes(entry.privilege)) {
        continue;
      }
      throw new Error(
        `PostgreSQL ACL grants ${entry.privilege} to PUBLIC on ${entry.schema || 'database'}.${entry.object}.`,
      );
    }
    if (entry.grantee !== 'omnis_runtime') continue;
    if (entry.grantable) {
      throw new Error(`Runtime ACL grant option is prohibited on ${entry.schema}.${entry.object}.`);
    }

    if (entry.objectType === 'database') {
      if (entry.privilege !== 'CONNECT') {
        throw new Error(`Runtime database privilege ${entry.privilege} is prohibited.`);
      }
      continue;
    }

    if (entry.objectType === 'schema') {
      if (!['omnis', 'pgboss'].includes(entry.schema) || entry.privilege !== 'USAGE') {
        throw new Error(
          `Runtime schema privilege ${entry.privilege} is prohibited on ${entry.object}.`,
        );
      }
      continue;
    }

    if (entry.objectType === 'table' && entry.schema === 'omnis') {
      if (!applicationReadTables.has(entry.object) || entry.privilege !== 'SELECT') {
        throw new Error(
          `Runtime table privilege ${entry.privilege} is prohibited on omnis.${entry.object}.`,
        );
      }
      continue;
    }

    if (entry.objectType === 'column' && entry.schema === 'omnis') {
      const allowed = applicationColumnPrivileges.get(entry.object);
      if (!allowed?.has(`${entry.privilege}:${entry.column}`)) {
        throw new Error(
          `Runtime column privilege ${entry.privilege} on omnis.${entry.object}.${entry.column} is prohibited.`,
        );
      }
      continue;
    }

    if (entry.objectType === 'table' && entry.schema === 'pgboss') {
      if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(entry.privilege)) {
        throw new Error(
          `Runtime pg-boss privilege ${entry.privilege} is prohibited on ${entry.object}.`,
        );
      }
      continue;
    }

    if (entry.objectType === 'sequence' && entry.schema === 'pgboss') {
      if (!['USAGE', 'SELECT'].includes(entry.privilege)) {
        throw new Error(
          `Runtime sequence privilege ${entry.privilege} is prohibited on pgboss.${entry.object}.`,
        );
      }
      continue;
    }

    if (
      entry.objectType === 'sequence' &&
      entry.schema === 'omnis' &&
      ['task_id_seq', 'run_id_seq'].includes(entry.object) &&
      ['USAGE', 'SELECT'].includes(entry.privilege)
    ) {
      continue;
    }

    if (entry.objectType === 'default:sequence' && entry.schema === 'pgboss') {
      if (!['USAGE', 'SELECT'].includes(entry.privilege)) {
        throw new Error(
          `Runtime default sequence privilege ${entry.privilege} is prohibited in pgboss.`,
        );
      }
      continue;
    }

    if (entry.objectType === 'default:table' && entry.schema === 'pgboss') {
      if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(entry.privilege)) {
        throw new Error(
          `Runtime default table privilege ${entry.privilege} is prohibited in pgboss.`,
        );
      }
      continue;
    }

    throw new Error(
      `Runtime ${entry.objectType} privilege ${entry.privilege} is prohibited on ${entry.schema}.${entry.object}.`,
    );
  }
}

function compareAclEntries(left, right) {
  return [
    left.schema,
    left.objectType,
    left.object,
    left.column ?? '',
    left.grantee,
    left.privilege,
    left.grantable,
  ]
    .join('\0')
    .localeCompare(
      [
        right.schema,
        right.objectType,
        right.object,
        right.column ?? '',
        right.grantee,
        right.privilege,
        right.grantable,
      ].join('\0'),
    );
}

export const aclSnapshotQuery = `WITH acl_entries AS (
  SELECT 'schema'::text AS object_type, n.nspname AS schema_name, n.nspname AS object_name,
         NULL::text AS column_name, acl.grantee, acl.privilege_type AS privilege,
         acl.is_grantable AS grantable, NULL::boolean AS security_definer
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
   WHERE n.nspname IN ('omnis', 'pgboss')
  UNION ALL
  SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'table' END,
         n.nspname, c.relname, NULL::text, acl.grantee, acl.privilege_type,
         acl.is_grantable, NULL::boolean
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      c.relacl,
      CASE WHEN c.relkind = 'S'
        THEN acldefault('S', c.relowner)
        ELSE acldefault('r', c.relowner)
      END
    )) acl
   WHERE n.nspname IN ('omnis', 'pgboss')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'column', n.nspname, c.relname, a.attname,
         acl.grantee, acl.privilege_type, acl.is_grantable, NULL::boolean
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(a.attacl) acl
   WHERE n.nspname IN ('omnis', 'pgboss')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  UNION ALL
  SELECT 'routine', n.nspname,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         NULL::text, acl.grantee, acl.privilege_type, acl.is_grantable, p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
   WHERE n.nspname IN ('omnis', 'pgboss')
  UNION ALL
  SELECT 'type', n.nspname, t.typname, NULL::text,
         acl.grantee, acl.privilege_type, acl.is_grantable, NULL::boolean
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl, acldefault('T', t.typowner))) acl
   WHERE n.nspname IN ('omnis', 'pgboss')
     AND t.typtype IN ('d', 'e', 'r', 'm')
  UNION ALL
  SELECT 'default:' || CASE d.defaclobjtype
           WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'routine'
           WHEN 'T' THEN 'type' WHEN 'n' THEN 'schema' ELSE d.defaclobjtype::text
         END,
         COALESCE(n.nspname, ''), '', NULL::text,
         acl.grantee, acl.privilege_type, acl.is_grantable
         ,NULL::boolean
    FROM pg_default_acl d
    JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
   WHERE owner_role.rolname = 'omnis_migrator'
     AND (d.defaclnamespace = 0 OR n.nspname IN ('omnis', 'pgboss'))
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

const knownRoles = new Set(['omnis', 'omnis_migrator', 'omnis_runtime', 'PUBLIC']);
const applicationTablePrivileges = new Map([
  ['tasks', new Set(['SELECT'])],
  ['runs', new Set(['SELECT'])],
  ['run_events', new Set(['SELECT'])],
  ['run_idempotency', new Set(['SELECT'])],
]);
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
    .map((entry) => ({
      objectType: entry.objectType,
      schema: entry.schema,
      object: entry.object,
      column: entry.column ?? null,
      grantee: entry.grantee,
      privilege: entry.privilege,
      grantable: entry.grantable === true,
      securityDefiner: entry.securityDefiner ?? null,
    }))
    .sort(compareAclEntries);
}

export function aclSnapshotsMatch(source, restored) {
  return (
    JSON.stringify(normalizeAclSnapshot(source)) === JSON.stringify(normalizeAclSnapshot(restored))
  );
}

export function assertRuntimeAclPolicy(snapshot) {
  for (const entry of normalizeAclSnapshot(snapshot)) {
    if (!knownRoles.has(entry.grantee)) {
      throw new Error(`Unexpected PostgreSQL ACL grantee ${entry.grantee}.`);
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
      throw new Error(
        `PostgreSQL ACL grants ${entry.privilege} to PUBLIC on ${entry.schema}.${entry.object}.`,
      );
    }
    if (entry.grantee !== 'omnis_runtime') continue;
    if (entry.grantable) {
      throw new Error(`Runtime ACL grant option is prohibited on ${entry.schema}.${entry.object}.`);
    }

    if (entry.objectType === 'schema') {
      if (entry.privilege !== 'USAGE') {
        throw new Error(
          `Runtime schema privilege ${entry.privilege} is prohibited on ${entry.object}.`,
        );
      }
      continue;
    }

    if (entry.objectType === 'table' && entry.schema === 'omnis') {
      const allowed = applicationTablePrivileges.get(entry.object);
      if (!allowed?.has(entry.privilege) && entry.privilege !== 'SELECT') {
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

    if (entry.objectType === 'sequence' && ['omnis', 'pgboss'].includes(entry.schema)) {
      if (!['USAGE', 'SELECT'].includes(entry.privilege)) {
        throw new Error(
          `Runtime sequence privilege ${entry.privilege} is prohibited on ${entry.schema}.${entry.object}.`,
        );
      }
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

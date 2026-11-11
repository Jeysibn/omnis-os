export const aclSnapshotQuery = `WITH user_schemas AS (
  SELECT oid, nspname, nspowner, nspacl
    FROM pg_namespace
   WHERE nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
     AND nspname !~ '^pg_(toast_)?temp_[0-9]+$'
), acl_entries AS (
  SELECT 'schema'::text AS object_type, n.nspname AS schema_name, n.nspname::text AS object_name,
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
         p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')',
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
  'omnis_authorizer',
  'omnis_launcher',
  'postgres',
  'pg_database_owner',
  'PUBLIC',
]);
const applicationReadTables = new Set([
  'tasks',
  'runs',
  'run_events',
  'run_idempotency',
  'mission_lane_clock',
  'mission_lane_events',
  'task_result_acceptances',
  'runtime_authorizations',
  'departments',
  'agents',
  'agent_profile_versions',
]);
const applicationColumnPrivileges = new Map([
  ['tasks', new Set(['UPDATE:status'])],
  [
    'runs',
    new Set([
      'INSERT:id',
      'INSERT:task_id',
      'INSERT:task_title',
      'INSERT:connector_authorization_id',
      'INSERT:connector_request_id',
      'INSERT:connector_correlation_id',
      'INSERT:connector_request_binding',
      'UPDATE:connector_attempt_id',
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
    'run_idempotency',
    new Set(
      ['idempotency_key', 'request_fingerprint', 'run_id'].map((column) => `INSERT:${column}`),
    ),
  ],
]);
const approvedSecurityDefinerRoutineArities = new Map([
  ['consume_run_authorization', 4],
  ['lock_active_run_authorization', 1],
  ['lock_run_authorization_for_admission', 2],
  ['append_runtime_admission_denial', 3],
  ['append_runtime_authorization_audit', 3],
  ['append_runtime_run_event', 3],
]);
const approvedTaskProjectRoutines = new Set([
  'create_task(p_title text, p_detail text, p_project_id text, p_request_id uuid, p_fingerprint bytea, p_remaining_ms integer)',
  'set_task_project(p_task_id text, p_expected_association_revision integer, p_project_id text, p_request_id uuid, p_fingerprint bytea, p_remaining_ms integer)',
  'set_task_epic(p_task_id text, p_expected_association_revision integer, p_epic_id text, p_request_id uuid, p_fingerprint bytea, p_remaining_ms integer)',
  'set_task_execution_assignment(p_task_id text, p_expected_revision integer, p_agent_id text, p_profile_version_no integer, p_runtime_id text, p_request_id uuid, p_fingerprint bytea)',
]);
const approvedRuntimeAdmissionRoutines = new Set([
  'acquire_mission_lane_admission(p_critical boolean, p_remaining_ms integer)',
]);

function isApprovedRuntimeSecurityDefiner(entry) {
  if (entry.objectType !== 'routine' || entry.schema !== 'omnis') return false;
  if (approvedTaskProjectRoutines.has(entry.object)) return true;
  if (approvedRuntimeAdmissionRoutines.has(entry.object)) return entry.securityDefiner === true;
  const match = /^([a-z_][a-z0-9_]*)\((.*)\)$/.exec(entry.object);
  if (!match) return false;
  const arity = approvedSecurityDefinerRoutineArities.get(match[1]);
  const argumentsList = match[2] ? match[2].split(',') : [];
  return (
    arity !== undefined &&
    argumentsList.length === arity &&
    argumentsList.every((argument) => argument.trim().split(/\s+/).at(-1) === 'text')
  );
}

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

const deferredDatabaseConnectGrantees = new Set([
  'PUBLIC',
  'omnis_runtime',
  'omnis_authorizer',
  'omnis_launcher',
]);

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
        ) &&
        // pg_restore --no-owner recreates this sequence as omnis_migrator.
        // Its intrinsic owner privileges replace explicit owner ACL entries
        // that pg_dump omits from the archive.
        !(
          entry.objectType === 'sequence' &&
          entry.schema === 'omnis' &&
          entry.object === 'task_id_seq' &&
          entry.grantee === 'omnis_migrator' &&
          ['SELECT', 'UPDATE'].includes(entry.privilege)
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
    if (entry.grantee === 'omnis_authorizer') {
      if (entry.grantable) {
        throw new Error(
          `Authorizer ACL grant option is prohibited on ${entry.schema}.${entry.object}.`,
        );
      }
      if (entry.objectType === 'database' && entry.privilege === 'CONNECT') continue;
      if (
        entry.objectType === 'routine' &&
        entry.schema === 'omnis' &&
        [
          'revoke_run_authorization(p_authorization_id text, p_actor_id text)',
          'accept_task_result(p_task_id text, p_run_id text, p_request_id uuid)',
          'acquire_mission_lane_admission(p_critical boolean, p_remaining_ms integer)',
          'archive_department(p_department_id text, p_request_id text)',
          'create_agent(p_id text, p_name text, p_slug text, p_department_id text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'get_agent_profile_draft(p_agent_id text)',
          'save_agent_profile_draft(p_agent_id text, p_expected_revision bigint, p_base_version_no integer, p_profile jsonb, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'publish_agent_profile(p_agent_id text, p_expected_version_no integer, p_expected_revision bigint, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'archive_agent(p_agent_id text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'update_agent_identity(p_agent_id text, p_expected_revision bigint, p_name text, p_slug text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'create_project(p_id text, p_key text, p_name text, p_objective text, p_priority text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'list_projects()',
          'get_project(p_id text)',
          'update_project(p_id text, p_expected_revision integer, p_name text, p_objective text, p_priority text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'archive_project(p_id text, p_expected_revision integer, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'list_project_milestones(p_project_id text, p_after_created_at timestamp with time zone, p_after_id text, p_limit integer)',
          'get_project_milestone(p_project_id text, p_id text)',
          'create_project_milestone(p_id text, p_project_id text, p_title text, p_description text, p_target_date date, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'update_project_milestone(p_project_id text, p_id text, p_expected_revision integer, p_title text, p_description text, p_description_supplied boolean, p_target_date date, p_target_date_supplied boolean, p_status text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'archive_project_milestone(p_project_id text, p_id text, p_expected_revision integer, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'list_project_epics(p_project_id text, p_after_created_at timestamp with time zone, p_after_id text, p_limit integer)',
          'get_project_epic(p_project_id text, p_id text)',
          'create_project_epic(p_id text, p_project_id text, p_title text, p_description text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'update_project_epic(p_project_id text, p_id text, p_expected_revision integer, p_title text, p_description text, p_description_supplied boolean, p_status text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'archive_project_epic(p_project_id text, p_id text, p_expected_revision integer, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
          'get_task_epic(p_task_id text)',
          'list_project_epic_tasks(p_project_id text, p_epic_id text, p_after_created_at timestamp with time zone, p_after_task_id text, p_limit integer)',
          'set_task_epic(p_task_id text, p_expected_association_revision integer, p_epic_id text, p_request_id uuid, p_fingerprint bytea, p_remaining_ms integer)',
        ].includes(entry.object) &&
        entry.privilege === 'EXECUTE' &&
        entry.securityDefiner === true
      )
        continue;
      if (entry.objectType === 'schema' && entry.schema === 'omnis' && entry.privilege === 'USAGE')
        continue;
      if (
        entry.objectType === 'table' &&
        entry.schema === 'omnis' &&
        ((entry.object === 'authorization_audit' &&
          ['SELECT', 'INSERT'].includes(entry.privilege)) ||
          (entry.object === 'runtime_authorizations' && entry.privilege === 'SELECT') ||
          (entry.object === 'connector_authorizations' &&
            ['SELECT', 'INSERT'].includes(entry.privilege)) ||
          (entry.object === 'connector_execution_attempts' &&
            ['SELECT', 'INSERT'].includes(entry.privilege)) ||
          (entry.object === 'connector_authorization_audit' &&
            ['SELECT', 'INSERT'].includes(entry.privilege)) ||
          (entry.object === 'task_result_acceptances' && entry.privilege === 'SELECT') ||
          (entry.object === 'departments' && entry.privilege === 'SELECT'))
      )
        continue;
      if (
        entry.objectType === 'column' &&
        entry.schema === 'omnis' &&
        entry.object === 'departments' &&
        entry.privilege === 'INSERT' &&
        ['id', 'slug', 'name'].includes(entry.column)
      )
        continue;
      if (
        entry.objectType === 'column' &&
        entry.schema === 'omnis' &&
        entry.object === 'departments' &&
        entry.privilege === 'UPDATE' &&
        ['slug', 'name', 'updated_at'].includes(entry.column)
      )
        continue;
      if (
        entry.objectType === 'column' &&
        entry.schema === 'omnis' &&
        entry.object === 'department_management_audit' &&
        entry.privilege === 'INSERT' &&
        ['id', 'department_id', 'actor_id', 'action', 'request_id'].includes(entry.column)
      )
        continue;
      if (
        entry.objectType === 'column' &&
        entry.schema === 'omnis' &&
        entry.object === 'runtime_authorizations' &&
        entry.privilege === 'INSERT' &&
        [
          'id',
          'requesting_actor',
          'runtime_id',
          'operation',
          'task_id',
          'capabilities',
          'scope',
          'policy_version',
          'correlation_id',
          'expires_at',
        ].includes(entry.column)
      )
        continue;
      if (
        entry.objectType === 'table' &&
        entry.schema === 'omnis' &&
        entry.object === 'tasks' &&
        entry.privilege === 'SELECT'
      )
        continue;
      if (
        entry.objectType === 'column' &&
        entry.schema === 'omnis' &&
        entry.object === 'runtime_authorizations' &&
        entry.privilege === 'UPDATE' &&
        ['status', 'decided_at', 'decided_by', 'revoked_at', 'revoked_by'].includes(entry.column)
      )
        continue;
      if (
        entry.objectType === 'column' &&
        entry.schema === 'omnis' &&
        entry.object === 'connector_authorizations' &&
        entry.privilege === 'UPDATE' &&
        [
          'status',
          'consented_at',
          'decided_at',
          'decided_by',
          'revoked_at',
          'revoked_by',
          'revocation_generation',
          'consumed_at',
          'consumed_request_id',
        ].includes(entry.column)
      )
        continue;
      if (
        entry.objectType === 'column' &&
        entry.schema === 'omnis' &&
        entry.object === 'connector_execution_attempts' &&
        entry.privilege === 'UPDATE' &&
        [
          'status',
          'submission_started_at',
          'broker_generation',
          'broker_lease_owner_id',
          'broker_lease_expires_at',
          'provider_submission_id',
          'cancel_requested_at',
          'response_text',
          'usage_provenance',
          'updated_at',
        ].includes(entry.column)
      )
        continue;
      if (
        entry.objectType === 'routine' &&
        entry.schema === 'omnis' &&
        entry.object ===
          'validate_connector_authorization_context(p_project_id text, p_project_revision integer, p_task_id text, p_task_revision integer, p_agent_id text, p_profile_version integer)' &&
        entry.privilege === 'EXECUTE' &&
        entry.securityDefiner === true
      )
        continue;
      throw new Error(
        `Authorizer ACL ${entry.privilege} is prohibited on ${entry.schema}.${entry.object}.`,
      );
    }
    if (entry.grantee === 'omnis_launcher') {
      if (entry.grantable)
        throw new Error(
          `Launcher ACL grant option is prohibited on ${entry.schema}.${entry.object}.`,
        );
      if (entry.objectType === 'database' && entry.privilege === 'CONNECT') continue;
      if (entry.objectType === 'schema' && entry.schema === 'omnis' && entry.privilege === 'USAGE')
        continue;
      if (
        entry.objectType === 'routine' &&
        entry.schema === 'omnis' &&
        [
          'authorize_mock_sandbox_launch(p_run_id text, p_worker_id text, p_generation integer)',
          'list_authorized_active_mock_runs(p_candidate_ids text[])',
        ].includes(entry.object) &&
        entry.privilege === 'EXECUTE' &&
        entry.securityDefiner === true
      )
        continue;
      throw new Error(
        `Launcher ACL ${entry.privilege} is prohibited on ${entry.schema}.${entry.object}.`,
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

    if (
      isApprovedRuntimeSecurityDefiner(entry) &&
      entry.privilege === 'EXECUTE' &&
      entry.securityDefiner === true
    ) {
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
      entry.object === 'run_id_seq' &&
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

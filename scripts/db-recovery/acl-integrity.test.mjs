import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aclSnapshotsMatch,
  assertRestoreDatabaseClosed,
  assertRuntimeAclPolicy,
  normalizeAclSnapshot,
  restoreAclSnapshotsMatch,
  runtimeAclSnapshotsMatch,
} from './acl-integrity.mjs';

const allowed = [
  acl('schema', 'omnis', 'omnis', 'USAGE'),
  acl('schema', 'pgboss', 'pgboss', 'USAGE'),
  acl('schema', 'public', 'public', 'USAGE', null, 'PUBLIC'),
  acl('database', '', 'database', 'CONNECT'),
  acl('table', 'omnis', 'tasks', 'SELECT'),
  acl('table', 'omnis', 'runs', 'SELECT'),
  acl('table', 'omnis', 'run_events', 'SELECT'),
  acl('table', 'omnis', 'run_idempotency', 'SELECT'),
  acl('table', 'omnis', 'runtime_authorizations', 'SELECT'),
  acl('table', 'omnis', 'departments', 'SELECT'),
  acl('table', 'omnis', 'agents', 'SELECT'),
  acl('table', 'omnis', 'agent_profile_versions', 'SELECT'),
  acl(
    'routine',
    'omnis',
    'consume_run_authorization(p_authorization_id text, p_task_id text, p_run_id text, p_correlation_id text)',
    'EXECUTE',
    null,
    'omnis_runtime',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'revoke_run_authorization(p_authorization_id text, p_actor_id text)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'archive_department(p_department_id text, p_request_id text)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'create_project(p_id text, p_key text, p_name text, p_objective text, p_priority text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl('routine', 'omnis', 'list_projects()', 'EXECUTE', null, 'omnis_authorizer', true),
  acl('routine', 'omnis', 'get_project(p_id text)', 'EXECUTE', null, 'omnis_authorizer', true),
  acl(
    'routine',
    'omnis',
    'update_project(p_id text, p_expected_revision integer, p_name text, p_objective text, p_priority text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'archive_project(p_id text, p_expected_revision integer, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'list_project_milestones(p_project_id text, p_after_created_at timestamp with time zone, p_after_id text, p_limit integer)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'get_project_milestone(p_project_id text, p_id text)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'create_project_milestone(p_id text, p_project_id text, p_title text, p_description text, p_target_date date, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'update_project_milestone(p_project_id text, p_id text, p_expected_revision integer, p_title text, p_description text, p_description_supplied boolean, p_target_date date, p_target_date_supplied boolean, p_status text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'archive_project_milestone(p_project_id text, p_id text, p_expected_revision integer, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'create_agent(p_id text, p_name text, p_slug text, p_department_id text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'get_agent_profile_draft(p_agent_id text)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'save_agent_profile_draft(p_agent_id text, p_expected_revision bigint, p_base_version_no integer, p_profile jsonb, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'publish_agent_profile(p_agent_id text, p_expected_version_no integer, p_expected_revision bigint, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'archive_agent(p_agent_id text, p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_authorizer',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'lock_active_run_authorization(p_run_id text)',
    'EXECUTE',
    null,
    'omnis_runtime',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'append_runtime_authorization_audit(p_run_id text, p_event_type text, p_reason_code text)',
    'EXECUTE',
    null,
    'omnis_runtime',
    true,
  ),
  acl('column', 'omnis', 'tasks', 'UPDATE', 'status'),
  acl('sequence', 'omnis', 'run_id_seq', 'SELECT'),
  acl(
    'routine',
    'omnis',
    'create_task(p_title text, p_detail text, p_project_id text, p_request_id uuid, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_runtime',
    true,
  ),
  acl(
    'routine',
    'omnis',
    'set_task_project(p_task_id text, p_expected_association_revision integer, p_project_id text, p_request_id uuid, p_fingerprint bytea)',
    'EXECUTE',
    null,
    'omnis_runtime',
    true,
  ),
  acl('table', 'pgboss', 'job', 'DELETE'),
  acl('default:table', 'pgboss', '', 'INSERT'),
  acl('routine', 'public', 'extension_helper()', 'EXECUTE', null, 'PUBLIC', false),
  acl('type', 'public', 'extension_state', 'USAGE', null, 'PUBLIC'),
];

describe('post-restore PostgreSQL ACL integrity', () => {
  it('accepts current mock-runtime and pg-boss grants', () => {
    assert.doesNotThrow(() => assertRuntimeAclPolicy(allowed));
  });

  it('rejects a prohibited runtime table mutation grant', () => {
    assert.throws(
      () => assertRuntimeAclPolicy([...allowed, acl('table', 'omnis', 'tasks', 'DELETE')]),
      /DELETE is prohibited on omnis\.tasks/,
    );
  });

  it('rejects direct task identity/project writes and task sequence access', () => {
    for (const entry of [
      acl('column', 'omnis', 'tasks', 'INSERT', 'id'),
      acl('column', 'omnis', 'tasks', 'UPDATE', 'project_id'),
      acl('sequence', 'omnis', 'task_id_seq', 'USAGE'),
    ]) {
      assert.throws(() => assertRuntimeAclPolicy([...allowed, entry]));
    }
  });

  it('allows SELECT only on the explicitly approved application tables', () => {
    for (const object of ['schema_migrations', 'unreviewed_view', 'future_read_model']) {
      const objectType = object === 'unreviewed_view' ? 'view' : 'table';
      assert.throws(
        () => assertRuntimeAclPolicy([...allowed, acl(objectType, 'omnis', object, 'SELECT')]),
        /Runtime (table|view) privilege SELECT is prohibited/,
        `${object} must not be readable by the runtime role`,
      );
    }
  });

  it('allows only the dedicated authorization operations for runtime and authorizer roles', () => {
    const safe = [
      acl('table', 'omnis', 'tasks', 'SELECT', null, 'omnis_authorizer'),
      acl('table', 'omnis', 'runtime_authorizations', 'SELECT', null, 'omnis_authorizer'),
      acl('table', 'omnis', 'authorization_audit', 'SELECT', null, 'omnis_authorizer'),
      acl('table', 'omnis', 'authorization_audit', 'INSERT', null, 'omnis_authorizer'),
      acl('table', 'omnis', 'departments', 'SELECT', null, 'omnis_authorizer'),
      acl('column', 'omnis', 'departments', 'INSERT', 'id', 'omnis_authorizer'),
      acl('column', 'omnis', 'departments', 'INSERT', 'slug', 'omnis_authorizer'),
      acl('column', 'omnis', 'departments', 'INSERT', 'name', 'omnis_authorizer'),
      acl('column', 'omnis', 'departments', 'UPDATE', 'name', 'omnis_authorizer'),
      acl(
        'column',
        'omnis',
        'department_management_audit',
        'INSERT',
        'request_id',
        'omnis_authorizer',
      ),
      acl('column', 'omnis', 'runtime_authorizations', 'INSERT', 'id', 'omnis_authorizer'),
      acl('column', 'omnis', 'runtime_authorizations', 'UPDATE', 'status', 'omnis_authorizer'),
      acl('schema', 'omnis', 'omnis', 'USAGE', null, 'omnis_launcher'),
      acl(
        'routine',
        'omnis',
        'authorize_mock_sandbox_launch(p_run_id text, p_worker_id text, p_generation integer)',
        'EXECUTE',
        null,
        'omnis_launcher',
        true,
      ),
      acl(
        'routine',
        'omnis',
        'list_authorized_active_mock_runs(p_candidate_ids text[])',
        'EXECUTE',
        null,
        'omnis_launcher',
        true,
      ),
    ];
    assert.doesNotThrow(() => assertRuntimeAclPolicy([...allowed, ...safe]));
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('table', 'omnis', 'authorization_audit', 'INSERT'),
        ]),
      /Runtime table privilege INSERT is prohibited on omnis\.authorization_audit/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl(
            'routine',
            'omnis',
            'append_runtime_authorization_audit(p_run_id text, p_event_type text, p_reason_code text)',
            'EXECUTE',
            null,
            'omnis_runtime',
            false,
          ),
        ]),
      /Runtime routine privilege EXECUTE is prohibited/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('table', 'omnis', 'authorization_audit', 'UPDATE'),
        ]),
      /Runtime table privilege UPDATE is prohibited/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('column', 'omnis', 'runtime_authorizations', 'UPDATE', 'status', 'omnis_runtime'),
        ]),
      /Runtime column privilege UPDATE on omnis\.runtime_authorizations\.status is prohibited/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('table', 'omnis', 'runs', 'DELETE', null, 'omnis_authorizer'),
        ]),
      /Authorizer ACL DELETE is prohibited/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('table', 'omnis', 'departments', 'DELETE', null, 'omnis_authorizer'),
        ]),
      /Authorizer ACL DELETE is prohibited/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('column', 'omnis', 'agents', 'INSERT', 'id', 'omnis_authorizer'),
        ]),
      /Authorizer ACL INSERT is prohibited/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('column', 'omnis', 'departments', 'UPDATE', 'archived_at', 'omnis_authorizer'),
        ]),
      /Authorizer ACL UPDATE is prohibited/,
    );
  });

  it('rejects unexpected schemas, unsafe PUBLIC grants, and runtime role memberships', () => {
    for (const unexpectedSchema of ['rogue', 'pg_unexpected']) {
      assert.throws(
        () =>
          assertRuntimeAclPolicy([
            ...allowed,
            acl('schema', unexpectedSchema, unexpectedSchema, 'USAGE'),
          ]),
        new RegExp(`Runtime schema privilege USAGE is prohibited on ${unexpectedSchema}`),
      );
    }
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('schema', 'public', 'public', 'CREATE', null, 'PUBLIC'),
        ]),
      /grants CREATE to PUBLIC on public\.public/,
    );
    assert.throws(
      () => assertRuntimeAclPolicy([...allowed, acl('membership', '', 'reader', 'MEMBER_OF')]),
      /membership involving the runtime role is prohibited/,
    );
    assert.throws(
      () => assertRuntimeAclPolicy([...allowed, acl('database', '', 'database', 'CREATE')]),
      /Runtime database privilege CREATE is prohibited/,
    );
  });

  it('rejects grants to PUBLIC, unknown roles, and grantable runtime ACLs', () => {
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('table', 'omnis', 'tasks', 'SELECT', null, 'PUBLIC'),
        ]),
      /grants SELECT to PUBLIC/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          acl('table', 'omnis', 'tasks', 'SELECT', null, 'unreviewed_role'),
        ]),
      /Unexpected PostgreSQL ACL grantee/,
    );
    assert.throws(
      () =>
        assertRuntimeAclPolicy([
          ...allowed,
          { ...acl('table', 'omnis', 'tasks', 'SELECT'), grantable: true },
        ]),
      /grant option is prohibited/,
    );
  });

  it('allows default PUBLIC execute only on invoker-rights routines', () => {
    const publicRoutine = {
      ...acl('routine', 'pgboss', 'helper()', 'EXECUTE', null, 'PUBLIC'),
      securityDefiner: false,
    };
    assert.doesNotThrow(() => assertRuntimeAclPolicy([...allowed, publicRoutine]));
    assert.throws(
      () => assertRuntimeAclPolicy([...allowed, { ...publicRoutine, securityDefiner: true }]),
      /grants EXECUTE to PUBLIC/,
    );
    assert.doesNotThrow(() =>
      assertRuntimeAclPolicy([
        ...allowed,
        acl('type', 'pgboss', 'job_state', 'USAGE', null, 'PUBLIC'),
      ]),
    );
  });

  it('normalizes entry order and detects source/restored ACL drift', () => {
    assert.deepEqual(normalizeAclSnapshot([...allowed].reverse()), normalizeAclSnapshot(allowed));
    assert.equal(aclSnapshotsMatch(allowed, [...allowed].reverse()), true);
    assert.equal(
      aclSnapshotsMatch(allowed, [...allowed, acl('table', 'omnis', 'tasks', 'DELETE')]),
      false,
    );
  });

  it('allows only the intentional deferred database CONNECT difference during restore', () => {
    const source = [
      {
        ...allowed[0],
        objectType: 'database',
        schema: '',
        object: 'database',
        grantee: 'PUBLIC',
        privilege: 'CONNECT',
      },
      {
        ...allowed[0],
        objectType: 'database',
        schema: '',
        object: 'database',
        grantee: 'omnis_runtime',
        privilege: 'CONNECT',
      },
      ...allowed,
    ];
    const restored = source.filter(
      (entry) => !(entry.objectType === 'database' && entry.privilege === 'CONNECT'),
    );
    assert.equal(restoreAclSnapshotsMatch(source, restored), true);
    assert.doesNotThrow(() => assertRestoreDatabaseClosed(restored));
    assert.throws(() => assertRestoreDatabaseClosed(source), /must remain closed/);
    assert.equal(
      restoreAclSnapshotsMatch(source, [...restored, { ...source[0], privilege: 'CREATE' }]),
      false,
    );
  });

  it('canonicalizes task sequence owner ACLs only when the restore role owns the sequence', () => {
    const ownerEntries = [
      acl('sequence', 'omnis', 'task_id_seq', 'SELECT', null, 'omnis_migrator'),
      acl('sequence', 'omnis', 'task_id_seq', 'UPDATE', null, 'omnis_migrator'),
    ];
    assert.equal(restoreAclSnapshotsMatch([...allowed, ...ownerEntries], allowed), true);
    assert.equal(
      restoreAclSnapshotsMatch(
        [...allowed, ...ownerEntries],
        [...allowed, { ...ownerEntries[0], grantee: 'omnis_runtime' }],
      ),
      false,
    );
    assert.equal(
      restoreAclSnapshotsMatch(
        [...allowed, ...ownerEntries],
        [...allowed, { ...ownerEntries[0], privilege: 'USAGE' }],
      ),
      false,
    );
  });

  it('compares the effective runtime grant set for legacy baseline parity', () => {
    assert.equal(runtimeAclSnapshotsMatch(allowed, [...allowed].reverse()), true);
    assert.equal(
      runtimeAclSnapshotsMatch(allowed, [...allowed, acl('table', 'omnis', 'tasks', 'DELETE')]),
      false,
    );
  });
});

function acl(
  objectType,
  schema,
  object,
  privilege,
  column = null,
  grantee = 'omnis_runtime',
  securityDefiner = null,
) {
  return {
    objectType,
    schema,
    object,
    column,
    grantee,
    privilege,
    grantable: false,
    securityDefiner,
  };
}

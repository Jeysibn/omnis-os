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
  acl('column', 'omnis', 'tasks', 'INSERT', 'id'),
  acl('column', 'omnis', 'tasks', 'UPDATE', 'status'),
  acl('sequence', 'omnis', 'task_id_seq', 'USAGE'),
  acl('sequence', 'omnis', 'run_id_seq', 'SELECT'),
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

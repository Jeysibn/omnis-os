import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aclSnapshotsMatch,
  assertRuntimeAclPolicy,
  normalizeAclSnapshot,
} from './acl-integrity.mjs';

const allowed = [
  acl('schema', 'omnis', 'omnis', 'USAGE'),
  acl('table', 'omnis', 'tasks', 'SELECT'),
  acl('column', 'omnis', 'tasks', 'INSERT', 'id'),
  acl('column', 'omnis', 'tasks', 'UPDATE', 'status'),
  acl('sequence', 'omnis', 'future_approved_id_seq', 'USAGE'),
  acl('table', 'omnis', 'future_read_model', 'SELECT'),
  acl('table', 'pgboss', 'job', 'DELETE'),
  acl('default:table', 'pgboss', '', 'INSERT'),
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
});

function acl(objectType, schema, object, privilege, column = null, grantee = 'omnis_runtime') {
  return { objectType, schema, object, column, grantee, privilege, grantable: false };
}

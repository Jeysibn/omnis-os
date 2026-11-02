import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRestoreRoleSecurity } from './role-integrity.mjs';

const safeRoles = [
  { name: 'omnis', login: true, superuser: true },
  {
    name: 'omnis_migrator',
    login: true,
    inherit: false,
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    membershipCount: 0,
  },
  {
    name: 'omnis_runtime',
    login: true,
    inherit: false,
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    membershipCount: 0,
  },
];

test('restore role security policy', async (suite) => {
  await suite.test(
    'accepts the provisioned administrator, migrator, and runtime role attributes',
    () => {
      assert.doesNotThrow(() => assertRestoreRoleSecurity(safeRoles));
    },
  );

  for (const [attribute, value] of [
    ['superuser', true],
    ['createRole', true],
    ['createDatabase', true],
    ['replication', true],
    ['bypassRls', true],
    ['inherit', true],
    ['membershipCount', 1],
  ]) {
    await suite.test(`rejects an unsafe runtime ${attribute} value`, () => {
      const changed = safeRoles.map((role) => ({ ...role }));
      changed.find((role) => role.name === 'omnis_runtime')[attribute] = value;
      assert.throws(() => assertRestoreRoleSecurity(changed), /omnis_runtime has unsafe/);
    });
  }

  await suite.test('rejects an escalated migrator while retaining its approved login role', () => {
    const changed = safeRoles.map((role) => ({ ...role }));
    changed.find((role) => role.name === 'omnis_migrator').createRole = true;
    assert.throws(() => assertRestoreRoleSecurity(changed), /omnis_migrator has unsafe/);
  });

  await suite.test('rejects missing required roles and malformed snapshots', () => {
    assert.throws(
      () => assertRestoreRoleSecurity(safeRoles.slice(0, 2)),
      /omnis_runtime is missing/,
    );
    assert.throws(() => assertRestoreRoleSecurity(null), /must be an array/);
  });
});

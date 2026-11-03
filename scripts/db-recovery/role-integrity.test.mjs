import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRestoreRoleSecurity } from './role-integrity.mjs';

const safeRoles = [
  {
    name: 'omnis',
    login: true,
    superuser: true,
    timeoutSettings: {},
    databaseTimeoutOverrides: [],
  },
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
    timeoutSettings: {},
    databaseTimeoutOverrides: [],
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
    timeoutSettings: {
      lock_timeout: '3s',
      statement_timeout: '20s',
      idle_in_transaction_session_timeout: '20s',
    },
    databaseTimeoutOverrides: [],
  },
  {
    name: 'omnis_authorizer',
    login: true,
    inherit: false,
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    membershipCount: 0,
    timeoutSettings: {
      lock_timeout: '3s',
      statement_timeout: '15s',
      idle_in_transaction_session_timeout: '20s',
    },
    databaseTimeoutOverrides: [],
  },
];

function cloneSafeRoles() {
  return safeRoles.map((role) => ({
    ...role,
    timeoutSettings: { ...role.timeoutSettings },
    databaseTimeoutOverrides: role.databaseTimeoutOverrides.map((entry) => ({ ...entry })),
  }));
}

test('restore role security policy', async (suite) => {
  await suite.test(
    'accepts the provisioned administrator, migrator, runtime, and authorizer role attributes',
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
      const changed = cloneSafeRoles();
      changed.find((role) => role.name === 'omnis_runtime')[attribute] = value;
      assert.throws(() => assertRestoreRoleSecurity(changed), /omnis_runtime has unsafe/);
    });
  }

  await suite.test('rejects an escalated migrator while retaining its approved login role', () => {
    const changed = cloneSafeRoles();
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

  await suite.test('rejects missing runtime timeout defaults', () => {
    const changed = cloneSafeRoles();
    changed.find((role) => role.name === 'omnis_runtime').timeoutSettings = {
      statement_timeout: '30s',
      idle_in_transaction_session_timeout: '30s',
    };
    assert.throws(() => assertRestoreRoleSecurity(changed), /omnis_runtime timeout policy/);
  });

  await suite.test('rejects a disabled or excessive runtime timeout', () => {
    const changed = cloneSafeRoles();
    changed.find((role) => role.name === 'omnis_runtime').timeoutSettings.statement_timeout = '0';
    assert.throws(() => assertRestoreRoleSecurity(changed), /omnis_runtime timeout policy/);
  });

  await suite.test('rejects a database-specific timeout override for a protected role', () => {
    const changed = cloneSafeRoles();
    changed.find((role) => role.name === 'omnis_runtime').databaseTimeoutOverrides = [
      { database: 'omnis_test', scope: 'role_database', setting: 'lock_timeout', value: '0' },
    ];
    assert.throws(
      () => assertRestoreRoleSecurity(changed),
      /omnis_runtime has database timeout overrides/,
    );
  });

  await suite.test('keeps timeout defaults separate for runtime and authorizer', () => {
    const changed = cloneSafeRoles();
    changed.find((role) => role.name === 'omnis_authorizer').timeoutSettings.statement_timeout =
      '30s';
    assert.throws(() => assertRestoreRoleSecurity(changed), /omnis_authorizer timeout policy/);
  });
});

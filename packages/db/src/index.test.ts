import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import {
  createPool,
  DepartmentStoreError,
  migrate,
  PostgresAgentProfileStore,
  PostgresAuthorizationStore,
  PostgresDepartmentManagementStore,
  PostgresRunStore,
  StoreError,
  type PgBossTransaction,
} from './index.ts';
import { provisionDatabaseRoles } from './provision-roles.ts';
import { assertValidMetrics, metricsQuery } from '../../../scripts/db-recovery/metrics.mjs';
import {
  assertRestoreRoleSecurity,
  restoreRoleSecurityQuery,
} from '../../../scripts/db-recovery/role-integrity.mjs';

const databaseUrl = process.env.OMNIS_TEST_DATABASE_URL;
const pool = databaseUrl ? createPool(databaseUrl) : undefined;
const migrationUrl = process.env.OMNIS_TEST_MIGRATION_DATABASE_URL;
const authorizerUrl = process.env.OMNIS_TEST_AUTHORIZER_DATABASE_URL;
const launcherUrl = process.env.OMNIS_TEST_LAUNCHER_DATABASE_URL;
const migrationPool = migrationUrl ? createPool(migrationUrl) : undefined;
const authorizerPool = authorizerUrl ? createPool(authorizerUrl) : undefined;
const launcherPool = launcherUrl ? createPool(launcherUrl) : undefined;
const adminUrl = process.env.OMNIS_TEST_ADMIN_DATABASE_URL;
const adminPool = adminUrl ? createPool(adminUrl) : undefined;
let nextKey = 0;
const postgresSuite = describe(
  'PostgreSQL run store',
  {
    skip: !databaseUrl || !migrationUrl || !adminUrl || !authorizerUrl || !launcherUrl,
  },
  () => {
    const store = new PostgresRunStore(pool!);
    const authorizations = new PostgresAuthorizationStore(pool!, authorizerPool!);
    const authorizationByIdempotency = new Map<string, Promise<string>>();
    async function admit(
      taskId: string,
      idempotencyKey: string,
      enqueue: (transaction: PgBossTransaction, data: { runId: string }) => Promise<string | null>,
    ) {
      const cacheKey = `${taskId}:${idempotencyKey}`;
      let authorizationId = authorizationByIdempotency.get(cacheKey);
      if (!authorizationId) {
        authorizationId = (async () => {
          const request = await authorizations.request(taskId, 'owner');
          return (await authorizations.decide(request.id, 'owner', 'approve')).id;
        })();
        authorizationByIdempotency.set(cacheKey, authorizationId);
      }
      return store.admitRun(taskId, idempotencyKey, await authorizationId, enqueue);
    }

    beforeEach(async () => {
      assertTestDatabase(databaseUrl!);
      authorizationByIdempotency.clear();
      await migrate(migrationPool!);
      await adminPool!.query(`
      CREATE TABLE IF NOT EXISTS omnis.test_queue_outbox (
        run_id text PRIMARY KEY
      )
    `);
      await adminPool!.query(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON omnis.test_queue_outbox TO omnis_runtime',
      );
      await adminPool!.query(
        'TRUNCATE omnis.test_queue_outbox, omnis.department_management_audit, omnis.agent_profile_versions, omnis.agents, omnis.departments, omnis.mock_sandbox_launches, omnis.legacy_unscoped_runs, omnis.authorization_audit, omnis.runtime_authorizations, omnis.run_idempotency, omnis.run_events, omnis.runs, omnis.tasks',
      );
      await adminPool!.query('ALTER SEQUENCE omnis.task_id_seq RESTART WITH 1');
      await adminPool!.query('ALTER SEQUENCE omnis.run_id_seq RESTART WITH 1');
      nextKey += 1;
    });

    it('returns an honestly empty complete agent directory', async () => {
      const profiles = new PostgresAgentProfileStore(
        pool!,
        'ao104-test-cursor-key-0123456789abcdef',
      );
      assert.deepEqual(await profiles.listAgents(), {
        agents: [],
        page: { total: 0, complete: true, nextCursor: null },
      });
    });

    it('fails closed instead of silently truncating a directory above the response bound', async () => {
      await adminPool!.query(
        `INSERT INTO omnis.agents (id, name, slug, lifecycle, provenance)
         SELECT 'agt_' || n, 'Agent ' || n, 'agent-' || n, 'draft', 'owner_created'
           FROM generate_series(1, 1001) AS n`,
      );
      const profiles = new PostgresAgentProfileStore(
        pool!,
        'ao104-test-cursor-key-0123456789abcdef',
      );
      await assert.rejects(profiles.listAgents(), (error: { statusCode: number; code: string }) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, 'directory_limit_exceeded');
        return true;
      });
    });

    it('keeps directory ordering stable when display names tie', async () => {
      await adminPool!.query(
        `INSERT INTO omnis.agents (id, name, slug, lifecycle, provenance) VALUES
          ('agt_tie_b', 'Atlas', 'atlas-b', 'draft', 'owner_created'),
          ('agt_tie_a', 'Atlas', 'atlas-a', 'draft', 'owner_created')`,
      );
      const profiles = new PostgresAgentProfileStore(
        pool!,
        'ao104-test-cursor-key-0123456789abcdef',
      );
      assert.deepEqual(
        (await profiles.listAgents()).agents.map((agent) => agent.id),
        ['agt_tie_a', 'agt_tie_b'],
      );
    });

    it('preserves exact immutable history and snapshot-consistent version pagination', async () => {
      const profiles = new PostgresAgentProfileStore(
        pool!,
        'ao104-test-cursor-key-0123456789abcdef',
      );
      const createdAt = new Date('2026-11-03T00:00:00.000Z');
      await adminPool!.query('BEGIN');
      try {
        await adminPool!.query(
          `INSERT INTO omnis.departments (id, slug, name) VALUES ('dep_engineering', 'engineering', 'Engineering')`,
        );
        await adminPool!.query(
          `INSERT INTO omnis.agents
             (id, department_id, name, slug, lifecycle, current_version_no, provenance, created_at, updated_at)
           VALUES ('agt_atlas', 'dep_engineering', 'Atlas', 'atlas', 'available', 3, 'owner_created', $1, $1)`,
          [createdAt],
        );
        for (const [versionNo, profession] of [
          [1, 'Systems Analyst'],
          [2, 'Systems Designer'],
          [3, 'Systems Architect'],
        ] as const) {
          await adminPool!.query(
            `INSERT INTO omnis.agent_profile_versions
               (version_id, agent_id, version_no, profession, seniority, specialties, personality, behavior, instructions, created_at)
             VALUES ($1, 'agt_atlas', $2, $3, 'senior', '["system-design"]',
               '{"traits":["methodical"],"tone":"professional","principles":["explain tradeoffs"]}',
               '{"autonomy":null,"escalation":"request owner review"}', $4, $5)`,
            [`apv_atlas_${versionNo}`, versionNo, profession, `Snapshot ${versionNo}`, createdAt],
          );
        }
        await adminPool!.query(
          `INSERT INTO omnis.agents (id, name, slug, lifecycle, provenance)
           VALUES ('agt_draft', 'Draft', 'draft', 'draft', 'owner_created')`,
        );
        await adminPool!.query('COMMIT');
      } catch (error) {
        await adminPool!.query('ROLLBACK');
        throw error;
      }

      const directory = await profiles.listAgents();
      assert.equal(directory.page.total, 2);
      assert.deepEqual(
        directory.agents.map((agent) => agent.id),
        ['agt_atlas', 'agt_draft'],
      );
      assert.equal(directory.agents[0]?.department?.id, 'dep_engineering');
      assert.equal(directory.agents[1]?.currentVersion, null);
      const profile = await profiles.getAgent('agt_atlas');
      assert.equal(profile?.currentVersion?.versionNo, 3);
      assert.equal(profile?.currentVersion?.instructions, 'Snapshot 3');
      assert.equal((await profiles.getVersion('agt_atlas', 1))?.version.instructions, 'Snapshot 1');
      assert.equal(await profiles.getVersion('agt_atlas', 99), null);
      assert.equal(await profiles.getVersion('agt_other', 1), null);
      const fullHistory = await profiles.listVersions('agt_atlas', { limit: 100 });
      assert.deepEqual(
        fullHistory?.versions.map((version) => version.versionNo),
        [3, 2, 1],
      );
      assert.equal(fullHistory?.page.complete, true);

      const firstPage = await profiles.listVersions('agt_atlas', { limit: 1 });
      assert.equal(firstPage?.page.total, 3);
      assert.equal(firstPage?.versions[0]?.versionNo, 3);
      assert.equal(firstPage?.versions[0]?.isCurrent, true);
      assert.ok(firstPage?.page.nextCursor);

      await adminPool!.query('BEGIN');
      try {
        await adminPool!.query(
          `INSERT INTO omnis.agent_profile_versions (version_id, agent_id, version_no, profession)
           VALUES ('apv_atlas_4', 'agt_atlas', 4, 'Systems Director')`,
        );
        await adminPool!.query(
          `UPDATE omnis.agents SET current_version_no = 4, lifecycle = 'archived', archived_at = now(), updated_at = now()
            WHERE id = 'agt_atlas'`,
        );
        await adminPool!.query('COMMIT');
      } catch (error) {
        await adminPool!.query('ROLLBACK');
        throw error;
      }
      const secondPage = await profiles.listVersions('agt_atlas', {
        limit: 1,
        cursor: firstPage!.page.nextCursor!,
      });
      assert.equal(secondPage?.page.total, 3);
      assert.equal(secondPage?.agent.currentVersion?.versionNo, 3);
      assert.equal(secondPage?.versions[0]?.versionNo, 2);
      assert.equal(secondPage?.versions[0]?.isCurrent, false);
      assert.equal(secondPage?.agent.lifecycle, 'archived');
      assert.ok(secondPage?.agent.archivedAt);
      assert.ok(secondPage?.page.nextCursor);
      const finalPage = await profiles.listVersions('agt_atlas', {
        limit: 1,
        cursor: secondPage!.page.nextCursor!,
      });
      assert.deepEqual(
        finalPage?.versions.map((version) => version.versionNo),
        [1],
      );
      assert.equal(finalPage?.versions[0]?.isCurrent, false);
      assert.equal(finalPage?.page.complete, true);
      assert.equal(finalPage?.page.total, 3);
      assert.equal((await profiles.listAgents()).agents[0]?.lifecycle, 'archived');

      await assert.rejects(
        adminPool!.query(
          `UPDATE omnis.agent_profile_versions SET instructions = 'changed' WHERE version_id = 'apv_atlas_1'`,
        ),
        /immutable/,
      );
      await assert.rejects(
        adminPool!.query(
          `DELETE FROM omnis.agent_profile_versions WHERE version_id = 'apv_atlas_1'`,
        ),
        /immutable/,
      );
      assert.equal((await profiles.getVersion('agt_atlas', 1))?.version.instructions, 'Snapshot 1');

      await adminPool!.query('BEGIN');
      try {
        await adminPool!.query(
          `INSERT INTO omnis.agents (id, name, slug, lifecycle, current_version_no, provenance)
           VALUES ('agt_unsafe', 'Unsafe', 'unsafe', 'available', 1, 'owner_created')`,
        );
        await adminPool!.query(
          `INSERT INTO omnis.agent_profile_versions (version_id, agent_id, version_no, profession, instructions)
           VALUES ('apv_unsafe_1', 'agt_unsafe', 1, 'Analyst', 'password=fixture-secret-123456')`,
        );
        await adminPool!.query('COMMIT');
      } catch (error) {
        await adminPool!.query('ROLLBACK');
        throw error;
      }
      await assert.rejects(profiles.getVersion('agt_unsafe', 1), (error: Error) => {
        assert.match(error.message, /disallowed credential material/);
        assert.doesNotMatch(error.message, /fixture-secret-123456/);
        return true;
      });
    });

    it('limits the runtime database role to reading profile tables and rejects malformed snapshots', async () => {
      const privileges = await pool!.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'omnis' AND grantee = 'omnis_runtime'
            AND table_name IN ('departments', 'agents', 'agent_profile_versions')
          ORDER BY table_name, privilege_type`,
      );
      assert.deepEqual(privileges.rows, [
        { table_name: 'agent_profile_versions', privilege_type: 'SELECT' },
        { table_name: 'agents', privilege_type: 'SELECT' },
        { table_name: 'departments', privilege_type: 'SELECT' },
      ]);
      const managementPrivileges = await adminPool!.query<{
        runtime_department_insert: boolean;
        authorizer_department_select: boolean;
        authorizer_department_table_insert: boolean;
        authorizer_department_insert_id: boolean;
        authorizer_department_update_name: boolean;
        authorizer_department_update_archive: boolean;
        authorizer_agent_select: boolean;
        authorizer_agent_insert: boolean;
        authorizer_profile_select: boolean;
        authorizer_profile_insert: boolean;
        authorizer_audit_insert: boolean;
        authorizer_audit_select: boolean;
        runtime_audit_select: boolean;
        authorizer_archive_function: boolean;
      }>(`
        SELECT has_table_privilege('omnis_runtime', 'omnis.departments', 'INSERT') AS runtime_department_insert,
               has_table_privilege('omnis_authorizer', 'omnis.departments', 'SELECT') AS authorizer_department_select,
               has_table_privilege('omnis_authorizer', 'omnis.departments', 'INSERT') AS authorizer_department_table_insert,
               has_column_privilege('omnis_authorizer', 'omnis.departments', 'id', 'INSERT') AS authorizer_department_insert_id,
               has_column_privilege('omnis_authorizer', 'omnis.departments', 'name', 'UPDATE') AS authorizer_department_update_name,
               has_column_privilege('omnis_authorizer', 'omnis.departments', 'archived_at', 'UPDATE') AS authorizer_department_update_archive,
               has_table_privilege('omnis_authorizer', 'omnis.agents', 'SELECT') AS authorizer_agent_select,
               has_table_privilege('omnis_authorizer', 'omnis.agents', 'INSERT') AS authorizer_agent_insert,
               has_table_privilege('omnis_authorizer', 'omnis.agent_profile_versions', 'SELECT') AS authorizer_profile_select,
               has_table_privilege('omnis_authorizer', 'omnis.agent_profile_versions', 'INSERT') AS authorizer_profile_insert,
               has_column_privilege('omnis_authorizer', 'omnis.department_management_audit', 'request_id', 'INSERT') AS authorizer_audit_insert,
               has_table_privilege('omnis_authorizer', 'omnis.department_management_audit', 'SELECT') AS authorizer_audit_select,
               has_table_privilege('omnis_runtime', 'omnis.department_management_audit', 'SELECT') AS runtime_audit_select,
               has_function_privilege('omnis_authorizer', 'omnis.archive_department(text,text)', 'EXECUTE') AS authorizer_archive_function
      `);
      assert.deepEqual(managementPrivileges.rows[0], {
        runtime_department_insert: false,
        authorizer_department_select: true,
        authorizer_department_table_insert: false,
        authorizer_department_insert_id: true,
        authorizer_department_update_name: true,
        authorizer_department_update_archive: false,
        authorizer_agent_select: false,
        authorizer_agent_insert: false,
        authorizer_profile_select: false,
        authorizer_profile_insert: false,
        authorizer_audit_insert: true,
        authorizer_audit_select: false,
        runtime_audit_select: false,
        authorizer_archive_function: true,
      });
      const functionPrivilege = await adminPool!.query<{ executable: boolean }>(
        `SELECT has_function_privilege('omnis_runtime',
           'omnis.is_bounded_string_array(jsonb,integer,integer)', 'EXECUTE') AS executable`,
      );
      assert.equal(functionPrivilege.rows[0]?.executable, false);
      await assert.rejects(
        pool!.query(`INSERT INTO omnis.departments (id, slug, name) VALUES ('dep_x', 'x', 'X')`),
        /permission denied/,
      );
      await assert.rejects(
        adminPool!.query(`INSERT INTO omnis.agent_profile_versions
          (version_id, agent_id, version_no, profession, specialties)
          VALUES ('apv_invalid', 'missing', 1, 'Unsafe', '{"not":"an array"}')`),
        /violates check constraint|violates foreign key constraint/,
      );
      const bounded = await adminPool!.query<{ accepted: boolean }>(
        `SELECT omnis.is_bounded_string_array(jsonb_build_array(repeat('x', 101)), 32, 100) AS accepted`,
      );
      assert.equal(bounded.rows[0]?.accepted, false);
    });

    it('creates, renames, and archives departments with atomic metadata-only audit records', async () => {
      const departments = new PostgresDepartmentManagementStore(authorizerPool!);
      const created = await departments.create(
        { slug: 'engineering', name: 'Engineering' },
        'authorizer-request-1',
      );
      assert.equal(created.slug, 'engineering');
      assert.equal(created.archivedAt, null);
      const updated = await departments.update(
        created.id,
        { slug: 'platform', name: 'Platform Engineering' },
        'authorizer-request-2',
      );
      assert.equal(updated.slug, 'platform');
      await assert.rejects(
        departments.create(
          { slug: 'platform', name: 'Duplicate Platform' },
          'authorizer-request-duplicate',
        ),
        (error: unknown) => error instanceof DepartmentStoreError && error.code === 'conflict',
      );
      const active = await departments.list();
      assert.deepEqual(
        active.departments.map((entry) => entry.id),
        [created.id],
      );
      const archived = await departments.archive(created.id, 'authorizer-request-3');
      assert.ok(archived.archivedAt);
      assert.deepEqual(await departments.list(), { departments: [], total: 0 });
      const all = await departments.list(true);
      assert.equal(all.total, 1);
      assert.equal(all.departments[0]?.archivedAt, archived.archivedAt);
      await assert.rejects(
        departments.update(created.id, { slug: 'later', name: 'Later' }, 'authorizer-request-4'),
        (error: unknown) =>
          error instanceof DepartmentStoreError && error.code === 'invalid_transition',
      );

      const audit = await adminPool!.query<{
        action: string;
        actor_id: string;
        request_id: string;
      }>(
        `SELECT action, actor_id, request_id FROM omnis.department_management_audit
          WHERE department_id = $1 ORDER BY occurred_at, id`,
        [created.id],
      );
      assert.deepEqual(audit.rows, [
        { action: 'created', actor_id: 'owner', request_id: 'authorizer-request-1' },
        { action: 'updated', actor_id: 'owner', request_id: 'authorizer-request-2' },
        { action: 'archived', actor_id: 'owner', request_id: 'authorizer-request-3' },
      ]);
      const createdAuditId = await adminPool!.query<{ id: string }>(
        `SELECT id FROM omnis.department_management_audit
          WHERE department_id = $1 AND action = 'created'`,
        [created.id],
      );
      await assert.rejects(
        authorizerPool!.query(
          `UPDATE omnis.department_management_audit SET action = 'archived' WHERE id = $1`,
          [createdAuditId.rows[0]!.id],
        ),
        /permission denied/,
      );
      await assert.rejects(
        adminPool!.query(
          `UPDATE omnis.department_management_audit SET action = 'archived' WHERE id = $1`,
          [createdAuditId.rows[0]!.id],
        ),
        /department management audit records are immutable/,
      );
    });

    it('refuses to archive referenced departments and rejects assignments to archived departments in PostgreSQL', async () => {
      const departments = new PostgresDepartmentManagementStore(authorizerPool!);
      const referenced = await departments.create(
        { slug: 'research', name: 'Research' },
        'authorizer-request-5',
      );
      await adminPool!.query(
        `INSERT INTO omnis.agents (id, department_id, name, slug, lifecycle, provenance)
         VALUES ('agt_department_guard', $1, 'Research Agent', 'research-agent', 'draft', 'owner_created')`,
        [referenced.id],
      );
      await assert.rejects(
        departments.archive(referenced.id, 'authorizer-request-6'),
        (error: unknown) =>
          error instanceof DepartmentStoreError && error.code === 'invalid_transition',
      );
      const unreferenced = await departments.create(
        { slug: 'archive-candidate', name: 'Archive Candidate' },
        'authorizer-request-7',
      );
      const archived = await departments.archive(unreferenced.id, 'authorizer-request-8');
      await assert.rejects(
        adminPool!.query(
          `INSERT INTO omnis.agents (id, department_id, name, slug, lifecycle, provenance)
           VALUES ('agt_archived_department', $1, 'Archived Agent', 'archived-agent', 'draft', 'owner_created')`,
          [unreferenced.id],
        ),
        /archived departments cannot be assigned/,
      );
      assert.ok(archived.archivedAt);
      await assert.rejects(
        authorizerPool!.query(`UPDATE omnis.departments SET slug = 'changed' WHERE id = $1`, [
          unreferenced.id,
        ]),
        /archived departments are immutable/,
      );
    });

    it('commits task, run, initial event, idempotency, and queue outbox atomically', async () => {
      const task = await store.createTask({
        title: 'Inspect files',
        detail: 'List files read-only.',
      });
      const admitted = await admit(task.id, key('atomic'), async (tx, { runId }) => {
        await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
        return `job-${runId}`;
      });

      assert.equal(admitted.created, true);
      assert.equal(admitted.run.status, 'queued');
      assert.equal(admitted.events[0]?.event.type, 'run.queued');
      assert.equal((await store.getEvents(admitted.run.id)).length, 1);
      assert.equal(
        (
          await pool!.query('SELECT 1 FROM omnis.test_queue_outbox WHERE run_id = $1', [
            admitted.run.id,
          ])
        ).rowCount,
        1,
      );
    });

    it('uses a restricted runtime role without DDL or superuser privileges', async () => {
      const identity = await pool!.query<{
        current_user: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
      }>(
        `SELECT current_user, r.rolsuper, r.rolcreatedb FROM pg_roles r WHERE r.rolname = current_user`,
      );
      assert.equal(identity.rows[0]?.current_user, 'omnis_runtime');
      assert.equal(identity.rows[0]?.rolsuper, false);
      assert.equal(identity.rows[0]?.rolcreatedb, false);
      await assert.rejects(
        pool!.query('SET ROLE omnis_authorizer'),
        /permission denied|cannot set role/,
      );
      await assert.rejects(
        pool!.query('CREATE TABLE omnis.runtime_ddl_probe (id integer)'),
        /permission denied/,
      );
      await assert.rejects(pool!.query('SELECT pg_reload_conf()'), /permission denied/);
      await assert.rejects(
        pool!.query("SELECT setval('omnis.task_id_seq', 1)"),
        /permission denied/,
      );
    });

    it('provisions distinct role timeout defaults and audits catalog scope', async () => {
      const passwords = {
        migration: decodeURIComponent(new URL(migrationUrl!).password),
        runtime: decodeURIComponent(new URL(databaseUrl!).password),
        authorizer: decodeURIComponent(new URL(authorizerUrl!).password),
        launcher: decodeURIComponent(new URL(launcherUrl!).password),
      };
      await provisionDatabaseRoles(adminPool!, passwords);
      await provisionDatabaseRoles(adminPool!, passwords);

      const catalog = await adminPool!.query<{ role_security: unknown }>(restoreRoleSecurityQuery);
      assertRestoreRoleSecurity(catalog.rows[0]?.role_security);

      const runtimeFreshPool = createPool({
        connectionString: databaseUrl!,
        application_name: 'omnis-timeout-runtime-fresh',
      });
      const authorizerFreshPool = createPool({
        connectionString: authorizerUrl!,
        application_name: 'omnis-timeout-authorizer-fresh',
      });
      const launcherFreshPool = createPool({
        connectionString: launcherUrl!,
        application_name: 'omnis-timeout-launcher-fresh',
      });
      try {
        const runtime = await runtimeFreshPool.query<{
          lock: string;
          statement: string;
          idle: string;
        }>(
          `SELECT current_setting('lock_timeout') AS lock,
                  current_setting('statement_timeout') AS statement,
                  current_setting('idle_in_transaction_session_timeout') AS idle`,
        );
        assert.deepEqual(runtime.rows[0], { lock: '3s', statement: '20s', idle: '20s' });
        const authorizer = await authorizerFreshPool.query<{
          lock: string;
          statement: string;
          idle: string;
        }>(
          `SELECT current_setting('lock_timeout') AS lock,
                  current_setting('statement_timeout') AS statement,
                  current_setting('idle_in_transaction_session_timeout') AS idle`,
        );
        assert.deepEqual(authorizer.rows[0], { lock: '3s', statement: '15s', idle: '20s' });
        const launcher = await launcherFreshPool.query<{
          lock: string;
          statement: string;
          idle: string;
        }>(
          `SELECT current_setting('lock_timeout') AS lock,
                  current_setting('statement_timeout') AS statement,
                  current_setting('idle_in_transaction_session_timeout') AS idle`,
        );
        assert.deepEqual(launcher.rows[0], { lock: '3s', statement: '10s', idle: '10s' });

        await runtimeFreshPool.query("SET lock_timeout = '0'");
        assert.equal(
          (await runtimeFreshPool.query("SELECT current_setting('lock_timeout') AS lock")).rows[0]
            ?.lock,
          '0',
        );
      } finally {
        await Promise.all([
          runtimeFreshPool.end(),
          authorizerFreshPool.end(),
          launcherFreshPool.end(),
        ]);
      }

      const currentDatabase = (
        await adminPool!.query<{ name: string }>('SELECT current_database() AS name')
      ).rows[0]!.name;
      const quotedDatabase = `"${currentDatabase.replaceAll('"', '""')}"`;
      try {
        await adminPool!.query(
          `ALTER ROLE omnis_runtime IN DATABASE ${quotedDatabase} SET lock_timeout TO '0'`,
        );
        await assert.rejects(
          provisionDatabaseRoles(adminPool!, passwords),
          /Database-specific PostgreSQL timeout settings are not permitted/,
        );
        const overridden = await adminPool!.query<{ role_security: unknown }>(
          restoreRoleSecurityQuery,
        );
        assert.throws(
          () => assertRestoreRoleSecurity(overridden.rows[0]?.role_security),
          /omnis_runtime has database timeout overrides/,
        );
      } finally {
        await adminPool!.query(
          `ALTER ROLE omnis_runtime IN DATABASE ${quotedDatabase} RESET lock_timeout`,
        );
      }
    });

    it('detects runtime-persisted timeout changes and repairs them during privileged provisioning', async () => {
      await pool!.query("SET lock_timeout = '0'");
      assert.equal(
        (await pool!.query<{ value: string }>("SELECT current_setting('lock_timeout') AS value"))
          .rows[0]?.value,
        '0',
      );
      await pool!.query('RESET lock_timeout');

      await pool!.query("ALTER ROLE omnis_runtime SET lock_timeout = '0'");
      const tampered = await adminPool!.query<{ role_security: unknown }>(restoreRoleSecurityQuery);
      assert.throws(
        () => assertRestoreRoleSecurity(tampered.rows[0]?.role_security),
        /omnis_runtime timeout policy/,
      );

      await provisionDatabaseRoles(adminPool!, {
        migration: decodeURIComponent(new URL(migrationUrl!).password),
        runtime: decodeURIComponent(new URL(databaseUrl!).password),
        authorizer: decodeURIComponent(new URL(authorizerUrl!).password),
        launcher: decodeURIComponent(new URL(launcherUrl!).password),
      });
      const storedSetting = await adminPool!.query(
        `SELECT 1 FROM pg_db_role_setting settings
          JOIN pg_roles roles ON roles.oid = settings.setrole
          CROSS JOIN LATERAL unnest(settings.setconfig) AS entry(setting)
         WHERE roles.rolname='omnis_runtime'
           AND settings.setdatabase=0
           AND split_part(setting, '=', 1)='lock_timeout'`,
      );
      assert.equal(storedSetting.rowCount, 1, 'the provisioned timeout remains unchanged');
      const repaired = await adminPool!.query<{ role_security: unknown }>(restoreRoleSecurityQuery);
      assertRestoreRoleSecurity(repaired.rows[0]?.role_security);
    });

    it('detects cluster-visible database timeout overrides in the role integrity audit', async () => {
      const currentDatabase = (
        await adminPool!.query<{ name: string }>('SELECT current_database() AS name')
      ).rows[0]!.name;
      const quotedDatabase = `"${currentDatabase.replaceAll('"', '""')}"`;
      try {
        await adminPool!.query(`ALTER DATABASE ${quotedDatabase} SET statement_timeout TO '0'`);
        const snapshot = await adminPool!.query<{ role_security: unknown }>(
          restoreRoleSecurityQuery,
        );
        assert.throws(
          () => assertRestoreRoleSecurity(snapshot.rows[0]?.role_security),
          /database timeout overrides/,
        );
        await assert.rejects(
          provisionDatabaseRoles(adminPool!, {
            migration: decodeURIComponent(new URL(migrationUrl!).password),
            runtime: decodeURIComponent(new URL(databaseUrl!).password),
            authorizer: decodeURIComponent(new URL(authorizerUrl!).password),
            launcher: decodeURIComponent(new URL(launcherUrl!).password),
          }),
          /Database-specific PostgreSQL timeout settings are not permitted/,
        );
      } finally {
        await adminPool!.query(`ALTER DATABASE ${quotedDatabase} RESET statement_timeout`);
      }
    });

    it('verifies role timeout precedence over cluster defaults on fresh connections', async () => {
      const runtimeFreshPool = createPool({
        connectionString: databaseUrl!,
        max: 1,
        application_name: 'omnis-cluster-timeout-precedence',
      });
      try {
        await adminPool!.query("ALTER SYSTEM SET statement_timeout = '45s'");
        await adminPool!.query('SELECT pg_reload_conf()');
        const runtime = await runtimeFreshPool.query<{
          statement: string;
          source: string;
        }>(
          "SELECT current_setting('statement_timeout') AS statement, (SELECT source FROM pg_settings WHERE name='statement_timeout') AS source",
        );
        assert.equal(runtime.rows[0]?.statement, '20s');
        assert.equal(runtime.rows[0]?.source, 'user');
      } finally {
        await adminPool!.query('ALTER SYSTEM RESET statement_timeout');
        await adminPool!.query('SELECT pg_reload_conf()');
        await runtimeFreshPool.end();
      }
    });

    it('survives PostgreSQL terminating an idle transaction in a separate Node process', async () => {
      const moduleUrl = new URL('./database.ts', import.meta.url).href;
      const childScript = `
        import { createPool, inTransaction } from ${JSON.stringify(moduleUrl)};
        const pool = createPool({ connectionString: process.env.OMNIS_TEST_DATABASE_URL, max: 1 });
        try {
          await inTransaction(pool, async (client) => {
            await client.query("SET LOCAL idle_in_transaction_session_timeout = '250ms'");
            await client.query('SELECT 1');
            await new Promise((resolve) => setTimeout(resolve, 500));
            await client.query('SELECT 2');
          });
          console.log(JSON.stringify({ result: 'unexpected_success' }));
          process.exitCode = 2;
        } catch (error) {
          const queryAfterDisconnect = await pool.query('SELECT 1 AS recovered');
          console.log(JSON.stringify({
            result: 'transaction_rejected',
            recovered: queryAfterDisconnect.rows[0]?.recovered === 1,
            errorCode: typeof error === 'object' && error !== null && 'code' in error ? error.code : null,
            errorMessage: error instanceof Error ? error.message : String(error)
          }));
        } finally {
          await pool.end();
        }
      `;
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', childScript],
        {
          env: { ...process.env, OMNIS_TEST_DATABASE_URL: databaseUrl! },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0, `isolated DB client process exited unexpectedly: ${stderr}`);
      assert.equal(signal, null);
      const outcome = JSON.parse(stdout.trim()) as {
        result: string;
        recovered: boolean;
        errorCode: string | null;
        errorMessage: string;
      };
      assert.equal(outcome.result, 'transaction_rejected');
      assert.equal(outcome.recovered, true);
      assert.ok(
        outcome.errorCode || /connection|terminat|not queryable/i.test(outcome.errorMessage),
        `the failed transaction error must remain observable: ${outcome.errorMessage}`,
      );
    });

    it('handles idle pooled-client termination without crashing and uses a replacement connection', async () => {
      const moduleUrl = new URL('./database.ts', import.meta.url).href;
      const childScript = `
        import { createPool } from ${JSON.stringify(moduleUrl)};
        let resolveIdleError;
        const idleError = new Promise((resolve) => { resolveIdleError = resolve; });
        const pool = createPool({
          connectionString: process.env.OMNIS_TEST_DATABASE_URL,
          max: 1,
          application_name: 'omnis-idle-pool-error-child'
        }, (error) => resolveIdleError(error));
        const client = await pool.connect();
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        client.release();
        process.stdout.write(JSON.stringify({ ready: true, pid }) + '\\n');
        const error = await idleError;
        const replacement = await pool.query('SELECT 1 AS recovered');
        process.stdout.write(JSON.stringify({
          handled: typeof error.code === 'string',
          safeCode: error.code ?? null,
          recovered: replacement.rows[0].recovered === 1
        }) + '\\n');
        await pool.end();
      `;
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', childScript],
        {
          env: { ...process.env, OMNIS_TEST_DATABASE_URL: databaseUrl! },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const lineReader = createInterface({ input: child.stdout! });
      const lines = lineReader[Symbol.asyncIterator]();
      const firstLine = await Promise.race([
        lines.next(),
        delay(5_000).then(() => {
          throw new Error('Timed out waiting for the idle-pool child to connect.');
        }),
      ]);
      const ready = JSON.parse(firstLine.value as string) as { ready: boolean; pid: number };
      assert.equal(ready.ready, true);
      await adminPool!.query('SELECT pg_terminate_backend($1)', [ready.pid]);
      const secondLine = await Promise.race([
        lines.next(),
        delay(5_000).then(() => {
          throw new Error('Timed out waiting for the idle-pool error handler.');
        }),
      ]);
      const outcome = JSON.parse(secondLine.value as string) as {
        handled: boolean;
        safeCode: string | null;
        recovered: boolean;
      };
      lineReader.close();
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal(outcome.handled, true);
      assert.equal(outcome.safeCode, '57P01');
      assert.equal(outcome.recovered, true);
    });

    it('recycles a backend killed by idle transaction timeout and leaves idle pooled sessions alone', async () => {
      const timeoutPool = createPool({
        connectionString: databaseUrl!,
        max: 1,
        application_name: 'omnis-idle-transaction-timeout',
      });
      let clientError: Error | undefined;
      const timedClient = await timeoutPool.connect();
      timedClient.on('error', (error: Error) => {
        clientError = error;
      });
      let backendPid: number;
      try {
        await timedClient.query("SET idle_in_transaction_session_timeout = '250ms'");
        await timedClient.query('BEGIN');
        await timedClient.query('SELECT pg_advisory_xact_lock(7046390999411)');
        backendPid = (await timedClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        await waitForBackendExit(adminPool!, backendPid, 3_000);
        assert.ok(clientError, 'PostgreSQL should terminate an idle transaction past its timeout');
        await assert.rejects(timedClient.query('SELECT 1'));
      } finally {
        timedClient.release(true);
      }

      const replacement = await timeoutPool.connect();
      try {
        const replacementPid = (
          await replacement.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0]!.pid;
        assert.notEqual(replacementPid, backendPid, 'the pool must replace the terminated backend');
      } finally {
        replacement.release();
        await timeoutPool.end();
      }

      const idleLockPool = createPool({
        connectionString: databaseUrl!,
        max: 1,
        application_name: 'omnis-idle-session-advisory-lock',
      });
      const idleLockClient = await idleLockPool.connect();
      const sessionLockKey = '7046390999412';
      try {
        await idleLockClient.query("SET idle_session_timeout = '0'");
        await idleLockClient.query('SELECT pg_advisory_lock($1::bigint)', [sessionLockKey]);
        const pid = (await idleLockClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        await delay(300);
        const state = await adminPool!.query<{ present: boolean; lock_held: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS present,
                  EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted) AS lock_held`,
          [pid],
        );
        assert.deepEqual(state.rows[0], { present: true, lock_held: true });
      } finally {
        await idleLockClient.query('SELECT pg_advisory_unlock($1::bigint)', [sessionLockKey]);
        idleLockClient.release();
        await idleLockPool.end();
      }
    });

    it('keeps authorization durable, scoped, auditable, and non-mutable by the runtime role', async () => {
      const task = await store.createTask({
        title: 'Authorization boundary',
        detail: 'Synthetic persistence test for run-scoped authorization.',
      });
      const pending = await authorizations.request(task.id, 'owner');
      assert.equal(pending.status, 'pending');
      const decisions = await Promise.allSettled([
        authorizations.decide(pending.id, 'owner', 'approve'),
        authorizations.decide(pending.id, 'owner', 'approve'),
      ]);
      assert.equal(decisions.filter((entry) => entry.status === 'fulfilled').length, 2);
      assert.equal(decisions.filter((entry) => entry.status === 'rejected').length, 0);
      const approvals = decisions.flatMap((entry) =>
        entry.status === 'fulfilled' ? [entry.value] : [],
      );
      assert.equal(approvals[0]?.id, approvals[1]?.id);
      assert.equal(approvals[0]?.status, 'authorized');

      await assert.rejects(
        authorizerPool!.query(
          `UPDATE omnis.runtime_authorizations SET scope='{"kind":"task","taskId":"task-9999"}' WHERE id=$1`,
          [pending.id],
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query("UPDATE omnis.runtime_authorizations SET status='revoked' WHERE id=$1", [
          pending.id,
        ]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('DELETE FROM omnis.runtime_authorizations WHERE id=$1', [pending.id]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          `INSERT INTO omnis.runtime_authorizations
             (id,requesting_actor,runtime_id,operation,task_id,capabilities,scope,policy_version,correlation_id,expires_at)
           VALUES ('forged','owner','mock','execute_task',$1,'["mock.execute"]',
             jsonb_build_object('kind','task','taskId',$1::text),'v1','forged',now()+interval '1 hour')`,
          [task.id],
        ),
        /permission denied/,
      );
      await assert.rejects(
        authorizerPool!.query(
          `INSERT INTO omnis.runtime_authorizations(id,requesting_actor,runtime_id,operation,task_id,capabilities,scope,policy_version,correlation_id,expires_at)
           VALUES ('agent-forged','agent:mock','mock','execute_task',$1,'["mock.execute"]',jsonb_build_object('kind','task','taskId',$1::text),'v1','agent',now()+interval '1 hour')`,
          [task.id],
        ),
        /check constraint/,
      );

      const otherTask = await store.createTask({
        title: 'Cross scope denial',
        detail: 'An authorization cannot cross task boundaries.',
      });
      await assert.rejects(
        store.admitRun(otherTask.id, key('cross-scope-auth'), pending.id, async () => 'job'),
        /active task-scoped authorization is required/,
      );

      const admitted = await admit(task.id, key('durable-auth'), async () => 'job');
      const runAuthorization = await authorizations.getForRun(admitted.run.id);
      assert.equal(runAuthorization?.status, 'authorized');
      assert.equal(runAuthorization?.consumedRunId, admitted.run.id);
      const restartedAuthorizer = new PostgresAuthorizationStore(pool!, authorizerPool!);
      assert.equal((await restartedAuthorizer.get(pending.id))?.status, 'authorized');
      const audit = await restartedAuthorizer.getAudit(pending.id);
      assert.equal(audit.filter((event) => event.eventType === 'authorization.approved').length, 1);
      assert.deepEqual(audit.map((event) => event.eventType).slice(0, 2), [
        'authorization.requested',
        'authorization.approved',
      ]);
      await restartedAuthorizer.revoke(runAuthorization!.id, 'owner');
      assert.equal((await restartedAuthorizer.getForRun(admitted.run.id))?.status, 'revoked');
      assert.equal(
        await restartedAuthorizer.isActive(runAuthorization!.id, task.id, admitted.run.id),
        false,
      );
      assert.ok(
        (await restartedAuthorizer.getAudit(runAuthorization!.id)).some(
          (event) => event.eventType === 'authorization.revoked',
        ),
      );
    });

    it('makes repeated authorizer request IDs idempotent and scope-bound', async () => {
      const task = await store.createTask({
        title: 'Authorizer request idempotency',
        detail: 'A replayed internal control request must return the original grant.',
      });
      const requestId = randomUUID();
      const first = await authorizations.request(task.id, 'owner', requestId);
      const replay = await authorizations.request(task.id, 'owner', requestId);
      assert.equal(replay.id, first.id);
      assert.equal(replay.correlationId, requestId);
      assert.equal(
        (
          await authorizerPool!.query(
            `SELECT 1 FROM omnis.authorization_audit
              WHERE authorization_id=$1 AND event_type='authorization.requested'`,
            [first.id],
          )
        ).rowCount,
        1,
      );

      const otherTask = await store.createTask({
        title: 'Other request scope',
        detail: 'An idempotency key cannot be rebound to a different task.',
      });
      await assert.rejects(
        authorizations.request(otherTask.id, 'owner', requestId),
        /idempotency key belongs to a different task/,
      );
    });

    it('expires authorizations using database time and records the expiry decision', async () => {
      const task = await store.createTask({
        title: 'Expired grant',
        detail: 'Synthetic expiry probe.',
      });
      const pending = await authorizations.request(task.id, 'owner');
      await adminPool!.query(
        `UPDATE omnis.runtime_authorizations SET expires_at=now()-interval '1 second' WHERE id=$1`,
        [pending.id],
      );
      await assert.rejects(authorizations.decide(pending.id, 'owner', 'approve'), /expired/);
      const expired = await authorizations.get(pending.id);
      assert.equal(expired?.status, 'expired');
      assert.ok(
        (await authorizations.getAudit(pending.id)).some(
          (event) => event.eventType === 'authorization.expired',
        ),
      );
    });

    it('prevents runtime audit forgery and predictable-ID denial of service', async () => {
      const task = await store.createTask({
        title: 'Audit boundary',
        detail: 'Synthetic regression fixture.',
      });
      const grant = await authorizations.request(task.id, 'owner');
      await authorizations.decide(grant.id, 'owner', 'approve');

      for (const eventType of [
        'authorization.approved',
        'authorization.denied',
        'authorization.revoked',
      ]) {
        await assert.rejects(
          pool!.query(
            `INSERT INTO omnis.authorization_audit (
               id, authorization_id, task_id, event_type, actor_id, effective_identity,
               capability, correlation_id, outcome
             ) VALUES ($1,$2,$3,$4,'attacker','human:owner','mock.execute','forged','recorded')`,
            [`audit-${grant.id}-${eventType}`, grant.id, task.id, eventType],
          ),
          /permission denied/,
        );
      }

      await assert.rejects(
        pool!.query('SELECT omnis.append_runtime_authorization_audit($1, $2, NULL)', [
          'run-not-real',
          'authorization.approved',
        ]),
        /runtime audit event type is not permitted/,
      );

      const catalog = await adminPool!.query<{
        table_insert: boolean;
        id_insert: boolean;
        event_insert: boolean;
        append_execute: boolean;
        authorizer_execute: boolean;
        public_execute: boolean;
        append_definer: boolean;
        append_owner: string;
        append_search_path: string[];
      }>(`
        SELECT has_table_privilege('omnis_runtime', 'omnis.authorization_audit', 'INSERT') AS table_insert,
               has_column_privilege('omnis_runtime', 'omnis.authorization_audit', 'id', 'INSERT') AS id_insert,
               has_column_privilege('omnis_runtime', 'omnis.authorization_audit', 'event_type', 'INSERT') AS event_insert,
               has_function_privilege('omnis_runtime', 'omnis.append_runtime_authorization_audit(text,text,text)', 'EXECUTE') AS append_execute,
               has_function_privilege('omnis_authorizer', 'omnis.append_runtime_authorization_audit(text,text,text)', 'EXECUTE') AS authorizer_execute,
               EXISTS (
                 SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS grant_row
                  WHERE grant_row.grantee=0 AND grant_row.privilege_type='EXECUTE'
               ) AS public_execute,
               p.prosecdef AS append_definer,
               r.rolname AS append_owner,
               p.proconfig AS append_search_path
          FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
         WHERE p.oid='omnis.append_runtime_authorization_audit(text,text,text)'::regprocedure
      `);
      assert.deepEqual(catalog.rows[0], {
        table_insert: false,
        id_insert: false,
        event_insert: false,
        append_execute: true,
        authorizer_execute: false,
        public_execute: false,
        append_definer: true,
        append_owner: 'omnis_migrator',
        append_search_path: ['search_path=pg_catalog, omnis'],
      });

      const collisionId = `audit-${grant.id}-revoked`;
      await assert.rejects(
        pool!.query(
          `INSERT INTO omnis.authorization_audit (
             id, authorization_id, task_id, event_type, actor_id, effective_identity,
             capability, correlation_id, outcome
           ) VALUES ($1,$2,$3,'authorization.revoked','attacker','human:owner',
                    'mock.execute','forged','recorded')`,
          [collisionId, grant.id, task.id],
        ),
        /permission denied/,
      );
      const revoked = await authorizations.revoke(grant.id, 'owner');
      assert.equal(revoked.status, 'revoked');
      assert.equal(await authorizations.isActive(grant.id, task.id, 'run-unused'), false);
      const audit = await authorizations.getAudit(grant.id);
      const revocation = audit.find((event) => event.eventType === 'authorization.revoked');
      assert.ok(revocation);
      assert.notEqual(revocation.id, collisionId);
      assert.equal(revocation.actorId, 'owner');
      assert.equal(revocation.effectiveIdentity, 'human:owner');
    });

    it('uses database audit IDs for consumption and expiry and keeps runtime events append-only', async () => {
      const task = await store.createTask({
        title: 'Generated audit IDs',
        detail: 'Synthetic event identity fixture.',
      });
      const grant = await authorizations.request(task.id, 'owner');
      await authorizations.decide(grant.id, 'owner', 'approve');
      await assert.rejects(
        pool!.query(
          `INSERT INTO omnis.authorization_audit (
             id, authorization_id, task_id, event_type, actor_id, effective_identity,
             capability, correlation_id, outcome
           ) VALUES ($1,$2,$3,'authorization.consumed','attacker','service:omnis-worker',
                    'mock.execute','forged','allowed')`,
          [`audit-${grant.id}-consumed`, grant.id, task.id],
        ),
        /permission denied/,
      );

      const admitted = await store.admitRun(
        task.id,
        key('audit-generated-consume'),
        grant.id,
        async () => 'job',
      );
      const consumedAudit = (await authorizations.getAudit(grant.id)).find(
        (event) => event.eventType === 'authorization.consumed',
      );
      assert.equal(consumedAudit?.actorId, 'service:omnis-runtime');
      assert.equal(consumedAudit?.effectiveIdentity, 'service:omnis-runtime');
      const started = await store.beginExecution(admitted.run.id, 'audit-worker', 30);
      assert.equal(started.started, true);
      await store.completeRun(admitted.run.id, 'audit-worker', started.generation, 'synthetic');
      await assert.rejects(
        store.admitRun(task.id, key('audit-consume-twice'), grant.id, async () => 'job'),
        /active task-scoped authorization is required/,
      );
      assert.equal(
        (
          await adminPool!.query('SELECT count(*)::int AS count FROM omnis.runs WHERE task_id=$1', [
            task.id,
          ])
        ).rows[0]?.count,
        1,
      );
      const operationEvents = (await authorizations.getAudit(grant.id)).filter((event) =>
        event.eventType.startsWith('operation.'),
      );
      assert.deepEqual(
        operationEvents.map((event) => event.eventType),
        ['operation.started', 'operation.completed'],
      );
      assert.ok(operationEvents.every((event) => event.actorId === 'owner'));
      assert.ok(
        operationEvents.every((event) => event.effectiveIdentity === 'service:omnis-runtime'),
      );

      const expiredTask = await store.createTask({
        title: 'Expiry audit ID',
        detail: 'Synthetic expiry fixture.',
      });
      const expiredGrant = await authorizations.request(expiredTask.id, 'owner');
      await adminPool!.query(
        `UPDATE omnis.runtime_authorizations SET expires_at=now()-interval '1 second' WHERE id=$1`,
        [expiredGrant.id],
      );
      await assert.rejects(
        pool!.query(
          `INSERT INTO omnis.authorization_audit (
             id, authorization_id, task_id, event_type, actor_id, effective_identity,
             capability, correlation_id, outcome
           ) VALUES ($1,$2,$3,'authorization.expired','attacker','service:omnis-authorizer',
                    'mock.execute','forged','recorded')`,
          [`audit-expired-${expiredGrant.id}`, expiredGrant.id, expiredTask.id],
        ),
        /permission denied/,
      );
      await authorizations.get(expiredGrant.id);
      await authorizations.get(expiredGrant.id);
      const expiryEvents = (await authorizations.getAudit(expiredGrant.id)).filter(
        (event) => event.eventType === 'authorization.expired',
      );
      assert.equal(expiryEvents.length, 1);
      assert.notEqual(expiryEvents[0]?.id, `audit-expired-${expiredGrant.id}`);
    });

    it('rolls back grant transitions when a mandatory audit insert fails', async () => {
      const revokeTask = await store.createTask({
        title: 'Audit rollback revocation',
        detail: 'Synthetic forced audit failure.',
      });
      const revokeGrant = await authorizations.request(revokeTask.id, 'owner');
      await authorizations.decide(revokeGrant.id, 'owner', 'approve');
      const consumeTask = await store.createTask({
        title: 'Audit rollback consumption',
        detail: 'Synthetic forced audit failure.',
      });
      const consumeGrant = await authorizations.request(consumeTask.id, 'owner');
      await authorizations.decide(consumeGrant.id, 'owner', 'approve');
      const failureTask = await store.createTask({
        title: 'Audit rollback failure',
        detail: 'Synthetic operation audit failure.',
      });
      const failureGrant = await authorizations.request(failureTask.id, 'owner');
      await authorizations.decide(failureGrant.id, 'owner', 'approve');

      await adminPool!.query(`
        CREATE FUNCTION omnis.reject_g4_audit_test() RETURNS trigger
        LANGUAGE plpgsql AS $test$
        BEGIN
          IF NEW.event_type IN ('authorization.revoked', 'authorization.consumed') THEN
            RAISE EXCEPTION 'controlled audit failure';
          END IF;
          RETURN NEW;
        END
        $test$;
        CREATE TRIGGER reject_g4_audit_test BEFORE INSERT ON omnis.authorization_audit
          FOR EACH ROW EXECUTE FUNCTION omnis.reject_g4_audit_test();
      `);
      try {
        await assert.rejects(
          authorizations.revoke(revokeGrant.id, 'owner'),
          /controlled audit failure/,
        );
        assert.equal((await authorizations.get(revokeGrant.id))?.status, 'authorized');
        assert.equal(
          (await authorizations.getAudit(revokeGrant.id)).some(
            (event) => event.eventType === 'authorization.revoked',
          ),
          false,
        );
        await assert.rejects(
          store.admitRun(
            consumeTask.id,
            key('mandatory-consume-audit'),
            consumeGrant.id,
            async () => 'job',
          ),
          /controlled audit failure/,
        );
        assert.equal((await authorizations.get(consumeGrant.id))?.consumedRunId, null);
        assert.equal(
          (await adminPool!.query('SELECT 1 FROM omnis.runs WHERE task_id=$1', [consumeTask.id]))
            .rowCount,
          0,
        );
        await adminPool!.query(`
          DROP TRIGGER reject_g4_audit_test ON omnis.authorization_audit;
          DROP FUNCTION omnis.reject_g4_audit_test();
          CREATE FUNCTION omnis.reject_g4_audit_test() RETURNS trigger
          LANGUAGE plpgsql AS $test$
          BEGIN
            IF NEW.event_type = 'operation.failed' THEN
              RAISE EXCEPTION 'controlled audit failure';
            END IF;
            RETURN NEW;
          END
          $test$;
          CREATE TRIGGER reject_g4_audit_test BEFORE INSERT ON omnis.authorization_audit
            FOR EACH ROW EXECUTE FUNCTION omnis.reject_g4_audit_test();
        `);
        const failureRun = await store.admitRun(
          failureTask.id,
          key('mandatory-failure-audit'),
          failureGrant.id,
          async () => 'job',
        );
        const failureClaim = await store.beginExecution(
          failureRun.run.id,
          'audit-failure-worker',
          30,
        );
        assert.equal(failureClaim.started, true);
        await assert.rejects(
          store.failRun(
            failureRun.run.id,
            'audit-failure-worker',
            failureClaim.generation,
            'Synthetic failure whose audit must persist.',
          ),
          /controlled audit failure/,
        );
        assert.equal((await store.getRun(failureRun.run.id))?.status, 'running');
        assert.equal(
          (await store.getEvents(failureRun.run.id)).some((event) => event.type === 'run.failed'),
          false,
        );
        assert.equal(
          (await authorizations.getAudit(failureGrant.id)).some(
            (event) => event.eventType === 'operation.failed',
          ),
          false,
        );
      } finally {
        await adminPool!.query(
          'DROP TRIGGER IF EXISTS reject_g4_audit_test ON omnis.authorization_audit; DROP FUNCTION IF EXISTS omnis.reject_g4_audit_test()',
        );
      }
    });

    it('does not let a runtime session-level advisory lock block authorization revocation', async () => {
      const task = await store.createTask({
        title: 'Advisory lock availability',
        detail: 'Synthetic probe for the former shared revocation key.',
      });
      const grant = await authorizations.request(task.id, 'owner');
      await authorizations.decide(grant.id, 'owner', 'approve');
      const holder = await pool!.connect();
      const revokerPool = createPool({
        connectionString: authorizerUrl!,
        application_name: 'omnis-g4-9-revoker',
        query_timeout: 5_000,
      });
      const revoker = new PostgresAuthorizationStore(pool!, revokerPool);
      let revokeSettled = false;
      let revokeError: unknown;
      let pendingRevoke:
        Promise<Awaited<ReturnType<typeof revoker.revoke>> | undefined> | undefined;
      try {
        await holder.query("SET application_name = 'omnis-g4-9-runtime-lock-holder'");
        await holder.query('SELECT pg_advisory_lock(70463909136524)');
        pendingRevoke = revoker.revoke(grant.id, 'owner').then(
          (value) => {
            revokeSettled = true;
            return value;
          },
          (error: unknown) => {
            revokeSettled = true;
            revokeError = error;
            return undefined;
          },
        );
        const observed = await waitForLockWaitOrCompletion(
          adminPool!,
          'omnis-g4-9-revoker',
          () => revokeSettled,
          3_000,
        );
        if (observed === 'lock_wait') {
          const locks = await adminPool!.query<{
            locktype: string;
            mode: string;
            granted: boolean;
          }>(
            `SELECT l.locktype, l.mode, l.granted
               FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
              WHERE a.application_name='omnis-g4-9-revoker' AND NOT l.granted`,
          );
          assert.ok(locks.rows.some((lock) => lock.locktype === 'advisory'));
        }
        assert.equal(
          observed,
          'completed',
          'a runtime-held former shared key must not block authorization revocation',
        );
      } finally {
        await holder.query('SELECT pg_advisory_unlock(70463909136524)').catch(() => undefined);
        holder.release();
        await pendingRevoke?.catch(() => undefined);
        await revokerPool.end();
      }
      const revoked = await pendingRevoke;
      if (revokeError) throw revokeError;
      assert.equal(revoked?.status, 'revoked');
      assert.ok(
        (await authorizations.getAudit(grant.id)).some(
          (event) => event.eventType === 'authorization.revoked',
        ),
      );
    });

    it('bounds genuine grant-row contention and never reports a timed-out revoke as committed', async () => {
      const task = await store.createTask({
        title: 'Bounded revocation contention',
        detail: 'Synthetic grant lock timeout fixture.',
      });
      const grant = await authorizations.request(task.id, 'owner');
      await authorizations.decide(grant.id, 'owner', 'approve');
      const holder = await pool!.connect();
      const revokerPool = createPool({
        connectionString: authorizerUrl!,
        application_name: 'omnis-g4-9-row-lock-revoker',
        query_timeout: 5_000,
      });
      const revoker = new PostgresAuthorizationStore(pool!, revokerPool);
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        const locked = await holder.query<{ allowed: boolean }>(
          'SELECT omnis.lock_run_authorization_for_admission($1, $2) AS allowed',
          [grant.id, task.id],
        );
        assert.equal(locked.rows[0]?.allowed, true);
        pending = revoker.revoke(grant.id, 'owner');
        await waitForLockWait(adminPool!, 'omnis-g4-9-row-lock-revoker');
        await assert.rejects(
          pending,
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '55P03',
        );
        const unchanged = await authorizations.get(grant.id);
        assert.equal(unchanged?.status, 'authorized');
        assert.equal(unchanged?.revokedAt, null);
        assert.equal(
          (await authorizations.getAudit(grant.id)).some(
            (event) => event.eventType === 'authorization.revoked',
          ),
          false,
        );
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        await pending?.catch(() => undefined);
        await revokerPool.end();
      }
      const revoked = await authorizations.revoke(grant.id, 'owner');
      assert.equal(revoked.status, 'revoked');
      assert.ok(
        (await authorizations.getAudit(grant.id)).some(
          (event) => event.eventType === 'authorization.revoked',
        ),
      );
    });

    it('bounds consumed-run row contention without committing revocation or audit', async () => {
      const task = await store.createTask({
        title: 'Consumed run revocation contention',
        detail: 'Synthetic run-row lock fixture for the consumed grant path.',
      });
      const grant = await authorizations.request(task.id, 'owner');
      await authorizations.decide(grant.id, 'owner', 'approve');
      const admitted = await store.admitRun(
        task.id,
        key('consumed-revoke-lock'),
        grant.id,
        async () => 'job',
      );
      const holder = await pool!.connect();
      const revokerPool = createPool({
        connectionString: authorizerUrl!,
        application_name: 'omnis-g4-12-consumed-run-revoker',
        query_timeout: 5_000,
      });
      const revoker = new PostgresAuthorizationStore(pool!, revokerPool);
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM omnis.runs WHERE id=$1 FOR UPDATE', [admitted.run.id]);
        const pending = revoker.revoke(grant.id, 'owner');
        await waitForLockWait(adminPool!, 'omnis-g4-12-consumed-run-revoker');
        await assert.rejects(
          pending,
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '55P03',
        );
        assert.equal((await authorizations.get(grant.id))?.status, 'authorized');
        assert.equal(
          (await authorizations.getAudit(grant.id)).some(
            (event) => event.eventType === 'authorization.revoked',
          ),
          false,
        );
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        await revokerPool.end();
      }
      assert.equal((await authorizations.revoke(grant.id, 'owner')).status, 'revoked');
    });

    it('allows only migration-marked grantless legacy runs to reach safe terminal states', async () => {
      const makeLegacyRun = async (suffix: string, status: 'queued' | 'stopping' | 'running') => {
        const task = await store.createTask({
          title: `Legacy ${status} run`,
          detail: 'Synthetic fixture carrying migration-created legacy provenance.',
        });
        const runId = `legacy-${suffix}-${nextKey}`;
        await adminPool!.query(
          `INSERT INTO omnis.runs (
             id, task_id, task_title, status, execution_generation, lease_owner,
             lease_expires_at, last_event_sequence
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
          [
            runId,
            task.id,
            task.title,
            status,
            status === 'running' ? 3 : 0,
            status === 'running' ? `legacy-worker-${suffix}` : null,
            status === 'running' ? new Date(Date.now() + 60_000) : null,
          ],
        );
        await adminPool!.query(
          `INSERT INTO omnis.run_events (id, run_id, sequence, event_type, message)
           VALUES ($1,$2,1,'run.queued','Synthetic pre-authorization queued event.')`,
          [`event-${runId}`, runId],
        );
        await adminPool!.query(
          `INSERT INTO omnis.legacy_unscoped_runs (run_id, task_id) VALUES ($1,$2)`,
          [runId, task.id],
        );
        return { task, runId, workerId: `legacy-worker-${suffix}` };
      };

      const queuedForExecution = await makeLegacyRun('claim-denied', 'queued');
      const deniedClaim = await store.beginExecution(
        queuedForExecution.runId,
        'legacy-claim-worker',
        30,
      );
      assert.equal(deniedClaim.started, false);
      assert.equal(deniedClaim.run.status, 'interrupted');

      const queued = await makeLegacyRun('cancel', 'stopping');
      const cancelled = await store.cancelRunAfterQueueTerminal(queued.runId);
      assert.equal(cancelled?.run.status, 'cancelled');
      assert.equal(await authorizations.getForRun(queued.runId), undefined);

      const running = await makeLegacyRun('interrupt', 'running');
      const interrupted = await store.interruptRun(running.runId, running.workerId, 3);
      assert.equal(interrupted?.run.status, 'interrupted');

      const failing = await makeLegacyRun('failure', 'running');
      const failed = await store.failRun(failing.runId, failing.workerId, 3, 'Legacy failure.');
      assert.equal(failed.run.status, 'failed');

      const runtimeAttributed = await makeLegacyRun('runtime-attribution', 'running');
      await pool!.query(
        `UPDATE omnis.runs SET status='failed', lease_owner=NULL, lease_expires_at=NULL
          WHERE id=$1`,
        [runtimeAttributed.runId],
      );
      const appended = await pool!.query<{ appended: boolean }>(
        `SELECT omnis.append_runtime_authorization_audit($1, 'operation.failed', 'runtime_failed')
          AS appended`,
        [runtimeAttributed.runId],
      );
      assert.equal(appended.rows[0]?.appended, true);
      const runtimeAttributedAudit = await adminPool!.query(
        `SELECT actor_id, effective_identity, correlation_id
           FROM omnis.authorization_audit WHERE run_id=$1 AND event_type='operation.failed'`,
        [runtimeAttributed.runId],
      );
      assert.deepEqual(runtimeAttributedAudit.rows[0], {
        actor_id: 'service:omnis-runtime',
        effective_identity: 'service:omnis-runtime',
        correlation_id: `legacy-grantless-run:${runtimeAttributed.runId}`,
      });

      const legacyAudit = await adminPool!.query<{
        run_id: string;
        authorization_id: string | null;
        actor_id: string;
        event_type: string;
      }>(
        `SELECT run_id, authorization_id, actor_id, event_type
           FROM omnis.authorization_audit WHERE run_id = ANY($1::text[]) ORDER BY run_id`,
        [
          [
            queuedForExecution.runId,
            queued.runId,
            running.runId,
            failing.runId,
            runtimeAttributed.runId,
          ],
        ],
      );
      assert.deepEqual(
        legacyAudit.rows.map((row) => [row.authorization_id, row.actor_id, row.event_type]),
        [
          [null, 'service:omnis-runtime', 'operation.cancelled'],
          [null, 'service:omnis-runtime', 'authorization.enforcement_denied'],
          [null, 'service:omnis-runtime', 'operation.failed'],
          [null, 'service:omnis-runtime', 'operation.interrupted'],
          [null, 'service:omnis-runtime', 'operation.failed'],
        ],
      );
      await assert.rejects(
        pool!.query('SELECT * FROM omnis.legacy_unscoped_runs'),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('INSERT INTO omnis.legacy_unscoped_runs (run_id, task_id) VALUES ($1,$2)', [
          queued.runId,
          queued.task.id,
        ]),
        /permission denied/,
      );
    });

    it('keeps a modern grantless run fail-closed and leaves it queued', async () => {
      const task = await store.createTask({
        title: 'Modern grantless run',
        detail: 'A new run without an authorization must not be classified as historical.',
      });
      const runId = `modern-unscoped-${nextKey}`;
      await adminPool!.query('INSERT INTO omnis.runs (id, task_id, task_title) VALUES ($1,$2,$3)', [
        runId,
        task.id,
        task.title,
      ]);
      await assert.rejects(
        store.beginExecution(runId, 'modern-untrusted-worker', 30),
        /runtime audit event could not be associated/,
      );
      assert.equal((await store.getRun(runId))?.status, 'queued');
      assert.equal(
        (
          await adminPool!.query('SELECT 1 FROM omnis.legacy_unscoped_runs WHERE run_id=$1', [
            runId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await store.getEvents(runId)).some((event) => event.type === 'run.started'),
        false,
      );
    });

    it('limits the admission-lock helper to runtime and denies runtime legacy-marker access', async () => {
      const result = await adminPool!.query<{
        runtime_execute: boolean;
        authorizer_execute: boolean;
        public_execute: boolean;
        runtime_select: boolean;
        runtime_insert: boolean;
        routine_owner: string;
        routine_search_path: string[];
      }>(`
        SELECT has_function_privilege(
                 'omnis_runtime',
                 'omnis.lock_run_authorization_for_admission(text,text)', 'EXECUTE'
               ) AS runtime_execute,
               has_function_privilege(
                 'omnis_authorizer',
                 'omnis.lock_run_authorization_for_admission(text,text)', 'EXECUTE'
               ) AS authorizer_execute,
               EXISTS (
                 SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                  WHERE x.grantee=0 AND x.privilege_type='EXECUTE'
               ) AS public_execute,
               has_table_privilege('omnis_runtime', 'omnis.legacy_unscoped_runs', 'SELECT') AS runtime_select,
               has_table_privilege('omnis_runtime', 'omnis.legacy_unscoped_runs', 'INSERT') AS runtime_insert,
               r.rolname AS routine_owner, p.proconfig AS routine_search_path
          FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
         WHERE p.oid='omnis.lock_run_authorization_for_admission(text,text)'::regprocedure
      `);
      assert.deepEqual(result.rows[0], {
        runtime_execute: true,
        authorizer_execute: false,
        public_execute: false,
        runtime_select: false,
        runtime_insert: false,
        routine_owner: 'omnis_migrator',
        routine_search_path: ['search_path=pg_catalog, omnis'],
      });
    });

    it('serializes unconsumed grant revocation with admission in both lock orders', async () => {
      const iterations = 3;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const task = await store.createTask({
          title: 'Admission wins revocation race',
          detail: `Synthetic lock-order iteration ${iteration}.`,
        });
        const grant = await authorizations.request(task.id, 'owner');
        await authorizations.decide(grant.id, 'owner', 'approve');
        const admissionPool = createPool({
          connectionString: databaseUrl!,
          application_name: 'omnis-g4-admission-wins',
        });
        const revokerPool = createPool({
          connectionString: authorizerUrl!,
          application_name: 'omnis-g4-admission-wins-revoker',
        });
        const admissionStore = new PostgresRunStore(admissionPool);
        const revoker = new PostgresAuthorizationStore(pool!, revokerPool);
        const enteredQueue = deferred<void>();
        const releaseAdmission = deferred<void>();
        try {
          const admission = admissionStore.admitRun(
            task.id,
            key(`admit-wins-${iteration}`),
            grant.id,
            async () => {
              enteredQueue.resolve();
              await releaseAdmission.promise;
              return 'job';
            },
          );
          await enteredQueue.promise;
          const revoke = revoker.revoke(grant.id, 'owner');
          await waitForLockWait(adminPool!, 'omnis-g4-admission-wins-revoker');
          releaseAdmission.resolve();
          const admitted = await admission;
          const revoked = await revoke;
          assert.equal(admitted.created, true);
          assert.equal(revoked.status, 'revoked');
          assert.equal(revoked.consumedRunId, admitted.run.id);
          const deniedClaim = await admissionStore.beginExecution(
            admitted.run.id,
            `g4-race-worker-${iteration}`,
            30,
          );
          assert.equal(deniedClaim.started, false);
          assert.equal(deniedClaim.run.status, 'interrupted');
          const audit = await authorizations.getAudit(grant.id);
          assert.deepEqual(
            audit
              .map((event) => event.eventType)
              .filter((type) => ['authorization.consumed', 'authorization.revoked'].includes(type)),
            ['authorization.consumed', 'authorization.revoked'],
          );
        } finally {
          releaseAdmission.resolve();
          await Promise.all([admissionPool.end(), revokerPool.end()]);
        }
      }

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const task = await store.createTask({
          title: 'Revocation wins admission race',
          detail: `Synthetic lock-order iteration ${iteration}.`,
        });
        const grant = await authorizations.request(task.id, 'owner');
        await authorizations.decide(grant.id, 'owner', 'approve');
        const gateKey = 7046390999911;
        const blocker = await adminPool!.connect();
        const admissionPool = createPool({
          connectionString: databaseUrl!,
          application_name: 'omnis-g4-revocation-wins-admission',
        });
        const revokerPool = createPool({
          connectionString: authorizerUrl!,
          application_name: 'omnis-g4-revocation-wins-revoker',
        });
        const revoker = new PostgresAuthorizationStore(pool!, revokerPool);
        const admissionStore = new PostgresRunStore(admissionPool);
        try {
          await blocker.query('SELECT pg_advisory_lock($1)', [gateKey]);
          await adminPool!.query(`
            CREATE OR REPLACE FUNCTION omnis.g4_revoke_audit_gate() RETURNS trigger
            LANGUAGE plpgsql AS $gate$
            BEGIN
              IF NEW.event_type = 'authorization.revoked' THEN
                PERFORM pg_advisory_xact_lock(${gateKey});
              END IF;
              RETURN NEW;
            END
            $gate$;
            DROP TRIGGER IF EXISTS g4_revoke_audit_gate ON omnis.authorization_audit;
            CREATE TRIGGER g4_revoke_audit_gate BEFORE INSERT ON omnis.authorization_audit
              FOR EACH ROW EXECUTE FUNCTION omnis.g4_revoke_audit_gate();
          `);
          const revoke = revoker.revoke(grant.id, 'owner');
          await waitForLockWait(adminPool!, 'omnis-g4-revocation-wins-revoker');
          const admissionKey = key(`revoke-wins-${iteration}`);
          const admission = admissionStore
            .admitRun(task.id, admissionKey, grant.id, async () => 'job')
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
          await waitForLockWait(adminPool!, 'omnis-g4-revocation-wins-admission');
          await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey]);
          const revoked = await revoke;
          const admissionResult = await admission;
          assert.equal(revoked.status, 'revoked');
          assert.ok('error' in admissionResult);
          assert.match(String(admissionResult.error), /authorization/i);
          assert.equal(
            (await adminPool!.query('SELECT 1 FROM omnis.runs WHERE task_id=$1', [task.id]))
              .rowCount,
            0,
          );
          assert.equal(
            (
              await adminPool!.query(
                'SELECT 1 FROM omnis.run_idempotency WHERE idempotency_key=$1',
                [admissionKey],
              )
            ).rowCount,
            0,
          );
          assert.ok(
            (await authorizations.getAudit(grant.id)).some(
              (event) => event.eventType === 'authorization.revoked',
            ),
          );
        } finally {
          await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey]).catch(() => undefined);
          await adminPool!.query(
            'DROP TRIGGER IF EXISTS g4_revoke_audit_gate ON omnis.authorization_audit; DROP FUNCTION IF EXISTS omnis.g4_revoke_audit_gate()',
          );
          blocker.release();
          await Promise.all([admissionPool.end(), revokerPool.end()]);
        }
      }
    });

    it('reproduces the legacy blocking admission lock and bounds the wait under that lock', async () => {
      const task = await store.createTask({
        title: 'Admission lock contention',
        detail: 'Disposable proof that a runtime-held capacity key cannot hang requests.',
      });
      const grant = await authorizations.request(task.id, 'owner');
      await authorizations.decide(grant.id, 'owner', 'approve');
      const lockKey = 70463909136524;
      const holder = await pool!.connect();
      const oldPathPool = createPool({
        connectionString: databaseUrl!,
        application_name: 'omnis-g4-13-old-admission-path',
      });
      const contender = await oldPathPool.connect();
      try {
        await holder.query("SET application_name = 'omnis-g4-13-lock-holder'");
        await holder.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);

        await contender.query('BEGIN');
        const historicalWait = contender.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          lockKey,
        ]);
        await waitForLockWait(adminPool!, 'omnis-g4-13-old-admission-path');
        await holder.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
        await historicalWait;
        await contender.query('ROLLBACK');

        await holder.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
        const startedAt = Date.now();
        await assert.rejects(
          store.admitRun(task.id, key('admission-key-held'), grant.id, async () => 'job'),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '55P03',
        );
        assert.ok(
          Date.now() - startedAt >= 2_500 && Date.now() - startedAt < 5_000,
          'the configured three-second lock timeout must bound the wait',
        );
        assert.equal(
          (await adminPool!.query('SELECT 1 FROM omnis.runs WHERE task_id=$1', [task.id])).rowCount,
          0,
        );
        assert.equal(
          (
            await adminPool!.query('SELECT 1 FROM omnis.run_idempotency WHERE idempotency_key=$1', [
              key('admission-key-held'),
            ])
          ).rowCount,
          0,
        );
        assert.equal((await authorizations.get(grant.id))?.consumedRunId, null);

        await holder.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
        const admitted = await store.admitRun(
          task.id,
          key('admission-key-held'),
          grant.id,
          async () => 'job',
        );
        assert.equal(admitted.created, true);
      } finally {
        await holder
          .query('SELECT pg_advisory_unlock($1::bigint)', [lockKey])
          .catch(() => undefined);
        await contender.query('ROLLBACK').catch(() => undefined);
        contender.release();
        holder.release();
        await oldPathPool.end();
      }
    });

    it('bounds waits for a runtime-held transaction-level admission key too', async () => {
      const task = await store.createTask({
        title: 'Transaction admission lock',
        detail: 'The protected path must not wait behind either advisory lock lifetime.',
      });
      const grant = await authorizations.request(task.id, 'owner');
      await authorizations.decide(grant.id, 'owner', 'approve');
      const holder = await pool!.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', ['70463909136524']);
        const startedAt = Date.now();
        await assert.rejects(
          store.admitRun(task.id, key('admission-xact-held'), grant.id, async () => 'job'),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '55P03',
        );
        assert.ok(Date.now() - startedAt >= 2_500 && Date.now() - startedAt < 5_000);
        assert.equal((await authorizations.get(grant.id))?.consumedRunId, null);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('serializes direct runtime consumption with revocation at the SQL function boundary', async () => {
      const iterations = 3;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const task = await store.createTask({
          title: 'Direct consume wins',
          detail: `Synthetic function-boundary iteration ${iteration}.`,
        });
        const grant = await authorizations.request(task.id, 'owner');
        await authorizations.decide(grant.id, 'owner', 'approve');
        const runId = `run-direct-consume-${nextKey}-${iteration}`;
        const runtimeDirectPool = createPool({
          connectionString: databaseUrl!,
          application_name: 'omnis-g4-direct-consume-wins',
        });
        const revokerPool = createPool({
          connectionString: authorizerUrl!,
          application_name: 'omnis-g4-direct-consume-wins-revoker',
        });
        const revoker = new PostgresAuthorizationStore(pool!, revokerPool);
        const consumer = await runtimeDirectPool.connect();
        try {
          await consumer.query('BEGIN');
          await consumer.query(
            'INSERT INTO omnis.runs (id, task_id, task_title) VALUES ($1,$2,$3)',
            [runId, task.id, task.title],
          );
          const consumed = await consumer.query<{ allowed: boolean }>(
            'SELECT omnis.consume_run_authorization($1,$2,$3,$4) AS allowed',
            [grant.id, task.id, runId, grant.correlationId],
          );
          assert.equal(consumed.rows[0]?.allowed, true);
          const revoke = revoker.revoke(grant.id, 'owner');
          await waitForLockWait(adminPool!, 'omnis-g4-direct-consume-wins-revoker');
          await consumer.query('COMMIT');
          const revoked = await revoke;
          assert.equal(revoked.status, 'revoked');
          assert.equal(revoked.consumedRunId, runId);
          const lifecycle = (await authorizations.getAudit(grant.id)).map(
            (event) => event.eventType,
          );
          assert.ok(lifecycle.includes('authorization.consumed'));
          assert.ok(lifecycle.includes('authorization.revoked'));
        } finally {
          await consumer.query('ROLLBACK').catch(() => undefined);
          consumer.release();
          await Promise.all([runtimeDirectPool.end(), revokerPool.end()]);
        }
      }

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const task = await store.createTask({
          title: 'Direct revoke wins',
          detail: `Synthetic function-boundary iteration ${iteration}.`,
        });
        const grant = await authorizations.request(task.id, 'owner');
        await authorizations.decide(grant.id, 'owner', 'approve');
        const runId = `run-direct-revoke-${nextKey}-${iteration}`;
        const gateKey = 7046390999912;
        const blocker = await adminPool!.connect();
        const runtimeDirectPool = createPool({
          connectionString: databaseUrl!,
          application_name: 'omnis-g4-direct-revoke-wins-consumer',
        });
        const revokerPool = createPool({
          connectionString: authorizerUrl!,
          application_name: 'omnis-g4-direct-revoke-wins-revoker',
        });
        const revoker = new PostgresAuthorizationStore(pool!, revokerPool);
        const consumer = await runtimeDirectPool.connect();
        try {
          await blocker.query('SELECT pg_advisory_lock($1)', [gateKey]);
          await adminPool!.query(`
            CREATE OR REPLACE FUNCTION omnis.g4_direct_revoke_audit_gate() RETURNS trigger
            LANGUAGE plpgsql AS $gate$
            BEGIN
              IF NEW.event_type = 'authorization.revoked' THEN
                PERFORM pg_advisory_xact_lock(${gateKey});
              END IF;
              RETURN NEW;
            END
            $gate$;
            DROP TRIGGER IF EXISTS g4_direct_revoke_audit_gate ON omnis.authorization_audit;
            CREATE TRIGGER g4_direct_revoke_audit_gate BEFORE INSERT ON omnis.authorization_audit
              FOR EACH ROW EXECUTE FUNCTION omnis.g4_direct_revoke_audit_gate();
          `);
          await consumer.query('BEGIN');
          await consumer.query(
            'INSERT INTO omnis.runs (id, task_id, task_title) VALUES ($1,$2,$3)',
            [runId, task.id, task.title],
          );
          const revoke = revoker.revoke(grant.id, 'owner');
          await waitForLockWait(adminPool!, 'omnis-g4-direct-revoke-wins-revoker');
          const consume = consumer.query<{ allowed: boolean }>(
            'SELECT omnis.consume_run_authorization($1,$2,$3,$4) AS allowed',
            [grant.id, task.id, runId, grant.correlationId],
          );
          await waitForLockWait(adminPool!, 'omnis-g4-direct-revoke-wins-consumer');
          await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey]);
          const revoked = await revoke;
          const consumed = await consume;
          assert.equal(revoked.status, 'revoked');
          assert.equal(consumed.rows[0]?.allowed, false);
          await consumer.query('ROLLBACK');
          assert.equal(
            (await adminPool!.query('SELECT 1 FROM omnis.runs WHERE id=$1', [runId])).rowCount,
            0,
          );
          assert.equal((await authorizations.get(grant.id))?.consumedRunId, null);
          const lifecycle = (await authorizations.getAudit(grant.id)).map(
            (event) => event.eventType,
          );
          assert.ok(lifecycle.includes('authorization.revoked'));
          assert.equal(lifecycle.includes('authorization.consumed'), false);
        } finally {
          await consumer.query('ROLLBACK').catch(() => undefined);
          consumer.release();
          await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey]).catch(() => undefined);
          await adminPool!.query(
            'DROP TRIGGER IF EXISTS g4_direct_revoke_audit_gate ON omnis.authorization_audit; DROP FUNCTION IF EXISTS omnis.g4_direct_revoke_audit_gate()',
          );
          blocker.release();
          await Promise.all([runtimeDirectPool.end(), revokerPool.end()]);
        }
      }
    });

    it('serializes revocation against completion and prevents a post-revocation success', async () => {
      const task = await store.createTask({
        title: 'Revocation fence',
        detail: 'Synthetic race probe.',
      });
      const admitted = await admit(task.id, key('revoke-fence'), async () => 'job');
      const authorization = await authorizations.getForRun(admitted.run.id);
      assert.ok(authorization);
      const claim = await store.beginExecution(admitted.run.id, 'worker-before-revoke', 30);
      await authorizations.revoke(authorization.id, 'owner');
      const completed = await store.completeRun(
        admitted.run.id,
        'worker-before-revoke',
        claim.generation,
        'must not complete after revocation',
      );
      assert.equal(completed.run.status, 'interrupted');
      assert.ok(
        (await authorizations.getAudit(authorization.id)).some(
          (event) =>
            event.eventType === 'authorization.enforcement_denied' &&
            event.reasonCode === 'revoked_before_completion',
        ),
      );
    });

    it('serializes a concurrent claim and revocation at the durable authorization row', async () => {
      const task = await store.createTask({
        title: 'Concurrent revoke and claim',
        detail: 'Synthetic race probe for claim/revoke ordering.',
      });
      const admitted = await admit(task.id, key('claim-revoke-race'), async () => 'job');
      const authorization = await authorizations.getForRun(admitted.run.id);
      assert.ok(authorization);

      const [claimResult] = await Promise.all([
        store.beginExecution(admitted.run.id, 'worker-race', 30),
        authorizations.revoke(authorization.id, 'owner'),
      ]);

      if (claimResult.started) {
        const settled = await store.completeRun(
          admitted.run.id,
          'worker-race',
          claimResult.generation,
          'must not complete after concurrent revocation',
        );
        assert.equal(settled.run.status, 'interrupted');
      } else {
        assert.equal(claimResult.run.status, 'interrupted');
      }
      assert.notEqual((await store.getRun(admitted.run.id))?.status, 'completed');
      assert.ok(
        (await authorizations.getAudit(authorization.id)).some(
          (event) => event.eventType === 'authorization.revoked',
        ),
      );
    });

    it('rechecks authorization after a heartbeat waits behind a committing revocation', async () => {
      const task = await store.createTask({
        title: 'Heartbeat revocation race',
        detail: 'A heartbeat queued behind revocation must not renew under its stale snapshot.',
      });
      const admitted = await admit(task.id, key('heartbeat-revocation-race'), async () => 'job');
      const authorization = await authorizations.getForRun(admitted.run.id);
      assert.ok(authorization);
      const claim = await store.beginExecution(admitted.run.id, 'heartbeat-race-worker', 30);
      assert.equal(claim.started, true);

      const gateKey = 7046390888877;
      const blocker = await adminPool!.connect();
      const revokerPool = createPool({
        connectionString: authorizerUrl!,
        application_name: 'omnis-g4-heartbeat-race-revoker',
        query_timeout: 5_000,
      });
      const heartbeatPool = createPool({
        connectionString: databaseUrl!,
        application_name: 'omnis-g4-heartbeat-race-heartbeat',
        query_timeout: 5_000,
      });
      const revoker = new PostgresAuthorizationStore(pool!, revokerPool);
      const heartbeatStore = new PostgresRunStore(heartbeatPool);
      try {
        await blocker.query('SELECT pg_advisory_lock($1::bigint)', [gateKey]);
        await adminPool!.query(`
          CREATE OR REPLACE FUNCTION omnis.g4_heartbeat_revoke_gate() RETURNS trigger
          LANGUAGE plpgsql AS $gate$
          BEGIN
            IF NEW.event_type = 'authorization.revoked' THEN
              PERFORM pg_advisory_xact_lock(${gateKey});
            END IF;
            RETURN NEW;
          END
          $gate$;
          DROP TRIGGER IF EXISTS g4_heartbeat_revoke_gate ON omnis.authorization_audit;
          CREATE TRIGGER g4_heartbeat_revoke_gate BEFORE INSERT ON omnis.authorization_audit
            FOR EACH ROW EXECUTE FUNCTION omnis.g4_heartbeat_revoke_gate();
        `);

        const revoke = revoker.revoke(authorization.id, 'owner');
        await waitForLockWait(adminPool!, 'omnis-g4-heartbeat-race-revoker');
        const heartbeat = heartbeatStore.renewLease(
          admitted.run.id,
          'heartbeat-race-worker',
          claim.generation,
          30,
        );
        await waitForLockWait(adminPool!, 'omnis-g4-heartbeat-race-heartbeat');
        await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [gateKey]);

        assert.equal((await revoke).status, 'revoked');
        assert.equal(
          await heartbeat,
          false,
          'heartbeat must re-read and lock the grant after the revoke commit',
        );
        assert.equal((await authorizations.get(authorization.id))?.status, 'revoked');
        const lifecycle = (await authorizations.getAudit(authorization.id)).map(
          (event) => event.eventType,
        );
        assert.deepEqual(lifecycle, [
          'authorization.requested',
          'authorization.approved',
          'authorization.consumed',
          'operation.started',
          'authorization.revoked',
        ]);
      } finally {
        await blocker
          .query('SELECT pg_advisory_unlock($1::bigint)', [gateKey])
          .catch(() => undefined);
        await adminPool!.query(
          'DROP TRIGGER IF EXISTS g4_heartbeat_revoke_gate ON omnis.authorization_audit; DROP FUNCTION IF EXISTS omnis.g4_heartbeat_revoke_gate()',
        );
        blocker.release();
        await Promise.all([heartbeatPool.end(), revokerPool.end()]);
      }
    });

    it('allows a committed heartbeat before revocation but denies every renewal afterward', async () => {
      const task = await store.createTask({
        title: 'Heartbeat wins revocation ordering',
        detail: 'A renewal before revocation is valid; later renewals must fail.',
      });
      const admitted = await admit(task.id, key('heartbeat-before-revoke'), async () => 'job');
      const authorization = await authorizations.getForRun(admitted.run.id);
      assert.ok(authorization);
      const claim = await store.beginExecution(admitted.run.id, 'heartbeat-before-revoke', 30);
      assert.equal(claim.started, true);
      const before = (
        await adminPool!.query<{ lease_expires_at: Date }>(
          'SELECT lease_expires_at FROM omnis.runs WHERE id=$1',
          [admitted.run.id],
        )
      ).rows[0]!.lease_expires_at;

      assert.equal(
        await store.renewLease(admitted.run.id, 'heartbeat-before-revoke', claim.generation, 30),
        true,
      );
      const renewed = (
        await adminPool!.query<{ lease_expires_at: Date }>(
          'SELECT lease_expires_at FROM omnis.runs WHERE id=$1',
          [admitted.run.id],
        )
      ).rows[0]!.lease_expires_at;
      assert.ok(renewed > before);

      assert.equal((await authorizations.revoke(authorization.id, 'owner')).status, 'revoked');
      const afterRevoke = (
        await adminPool!.query<{ lease_expires_at: Date }>(
          'SELECT lease_expires_at FROM omnis.runs WHERE id=$1',
          [admitted.run.id],
        )
      ).rows[0]!.lease_expires_at;
      assert.equal(
        await store.renewLease(admitted.run.id, 'heartbeat-before-revoke', claim.generation, 30),
        false,
      );
      assert.equal(
        (
          await adminPool!.query<{ lease_expires_at: Date }>(
            'SELECT lease_expires_at FROM omnis.runs WHERE id=$1',
            [admitted.run.id],
          )
        ).rows[0]!.lease_expires_at.toISOString(),
        afterRevoke.toISOString(),
      );
    });

    it('rolls back and bounds heartbeat renewal behind runtime-held run and grant locks', async () => {
      for (const lockTarget of ['run', 'grant'] as const) {
        const task = await store.createTask({
          title: `Heartbeat ${lockTarget} lock timeout`,
          detail: 'A timed-out renewal must fail closed without extending its lease.',
        });
        const grant = await authorizations.request(task.id, 'owner');
        await authorizations.decide(grant.id, 'owner', 'approve');
        const admitted = await store.admitRun(
          task.id,
          key(`heartbeat-${lockTarget}-timeout`),
          grant.id,
          async () => 'job',
        );
        const claim = await store.beginExecution(admitted.run.id, 'timeout-worker', 30);
        assert.equal(claim.started, true);

        const holder = await pool!.connect();
        const blockerName = `omnis-heartbeat-${lockTarget}-holder`;
        const heartbeatName = `omnis-heartbeat-${lockTarget}-waiter`;
        const heartbeatPool = createPool({
          connectionString: databaseUrl!,
          application_name: heartbeatName,
          query_timeout: 5_000,
        });
        const heartbeatStore = new PostgresRunStore(heartbeatPool);
        const leaseBefore = (
          await adminPool!.query<{ lease_expires_at: Date }>(
            'SELECT lease_expires_at FROM omnis.runs WHERE id=$1',
            [admitted.run.id],
          )
        ).rows[0]?.lease_expires_at;
        assert.ok(leaseBefore);
        let renewal: Promise<boolean | 'stop_requested'> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT set_config($1, $2, false)', ['application_name', blockerName]);
          if (lockTarget === 'run') {
            await holder.query('SELECT id FROM omnis.runs WHERE id=$1 FOR UPDATE', [
              admitted.run.id,
            ]);
          } else {
            const locked = await holder.query<{ allowed: boolean }>(
              'SELECT omnis.lock_active_run_authorization($1) AS allowed',
              [admitted.run.id],
            );
            assert.equal(locked.rows[0]?.allowed, true);
          }

          const startedAt = Date.now();
          renewal = heartbeatStore.renewLease(
            admitted.run.id,
            'timeout-worker',
            claim.generation,
            30,
          );
          await waitForLockWait(adminPool!, heartbeatName);
          assert.equal(await renewal, false);
          assert.ok(
            Date.now() - startedAt >= 2_500 && Date.now() - startedAt < 5_000,
            'heartbeat lock waits must fail within the transaction-local three-second bound',
          );
          const leaseAfter = (
            await adminPool!.query<{ lease_expires_at: Date }>(
              'SELECT lease_expires_at FROM omnis.runs WHERE id=$1',
              [admitted.run.id],
            )
          ).rows[0]?.lease_expires_at;
          assert.equal(leaseAfter?.toISOString(), leaseBefore.toISOString());
          assert.equal((await heartbeatPool.query('SELECT 1 AS usable')).rows[0]?.usable, 1);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          holder.release();
          await renewal?.catch(() => undefined);
          await heartbeatPool.end();
        }

        assert.equal(
          await store.renewLease(admitted.run.id, 'timeout-worker', claim.generation, 30),
          true,
          'the current fenced owner can renew after contention clears',
        );
        assert.equal(
          await store.renewLease(admitted.run.id, 'stale-timeout-worker', claim.generation, 30),
          false,
          'a stale owner remains fenced after a timed-out heartbeat',
        );
        await store.completeRun(
          admitted.run.id,
          'timeout-worker',
          claim.generation,
          'Synthetic heartbeat lock-timeout verification completed.',
        );
      }
    });

    it('restricts the authorizer database role to authorization records and audit writes', async () => {
      const identity = await authorizerPool!.query<{ current_user: string; rolsuper: boolean }>(
        'SELECT current_user, r.rolsuper FROM pg_roles r WHERE r.rolname=current_user',
      );
      assert.equal(identity.rows[0]?.current_user, 'omnis_authorizer');
      assert.equal(identity.rows[0]?.rolsuper, false);
      await assert.rejects(
        authorizerPool!.query('CREATE TABLE omnis.authorizer_ddl_probe (id integer)'),
        /permission denied/,
      );
      await assert.rejects(
        authorizerPool!.query("UPDATE omnis.tasks SET title='tampered'"),
        /permission denied/,
      );
      await assert.rejects(
        authorizerPool!.query('DELETE FROM omnis.authorization_audit'),
        /permission denied/,
      );
      await assert.rejects(authorizerPool!.query('SELECT pg_reload_conf()'), /permission denied/);
    });

    it('allows only the launcher role to validate and reserve one authorized mock execution', async () => {
      const task = await store.createTask({
        title: 'Launcher authorization fixture',
        detail: 'Synthetic fixed-workload launch authorization test.',
      });
      const grantRequest = await authorizations.request(task.id, 'owner');
      const grant = await authorizations.decide(grantRequest.id, 'owner', 'approve');
      const admitted = await store.admitRun(task.id, key('launcher'), grant.id, async () => 'job');
      const workerId = randomUUID();
      const claim = await store.beginExecution(admitted.run.id, workerId, 30);
      assert.equal(claim.started, true);

      await assert.rejects(
        pool!.query('SELECT task_title FROM omnis.authorize_mock_sandbox_launch($1, $2, $3)', [
          admitted.run.id,
          workerId,
          claim.generation,
        ]),
        /permission denied for function authorize_mock_sandbox_launch/,
      );
      await assert.rejects(
        pool!.query('SELECT * FROM omnis.mock_sandbox_launches'),
        /permission denied/,
      );
      await assert.rejects(
        launcherPool!.query('SELECT * FROM omnis.runs'),
        /permission denied for table runs/,
      );

      const allowed = await launcherPool!.query<{ task_title: string }>(
        'SELECT task_title FROM omnis.authorize_mock_sandbox_launch($1, $2, $3)',
        [admitted.run.id, workerId, claim.generation],
      );
      assert.deepEqual(allowed.rows, [{ task_title: task.title }]);
      const replay = await launcherPool!.query(
        'SELECT task_title FROM omnis.authorize_mock_sandbox_launch($1, $2, $3)',
        [admitted.run.id, workerId, claim.generation],
      );
      assert.equal(
        replay.rowCount,
        0,
        'a repeated or replayed launch cannot start a second sandbox',
      );
      const stale = await launcherPool!.query(
        'SELECT task_title FROM omnis.authorize_mock_sandbox_launch($1, $2, $3)',
        [admitted.run.id, workerId, claim.generation + 1],
      );
      assert.equal(stale.rowCount, 0, 'a stale execution generation cannot launch');
    });

    it('preserves later migration privileges when runtime roles are re-provisioned', async () => {
      const laterMigrationTable = 'future_privilege_probe';
      const ungrantedTable = 'future_ungranted_probe';
      const laterMigrationSequence = 'future_privilege_sequence';
      const ungrantedSequence = 'future_ungranted_sequence';
      try {
        await migrationPool!.query(`
          CREATE TABLE omnis.${laterMigrationTable} (id integer PRIMARY KEY);
          INSERT INTO omnis.${laterMigrationTable} VALUES (7);
          GRANT SELECT ON omnis.${laterMigrationTable} TO omnis_runtime;
          CREATE TABLE omnis.${ungrantedTable} (id integer PRIMARY KEY);
          CREATE SEQUENCE omnis.${laterMigrationSequence};
          GRANT USAGE, SELECT ON SEQUENCE omnis.${laterMigrationSequence} TO omnis_runtime;
          CREATE SEQUENCE omnis.${ungrantedSequence};
        `);

        const migrationConnection = new URL(migrationUrl!);
        await provisionDatabaseRoles(adminPool!, {
          migration: decodeURIComponent(migrationConnection.password),
          runtime: decodeURIComponent(new URL(databaseUrl!).password),
          authorizer: decodeURIComponent(new URL(authorizerUrl!).password),
          launcher: decodeURIComponent(new URL(launcherUrl!).password),
        });

        assert.equal(
          (await pool!.query(`SELECT id FROM omnis.${laterMigrationTable}`)).rows[0]?.id,
          7,
          'a privilege added by a later migration should survive role reprovisioning',
        );
        await assert.rejects(
          pool!.query(`SELECT id FROM omnis.${ungrantedTable}`),
          /permission denied/,
          'reprovisioning must not grant access to future objects without migration approval',
        );
        await assert.rejects(
          pool!.query(`SELECT nextval('omnis.${ungrantedSequence}')`),
          /permission denied/,
          'reprovisioning must not grant access to future sequences without migration approval',
        );
        assert.equal(
          (await pool!.query(`SELECT nextval('omnis.${laterMigrationSequence}') AS value`)).rows[0]
            ?.value,
          '1',
          'a later migration sequence grant should survive role reprovisioning',
        );

        const task = await store.createTask({
          title: 'Reprovisioning regression',
          detail: 'Normal task admission remains available.',
        });
        const admitted = await admit(task.id, key('reprovisioning'), async () => 'job');
        assert.equal(admitted.created, true);
        assert.equal(admitted.run.runtimeKind, 'mock');
      } finally {
        await adminPool!.query(
          `DROP TABLE IF EXISTS omnis.${laterMigrationTable}, omnis.${ungrantedTable}; DROP SEQUENCE IF EXISTS omnis.${laterMigrationSequence}, omnis.${ungrantedSequence}`,
        );
      }
    });

    it('limits runtime changes to task/run lifecycle operations and append-only records', async () => {
      const task = await store.createTask({
        title: 'Privilege boundary fixture',
        detail: 'Exercise allowed and prohibited SQL under omnis_runtime.',
      });
      const admitted = await admit(task.id, key('least-privilege'), async () => 'job');
      const eventId = admitted.events[0]!.event.id;

      await assert.rejects(
        pool!.query('UPDATE omnis.tasks SET title = $2 WHERE id = $1', [task.id, 'tampered']),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          "INSERT INTO omnis.tasks (id, title, detail, status) VALUES ('task-9999', 'Explicit status', 'Must use the database default.', 'open')",
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          'INSERT INTO omnis.runs (id, task_id, task_title, status, runtime_kind, synthetic, usage) VALUES (\'run-9999\', $1, \'Explicit runtime\', \'queued\', \'mock\', TRUE, \'{"quality":"unknown","inputTokens":null,"outputTokens":null,"cost":null}\'::jsonb)',
          [task.id],
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('UPDATE omnis.runs SET runtime_kind = $2 WHERE id = $1', [
          admitted.run.id,
          'real',
        ]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('UPDATE omnis.runs SET retry_count = 99 WHERE id = $1', [admitted.run.id]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('UPDATE omnis.run_events SET message = $2 WHERE id = $1', [
          eventId,
          'tampered',
        ]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('DELETE FROM omnis.run_events WHERE id = $1', [eventId]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          "INSERT INTO omnis.run_events (id, run_id, sequence, event_type, source, synthetic, message) VALUES ('event-untrusted', $1, 99, 'run.output', 'mock', TRUE, 'Must use database defaults.')",
          [admitted.run.id],
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query(
          'UPDATE omnis.run_idempotency SET request_fingerprint = $2 WHERE idempotency_key = $1',
          [key('least-privilege'), 'tampered'],
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query('DELETE FROM omnis.run_idempotency WHERE idempotency_key = $1', [
          key('least-privilege'),
        ]),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query("SELECT * FROM omnis.schema_migrations WHERE id = '0001_initial'"),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query("UPDATE omnis.schema_migrations SET id = 'tampered' WHERE id = '0001_initial'"),
        /permission denied/,
      );
      await assert.rejects(
        pool!.query("DELETE FROM omnis.schema_migrations WHERE id = '0001_initial'"),
        /permission denied/,
      );

      await store.requestStop(admitted.run.id);
      const cancelled = await store.beginExecution(admitted.run.id, 'cancel-before-claim', 30);
      assert.equal(cancelled.run.status, 'cancelled');
      assert.deepEqual(
        (await store.getEvents(admitted.run.id)).map((event) => event.type),
        ['run.queued', 'run.stop_requested', 'run.cancelled'],
      );
    });

    it('detects deliberately stale task and run sequences against existing identifiers', async () => {
      const task = await store.createTask({ title: 'Sequence fixture', detail: 'Task ID check.' });
      const admitted = await admit(task.id, key('sequence-integrity'), async () => 'job');

      await adminPool!.query("SELECT setval('omnis.task_id_seq', 1, false)");
      await adminPool!.query("SELECT setval('omnis.run_id_seq', 1, false)");
      const stale = await adminPool!.query(metricsQuery);
      const staleMetrics = stale.rows[0]!.json_build_object as Record<string, unknown>;
      assert.throws(() => assertValidMetrics(staleMetrics), /task ID sequence is stale/i);

      await adminPool!.query("SELECT setval('omnis.task_id_seq', 1, true)");
      const staleRun = await adminPool!.query(metricsQuery);
      assert.throws(
        () => assertValidMetrics(staleRun.rows[0]!.json_build_object as Record<string, unknown>),
        /run ID sequence is stale/i,
      );

      await adminPool!.query("SELECT setval('omnis.run_id_seq', 1, true)");
      const safe = await adminPool!.query(metricsQuery);
      assert.doesNotThrow(() =>
        assertValidMetrics(safe.rows[0]!.json_build_object as Record<string, unknown>),
      );
      assert.equal(admitted.run.id, 'run-0001');
    });

    it('accepts empty application tables with task/run sequences not yet called', async () => {
      const report = await adminPool!.query(metricsQuery);
      const metrics = report.rows[0]!.json_build_object as Record<string, unknown> & {
        idSequences: {
          tasks: { isCalled: boolean };
          runs: { isCalled: boolean };
        };
      };
      assertValidMetrics(metrics);
      assert.deepEqual(metrics.idSequences, {
        tasks: {
          lastValue: '1',
          isCalled: false,
          incrementBy: '1',
          maxIssued: '0',
          malformedIds: 0,
          nextValue: '1',
        },
        runs: {
          lastValue: '1',
          isCalled: false,
          incrementBy: '1',
          maxIssued: '0',
          malformedIds: 0,
          nextValue: '1',
        },
      });
    });

    it('upgrades the released checksum-less migration ledger while preserving application rows', async () => {
      const task = await store.createTask({
        title: 'Upgrade fixture',
        detail: 'Preserve this row.',
      });
      const checksum = await adminPool!.query<{ checksum: string }>(
        "SELECT checksum FROM omnis.schema_migrations WHERE id = '0001_initial'",
      );
      assert.ok(checksum.rows[0]?.checksum);
      await adminPool!.query(
        "UPDATE omnis.schema_migrations SET checksum = NULL WHERE id = '0001_initial'",
      );

      await migrate(migrationPool!);

      assert.equal((await store.getTask(task.id))?.title, 'Upgrade fixture');
      const upgraded = await adminPool!.query<{ checksum: string | null }>(
        "SELECT checksum FROM omnis.schema_migrations WHERE id = '0001_initial'",
      );
      assert.equal(upgraded.rows[0]?.checksum, checksum.rows[0]!.checksum);
      assert.equal(
        (
          await adminPool!.query(
            "SELECT 1 FROM omnis.schema_migrations WHERE id = '0002_runtime_grants'",
          )
        ).rowCount,
        1,
      );
    });

    it('rejects historical migration checksum drift and serializes concurrent migrations', async () => {
      const original = await adminPool!.query<{ checksum: string }>(
        "SELECT checksum FROM omnis.schema_migrations WHERE id = '0001_initial'",
      );
      await adminPool!.query(
        "UPDATE omnis.schema_migrations SET checksum = repeat('0', 64) WHERE id = '0001_initial'",
      );
      try {
        await assert.rejects(migrate(migrationPool!), /has been modified/);
      } finally {
        await adminPool!.query(
          "UPDATE omnis.schema_migrations SET checksum = $1 WHERE id = '0001_initial'",
          [original.rows[0]!.checksum],
        );
      }

      const concurrentPool = createPool(migrationUrl!);
      try {
        await Promise.all([migrate(migrationPool!), migrate(concurrentPool)]);
      } finally {
        await concurrentPool.end();
      }
    });

    it('rolls run state and queue admission back when enqueue fails', async () => {
      const task = await store.createTask({
        title: 'Inspect files',
        detail: 'List files read-only.',
      });
      await assert.rejects(
        admit(task.id, key('rollback'), async () => {
          throw new Error('queue rejected');
        }),
        /queue rejected/,
      );
      assert.equal((await store.listRuns()).length, 0);
      assert.equal((await store.listTasks())[0]?.status, 'open');
      assert.equal((await pool!.query('SELECT 1 FROM omnis.run_events')).rowCount, 0);
      assert.equal((await pool!.query('SELECT 1 FROM omnis.run_idempotency')).rowCount, 0);
    });

    it('makes concurrent retries idempotent and serializes distinct active work', async () => {
      const task = await store.createTask({
        title: 'Inspect files',
        detail: 'List files read-only.',
      });
      const idem = key('retry');
      const enqueue = async (tx: PgBossTransaction, { runId }: { runId: string }) => {
        await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
        return `job-${runId}`;
      };
      const [first, retry] = await Promise.all([
        admit(task.id, idem, enqueue),
        admit(task.id, idem, enqueue),
      ]);
      assert.equal(first.run.id, retry.run.id);
      assert.equal([first.created, retry.created].filter(Boolean).length, 1);
      assert.equal((await pool!.query('SELECT 1 FROM omnis.test_queue_outbox')).rowCount, 1);

      const otherTask = await store.createTask({
        title: 'Another task',
        detail: 'Read another file list.',
      });
      await assert.rejects(
        admit(otherTask.id, key('concurrency'), enqueue),
        (error: unknown) => error instanceof StoreError && error.code === 'concurrency_limit',
      );
    });

    it('persists cancellation and event replay with a stable ordered cursor', async () => {
      const task = await store.createTask({
        title: 'Inspect files',
        detail: 'List files read-only.',
      });
      const admitted = await admit(task.id, key('cancel'), async (tx, { runId }) => {
        await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
        return `job-${runId}`;
      });
      const claim = await store.beginExecution(admitted.run.id, 'worker-test', 30);
      await store.requestStop(admitted.run.id);
      const cancelled = await store.cancelRun(admitted.run.id, 'worker-test', claim.generation);
      const events = await store.getEvents(admitted.run.id);

      assert.equal(cancelled.run.status, 'cancelled');
      assert.deepEqual(
        events.map((event) => event.sequence),
        [1, 2, 3, 4],
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['run.queued', 'run.started', 'run.stop_requested', 'run.cancelled'],
      );
      assert.equal((await store.getEvents(admitted.run.id, 2)).length, 2);
    });

    it('completes a run only when the row-lock query confirms its lease owner', async () => {
      const task = await store.createTask({
        title: 'Complete an owned run',
        detail: 'Persist deterministic synthetic output.',
      });
      const admitted = await admit(task.id, key('complete-owned'), async () => 'job');
      const claim = await store.beginExecution(admitted.run.id, 'worker-owner', 30);

      const completed = await store.completeRun(
        admitted.run.id,
        'worker-owner',
        claim.generation,
        'Synthetic result only.',
        [],
      );
      assert.equal(completed.run.status, 'completed');
      assert.deepEqual(
        (await store.getEvents(admitted.run.id)).map((event) => event.type),
        ['run.queued', 'run.started', 'run.completed'],
      );
      await assert.rejects(
        store.completeRun(
          admitted.run.id,
          'different-worker',
          claim.generation,
          'Not accepted.',
          [],
        ),
        (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
      );
    });

    it('rejects stale completion after a new worker generation owns the execution', async () => {
      const task = await store.createTask({
        title: 'Fence an old worker',
        detail: 'An old generation cannot finalize a run claimed by another worker.',
      });

      const admitted = await admit(task.id, key('stale-finalizer'), async () => 'job');
      const staleClaim = await store.beginExecution(admitted.run.id, 'worker-old', 30);
      await pool!.query(
        "UPDATE omnis.runs SET execution_generation = execution_generation + 1, lease_owner = 'worker-new' WHERE id = $1",
        [admitted.run.id],
      );
      await assert.rejects(
        store.completeRun(
          admitted.run.id,
          'worker-old',
          staleClaim.generation,
          'stale output.',
          [],
        ),
        (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
      );
      assert.equal(
        (await store.getEvents(admitted.run.id)).some((event) => event.type === 'run.completed'),
        false,
      );
      const current = await store.completeRun(
        admitted.run.id,
        'worker-new',
        staleClaim.generation + 1,
        'current output.',
        [],
      );
      assert.equal(current.run.status, 'completed');
    });

    it('allows one competing worker claim and fences stale completion, failure, heartbeat, and cancellation', async () => {
      const task = await store.createTask({
        title: 'Fence competing worker claims',
        detail: 'Only one worker may own the execution generation.',
      });
      const admitted = await admit(task.id, key('two-worker-claim'), async () => 'job');
      const secondPool = createPool(databaseUrl!);
      const secondStore = new PostgresRunStore(secondPool);
      try {
        const claimAttempts = await Promise.all([
          store.beginExecution(admitted.run.id, 'worker-alpha', 30).then((claim) => ({
            workerId: 'worker-alpha',
            claim,
          })),
          secondStore.beginExecution(admitted.run.id, 'worker-beta', 30).then((claim) => ({
            workerId: 'worker-beta',
            claim,
          })),
        ]);
        assert.equal(claimAttempts.filter(({ claim }) => claim.started).length, 1);
        assert.equal(claimAttempts.filter(({ claim }) => !claim.started).length, 1);
        const { workerId: staleWorker, claim } = claimAttempts.find(
          ({ claim: attempt }) => attempt.started,
        )!;
        const currentWorker = staleWorker === 'worker-alpha' ? 'worker-beta' : 'worker-alpha';
        const currentGeneration = claim.generation + 1;

        await pool!.query(
          "UPDATE omnis.runs SET execution_generation = $2, lease_owner = $3, lease_expires_at = now() + interval '30 seconds' WHERE id = $1",
          [admitted.run.id, currentGeneration, currentWorker],
        );
        await assert.rejects(
          store.completeRun(admitted.run.id, staleWorker, claim.generation, 'stale output.', []),
          (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
        );
        await assert.rejects(
          store.failRun(admitted.run.id, staleWorker, claim.generation, 'stale failure.'),
          (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
        );
        assert.equal(
          await store.renewLease(admitted.run.id, staleWorker, claim.generation, 30),
          false,
        );
        assert.equal(
          await store.appendOutput(admitted.run.id, staleWorker, claim.generation, 'stale output'),
          undefined,
        );

        await store.requestStop(admitted.run.id);
        await assert.rejects(
          store.cancelRun(admitted.run.id, staleWorker, claim.generation),
          (error: unknown) => error instanceof StoreError && error.code === 'conflict',
        );
        await store.cancelRun(admitted.run.id, currentWorker, currentGeneration);
        await assert.rejects(
          store.completeRun(admitted.run.id, currentWorker, currentGeneration, 'late output.', []),
          (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
        );
        await assert.rejects(
          store.failRun(admitted.run.id, currentWorker, currentGeneration, 'late failure.'),
          (error: unknown) => error instanceof StoreError && error.code === 'invalid_transition',
        );
        assert.equal(
          (await store.getEvents(admitted.run.id)).filter((event) => event.type === 'run.started')
            .length,
          1,
        );
      } finally {
        await secondPool.end();
      }
    });

    it('persists sandbox failure state and a safe ordered failure event', async () => {
      const task = await store.createTask({
        title: 'Exercise the isolated runtime',
        detail: 'The trusted worker owns this task and failure state.',
      });
      const admitted = await admit(task.id, key('sandbox-failure'), async () => 'job');
      const claim = await store.beginExecution(admitted.run.id, 'worker-sandbox', 30);

      const failed = await store.failRun(
        admitted.run.id,
        'worker-sandbox',
        claim.generation,
        'The sandbox execution exceeded its time limit.',
      );

      assert.equal(failed.run.status, 'failed');
      assert.deepEqual(
        (await store.getEvents(admitted.run.id)).map((event) => [event.sequence, event.type]),
        [
          [1, 'run.queued'],
          [2, 'run.started'],
          [3, 'run.failed'],
        ],
      );
      assert.equal(
        (await store.getEvents(admitted.run.id))[2]?.message,
        'The sandbox execution exceeded its time limit.',
      );
      assert.equal((await store.getTask(task.id))?.status, 'open');
    });

    it('delivers a durable stop request to the process holding the execution lease', async () => {
      const task = await store.createTask({
        title: 'Observe stop state',
        detail: 'A second worker process requested cancellation.',
      });
      const admitted = await admit(task.id, key('cross-worker-stop'), async () => 'job');
      const claim = await store.beginExecution(admitted.run.id, 'worker-owner', 30);
      await store.requestStop(admitted.run.id);

      assert.equal(
        await store.renewLease(admitted.run.id, 'worker-owner', claim.generation, 30),
        'stop_requested',
      );
      assert.equal(
        await store.renewLease(admitted.run.id, 'other-worker', claim.generation, 30),
        false,
      );
    });

    it('does not let an expired worker lease be revived by a late heartbeat', async () => {
      const task = await store.createTask({
        title: 'Reject stale lease heartbeat',
        detail: 'Expired lease ownership cannot be reclaimed without a new run.',
      });
      const admitted = await admit(task.id, key('expired-lease-heartbeat'), async () => 'job');
      const claim = await store.beginExecution(admitted.run.id, 'stale-worker', 30);
      await pool!.query(
        "UPDATE omnis.runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [admitted.run.id],
      );

      assert.equal(
        await store.renewLease(admitted.run.id, 'stale-worker', claim.generation, 30),
        false,
      );
      assert.deepEqual(await store.listActiveRunIds([admitted.run.id]), []);
    });

    it('acknowledges cancellation when an unstarted queued job is gone', async () => {
      const task = await store.createTask({
        title: 'Inspect files',
        detail: 'List files read-only.',
      });
      const admitted = await admit(task.id, key('queued-cancel'), async (tx, { runId }) => {
        await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
        return `job-${runId}`;
      });
      await store.requestStop(admitted.run.id);

      const recovered = await store.interruptQueuedRun(
        admitted.run.id,
        'The queue job is missing.',
      );
      assert.equal(recovered?.run.status, 'cancelled');
      assert.equal(recovered?.events[0]?.event.type, 'run.cancelled');
    });

    it('acknowledges a stop after pg-boss confirms the execution job is terminal', async () => {
      const task = await store.createTask({
        title: 'Settle a terminal queue job',
        detail: 'The queue reports no active executor for this run.',
      });
      const admitted = await admit(task.id, key('terminal-queue-stop'), async () => 'job');
      await store.beginExecution(admitted.run.id, 'worker-old', 30);
      await store.requestStop(admitted.run.id);

      const recovered = await store.cancelRunAfterQueueTerminal(admitted.run.id);
      assert.equal(recovered?.run.status, 'cancelled');
      assert.equal(recovered?.events[0]?.event.type, 'run.cancelled');
    });

    it('recovers an expired execution lease without replay and allows a fresh run', async () => {
      const task = await store.createTask({
        title: 'Inspect files',
        detail: 'List files read-only.',
      });
      const admitted = await admit(task.id, key('interrupted'), async (tx, { runId }) => {
        await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
        return `job-${runId}`;
      });
      await store.beginExecution(admitted.run.id, 'worker-old', 1);
      assert.ok((await store.listActiveRunIds()).includes(admitted.run.id));
      await pool!.query(
        "UPDATE omnis.runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [admitted.run.id],
      );

      const recovered = await store.reconcileExpiredRuns();
      assert.equal((await store.getRun(admitted.run.id))?.status, 'interrupted');
      assert.equal(recovered[0]?.event.type, 'run.interrupted');
      assert.equal((await store.getTask(task.id))?.status, 'open');
      assert.equal((await store.listActiveRunIds()).includes(admitted.run.id), false);

      const anotherTask = await store.createTask({
        title: 'Later task',
        detail: 'Read another file list.',
      });
      const later = await admit(anotherTask.id, key('fresh-run'), async (tx, { runId }) => {
        await tx.executeSql('INSERT INTO omnis.test_queue_outbox (run_id) VALUES ($1)', [runId]);
        return `job-${runId}`;
      });
      assert.equal(later.created, true);
      assert.equal(later.run.status, 'queued');
      assert.equal((await store.getRun(admitted.run.id))?.status, 'interrupted');
    });

    after(async () => {
      if (pool && databaseUrl) {
        assertTestDatabase(databaseUrl);
        await adminPool!.query(`
        TRUNCATE omnis.test_queue_outbox, omnis.department_management_audit,
          omnis.agent_profile_versions, omnis.agents, omnis.departments,
          omnis.mock_sandbox_launches, omnis.legacy_unscoped_runs, omnis.authorization_audit,
          omnis.runtime_authorizations, omnis.run_idempotency,
          omnis.run_events, omnis.runs, omnis.tasks
      `);
        await adminPool!.query('ALTER SEQUENCE omnis.task_id_seq RESTART WITH 1');
        await adminPool!.query('ALTER SEQUENCE omnis.run_id_seq RESTART WITH 1');
        await adminPool!.query('DROP TABLE IF EXISTS omnis.test_queue_outbox');
      }
      await pool?.end();
      await migrationPool?.end();
      await authorizerPool?.end();
      await launcherPool?.end();
      await adminPool?.end();
    });
  },
);

void postgresSuite;

describe('agent profile cursor validation', () => {
  it('rejects malformed and foreign cursors before opening a database connection', async () => {
    const unusedPool = createPool('postgres://unused:unused@127.0.0.1:1/unused');
    const profiles = new PostgresAgentProfileStore(
      unusedPool,
      'ao104-test-cursor-key-0123456789abcdef',
    );
    try {
      await assert.rejects(profiles.listVersions('agt_atlas', { cursor: 'not-a-cursor' }), {
        code: 'invalid_cursor',
        statusCode: 422,
      });
      const forged = Buffer.from(
        JSON.stringify({
          version: 1,
          agentId: 'agt_someone_else',
          highWaterVersionNo: 2,
          currentVersionNo: 2,
          total: 2,
          lastVersionNo: 1,
        }),
      ).toString('base64url');
      await assert.rejects(profiles.listVersions('agt_atlas', { cursor: `${forged}.AAAA` }), {
        code: 'invalid_cursor',
        statusCode: 422,
      });
    } finally {
      await unusedPool.end();
    }
  });
});

function key(prefix: string): string {
  return `${prefix}-${String(nextKey).padStart(4, '0')}-unique`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForLockWait(admin: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await admin.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity
        WHERE application_name=$1 AND state='active'`,
      [applicationName],
    );
    if (result.rows.some((row) => row.wait_event_type === 'Lock')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Database session ${applicationName} did not reach the expected lock wait.`);
}

async function waitForBackendExit(
  admin: Pool,
  backendPid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [backendPid]);
    if (!result.rowCount) return;
    await delay(20);
  }
  throw new Error(`PostgreSQL backend ${backendPid} did not exit before the test timeout.`);
}

async function waitForLockWaitOrCompletion(
  admin: Pool,
  applicationName: string,
  isSettled: () => boolean,
  timeoutMs: number,
): Promise<'lock_wait' | 'completed' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSettled()) return 'completed';
    const result = await admin.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity
        WHERE application_name=$1 AND state='active'`,
      [applicationName],
    );
    if (result.rows.some((row) => row.wait_event_type === 'Lock')) return 'lock_wait';
    if (isSettled()) return 'completed';
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return isSettled() ? 'completed' : 'timeout';
}

function assertTestDatabase(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:^|[_-])test(?:s)?$/i.test(databaseName)) {
    throw new Error('OMNIS_TEST_DATABASE_URL must point to a database ending in test or tests.');
  }
}

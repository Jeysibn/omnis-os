-- ACL-free archives cannot preserve migration-specific grants. Rebuild the
-- currently approved runtime baseline explicitly and leave future objects denied.
REVOKE ALL ON SCHEMA omnis, pgboss FROM omnis_runtime;
GRANT USAGE ON SCHEMA omnis, pgboss TO omnis_runtime;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA omnis FROM omnis_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA omnis FROM omnis_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM omnis_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM omnis_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis
  REVOKE ALL ON TABLES FROM omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis
  REVOKE ALL ON SEQUENCES FROM omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  REVOKE ALL ON TABLES FROM omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  REVOKE ALL ON SEQUENCES FROM omnis_runtime;

GRANT SELECT ON omnis.tasks, omnis.runs, omnis.run_events, omnis.run_idempotency
  TO omnis_runtime;
GRANT INSERT (id, title, detail) ON omnis.tasks TO omnis_runtime;
GRANT UPDATE (status) ON omnis.tasks TO omnis_runtime;
GRANT INSERT (id, task_id, task_title) ON omnis.runs TO omnis_runtime;
GRANT UPDATE (
  status, execution_generation, lease_owner, lease_expires_at, updated_at,
  result_output, result_evidence_refs, pg_boss_job_id, last_event_sequence
) ON omnis.runs TO omnis_runtime;
GRANT INSERT (id, run_id, sequence, event_type, at, message)
  ON omnis.run_events TO omnis_runtime;
GRANT INSERT (idempotency_key, request_fingerprint, run_id)
  ON omnis.run_idempotency TO omnis_runtime;
GRANT SELECT ON omnis.runtime_authorizations TO omnis_runtime;
DO $agent_profile_acl$
BEGIN
  IF pg_catalog.to_regclass('omnis.departments') IS NOT NULL
     AND pg_catalog.to_regclass('omnis.agents') IS NOT NULL
     AND pg_catalog.to_regclass('omnis.agent_profile_versions') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON omnis.departments, omnis.agents, omnis.agent_profile_versions TO omnis_runtime';
  END IF;
END
$agent_profile_acl$;
DO $agent_profile_function_acl$
BEGIN
  IF pg_catalog.to_regprocedure('omnis.is_bounded_string_array(jsonb,integer,integer)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.is_bounded_string_array(jsonb, integer, integer) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.reject_agent_profile_version_mutation()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.reject_agent_profile_version_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.assert_agent_profile_version_head()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.assert_agent_profile_version_head() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
END
$agent_profile_function_acl$;
REVOKE ALL PRIVILEGES ON TABLE omnis.authorization_audit FROM omnis_runtime;
REVOKE INSERT (
  id, authorization_id, task_id, run_id, event_type, actor_id,
  effective_identity, capability, correlation_id, outcome, reason_code, occurred_at
) ON omnis.authorization_audit FROM omnis_runtime;
REVOKE ALL ON FUNCTION omnis.consume_run_authorization(text, text, text, text)
  FROM PUBLIC, omnis_runtime, omnis_authorizer;
REVOKE ALL ON FUNCTION omnis.lock_active_run_authorization(text) FROM PUBLIC, omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.consume_run_authorization(text, text, text, text)
  TO omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.lock_active_run_authorization(text) TO omnis_runtime;
DO $grant_admission_lock$
BEGIN
  IF pg_catalog.to_regprocedure(
       'omnis.lock_run_authorization_for_admission(text,text)'
     ) IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.lock_run_authorization_for_admission(text, text) FROM PUBLIC, omnis_authorizer';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.lock_run_authorization_for_admission(text, text) TO omnis_runtime';
  END IF;
END
$grant_admission_lock$;
REVOKE ALL ON FUNCTION omnis.append_runtime_authorization_audit(text, text, text)
  FROM PUBLIC, omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.append_runtime_authorization_audit(text, text, text)
  TO omnis_runtime;
REVOKE ALL ON FUNCTION omnis.append_runtime_admission_denial(text, text, text)
  FROM PUBLIC, omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.append_runtime_admission_denial(text, text, text)
  TO omnis_runtime;
REVOKE ALL ON FUNCTION omnis.revoke_run_authorization(text, text)
  FROM PUBLIC, omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.revoke_run_authorization(text, text)
  TO omnis_authorizer;
DO $launcher_acl$
BEGIN
  IF pg_catalog.to_regprocedure('omnis.authorize_mock_sandbox_launch(text,text,integer)') IS NOT NULL
     AND pg_catalog.to_regprocedure('omnis.list_authorized_active_mock_runs(text[])') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SCHEMA omnis TO omnis_launcher';
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.authorize_mock_sandbox_launch(text, text, integer) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.list_authorized_active_mock_runs(text[]) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.authorize_mock_sandbox_launch(text, text, integer) TO omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.list_authorized_active_mock_runs(text[]) TO omnis_launcher';
  END IF;
END
$launcher_acl$;
GRANT SELECT ON omnis.runtime_authorizations TO omnis_authorizer;
GRANT SELECT, INSERT ON omnis.authorization_audit TO omnis_authorizer;
GRANT INSERT (
  id, requesting_actor, runtime_id, operation, task_id, capabilities,
  scope, policy_version, correlation_id, expires_at
) ON omnis.runtime_authorizations TO omnis_authorizer;
GRANT UPDATE (status, decided_at, decided_by, revoked_at, revoked_by)
  ON omnis.runtime_authorizations TO omnis_authorizer;
GRANT SELECT ON omnis.tasks TO omnis_authorizer;
GRANT UPDATE (status, decided_at, decided_by, revoked_at, revoked_by)
  ON omnis.runtime_authorizations TO omnis_authorizer;

DO $department_management_acl$
BEGIN
  IF pg_catalog.to_regclass('omnis.departments') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.departments FROM omnis_authorizer';
    EXECUTE 'GRANT SELECT ON omnis.departments TO omnis_authorizer';
    EXECUTE 'GRANT INSERT (id, slug, name) ON omnis.departments TO omnis_authorizer';
    EXECUTE 'GRANT UPDATE (slug, name, updated_at) ON omnis.departments TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regclass('omnis.department_management_audit') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.department_management_audit FROM omnis_authorizer';
    EXECUTE 'GRANT INSERT (id, department_id, actor_id, action, request_id) ON omnis.department_management_audit TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.archive_department(text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.archive_department(text, text) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.archive_department(text, text) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.reject_department_management_audit_mutation()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.reject_department_management_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.assert_agent_department_active()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.assert_agent_department_active() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.guard_department_lifecycle()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.guard_department_lifecycle() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
END
$department_management_acl$;
GRANT USAGE, SELECT ON SEQUENCE omnis.task_id_seq, omnis.run_id_seq TO omnis_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO omnis_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;

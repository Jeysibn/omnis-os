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

DO $agent_lifecycle_acl$
BEGIN
  IF pg_catalog.to_regclass('omnis.agents') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.agents, omnis.agent_profile_versions FROM omnis_authorizer';
  END IF;
  IF pg_catalog.to_regclass('omnis.agent_profile_drafts') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.agent_profile_drafts, omnis.agent_management_audit, omnis.agent_management_idempotency FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.create_agent(text,text,text,text,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.create_agent(text,text,text,text,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.create_agent(text,text,text,text,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.get_agent_profile_draft(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.get_agent_profile_draft(text) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.get_agent_profile_draft(text) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.save_agent_profile_draft(text,bigint,integer,jsonb,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.save_agent_profile_draft(text,bigint,integer,jsonb,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.save_agent_profile_draft(text,bigint,integer,jsonb,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.publish_agent_profile(text,integer,bigint,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.publish_agent_profile(text,integer,bigint,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.publish_agent_profile(text,integer,bigint,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.archive_agent(text,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.archive_agent(text,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.archive_agent(text,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.reject_agent_management_audit_mutation()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.reject_agent_management_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.guard_agent_profile_draft()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.guard_agent_profile_draft() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.agent_management_replay(uuid,text,text,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.agent_management_replay(uuid,text,text,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.agent_management_remember(uuid,text,text,integer,bytea,jsonb)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.agent_management_remember(uuid,text,text,integer,bytea,jsonb) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
END
$agent_lifecycle_acl$;

DO $project_management_acl$
BEGIN
  IF pg_catalog.to_regclass('omnis.projects') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.projects, omnis.project_management_audit, omnis.project_management_idempotency FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.create_project(text,text,text,text,text,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.create_project(text,text,text,text,text,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.create_project(text,text,text,text,text,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.list_projects()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.list_projects() FROM PUBLIC, omnis_runtime, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.list_projects() TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.get_project(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.get_project(text) FROM PUBLIC, omnis_runtime, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.get_project(text) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.update_project(text,integer,text,text,text,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.update_project(text, integer, text, text, text, uuid, integer, bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.update_project(text, integer, text, text, text, uuid, integer, bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.archive_project(text,integer,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.archive_project(text, integer, uuid, integer, bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.archive_project(text, integer, uuid, integer, bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.reject_project_audit_mutation()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.reject_project_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
END
$project_management_acl$;
DO $project_milestone_acl$
BEGIN
  IF pg_catalog.to_regclass('omnis.project_milestones') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.project_milestones, omnis.project_milestone_management_audit FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.reject_project_milestone_audit_mutation()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.reject_project_milestone_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.list_project_milestones(text,timestamptz,text,integer)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.list_project_milestones(text,timestamptz,text,integer) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.list_project_milestones(text,timestamptz,text,integer) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.get_project_milestone(text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.get_project_milestone(text,text) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.get_project_milestone(text,text) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.create_project_milestone(text,text,text,text,date,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.create_project_milestone(text,text,text,text,date,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.create_project_milestone(text,text,text,text,date,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.update_project_milestone(text,text,integer,text,text,boolean,date,boolean,text,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.update_project_milestone(text,text,integer,text,text,boolean,date,boolean,text,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.update_project_milestone(text,text,integer,text,text,boolean,date,boolean,text,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.archive_project_milestone(text,text,integer,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.archive_project_milestone(text,text,integer,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.archive_project_milestone(text,text,integer,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
END
$project_milestone_acl$;
DO $project_epic_acl$
BEGIN
  IF pg_catalog.to_regclass('omnis.project_epics') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.project_epics, omnis.project_epic_management_audit FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.reject_project_epic_audit_mutation()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.reject_project_epic_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.list_project_epics(text,timestamptz,text,integer)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.list_project_epics(text,timestamptz,text,integer) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.list_project_epics(text,timestamptz,text,integer) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.get_project_epic(text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.get_project_epic(text,text) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.get_project_epic(text,text) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.create_project_epic(text,text,text,text,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.create_project_epic(text,text,text,text,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.create_project_epic(text,text,text,text,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.update_project_epic(text,text,integer,text,text,boolean,text,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.update_project_epic(text,text,integer,text,text,boolean,text,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.update_project_epic(text,text,integer,text,text,boolean,text,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.archive_project_epic(text,text,integer,uuid,integer,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.archive_project_epic(text,text,integer,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.archive_project_epic(text,text,integer,uuid,integer,bytea) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regclass('omnis.task_epic_associations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.task_epic_associations FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regclass('omnis.task_epic_management_audit') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.task_epic_management_audit FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.reject_task_epic_audit_mutation()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.reject_task_epic_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.get_task_epic(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.get_task_epic(text) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.get_task_epic(text) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.list_project_epic_tasks(text,text,timestamptz,text,integer)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.list_project_epic_tasks(text,text,timestamptz,text,integer) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.list_project_epic_tasks(text,text,timestamptz,text,integer) TO omnis_authorizer';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.set_task_epic(text,integer,text,uuid,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea) TO omnis_authorizer';
  END IF;
END
$project_epic_acl$;
GRANT USAGE, SELECT ON SEQUENCE omnis.run_id_seq TO omnis_runtime;
DO $synthetic_run_projection_acl$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'omnis'
       AND table_name = 'runs'
       AND column_name = 'connector_authorization_id'
  ) THEN
    EXECUTE 'GRANT INSERT (connector_authorization_id, connector_request_id,
      connector_correlation_id, connector_request_binding) ON omnis.runs TO omnis_runtime';
    EXECUTE 'GRANT UPDATE (connector_attempt_id) ON omnis.runs TO omnis_runtime';
  END IF;
END
$synthetic_run_projection_acl$;
DO $task_project_acl$
BEGIN
  IF pg_catalog.to_regprocedure('omnis.create_task(text,text,text,uuid,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.create_task(text, text, text, uuid, bytea) FROM PUBLIC, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.create_task(text, text, text, uuid, bytea) TO omnis_runtime';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.set_task_project(text,integer,text,uuid,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.set_task_project(text, integer, text, uuid, bytea) FROM PUBLIC, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.set_task_project(text, integer, text, uuid, bytea) TO omnis_runtime';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.enforce_task_project_run_admission()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.enforce_task_project_run_admission() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.reject_task_project_audit_mutation()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.reject_task_project_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
END
$task_project_acl$;
REVOKE ALL ON TABLE omnis.task_project_management_audit,
  omnis.task_project_management_idempotency FROM PUBLIC, omnis_runtime,
  omnis_authorizer, omnis_launcher;
DO $task_execution_assignment_acl$
BEGIN
  IF pg_catalog.to_regclass('omnis.task_execution_assignment_audit') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.task_execution_assignment_audit FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regclass('omnis.task_execution_assignment_idempotency') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON omnis.task_execution_assignment_idempotency FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher';
  END IF;
  IF pg_catalog.to_regprocedure('omnis.set_task_execution_assignment(text,integer,text,integer,text,uuid,bytea)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION omnis.set_task_execution_assignment(text,integer,text,integer,text,uuid,bytea) FROM PUBLIC, omnis_authorizer, omnis_launcher';
    EXECUTE 'GRANT EXECUTE ON FUNCTION omnis.set_task_execution_assignment(text,integer,text,integer,text,uuid,bytea) TO omnis_runtime';
  END IF;
END
$task_execution_assignment_acl$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO omnis_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;

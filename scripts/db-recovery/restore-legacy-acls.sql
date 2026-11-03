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
GRANT USAGE, SELECT ON SEQUENCE omnis.task_id_seq, omnis.run_id_seq TO omnis_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO omnis_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;

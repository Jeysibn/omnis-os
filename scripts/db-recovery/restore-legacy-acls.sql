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
GRANT USAGE, SELECT ON SEQUENCE omnis.task_id_seq, omnis.run_id_seq TO omnis_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO omnis_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;

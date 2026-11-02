ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis
  REVOKE ALL ON TABLES FROM omnis_runtime;

ALTER TABLE omnis.tasks ALTER COLUMN status SET DEFAULT 'open';
ALTER TABLE omnis.runs
  ALTER COLUMN status SET DEFAULT 'queued',
  ALTER COLUMN runtime_kind SET DEFAULT 'mock',
  ALTER COLUMN synthetic SET DEFAULT TRUE,
  ALTER COLUMN usage SET DEFAULT '{"quality":"unknown","inputTokens":null,"outputTokens":null,"cost":null}'::jsonb;
ALTER TABLE omnis.run_events
  ALTER COLUMN source SET DEFAULT 'mock',
  ALTER COLUMN synthetic SET DEFAULT TRUE;

GRANT USAGE ON SCHEMA omnis TO omnis_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA omnis FROM omnis_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA omnis TO omnis_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis
  GRANT USAGE, SELECT ON SEQUENCES TO omnis_runtime;

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

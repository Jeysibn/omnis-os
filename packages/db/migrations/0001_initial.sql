CREATE SCHEMA IF NOT EXISTS omnis;

CREATE SEQUENCE IF NOT EXISTS omnis.task_id_seq;
CREATE SEQUENCE IF NOT EXISTS omnis.run_id_seq;

CREATE TABLE IF NOT EXISTS omnis.tasks (
  id text PRIMARY KEY,
  title varchar(120) NOT NULL,
  detail varchar(2000) NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'in_progress', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS omnis.runs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES omnis.tasks(id),
  task_title varchar(120) NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'stopping', 'completed', 'cancelled', 'failed', 'interrupted', 'unknown')),
  runtime_kind text NOT NULL CHECK (runtime_kind = 'mock'),
  synthetic boolean NOT NULL CHECK (synthetic IS TRUE),
  usage jsonb NOT NULL CHECK (
    usage = '{"quality":"unknown","inputTokens":null,"outputTokens":null,"cost":null}'::jsonb
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  result_output text,
  result_evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(result_evidence_refs) = 'array'),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  retry_policy text NOT NULL DEFAULT 'never' CHECK (retry_policy IN ('never', 'manual', 'safe')),
  execution_generation integer NOT NULL DEFAULT 0 CHECK (execution_generation >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  pg_boss_job_id text,
  last_event_sequence integer NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS runs_status_lease_idx
  ON omnis.runs (status, lease_expires_at)
  WHERE status IN ('queued', 'running', 'stopping', 'unknown');
CREATE INDEX IF NOT EXISTS runs_task_created_idx ON omnis.runs (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS omnis.run_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES omnis.runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'run.queued', 'run.started', 'run.output', 'run.stop_requested',
    'run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'
  )),
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source = 'mock'),
  synthetic boolean NOT NULL CHECK (synthetic IS TRUE),
  message varchar(2000) NOT NULL,
  source_event_id text,
  UNIQUE (run_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS run_events_source_dedup_idx
  ON omnis.run_events (run_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS omnis.run_idempotency (
  idempotency_key varchar(128) PRIMARY KEY,
  request_fingerprint text NOT NULL,
  run_id text NOT NULL UNIQUE REFERENCES omnis.runs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);


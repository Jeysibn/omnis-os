-- Canonical Run rows are a read/event projection for the existing connector
-- authorization and attempt records. They do not authorize or submit work.
-- PR #41's deferred 0021 migration is independent of this additive 0024 migration.
ALTER TABLE omnis.runs
  ADD COLUMN connector_authorization_id uuid,
  ADD COLUMN connector_request_id uuid,
  ADD COLUMN connector_correlation_id uuid,
  ADD COLUMN connector_request_binding jsonb,
  ADD COLUMN connector_attempt_id uuid,
  ADD CONSTRAINT runs_connector_projection_complete CHECK (COALESCE((
    (connector_authorization_id IS NULL
      AND connector_request_id IS NULL
      AND connector_correlation_id IS NULL
      AND connector_request_binding IS NULL
      AND connector_attempt_id IS NULL)
    OR
    (connector_authorization_id IS NOT NULL
      AND connector_request_id IS NOT NULL
      AND connector_correlation_id IS NOT NULL
      AND connector_request_binding IS NOT NULL
      AND connector_request_binding->>'taskId' = task_id
      AND connector_request_binding->>'promptDigest' ~ '^sha256:[0-9a-f]{64}$')
  ), false));

CREATE UNIQUE INDEX runs_connector_request_idx
  ON omnis.runs (connector_request_id)
  WHERE connector_request_id IS NOT NULL;

CREATE UNIQUE INDEX runs_connector_authorization_idx
  ON omnis.runs (connector_authorization_id)
  WHERE connector_authorization_id IS NOT NULL;

CREATE UNIQUE INDEX runs_connector_correlation_idx
  ON omnis.runs (connector_correlation_id)
  WHERE connector_correlation_id IS NOT NULL;

-- The runtime can persist only the non-authoritative Run projection pointers.
-- Grant consumption, approval, revocation, and attempts remain authorizer-owned.
GRANT INSERT (
  connector_authorization_id,
  connector_request_id,
  connector_correlation_id,
  connector_request_binding
) ON omnis.runs TO omnis_runtime;
GRANT UPDATE (connector_attempt_id) ON omnis.runs TO omnis_runtime;

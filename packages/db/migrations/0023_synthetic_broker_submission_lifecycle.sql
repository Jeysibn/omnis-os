-- Extends PR #43's synthetic attempt record in place. This migration is intentionally
-- independent of deferred 0021 (PR #41) and never alters task/run event architecture.
ALTER TABLE omnis.connector_execution_attempts
  DROP CONSTRAINT connector_execution_attempts_status_check,
  ADD CONSTRAINT connector_execution_attempts_status_check CHECK (status IN (
    'admitted', 'submitting', 'accepted', 'running', 'completed', 'failed', 'interrupted', 'unknown'
  )),
  ADD COLUMN decision_envelope jsonb,
  ADD COLUMN decision_nonce uuid UNIQUE,
  ADD COLUMN submission_started_at timestamptz,
  ADD COLUMN provider_submission_id text,
  ADD COLUMN response_text text CHECK (response_text IS NULL OR length(response_text) BETWEEN 1 AND 32000),
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN usage_provenance jsonb NOT NULL DEFAULT '{"kind":"unknown","reason":"not_reported","billingExposure":"unknown"}'::jsonb,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE omnis.connector_authorization_audit
  DROP CONSTRAINT connector_authorization_audit_event_type_check,
  ADD CONSTRAINT connector_authorization_audit_event_type_check CHECK (event_type IN (
    'connector.authorization_requested', 'connector.authorization_approved',
    'connector.authorization_denied', 'connector.authorization_revoked',
    'connector.authorization_consumed', 'connector.submission_started',
    'connector.submission_accepted', 'connector.execution_running',
    'connector.execution_completed', 'connector.execution_failed',
    'connector.execution_interrupted', 'connector.execution_unknown',
    'connector.cancellation_requested', 'connector.cancellation_confirmed'
  )),
  ADD COLUMN source_event_id text,
  ADD COLUMN source_event_fingerprint bytea,
  ADD CONSTRAINT connector_authorization_source_event_fingerprint_shape CHECK (
    (source_event_id IS NULL) = (source_event_fingerprint IS NULL)
    AND (source_event_fingerprint IS NULL OR octet_length(source_event_fingerprint) = 32)
  );
CREATE UNIQUE INDEX connector_authorization_audit_source_event_idx
  ON omnis.connector_authorization_audit(authorization_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

ALTER TABLE omnis.connector_execution_attempts
  ADD CONSTRAINT connector_attempt_usage_shape CHECK (
    jsonb_typeof(usage_provenance) = 'object'
    AND usage_provenance ? 'kind'
    AND usage_provenance->>'kind' IN ('measured', 'estimated', 'unknown')
    AND (usage_provenance->>'kind' <> 'unknown'
      OR (NOT (usage_provenance ? 'inputUnits') AND NOT (usage_provenance ? 'outputUnits')))
  ),
  ADD CONSTRAINT connector_attempt_submission_shape CHECK (
    (status = 'admitted' AND submission_started_at IS NULL)
    OR status = 'interrupted'
    OR (status NOT IN ('admitted','interrupted') AND submission_started_at IS NOT NULL)
  ),
  ADD CONSTRAINT connector_attempt_response_shape CHECK (
    (status = 'completed') = (response_text IS NOT NULL)
  );

CREATE FUNCTION omnis.guard_connector_attempt_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  IF ROW(NEW.id, NEW.authorization_id, NEW.request_id, NEW.synthetic, NEW.created_at,
         NEW.decision_envelope, NEW.decision_nonce)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.authorization_id, OLD.request_id, OLD.synthetic, OLD.created_at,
         OLD.decision_envelope, OLD.decision_nonce) THEN
    RAISE EXCEPTION 'connector attempt identity and decision are immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD.submission_started_at IS NOT NULL AND NEW.submission_started_at IS DISTINCT FROM OLD.submission_started_at)
     OR (OLD.submission_started_at IS NULL AND NEW.submission_started_at IS NOT NULL
         AND NOT (OLD.status = 'admitted' AND NEW.status = 'submitting')) THEN
    RAISE EXCEPTION 'connector submission boundary timestamp is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_submission_id IS NOT NULL AND NEW.provider_submission_id IS DISTINCT FROM OLD.provider_submission_id THEN
    RAISE EXCEPTION 'provider submission identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_submission_id IS NULL AND NEW.provider_submission_id IS NOT NULL
     AND NEW.status NOT IN ('submitting','accepted','running','completed','failed','interrupted','unknown') THEN
    RAISE EXCEPTION 'provider submission identity is premature' USING ERRCODE = '55000';
  END IF;
  IF OLD.response_text IS NOT NULL AND NEW.response_text IS DISTINCT FROM OLD.response_text THEN
    RAISE EXCEPTION 'provider response is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.response_text IS NOT NULL AND NEW.status <> 'completed' THEN
    RAISE EXCEPTION 'provider response is valid only for completed attempts' USING ERRCODE = '55000';
  END IF;
  IF OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
    RAISE EXCEPTION 'cancellation request is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NOT NULL
     AND NEW.status NOT IN ('submitting','accepted','running','unknown') THEN
    RAISE EXCEPTION 'cancellation can only target in-flight work' USING ERRCODE = '55000';
  END IF;
  IF OLD.usage_provenance IS DISTINCT FROM NEW.usage_provenance AND OLD.status = NEW.status THEN
    RAISE EXCEPTION 'usage provenance changes require a state transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'admitted' AND NEW.status IN ('submitting','interrupted'))
     OR (OLD.status = 'submitting' AND NEW.status IN ('accepted','failed','unknown','interrupted'))
     OR (OLD.status = 'accepted' AND NEW.status IN ('running','completed','failed','unknown','interrupted'))
     OR (OLD.status = 'running' AND NEW.status IN ('completed','failed','unknown','interrupted'))
     OR (OLD.status = 'unknown' AND NEW.status IN ('accepted','running','completed','failed','interrupted')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid connector attempt state transition' USING ERRCODE = '55000';
END
$function$;
REVOKE ALL ON FUNCTION omnis.guard_connector_attempt_update() FROM PUBLIC;
CREATE TRIGGER connector_attempt_transition_guard
  BEFORE UPDATE ON omnis.connector_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION omnis.guard_connector_attempt_update();

REVOKE ALL ON omnis.connector_execution_attempts FROM PUBLIC, omnis_runtime, omnis_launcher;
GRANT SELECT, INSERT ON omnis.connector_execution_attempts TO omnis_authorizer;
GRANT UPDATE (status, submission_started_at, provider_submission_id, cancel_requested_at,
              response_text, usage_provenance, updated_at)
  ON omnis.connector_execution_attempts TO omnis_authorizer;
REVOKE ALL ON omnis.connector_authorization_audit FROM PUBLIC, omnis_runtime, omnis_launcher;
GRANT SELECT, INSERT ON omnis.connector_authorization_audit TO omnis_authorizer;

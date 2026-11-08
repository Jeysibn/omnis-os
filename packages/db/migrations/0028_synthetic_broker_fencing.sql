-- Fences stale broker processes while retaining the existing authoritative attempt row.
ALTER TABLE omnis.connector_execution_attempts
  ADD COLUMN broker_generation integer NOT NULL DEFAULT 0 CHECK (broker_generation >= 0),
  ADD COLUMN broker_lease_owner_id uuid,
  ADD COLUMN broker_lease_expires_at timestamptz,
  ADD CONSTRAINT connector_attempt_broker_lease_shape CHECK (
    (broker_lease_owner_id IS NULL) = (broker_lease_expires_at IS NULL)
  );

ALTER TABLE omnis.connector_authorization_audit
  DROP CONSTRAINT connector_authorization_audit_event_type_check,
  ADD CONSTRAINT connector_authorization_audit_event_type_check CHECK (event_type IN (
    'connector.authorization_requested', 'connector.authorization_approved',
    'connector.authorization_denied', 'connector.authorization_revoked',
    'connector.authorization_consumed', 'connector.submission_started',
    'connector.submission_accepted', 'connector.execution_running',
    'connector.execution_completed', 'connector.execution_failed',
    'connector.execution_interrupted', 'connector.execution_unknown',
    'connector.cancellation_requested', 'connector.cancellation_confirmed',
    'connector.recovery_claimed'
  ));

CREATE OR REPLACE FUNCTION omnis.guard_connector_attempt_update()
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
  IF NEW.broker_generation < OLD.broker_generation
     OR NEW.broker_generation > OLD.broker_generation + 1 THEN
    RAISE EXCEPTION 'broker generation must increase by at most one' USING ERRCODE = '55000';
  END IF;
  IF NEW.broker_generation = OLD.broker_generation + 1 AND NOT (
       (OLD.status = 'admitted' AND NEW.status = 'submitting')
       OR (OLD.status = 'submitting' AND NEW.status = 'unknown')
       OR (OLD.status IN ('accepted','running','unknown') AND NEW.status = OLD.status)
     ) THEN
    RAISE EXCEPTION 'broker generation change is not valid for this attempt state' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'admitted' AND NEW.status = 'submitting'
     AND NEW.broker_generation <> OLD.broker_generation + 1 THEN
    RAISE EXCEPTION 'submission must acquire a new broker generation' USING ERRCODE = '55000';
  END IF;
  IF (NEW.broker_lease_owner_id IS NULL) <> (NEW.broker_lease_expires_at IS NULL) THEN
    RAISE EXCEPTION 'broker lease owner and expiry must be set together' USING ERRCODE = '55000';
  END IF;
  IF NEW.broker_lease_owner_id IS NOT NULL
     AND NEW.status NOT IN ('submitting','accepted','running','unknown') THEN
    RAISE EXCEPTION 'broker lease is invalid for this attempt state' USING ERRCODE = '55000';
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
GRANT UPDATE (broker_generation, broker_lease_owner_id, broker_lease_expires_at)
  ON omnis.connector_execution_attempts TO omnis_authorizer;

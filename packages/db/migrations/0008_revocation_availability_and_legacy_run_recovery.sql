-- Preserve provenance for active rows created before durable authorization
-- existed. Runtime cannot add, edit, or read these classifications.
CREATE TABLE omnis.legacy_unscoped_runs (
  run_id text PRIMARY KEY REFERENCES omnis.runs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES omnis.tasks(id),
  classified_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO omnis.legacy_unscoped_runs (run_id, task_id)
SELECT r.id, r.task_id
  FROM omnis.runs AS r
 WHERE r.status IN ('queued', 'running', 'stopping')
   AND r.created_at < (
     SELECT applied_at FROM omnis.schema_migrations
      WHERE id = '0005_durable_authorization'
   )
   AND NOT EXISTS (
     SELECT 1 FROM omnis.runtime_authorizations AS a WHERE a.consumed_run_id = r.id
   );

REVOKE ALL PRIVILEGES ON TABLE omnis.legacy_unscoped_runs FROM PUBLIC, omnis_runtime, omnis_authorizer;

-- Admission locks its authorization before taking the task row lock. This
-- matches unconsumed revocation (authorization then audit FK KEY SHARE on task)
-- and avoids reversing the G4-2 lock order. Direct run insertion acquires only
-- task KEY SHARE before consumption, which is compatible with the audit FK.
CREATE FUNCTION omnis.lock_run_authorization_for_admission(
  p_authorization_id text,
  p_task_id text,
  p_actor_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  locked_id text;
BEGIN
  SELECT id INTO locked_id
    FROM omnis.runtime_authorizations
   WHERE id = p_authorization_id
     AND requesting_actor = p_actor_id
     AND task_id = p_task_id
     AND runtime_id = 'mock'
     AND operation = 'execute_task'
     AND capabilities = '["mock.execute"]'::jsonb
     AND scope = jsonb_build_object('kind', 'task', 'taskId', p_task_id)
     AND status = 'authorized'
     AND expires_at > now()
     AND revoked_at IS NULL
     AND consumed_at IS NULL
   FOR UPDATE;
  RETURN FOUND;
END
$function$;

REVOKE ALL ON FUNCTION omnis.lock_run_authorization_for_admission(text, text, text)
  FROM PUBLIC, omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.lock_run_authorization_for_admission(text, text, text)
  TO omnis_runtime;

-- Replace the audit append interface with explicit historical termination
-- support. A migration-created row is required; callers cannot self-attest
-- legacy status. Grant-less legacy runs can only be denied execution or moved
-- to failed/cancelled/interrupted terminal states.
CREATE OR REPLACE FUNCTION omnis.append_runtime_authorization_audit(
  p_run_id text,
  p_event_type text,
  p_reason_code text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  v_task_id text;
  authorization_id text;
  requesting_actor text;
  correlation_id text;
  run_status text;
  event_outcome text;
  is_migration_classified_legacy boolean;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'runtime audit append requires the runtime database identity'
      USING ERRCODE = '42501';
  END IF;

  IF p_event_type NOT IN (
    'authorization.enforcement_denied',
    'operation.started', 'operation.completed', 'operation.failed',
    'operation.cancelled', 'operation.interrupted'
  ) THEN
    RAISE EXCEPTION 'runtime audit event type is not permitted'
      USING ERRCODE = '42501';
  END IF;

  IF p_reason_code IS NOT NULL AND p_reason_code NOT IN (
    'missing_expired_or_revoked', 'revoked_before_completion', 'runtime_failed'
  ) THEN
    RAISE EXCEPTION 'runtime audit reason code is not permitted'
      USING ERRCODE = '22023';
  END IF;

  SELECT r.task_id, r.status, a.id, a.requesting_actor, a.correlation_id
    INTO v_task_id, run_status, authorization_id, requesting_actor, correlation_id
    FROM omnis.runs AS r
    LEFT JOIN omnis.runtime_authorizations AS a
      ON a.consumed_run_id = r.id AND a.task_id = r.task_id
   WHERE r.id = p_run_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF authorization_id IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM omnis.legacy_unscoped_runs AS legacy
       WHERE legacy.run_id = p_run_id AND legacy.task_id = v_task_id
    ) INTO is_migration_classified_legacy;

    IF NOT is_migration_classified_legacy OR p_event_type NOT IN (
      'authorization.enforcement_denied', 'operation.failed',
      'operation.cancelled', 'operation.interrupted'
    ) THEN
      RETURN false;
    END IF;

    IF (p_event_type = 'operation.failed' AND run_status <> 'failed') OR
       (p_event_type = 'operation.cancelled' AND run_status <> 'cancelled') OR
       (p_event_type IN ('operation.interrupted', 'authorization.enforcement_denied')
         AND run_status <> 'interrupted') THEN
      RAISE EXCEPTION 'legacy runtime audit event does not match the persisted run state'
        USING ERRCODE = '23514';
    END IF;

    event_outcome := CASE
      WHEN p_event_type = 'authorization.enforcement_denied' THEN 'denied'
      ELSE 'recorded'
    END;

    INSERT INTO omnis.authorization_audit (
      task_id, run_id, event_type, actor_id, effective_identity,
      capability, correlation_id, outcome, reason_code
    ) VALUES (
      v_task_id, p_run_id, p_event_type, 'service:omnis-runtime',
      'service:omnis-runtime', 'mock.execute', 'legacy-grantless-run:' || p_run_id,
      event_outcome, p_reason_code
    );
    RETURN true;
  END IF;

  IF (p_event_type = 'operation.started' AND run_status <> 'running') OR
     (p_event_type = 'operation.completed' AND run_status <> 'completed') OR
     (p_event_type = 'operation.failed' AND run_status <> 'failed') OR
     (p_event_type = 'operation.cancelled' AND run_status <> 'cancelled') OR
     (p_event_type IN ('operation.interrupted', 'authorization.enforcement_denied')
       AND run_status <> 'interrupted') THEN
    RAISE EXCEPTION 'runtime audit event does not match the persisted run state'
      USING ERRCODE = '23514';
  END IF;

  event_outcome := CASE
    WHEN p_event_type = 'authorization.enforcement_denied' THEN 'denied'
    WHEN p_event_type IN ('operation.started', 'operation.completed') THEN 'allowed'
    ELSE 'recorded'
  END;

  INSERT INTO omnis.authorization_audit (
    authorization_id, task_id, run_id, event_type, actor_id,
    effective_identity, capability, correlation_id, outcome, reason_code
  ) VALUES (
    authorization_id, v_task_id, p_run_id, p_event_type, requesting_actor,
    'service:omnis-runtime', 'mock.execute', correlation_id, event_outcome, p_reason_code
  );
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION omnis.append_runtime_authorization_audit(text, text, text)
  FROM PUBLIC, omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.append_runtime_authorization_audit(text, text, text)
  TO omnis_runtime;

-- Admission and unconsumed revocation now serialize on the authorization row,
-- not a publicly callable advisory key. A short transaction-local lock timeout
-- makes genuine row contention visible and bounded; failed revocation is rolled
-- back and can be retried by the owner.
CREATE OR REPLACE FUNCTION omnis.consume_run_authorization(
  p_authorization_id text,
  p_task_id text,
  p_actor_id text,
  p_run_id text,
  p_correlation_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  updated_id text;
BEGIN
  UPDATE omnis.runtime_authorizations
     SET consumed_at = now(), consumed_run_id = p_run_id
   WHERE id = p_authorization_id
     AND requesting_actor = p_actor_id
     AND task_id = p_task_id
     AND runtime_id = 'mock'
     AND operation = 'execute_task'
     AND capabilities = '["mock.execute"]'::jsonb
     AND scope = jsonb_build_object('kind', 'task', 'taskId', p_task_id)
     AND status = 'authorized'
     AND expires_at > now()
     AND revoked_at IS NULL
     AND consumed_at IS NULL
     AND EXISTS (
       SELECT 1 FROM omnis.runs r
        WHERE r.id = p_run_id AND r.task_id = p_task_id AND r.status = 'queued'
     )
  RETURNING id INTO updated_id;

  IF updated_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO omnis.authorization_audit (
    authorization_id, task_id, run_id, event_type, actor_id,
    effective_identity, capability, correlation_id, outcome
  ) VALUES (
    p_authorization_id, p_task_id, p_run_id, 'authorization.consumed', p_actor_id,
    'service:omnis-worker', 'mock.execute', p_correlation_id, 'allowed'
  );
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION omnis.consume_run_authorization(text, text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omnis.consume_run_authorization(text, text, text, text, text)
  TO omnis_runtime;

-- Revocation locks the consumed run then authorization (matching worker
-- transitions), or the unconsumed authorization alone. In the latter branch,
-- the audit FK's task KEY SHARE is compatible with a direct run insert's FK.
CREATE OR REPLACE FUNCTION omnis.revoke_run_authorization(
  p_authorization_id text,
  p_actor_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  target_run_id text;
  current_run_id text;
  target_task_id text;
  target_correlation_id text;
  current_status text;
  current_revoked_at timestamptz;
BEGIN
  IF p_actor_id <> 'owner' THEN
    RETURN 'inactive';
  END IF;

  PERFORM pg_catalog.set_config('lock_timeout', '3000ms', true);

  SELECT task_id, consumed_run_id
    INTO target_task_id, target_run_id
    FROM omnis.runtime_authorizations
   WHERE id = p_authorization_id;
  IF NOT FOUND THEN
    RETURN 'inactive';
  END IF;

  IF target_run_id IS NULL THEN
    SELECT status, revoked_at, consumed_run_id, task_id, correlation_id
      INTO current_status, current_revoked_at, current_run_id,
           target_task_id, target_correlation_id
      FROM omnis.runtime_authorizations
     WHERE id = p_authorization_id
     FOR UPDATE;
    IF current_run_id IS NOT NULL THEN
      RETURN 'retry_consumed';
    END IF;
  ELSE
    PERFORM 1 FROM omnis.runs WHERE id = target_run_id FOR UPDATE;

    SELECT status, revoked_at, consumed_run_id, task_id, correlation_id
      INTO current_status, current_revoked_at, current_run_id,
           target_task_id, target_correlation_id
      FROM omnis.runtime_authorizations
     WHERE id = p_authorization_id
     FOR UPDATE;
    IF current_run_id IS DISTINCT FROM target_run_id THEN
      RETURN CASE WHEN current_run_id IS NULL THEN 'retry_unconsumed' ELSE 'retry_consumed' END;
    END IF;
  END IF;

  IF current_status IS DISTINCT FROM 'authorized' OR current_revoked_at IS NOT NULL THEN
    RETURN 'inactive';
  END IF;

  UPDATE omnis.runtime_authorizations
     SET status = 'revoked', revoked_at = now(), revoked_by = p_actor_id
   WHERE id = p_authorization_id;

  INSERT INTO omnis.authorization_audit (
    authorization_id, task_id, run_id, event_type, actor_id,
    effective_identity, capability, correlation_id, outcome
  ) VALUES (
    p_authorization_id, target_task_id, current_run_id, 'authorization.revoked',
    p_actor_id, 'human:owner', 'mock.execute', target_correlation_id, 'recorded'
  );

  RETURN 'revoked';
END
$function$;

REVOKE ALL ON FUNCTION omnis.revoke_run_authorization(text, text)
  FROM PUBLIC, omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.revoke_run_authorization(text, text) TO omnis_authorizer;

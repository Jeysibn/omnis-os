-- Runtime admission proves the persisted owner approval but cannot assert that
-- the execution worker itself is the human owner in the audit trail.
REVOKE ALL ON FUNCTION omnis.lock_run_authorization_for_admission(text, text, text)
  FROM PUBLIC, omnis_runtime, omnis_authorizer;
DROP FUNCTION omnis.lock_run_authorization_for_admission(text, text, text);
CREATE FUNCTION omnis.lock_run_authorization_for_admission(
  p_authorization_id text,
  p_task_id text
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
     AND requesting_actor = 'owner'
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

REVOKE ALL ON FUNCTION omnis.lock_run_authorization_for_admission(text, text)
  FROM PUBLIC, omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.lock_run_authorization_for_admission(text, text)
  TO omnis_runtime;

REVOKE ALL ON FUNCTION omnis.consume_run_authorization(text, text, text, text, text)
  FROM PUBLIC, omnis_runtime, omnis_authorizer;
DROP FUNCTION omnis.consume_run_authorization(text, text, text, text, text);

CREATE FUNCTION omnis.consume_run_authorization(
  p_authorization_id text,
  p_task_id text,
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
     AND requesting_actor = 'owner'
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
    p_authorization_id, p_task_id, p_run_id, 'authorization.consumed',
    'service:omnis-runtime', 'service:omnis-runtime', 'mock.execute',
    p_correlation_id, 'allowed'
  );
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION omnis.consume_run_authorization(text, text, text, text)
  FROM PUBLIC, omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.consume_run_authorization(text, text, text, text)
  TO omnis_runtime;

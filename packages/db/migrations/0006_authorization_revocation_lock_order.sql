-- Revocation takes the same run-then-authorization lock order as worker claim
-- and completion. Doing the transition and audit write here also avoids the
-- audit foreign-key check introducing an authorization-then-run lock cycle.
CREATE FUNCTION omnis.revoke_run_authorization(
  p_authorization_id text,
  p_actor_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  target_run_id text;
  target_task_id text;
  target_correlation_id text;
  current_status text;
  current_revoked_at timestamptz;
BEGIN
  IF p_actor_id <> 'owner' THEN
    RETURN false;
  END IF;

  SELECT consumed_run_id INTO target_run_id
    FROM omnis.runtime_authorizations
   WHERE id = p_authorization_id;

  IF target_run_id IS NOT NULL THEN
    PERFORM 1 FROM omnis.runs WHERE id = target_run_id FOR UPDATE;
  END IF;

  SELECT status, revoked_at, task_id, correlation_id
    INTO current_status, current_revoked_at, target_task_id, target_correlation_id
    FROM omnis.runtime_authorizations
   WHERE id = p_authorization_id
   FOR UPDATE;

  IF current_status IS DISTINCT FROM 'authorized' OR current_revoked_at IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE omnis.runtime_authorizations
     SET status = 'revoked', revoked_at = now(), revoked_by = p_actor_id
   WHERE id = p_authorization_id;

  INSERT INTO omnis.authorization_audit (
    id, authorization_id, task_id, run_id, event_type, actor_id,
    effective_identity, capability, correlation_id, outcome
  ) VALUES (
    'audit-' || p_authorization_id || '-revoked', p_authorization_id, target_task_id,
    target_run_id, 'authorization.revoked', p_actor_id, 'human:owner',
    'mock.execute', target_correlation_id, 'recorded'
  );

  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION omnis.revoke_run_authorization(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION omnis.revoke_run_authorization(text, text) FROM omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.revoke_run_authorization(text, text) TO omnis_authorizer;

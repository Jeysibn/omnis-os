-- Control requests carry a stable correlation/idempotency ID. A unique key
-- makes a replay return the original authorization instead of duplicating it.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT correlation_id
      FROM omnis.runtime_authorizations
     GROUP BY correlation_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'authorization correlation IDs are not unique; refusing idempotency migration';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX runtime_authorizations_correlation_id_uidx
  ON omnis.runtime_authorizations (correlation_id);

-- The worker must record admission denials without receiving authorizer
-- credentials. This routine emits only runtime-provenance events and derives
-- all actor/correlation values itself. It cannot write owner decisions.
CREATE FUNCTION omnis.append_runtime_admission_denial(
  p_authorization_id text,
  p_task_id text,
  p_reason_code text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  persisted_authorization_id text;
  persisted_task_id text;
  persisted_correlation_id text;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'runtime admission audit requires the runtime database identity'
      USING ERRCODE = '42501';
  END IF;

  IF p_reason_code NOT IN (
    'scope_status_or_expiry_mismatch',
    'authorization_missing',
    'admission_authorization_race'
  ) THEN
    RAISE EXCEPTION 'runtime admission denial reason is not permitted'
      USING ERRCODE = '22023';
  END IF;

  SELECT a.id, a.task_id, a.correlation_id
    INTO persisted_authorization_id, persisted_task_id, persisted_correlation_id
    FROM omnis.runtime_authorizations AS a
   WHERE a.id = p_authorization_id
     AND a.task_id = p_task_id;

  IF persisted_task_id IS NULL THEN
    SELECT t.id INTO persisted_task_id
      FROM omnis.tasks AS t
     WHERE t.id = p_task_id;
    persisted_authorization_id := NULL;
    persisted_correlation_id := gen_random_uuid()::text;
  END IF;

  INSERT INTO omnis.authorization_audit (
    authorization_id, task_id, event_type, actor_id, effective_identity,
    capability, correlation_id, outcome, reason_code
  ) VALUES (
    persisted_authorization_id, persisted_task_id, 'authorization.enforcement_denied',
    'service:omnis-runtime', 'service:omnis-runtime', 'mock.execute',
    COALESCE(persisted_correlation_id, gen_random_uuid()::text), 'denied', p_reason_code
  );

  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION omnis.append_runtime_admission_denial(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION omnis.append_runtime_admission_denial(text, text, text) FROM omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.append_runtime_admission_denial(text, text, text) TO omnis_runtime;

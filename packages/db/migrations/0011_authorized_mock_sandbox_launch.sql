CREATE TABLE omnis.mock_sandbox_launches (
  run_id text PRIMARY KEY REFERENCES omnis.runs(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  requested_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON omnis.mock_sandbox_launches FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;

CREATE FUNCTION omnis.authorize_mock_sandbox_launch(
  p_run_id text,
  p_worker_id text,
  p_generation integer
) RETURNS TABLE (task_title text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  v_task_id text;
  v_title text;
BEGIN
  IF session_user <> 'omnis_launcher' THEN
    RAISE EXCEPTION 'sandbox launch requires the launcher database identity'
      USING ERRCODE = '42501';
  END IF;

  SELECT r.task_id, r.task_title
    INTO v_task_id, v_title
    FROM omnis.runs AS r
   WHERE r.id = p_run_id
     AND r.status = 'running'
     AND r.lease_owner = p_worker_id
     AND r.execution_generation = p_generation
     AND r.lease_expires_at > clock_timestamp()
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM 1
    FROM omnis.runtime_authorizations AS a
   WHERE a.consumed_run_id = p_run_id
     AND a.task_id = v_task_id
     AND a.requesting_actor = 'owner'
     AND a.runtime_id = 'mock'
     AND a.operation = 'execute_task'
     AND a.capabilities = '["mock.execute"]'::jsonb
     AND a.scope = jsonb_build_object('kind', 'task', 'taskId', v_task_id)
     AND a.status = 'authorized'
     AND a.expires_at > clock_timestamp()
     AND a.revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO omnis.mock_sandbox_launches(run_id, worker_id, generation)
  VALUES (p_run_id, p_worker_id, p_generation)
  ON CONFLICT (run_id) DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT v_title;
END
$function$;

CREATE FUNCTION omnis.list_authorized_active_mock_runs(p_candidate_ids text[])
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
BEGIN
  IF session_user <> 'omnis_launcher' THEN
    RAISE EXCEPTION 'sandbox cleanup requires the launcher database identity'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT r.id
      FROM omnis.runs AS r
      JOIN omnis.runtime_authorizations AS a ON a.consumed_run_id = r.id
     WHERE r.id = ANY(p_candidate_ids)
       AND r.status = 'running'
       AND r.lease_expires_at > clock_timestamp()
       AND a.status = 'authorized'
       AND a.expires_at > clock_timestamp()
       AND a.revoked_at IS NULL;
END
$function$;

REVOKE ALL ON FUNCTION omnis.authorize_mock_sandbox_launch(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION omnis.list_authorized_active_mock_runs(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omnis.authorize_mock_sandbox_launch(text, text, integer) TO omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.list_authorized_active_mock_runs(text[]) TO omnis_launcher;

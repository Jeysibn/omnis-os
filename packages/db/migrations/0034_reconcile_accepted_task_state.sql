-- An owner-authorized acceptance replay may repair task state after a permitted
-- runtime transition reopened the same accepted result. The immutable receipt
-- remains the source of truth; only the current latest eligible Run may repair
-- the task. No historical rows are rewritten.
CREATE OR REPLACE FUNCTION omnis.project_task_event_to_mission_lane()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_type text; v_key text; v_acceptance omnis.task_result_acceptances%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM omnis.append_mission_lane_event(
      'task:' || NEW.id || ':created', 'task', NEW.id, 'task.created',
      'owner', 'api', false, NEW.id, NULL, NEW.project_id, NULL,
      NEW.created_at, '{}'::jsonb
    );
    RETURN NEW;
  END IF;

  IF OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    v_type := CASE WHEN OLD.project_id IS NULL THEN 'task.project_assigned'
      WHEN NEW.project_id IS NULL THEN 'task.project_unassigned'
      ELSE 'task.project_reassigned' END;
    v_key := 'task:' || NEW.id || ':project:' || NEW.association_revision::text;
    PERFORM omnis.append_mission_lane_event(
      v_key, 'task', NEW.id, v_type, 'owner', 'api', false, NEW.id, NULL,
      NEW.project_id, OLD.project_id, clock_timestamp(), '{}'::jsonb
    );
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status = 'in_review' AND NEW.status = 'completed' THEN
      SELECT * INTO v_acceptance FROM omnis.task_result_acceptances
       WHERE task_id = NEW.id
         AND run_id = (
           SELECT id FROM omnis.runs WHERE task_id = NEW.id
            ORDER BY created_at DESC, id DESC LIMIT 1
         );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Task result completion requires an owner acceptance'
          USING ERRCODE = '23514';
      END IF;
      PERFORM omnis.append_mission_lane_event(
        'task:' || NEW.id || ':status:' || NEW.mission_status_revision::text,
        'task', NEW.id, 'task.status_changed', 'owner', 'api', false,
        NEW.id, NULL, NEW.project_id, NULL, clock_timestamp(),
        jsonb_build_object(
          'from', OLD.status, 'to', NEW.status, 'runId', v_acceptance.run_id
        )
      );
    ELSIF NEW.status = 'completed' THEN
      RAISE EXCEPTION 'Task completion requires an eligible owner acceptance'
        USING ERRCODE = '23514';
    ELSE
      PERFORM omnis.append_mission_lane_event(
        'task:' || NEW.id || ':status:' || NEW.mission_status_revision::text,
        'task', NEW.id, 'task.status_changed',
        CASE WHEN NEW.status = 'in_progress' THEN 'service:omnis-runtime'
          ELSE 'service:omnis-worker' END,
        CASE WHEN NEW.status = 'in_progress' THEN 'api' ELSE 'mock-worker' END,
        true, NEW.id, NULL, NEW.project_id, NULL,
        clock_timestamp(), jsonb_build_object('from', OLD.status, 'to', NEW.status)
      );
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION omnis.accept_task_result(p_task_id text, p_run_id text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE
  v_task omnis.tasks%ROWTYPE;
  v_latest_run omnis.runs%ROWTYPE;
  v_acceptance omnis.task_result_acceptances%ROWTYPE;
  v_created boolean := false;
  v_acceptance_json jsonb;
  v_task_acceptance_json jsonb;
  v_task_json jsonb;
BEGIN
  PERFORM omnis.require_mission_lane_writer_lock();
  SELECT * INTO v_task FROM omnis.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_acceptance FROM omnis.task_result_acceptances
   WHERE task_id = p_task_id AND run_id = p_run_id;
  IF FOUND THEN
    -- Reconcile only a task reopened around the same accepted, latest result.
    -- An older receipt remains historical when a newer Run exists.
    IF v_task.status = 'in_review' THEN
      SELECT * INTO v_latest_run FROM omnis.runs
       WHERE task_id = p_task_id ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE;
      IF FOUND AND v_latest_run.id = p_run_id
         AND v_latest_run.status = 'completed'
         AND v_latest_run.runtime_kind = 'mock' AND v_latest_run.synthetic
         AND v_latest_run.result_output IS NOT NULL
         AND v_latest_run.lease_owner IS NULL
         AND v_latest_run.lease_expires_at IS NULL THEN
        UPDATE omnis.tasks SET status = 'completed'
         WHERE id = p_task_id RETURNING * INTO v_task;
      END IF;
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM omnis.task_result_acceptances WHERE request_id = p_request_id
    ) THEN
      RAISE EXCEPTION 'Acceptance request identity was already used' USING ERRCODE = 'P2005';
    END IF;
    IF v_task.status <> 'in_review' THEN
      RAISE EXCEPTION 'Task is not awaiting result review' USING ERRCODE = 'P2005';
    END IF;

    SELECT * INTO v_latest_run FROM omnis.runs
     WHERE task_id = p_task_id ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR v_latest_run.id <> p_run_id
       OR v_latest_run.status <> 'completed'
       OR v_latest_run.runtime_kind <> 'mock' OR NOT v_latest_run.synthetic
       OR v_latest_run.result_output IS NULL
       OR v_latest_run.lease_owner IS NOT NULL
       OR v_latest_run.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'Run is not the current eligible synthetic result'
        USING ERRCODE = 'P2005';
    END IF;

    INSERT INTO omnis.task_result_acceptances(task_id, run_id, request_id)
    VALUES (p_task_id, p_run_id, p_request_id)
    RETURNING * INTO v_acceptance;
    UPDATE omnis.tasks SET status = 'completed' WHERE id = p_task_id RETURNING * INTO v_task;
    v_created := true;
  END IF;

  v_acceptance_json := jsonb_build_object(
    'runId', v_acceptance.run_id,
    'acceptedBy', v_acceptance.accepted_by,
    'acceptedAt', to_char(v_acceptance.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'requestId', v_acceptance.request_id
  );
  SELECT jsonb_build_object(
    'runId', latest.run_id,
    'acceptedBy', latest.accepted_by,
    'acceptedAt', to_char(latest.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'requestId', latest.request_id
  ) INTO v_task_acceptance_json
    FROM omnis.task_result_acceptances AS latest
   WHERE latest.task_id = p_task_id
     AND latest.run_id = (
       SELECT id FROM omnis.runs WHERE task_id = p_task_id
        ORDER BY created_at DESC, id DESC LIMIT 1
     )
   LIMIT 1;
  v_task_json := jsonb_build_object(
    'id', v_task.id,
    'title', v_task.title,
    'detail', v_task.detail,
    'status', v_task.status,
    'createdAt', to_char(v_task.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'projectId', v_task.project_id,
    'associationRevision', v_task.association_revision,
    'agentId', v_task.execution_agent_id,
    'profileVersion', v_task.execution_profile_version_no,
    'runtimeId', v_task.execution_runtime_id,
    'assignmentRevision', v_task.execution_assignment_revision,
    'resultAcceptance', v_task_acceptance_json
  );
  RETURN jsonb_build_object(
    'task', v_task_json,
    'acceptance', v_acceptance_json,
    'created', v_created
  );
END
$function$;

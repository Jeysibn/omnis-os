ALTER TABLE omnis.tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE omnis.tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('open', 'in_progress', 'in_review', 'completed'));

ALTER TABLE omnis.runs
  ADD CONSTRAINT runs_task_id_id_unique UNIQUE (task_id, id);

CREATE TABLE omnis.task_result_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  run_id text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  accepted_by text NOT NULL DEFAULT 'owner' CHECK (accepted_by = 'owner'),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (task_id, run_id) REFERENCES omnis.runs(task_id, id) ON DELETE RESTRICT,
  UNIQUE (task_id, run_id)
);
CREATE INDEX task_result_acceptances_latest_idx
  ON omnis.task_result_acceptances(task_id, accepted_at DESC, id DESC);

REVOKE ALL ON omnis.task_result_acceptances
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT SELECT ON omnis.task_result_acceptances TO omnis_runtime;
CREATE TRIGGER task_result_acceptances_immutable
  BEFORE UPDATE OR DELETE ON omnis.task_result_acceptances
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_mission_lane_mutation();

DO $migration$
DECLARE v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT conname, pg_catalog.pg_get_constraintdef(oid) AS definition
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'omnis.mission_lane_events'::regclass
       AND contype = 'c'
  LOOP
    IF v_constraint.definition LIKE '%source_kind%'
       AND v_constraint.definition LIKE '%synthetic%'
       AND v_constraint.definition LIKE '%actor%'
       AND v_constraint.definition LIKE '%origin%' THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE omnis.mission_lane_events DROP CONSTRAINT %I', v_constraint.conname
      );
    ELSIF v_constraint.definition LIKE '%payload%'
       AND v_constraint.definition LIKE '%task.status_changed%' THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE omnis.mission_lane_events DROP CONSTRAINT %I', v_constraint.conname
      );
    END IF;
  END LOOP;
END
$migration$;

ALTER TABLE omnis.mission_lane_events
  ADD CONSTRAINT mission_lane_events_provenance_v2_check CHECK (
    (source_kind = 'run' AND actor = 'service:omnis-worker'
      AND origin = 'mock-worker' AND synthetic)
    OR (source_kind = 'task' AND event_type = 'task.status_changed'
      AND actor IN ('service:omnis-runtime','service:omnis-worker')
      AND origin IN ('api','mock-worker') AND synthetic)
    OR (source_kind = 'task' AND event_type = 'task.status_changed'
      AND actor = 'owner' AND origin = 'api' AND NOT synthetic)
    OR (source_kind = 'task' AND event_type <> 'task.status_changed'
      AND actor = 'owner' AND origin = 'api' AND NOT synthetic)
  );

ALTER TABLE omnis.mission_lane_events
  ADD CONSTRAINT mission_lane_events_payload_v2_check CHECK (
    (event_type = 'task.created' AND source_kind = 'task' AND payload = '{}'::jsonb)
    OR (event_type IN ('task.project_assigned','task.project_unassigned','task.project_reassigned')
      AND source_kind = 'task' AND payload = '{}'::jsonb)
    OR (event_type IN ('task.epic_assigned','task.epic_unassigned','task.epic_reassigned')
      AND source_kind = 'task' AND payload ?& ARRAY['previousEpicId','epicId']::text[]
      AND payload - ARRAY['previousEpicId','epicId']::text[] = '{}'::jsonb)
    OR (event_type = 'task.status_changed' AND source_kind = 'task'
      AND payload ?& ARRAY['from','to']::text[]
      AND payload - ARRAY['from','to']::text[] = '{}'::jsonb)
    OR (event_type = 'task.status_changed' AND source_kind = 'task'
      AND payload ?& ARRAY['from','to','runId']::text[]
      AND payload - ARRAY['from','to','runId']::text[] = '{}'::jsonb
      AND payload->>'from' = 'in_review' AND payload->>'to' = 'completed'
      AND length(payload->>'runId') BETWEEN 1 AND 128)
    OR (event_type IN ('run.queued','run.started','run.stop_requested','run.outcome_unknown',
      'run.completed','run.cancelled','run.failed','run.interrupted')
      AND source_kind = 'run' AND payload = '{}'::jsonb)
  );

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
        NEW.id, NULL, NEW.project_id, NULL, v_acceptance.accepted_at,
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

CREATE FUNCTION omnis.accept_task_result(p_task_id text, p_run_id text, p_request_id uuid)
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
  IF NOT FOUND THEN
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

REVOKE ALL ON FUNCTION omnis.project_task_event_to_mission_lane()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.accept_task_result(text,text,uuid)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.accept_task_result(text,text,uuid) TO omnis_runtime;

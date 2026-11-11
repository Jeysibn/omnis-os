-- Mission Lane starts at this migration's cutover. No existing Task or Run
-- history is backfilled into the global feed.
ALTER TABLE omnis.run_events
  ADD CONSTRAINT run_events_run_id_id_unique UNIQUE (run_id, id);

CREATE TABLE omnis.mission_lane_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  feed_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  last_global_sequence bigint NOT NULL DEFAULT 0 CHECK (last_global_sequence >= 0),
  history_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  history_start_sequence bigint NOT NULL DEFAULT 1 CHECK (history_start_sequence = 1)
);

INSERT INTO omnis.mission_lane_clock(singleton) VALUES (true);

CREATE TABLE omnis.mission_lane_events (
  global_sequence bigint PRIMARY KEY CHECK (global_sequence > 0),
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  source_key text NOT NULL UNIQUE CHECK (length(source_key) BETWEEN 1 AND 200),
  source_kind text NOT NULL CHECK (source_kind IN ('task', 'run')),
  source_record_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'task.created', 'task.project_assigned', 'task.project_unassigned',
    'task.project_reassigned', 'task.epic_assigned', 'task.epic_unassigned',
    'task.epic_reassigned', 'task.status_changed', 'run.queued', 'run.started',
    'run.stop_requested', 'run.outcome_unknown', 'run.completed',
    'run.cancelled', 'run.failed', 'run.interrupted'
  )),
  actor text NOT NULL CHECK (actor IN ('owner', 'service:omnis-runtime', 'service:omnis-worker')),
  origin text NOT NULL CHECK (origin IN ('api', 'mock-worker')),
  synthetic boolean NOT NULL,
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  run_id text REFERENCES omnis.runs(id) ON DELETE RESTRICT,
  project_id text REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  previous_project_id text REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 2048),
  CHECK ((source_kind = 'run') = (run_id IS NOT NULL)),
  FOREIGN KEY (run_id, source_record_id)
    REFERENCES omnis.run_events(run_id, id) ON DELETE RESTRICT,
  CHECK (
    (source_kind = 'run' AND actor = 'service:omnis-worker'
      AND origin = 'mock-worker' AND synthetic)
    OR (source_kind = 'task' AND event_type = 'task.status_changed'
      AND actor IN ('service:omnis-runtime','service:omnis-worker')
      AND origin IN ('api','mock-worker') AND synthetic)
    OR (source_kind = 'task' AND event_type <> 'task.status_changed'
      AND actor = 'owner' AND origin = 'api' AND NOT synthetic)
  ),
  CHECK (previous_project_id IS NULL OR previous_project_id IS DISTINCT FROM project_id),
  CHECK (
    (event_type = 'task.created' AND source_kind = 'task' AND payload = '{}'::jsonb)
    OR (event_type IN ('task.project_assigned','task.project_unassigned','task.project_reassigned')
      AND source_kind = 'task' AND payload = '{}'::jsonb)
    OR (event_type IN ('task.epic_assigned','task.epic_unassigned','task.epic_reassigned')
      AND source_kind = 'task' AND payload ?& ARRAY['previousEpicId','epicId']::text[]
      AND payload - ARRAY['previousEpicId','epicId']::text[] = '{}'::jsonb)
    OR (event_type = 'task.status_changed' AND source_kind = 'task'
      AND payload ?& ARRAY['from','to']::text[]
      AND payload - ARRAY['from','to']::text[] = '{}'::jsonb)
    OR (event_type IN ('run.queued','run.started','run.stop_requested','run.outcome_unknown',
      'run.completed','run.cancelled','run.failed','run.interrupted')
      AND source_kind = 'run' AND payload = '{}'::jsonb)
  )
);

CREATE INDEX mission_lane_task_sequence_idx
  ON omnis.mission_lane_events(task_id, global_sequence);
CREATE INDEX mission_lane_project_sequence_idx
  ON omnis.mission_lane_events(project_id, global_sequence)
  WHERE project_id IS NOT NULL;
CREATE INDEX mission_lane_run_sequence_idx
  ON omnis.mission_lane_events(run_id, global_sequence)
  WHERE run_id IS NOT NULL;

CREATE FUNCTION omnis.reject_mission_lane_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'Mission Lane history is append-only' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER mission_lane_events_immutable
  BEFORE UPDATE OR DELETE ON omnis.mission_lane_events
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_mission_lane_mutation();
CREATE TRIGGER mission_lane_clock_immutable
  BEFORE DELETE ON omnis.mission_lane_clock
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_mission_lane_mutation();

CREATE FUNCTION omnis.require_mission_lane_writer_lock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS pg_lock
     WHERE pg_lock.locktype = 'advisory' AND pg_lock.pid = pg_catalog.pg_backend_pid()
       AND pg_lock.granted AND pg_lock.mode = 'ExclusiveLock' AND pg_lock.objsubid = 1
       AND ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint) = 70463909136525
  ) THEN
    RAISE EXCEPTION 'Mission Lane writers must acquire the cursor lock before source locks'
      USING ERRCODE = '55000';
  END IF;
END
$function$;

CREATE FUNCTION omnis.append_mission_lane_event(
  p_source_key text, p_source_kind text, p_source_record_id text,
  p_event_type text, p_actor text, p_origin text, p_synthetic boolean,
  p_task_id text, p_run_id text, p_project_id text, p_previous_project_id text,
  p_occurred_at timestamptz, p_payload jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
DECLARE v_sequence bigint;
BEGIN
  -- Writers take the lock before domain locks; trigger code only verifies it
  -- and never waits for the cursor while holding a source row lock.
  PERFORM omnis.require_mission_lane_writer_lock();
  IF EXISTS (SELECT 1 FROM omnis.mission_lane_events WHERE source_key = p_source_key) THEN
    IF EXISTS (
      SELECT 1 FROM omnis.mission_lane_events
       WHERE source_key = p_source_key AND ROW(
         source_kind, source_record_id, event_type, actor, origin, synthetic,
         task_id, run_id, project_id, previous_project_id, occurred_at, payload
       ) IS DISTINCT FROM ROW(
         p_source_kind, p_source_record_id, p_event_type, p_actor, p_origin, p_synthetic,
         p_task_id, p_run_id, p_project_id, p_previous_project_id, p_occurred_at, p_payload
       )
    ) THEN
      RAISE EXCEPTION 'Mission Lane source identity was reused with conflicting content'
        USING ERRCODE = '23505';
    END IF;
    RETURN;
  END IF;
  UPDATE omnis.mission_lane_clock
     SET last_global_sequence = last_global_sequence + 1
   WHERE singleton
   RETURNING last_global_sequence INTO v_sequence;
  IF v_sequence IS NULL THEN
    RAISE EXCEPTION 'Mission Lane clock is unavailable' USING ERRCODE = '55000';
  END IF;
  INSERT INTO omnis.mission_lane_events(
    global_sequence, source_key, source_kind, source_record_id, event_type,
    actor, origin, synthetic, task_id, run_id, project_id, previous_project_id,
    occurred_at, payload
  ) VALUES (
    v_sequence, p_source_key, p_source_kind, p_source_record_id, p_event_type,
    p_actor, p_origin, p_synthetic, p_task_id, p_run_id, p_project_id,
    p_previous_project_id, p_occurred_at, p_payload
  );
END
$function$;

CREATE FUNCTION omnis.append_runtime_run_event(
  p_run_id text, p_event_type text, p_message text
) RETURNS TABLE(id text, run_id text, sequence integer, event_type text,
                at timestamptz, source text, synthetic boolean, message varchar)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
DECLARE v_run omnis.runs%ROWTYPE; v_event omnis.run_events%ROWTYPE;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'Run event append requires the runtime identity' USING ERRCODE = '42501';
  END IF;
  IF p_event_type NOT IN (
    'run.queued','run.started','run.provider_submission_requested','run.output',
    'run.stop_requested','run.completed','run.cancelled','run.failed',
    'run.interrupted','run.outcome_unknown'
  ) OR p_run_id IS NULL OR length(p_run_id) NOT BETWEEN 1 AND 128
    OR p_message IS NULL OR length(p_message) > 2000 THEN
    RAISE EXCEPTION 'Run event input is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_event_type NOT IN ('run.output','run.provider_submission_requested') THEN
    PERFORM omnis.require_mission_lane_writer_lock();
  END IF;
  SELECT r.* INTO v_run FROM omnis.runs AS r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run was not found' USING ERRCODE = 'P0002';
  END IF;
  IF (p_event_type = 'run.queued' AND v_run.status <> 'queued') OR
     (p_event_type = 'run.started' AND v_run.status <> 'running') OR
     (p_event_type = 'run.provider_submission_requested' AND v_run.status <> 'running') OR
     (p_event_type = 'run.output' AND v_run.status <> 'running') OR
     (p_event_type = 'run.stop_requested' AND v_run.status <> 'stopping') OR
     (p_event_type = 'run.completed' AND v_run.status <> 'completed') OR
     (p_event_type = 'run.cancelled' AND v_run.status <> 'cancelled') OR
     (p_event_type = 'run.failed' AND v_run.status <> 'failed') OR
     (p_event_type = 'run.interrupted' AND v_run.status <> 'interrupted') OR
     (p_event_type = 'run.outcome_unknown' AND v_run.status <> 'unknown') THEN
    RAISE EXCEPTION 'Run event does not match the committed Run state' USING ERRCODE = '55000';
  END IF;
  UPDATE omnis.runs AS r
     SET last_event_sequence = last_event_sequence + 1, updated_at = now()
   WHERE r.id = p_run_id
   RETURNING r.last_event_sequence INTO sequence;
  INSERT INTO omnis.run_events (id, run_id, sequence, event_type, at, message)
  VALUES (
    'evt-' || p_run_id || '-' || lpad(sequence::text, 4, '0'),
    p_run_id, sequence, p_event_type, now(), p_message
  ) RETURNING * INTO v_event;
  RETURN QUERY SELECT v_event.id, v_event.run_id, v_event.sequence,
    v_event.event_type, v_event.at, v_event.source, v_event.synthetic, v_event.message;
END
$function$;

CREATE FUNCTION omnis.project_run_event_to_mission_lane()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_run omnis.runs%ROWTYPE;
BEGIN
  IF NEW.event_type NOT IN (
    'run.queued','run.started','run.stop_requested','run.outcome_unknown',
    'run.completed','run.cancelled','run.failed','run.interrupted'
  ) THEN
    RETURN NEW;
  END IF;
  SELECT r.* INTO v_run FROM omnis.runs r WHERE r.id = NEW.run_id;
  IF NOT FOUND OR v_run.synthetic IS NOT TRUE OR v_run.runtime_kind <> 'mock' THEN
    RAISE EXCEPTION 'Mission Lane Run source is not synthetic mock execution' USING ERRCODE = '55000';
  END IF;
  IF (NEW.event_type = 'run.queued' AND v_run.status <> 'queued') OR
     (NEW.event_type = 'run.started' AND v_run.status <> 'running') OR
     (NEW.event_type = 'run.stop_requested' AND v_run.status <> 'stopping') OR
     (NEW.event_type = 'run.outcome_unknown' AND v_run.status <> 'unknown') OR
     (NEW.event_type = 'run.completed' AND v_run.status <> 'completed') OR
     (NEW.event_type = 'run.cancelled' AND v_run.status <> 'cancelled') OR
     (NEW.event_type = 'run.failed' AND v_run.status <> 'failed') OR
     (NEW.event_type = 'run.interrupted' AND v_run.status <> 'interrupted') OR
     NEW.sequence <> v_run.last_event_sequence THEN
    RAISE EXCEPTION 'Mission Lane Run event does not match its committed source state'
      USING ERRCODE = '55000';
  END IF;
  PERFORM omnis.append_mission_lane_event(
    'run:' || NEW.run_id || ':' || NEW.sequence::text,
    'run', NEW.id, NEW.event_type, 'service:omnis-worker', 'mock-worker', true,
    v_run.task_id, NEW.run_id,
    (SELECT t.project_id FROM omnis.tasks t WHERE t.id = v_run.task_id),
    NULL, NEW.at, '{}'::jsonb
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_lane_project_run_event
  AFTER INSERT ON omnis.run_events
  FOR EACH ROW EXECUTE FUNCTION omnis.project_run_event_to_mission_lane();

CREATE FUNCTION omnis.project_task_event_to_mission_lane()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_type text; v_key text; v_payload jsonb; v_previous_project text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_type := 'task.created';
    v_key := 'task:' || NEW.id || ':created';
    v_payload := '{}'::jsonb;
    PERFORM omnis.append_mission_lane_event(
      v_key, 'task', NEW.id, v_type, 'owner', 'api', false, NEW.id, NULL,
      NEW.project_id, NULL, NEW.created_at, v_payload
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
    -- Current status transitions are produced by authorized admission and
    -- worker lifecycle transactions. The source row is the committed Task.
    PERFORM omnis.append_mission_lane_event(
      'task:' || NEW.id || ':status:' || NEW.mission_status_revision::text,
      'task', NEW.id, 'task.status_changed',
      CASE WHEN NEW.status = 'in_progress' THEN 'service:omnis-runtime' ELSE 'service:omnis-worker' END,
      CASE WHEN NEW.status = 'in_progress' THEN 'api' ELSE 'mock-worker' END,
      true, NEW.id, NULL, NEW.project_id, NULL,
      clock_timestamp(), jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_lane_project_task_event
  AFTER INSERT OR UPDATE OF project_id, status ON omnis.tasks
  FOR EACH ROW EXECUTE FUNCTION omnis.project_task_event_to_mission_lane();

CREATE FUNCTION omnis.project_task_epic_event_to_mission_lane()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_type text;
BEGIN
  v_type := CASE NEW.action WHEN 'assigned' THEN 'task.epic_assigned'
    WHEN 'unassigned' THEN 'task.epic_unassigned' ELSE 'task.epic_reassigned' END;
  PERFORM omnis.append_mission_lane_event(
    'task-epic:' || NEW.request_id::text, 'task', NEW.id, v_type, 'owner', 'api', false,
    NEW.task_id, NULL, NEW.project_id, NULL, NEW.occurred_at,
    jsonb_build_object('previousEpicId', NEW.previous_epic_id, 'epicId', NEW.epic_id)
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_lane_project_task_epic_event
  AFTER INSERT ON omnis.task_epic_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.project_task_epic_event_to_mission_lane();

-- A committed task status transition has a durable stable source revision.
ALTER TABLE omnis.tasks
  ADD COLUMN mission_status_revision bigint NOT NULL DEFAULT 0 CHECK (mission_status_revision >= 0);
CREATE FUNCTION omnis.advance_mission_task_status_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.mission_status_revision := OLD.mission_status_revision + 1;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_task_status_revision
  BEFORE UPDATE OF status ON omnis.tasks
  FOR EACH ROW EXECUTE FUNCTION omnis.advance_mission_task_status_revision();

-- Acquire the fixed ledger serialization lock before task/project/advisory
-- locks in the trusted SECURITY DEFINER association writers.
ALTER FUNCTION omnis.create_task(text, text, text, uuid, bytea)
  RENAME TO create_task_mission_lane_impl;
CREATE OR REPLACE FUNCTION omnis.create_task(
  p_title text, p_detail text, p_project_id text, p_request_id uuid, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task creation requires the runtime identity' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(70463909136525);
  RETURN omnis.create_task_mission_lane_impl(p_title, p_detail, p_project_id, p_request_id, p_fingerprint);
END
$function$;
REVOKE ALL ON FUNCTION omnis.create_task_mission_lane_impl(text,text,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.create_task(text,text,text,uuid,bytea)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.create_task(text,text,text,uuid,bytea) TO omnis_runtime;

ALTER FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea)
  RENAME TO set_task_project_mission_lane_impl;
CREATE FUNCTION omnis.set_task_project(
  p_task_id text, p_expected_association_revision integer, p_project_id text,
  p_request_id uuid, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task project changes require the runtime identity' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(70463909136525);
  RETURN omnis.set_task_project_mission_lane_impl(
    p_task_id,p_expected_association_revision,p_project_id,p_request_id,p_fingerprint
  );
END
$function$;
REVOKE ALL ON FUNCTION omnis.set_task_project_mission_lane_impl(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea) TO omnis_runtime;

ALTER FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea)
  RENAME TO set_task_epic_mission_lane_impl;
CREATE FUNCTION omnis.set_task_epic(
  p_task_id text, p_expected_association_revision integer, p_epic_id text,
  p_request_id uuid, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'task Epic changes require the authorizer identity' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(70463909136525);
  RETURN omnis.set_task_epic_mission_lane_impl(
    p_task_id,p_expected_association_revision,p_epic_id,p_request_id,p_fingerprint
  );
END
$function$;
REVOKE ALL ON FUNCTION omnis.set_task_epic_mission_lane_impl(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea) TO omnis_authorizer;

REVOKE ALL ON omnis.mission_lane_clock, omnis.mission_lane_events
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.append_mission_lane_event(
  text,text,text,text,text,text,boolean,text,text,text,text,timestamptz,jsonb
) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.require_mission_lane_writer_lock()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.append_runtime_run_event(text,text,text)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
REVOKE INSERT ON omnis.run_events FROM omnis_runtime;
REVOKE INSERT (id,run_id,sequence,event_type,at,message)
  ON omnis.run_events FROM omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.append_runtime_run_event(text,text,text) TO omnis_runtime;
REVOKE ALL ON FUNCTION omnis.project_run_event_to_mission_lane()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.project_task_event_to_mission_lane()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.project_task_epic_event_to_mission_lane()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.advance_mission_task_status_revision()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.reject_mission_lane_mutation()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT SELECT ON omnis.mission_lane_clock, omnis.mission_lane_events TO omnis_runtime;

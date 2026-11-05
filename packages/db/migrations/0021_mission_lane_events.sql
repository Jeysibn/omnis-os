CREATE TABLE omnis.mission_event_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  feed_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  history_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  history_start_seq bigint NOT NULL DEFAULT 1 CHECK (history_start_seq >= 1)
);
INSERT INTO omnis.mission_event_clock(singleton) VALUES (true);

CREATE TABLE omnis.mission_events (
  seq bigint PRIMARY KEY CHECK (seq > 0),
  id text NOT NULL UNIQUE CHECK (id ~ '^mev_[0-9a-f]{32}$'),
  source_key text NOT NULL UNIQUE CHECK (octet_length(source_key) <= 256),
  event_type text NOT NULL CHECK (event_type IN (
    'task.created', 'task.project_assigned', 'task.project_unassigned', 'task.project_reassigned',
    'task.epic_assigned', 'task.epic_unassigned', 'task.epic_reassigned', 'task.status_changed',
    'run.queued', 'run.started', 'run.stop_requested', 'run.completed', 'run.cancelled',
    'run.failed', 'run.interrupted'
  )),
  actor text NOT NULL,
  origin_kind text NOT NULL CHECK (origin_kind IN ('task_state', 'run_event')),
  synthetic boolean NOT NULL,
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  run_id text REFERENCES omnis.runs(id) ON DELETE RESTRICT,
  project_id text REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  previous_project_id text REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 4096),
  CONSTRAINT mission_events_type_origin_check CHECK (
    (event_type LIKE 'task.%' AND origin_kind = 'task_state' AND synthetic = false)
    OR (event_type LIKE 'run.%' AND origin_kind = 'run_event' AND synthetic = true)
  ),
  CONSTRAINT mission_events_actor_check CHECK (
    (event_type IN ('task.created','task.project_assigned','task.project_unassigned',
      'task.project_reassigned','task.epic_assigned','task.epic_unassigned','task.epic_reassigned') AND actor = 'owner')
    OR (event_type IN ('task.status_changed','run.queued','run.started','run.stop_requested',
      'run.completed','run.cancelled','run.failed','run.interrupted') AND actor = 'system')
  ),
  CONSTRAINT mission_events_run_shape_check CHECK (
    (event_type LIKE 'run.%' AND run_id IS NOT NULL)
    OR (event_type = 'task.status_changed' AND run_id IS NOT NULL)
    OR (event_type LIKE 'task.%' AND event_type <> 'task.status_changed' AND run_id IS NULL)
  ),
  CONSTRAINT mission_events_project_shape_check CHECK (
    (event_type = 'task.project_assigned' AND previous_project_id IS NULL AND project_id IS NOT NULL)
    OR (event_type = 'task.project_unassigned' AND previous_project_id IS NOT NULL AND project_id IS NULL)
    OR (event_type = 'task.project_reassigned' AND previous_project_id IS NOT NULL AND project_id IS NOT NULL)
    OR (event_type NOT IN ('task.project_assigned','task.project_unassigned','task.project_reassigned')
      AND previous_project_id IS NULL)
  )
);
CREATE INDEX mission_events_project_seq_idx ON omnis.mission_events(project_id, seq DESC);
CREATE INDEX mission_events_previous_project_seq_idx ON omnis.mission_events(previous_project_id, seq DESC);
CREATE INDEX mission_events_task_seq_idx ON omnis.mission_events(task_id, seq DESC);
CREATE INDEX mission_events_run_seq_idx ON omnis.mission_events(run_id, seq DESC);

CREATE FUNCTION omnis.lock_mission_event_clock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
BEGIN
  IF session_user NOT IN ('omnis_runtime', 'omnis_authorizer', 'omnis') THEN
    RAISE EXCEPTION 'mission event writer identity is not permitted' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('lock_timeout', '3s', true);
  PERFORM 1 FROM omnis.mission_event_clock WHERE singleton = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mission event clock is unavailable' USING ERRCODE = '55000'; END IF;
END
$function$;

CREATE FUNCTION omnis.append_mission_event(
  p_source_key text, p_event_type text, p_actor text, p_origin_kind text, p_synthetic boolean,
  p_task_id text, p_run_id text, p_project_id text, p_previous_project_id text,
  p_payload jsonb, p_occurred_at timestamptz DEFAULT clock_timestamp()
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_seq bigint; v_id text;
BEGIN
  -- Always take the real row lock here. Application entry points acquire it before
  -- domain rows; unconditional acquisition prevents a caller-forged custom GUC from
  -- bypassing serialization on direct trigger-backed paths.
  PERFORM omnis.lock_mission_event_clock();
  IF p_source_key IS NULL OR octet_length(p_source_key) > 256
     OR p_payload IS NULL OR octet_length(p_payload::text) > 4096 THEN
    RAISE EXCEPTION 'mission event input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT last_seq + 1 INTO v_seq FROM omnis.mission_event_clock WHERE singleton = true FOR UPDATE;
  v_id := 'mev_' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO omnis.mission_event_clock(singleton, last_seq) VALUES (true, v_seq)
    ON CONFLICT (singleton) DO UPDATE SET last_seq = EXCLUDED.last_seq;
  INSERT INTO omnis.mission_events(
    seq, id, source_key, event_type, actor, origin_kind, synthetic, task_id, run_id,
    project_id, previous_project_id, occurred_at, payload
  ) VALUES (
    v_seq, v_id, p_source_key, p_event_type, p_actor, p_origin_kind, p_synthetic, p_task_id,
    p_run_id, p_project_id, p_previous_project_id, p_occurred_at, p_payload
  ) ON CONFLICT (source_key) DO NOTHING;
  IF NOT FOUND THEN
    -- Source keys are emitted once inside a transaction; a retry must not allocate a cursor.
    UPDATE omnis.mission_event_clock SET last_seq = last_seq - 1 WHERE singleton = true;
    RETURN NULL;
  END IF;
  PERFORM pg_notify('omnis_mission_events', v_seq::text);
  RETURN v_id;
END
$function$;

CREATE FUNCTION omnis.reject_mission_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'mission event history is append-only' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER mission_events_immutable
  BEFORE UPDATE OR DELETE ON omnis.mission_events
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_mission_event_mutation();

CREATE FUNCTION omnis.project_task_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
BEGIN
  PERFORM omnis.append_mission_event(
    'task.created:' || NEW.id, 'task.created', 'owner', 'task_state', false,
    NEW.id, NULL, NEW.project_id, NULL, '{}'::jsonb, NEW.created_at
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_task_created
  AFTER INSERT ON omnis.tasks FOR EACH ROW EXECUTE FUNCTION omnis.project_task_created();

CREATE FUNCTION omnis.project_task_project_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_type text;
BEGIN
  IF NEW.action = 'created_assigned' THEN RETURN NEW; END IF;
  v_type := CASE NEW.action WHEN 'assigned' THEN 'task.project_assigned'
    WHEN 'unassigned' THEN 'task.project_unassigned' ELSE 'task.project_reassigned' END;
  PERFORM omnis.append_mission_event(
    'task.project:' || NEW.id, v_type, 'owner', 'task_state', false, NEW.task_id, NULL,
    NEW.project_id, NEW.previous_project_id, '{}'::jsonb, NEW.occurred_at
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_task_project_audit
  AFTER INSERT ON omnis.task_project_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.project_task_project_audit();

CREATE FUNCTION omnis.project_task_epic_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_type text;
BEGIN
  v_type := CASE NEW.action WHEN 'assigned' THEN 'task.epic_assigned'
    WHEN 'unassigned' THEN 'task.epic_unassigned' ELSE 'task.epic_reassigned' END;
  PERFORM omnis.append_mission_event(
    'task.epic:' || NEW.id, v_type, 'owner', 'task_state', false, NEW.task_id, NULL,
    NEW.project_id, NULL,
    jsonb_build_object('previousEpicId', NEW.previous_epic_id, 'epicId', NEW.epic_id), NEW.occurred_at
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_task_epic_audit
  AFTER INSERT ON omnis.task_epic_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.project_task_epic_audit();

CREATE FUNCTION omnis.project_run_lifecycle_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_type text; v_message text; v_task_id text; v_project_id text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_type := 'run.queued';
    v_message := 'Run admitted to the synthetic mock worker.';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    v_type := CASE NEW.status WHEN 'running' THEN 'run.started' WHEN 'stopping' THEN 'run.stop_requested'
      WHEN 'completed' THEN 'run.completed' WHEN 'cancelled' THEN 'run.cancelled'
      WHEN 'failed' THEN 'run.failed' WHEN 'interrupted' THEN 'run.interrupted' ELSE NULL END;
    v_message := CASE NEW.status WHEN 'running' THEN 'Synthetic mock run started.'
      WHEN 'stopping' THEN 'Synthetic mock run stop requested.'
      WHEN 'completed' THEN 'Synthetic mock run completed.'
      WHEN 'cancelled' THEN 'Synthetic mock run cancelled.'
      WHEN 'failed' THEN 'Synthetic mock run failed.'
      WHEN 'interrupted' THEN 'Synthetic mock run interrupted.' ELSE NULL END;
  END IF;
  IF v_type IS NULL THEN RETURN NEW; END IF;
  PERFORM omnis.lock_mission_event_clock();
  SELECT task.id, task.project_id INTO v_task_id, v_project_id
    FROM omnis.tasks AS task WHERE task.id = NEW.task_id;
  UPDATE omnis.runs SET last_event_sequence = last_event_sequence + 1 WHERE id = NEW.id;
  INSERT INTO omnis.run_events(id, run_id, sequence, event_type, at, source, synthetic, message, source_event_id)
  SELECT 'evt-' || NEW.id || '-' || lpad((NEW.last_event_sequence + 1)::text, 4, '0'),
    NEW.id, NEW.last_event_sequence + 1, v_type, clock_timestamp(), 'mock', true, v_message,
    'mission-lane:' || v_type || ':' || NEW.id || ':' || COALESCE(NEW.updated_at::text, NEW.created_at::text);
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_run_lifecycle_insert
  AFTER INSERT ON omnis.runs FOR EACH ROW EXECUTE FUNCTION omnis.project_run_lifecycle_event();
CREATE TRIGGER mission_run_lifecycle_update
  AFTER UPDATE OF status ON omnis.runs FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION omnis.project_run_lifecycle_event();

CREATE FUNCTION omnis.project_run_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_project_id text; v_type text;
BEGIN
  IF NEW.event_type = 'run.output' THEN RETURN NEW; END IF;
  v_type := NEW.event_type;
  IF v_type NOT IN ('run.queued','run.started','run.stop_requested','run.completed',
      'run.cancelled','run.failed','run.interrupted') THEN
    RAISE EXCEPTION 'run event type is not projectable' USING ERRCODE = '22023';
  END IF;
  SELECT task.project_id INTO v_project_id FROM omnis.runs AS run
    JOIN omnis.tasks AS task ON task.id = run.task_id WHERE run.id = NEW.run_id;
  PERFORM omnis.append_mission_event(
    'run-event:' || NEW.id, v_type, 'system', 'run_event', true,
    (SELECT task_id FROM omnis.runs WHERE id = NEW.run_id), NEW.run_id, v_project_id, NULL,
    '{}'::jsonb, NEW.at
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_run_event_insert
  AFTER INSERT ON omnis.run_events FOR EACH ROW EXECUTE FUNCTION omnis.project_run_event();

CREATE FUNCTION omnis.set_task_status_from_run(p_task_id text, p_run_id text, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_old_status text; v_run_event_id text; v_source_type text; v_expected text;
  v_run_status text;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task status transition requires runtime identity' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.lock_mission_event_clock();
  IF p_status NOT IN ('open','in_progress','completed') THEN
    RAISE EXCEPTION 'task status is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT status INTO v_run_status FROM omnis.runs WHERE id = p_run_id AND task_id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run/task relationship is invalid' USING ERRCODE = '23514'; END IF;
  SELECT event.id, event.event_type INTO v_run_event_id, v_source_type
    FROM omnis.run_events AS event JOIN omnis.runs AS run ON run.id = event.run_id
   WHERE run.id = p_run_id AND run.task_id = p_task_id
   ORDER BY event.sequence DESC LIMIT 1;
  v_expected := CASE v_source_type WHEN 'run.queued' THEN 'in_progress'
    WHEN 'run.completed' THEN 'completed' WHEN 'run.cancelled' THEN 'open'
    WHEN 'run.failed' THEN 'open' WHEN 'run.interrupted' THEN 'open' ELSE NULL END;
  IF v_expected IS NULL OR v_expected <> p_status OR NOT (
      (v_source_type = 'run.queued' AND v_run_status = 'queued') OR
      (v_source_type = 'run.completed' AND v_run_status = 'completed') OR
      (v_source_type = 'run.cancelled' AND v_run_status = 'cancelled') OR
      (v_source_type = 'run.failed' AND v_run_status = 'failed') OR
      (v_source_type = 'run.interrupted' AND v_run_status = 'interrupted')
    ) THEN
    RAISE EXCEPTION 'run/task status relationship is invalid' USING ERRCODE = '23514';
  END IF;
  IF v_run_event_id IS NULL THEN
    RAISE EXCEPTION 'run lifecycle source event is missing' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO v_old_status FROM omnis.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_old_status = p_status THEN RETURN false; END IF;
  PERFORM set_config('omnis.mission_task_run_id', p_run_id, true);
  PERFORM set_config('omnis.mission_task_run_event_id', v_run_event_id, true);
  UPDATE omnis.tasks SET status = p_status WHERE id = p_task_id;
  RETURN true;
END
$function$;

-- Run admission is kept inside the database boundary so a runtime connection
-- cannot insert a run while bypassing the cursor, authorization, capacity,
-- idempotency, task-state, or project-archive checks.
CREATE FUNCTION omnis.admit_run(
  p_task_id text, p_authorization_id text, p_idempotency_key text,
  p_fingerprint text, p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_previous omnis.run_idempotency%ROWTYPE; v_task omnis.tasks%ROWTYPE;
  v_run omnis.runs%ROWTYPE; v_allowed boolean;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'run admission requires runtime identity' USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 16 AND 128
     OR p_fingerprint IS NULL OR length(p_fingerprint) > 4096
     OR p_authorization_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'run admission input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM omnis.lock_mission_event_clock();
  PERFORM pg_advisory_xact_lock(70463909136524::bigint);
  SELECT * INTO v_previous FROM omnis.run_idempotency
    WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_previous.request_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'run idempotency key conflicts with an earlier request' USING ERRCODE = 'P2002';
    END IF;
    SELECT * INTO v_run FROM omnis.runs WHERE id = v_previous.run_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'prior run state is unavailable' USING ERRCODE = 'P2002'; END IF;
    RETURN jsonb_build_object('created', false, 'run', to_jsonb(v_run));
  END IF;
  SELECT omnis.lock_run_authorization_for_admission(p_authorization_id, p_task_id) INTO v_allowed;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'active task authorization is required' USING ERRCODE = 'P2004';
  END IF;
  SELECT * INTO v_task FROM omnis.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task was not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM omnis.runs WHERE status IN ('queued','running','stopping','unknown')) THEN
    RAISE EXCEPTION 'run capacity is unavailable' USING ERRCODE = 'P2005';
  END IF;
  INSERT INTO omnis.runs(id, task_id, task_title)
    VALUES ('run-' || lpad(nextval('omnis.run_id_seq')::text, 4, '0'), v_task.id, v_task.title)
    RETURNING * INTO v_run;
  SELECT omnis.consume_run_authorization(
    p_authorization_id, v_task.id, v_run.id, p_correlation_id
  ) INTO v_allowed;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'active task authorization is required' USING ERRCODE = 'P2004';
  END IF;
  INSERT INTO omnis.run_idempotency(idempotency_key, request_fingerprint, run_id)
    VALUES (p_idempotency_key, p_fingerprint, v_run.id);
  PERFORM omnis.set_task_status_from_run(v_task.id, v_run.id, 'in_progress');
  RETURN jsonb_build_object('created', true, 'run', to_jsonb(v_run));
END
$function$;

-- All run status changes use this finite transition function. It owns the
-- cursor-first lock, expected-state check, worker lease check, source event,
-- status projection, and associated task status transition.
CREATE FUNCTION omnis.transition_run_status(
  p_run_id text, p_expected_status text, p_next_status text,
  p_worker_id text DEFAULT NULL, p_generation integer DEFAULT NULL,
  p_lease_seconds integer DEFAULT NULL, p_result_output text DEFAULT NULL,
  p_evidence_refs jsonb DEFAULT '[]'::jsonb, p_audit_reason text DEFAULT NULL
) RETURNS omnis.runs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_current omnis.runs%ROWTYPE; v_updated omnis.runs%ROWTYPE;
  v_task_status text; v_allowed boolean; v_audit_type text; v_reason text;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'run transition requires runtime identity' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.lock_mission_event_clock();
  SELECT * INTO v_current FROM omnis.runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run was not found' USING ERRCODE = 'P0002'; END IF;
  IF p_expected_status IS NULL OR p_next_status IS NULL
     OR v_current.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'run status changed concurrently' USING ERRCODE = 'P2002';
  END IF;
  IF p_audit_reason IS NOT NULL AND NOT (
    (p_next_status = 'failed' AND p_audit_reason = 'runtime_failed') OR
    (p_next_status = 'interrupted' AND p_expected_status = 'queued'
      AND p_audit_reason = 'missing_expired_or_revoked') OR
    (p_next_status = 'interrupted' AND p_expected_status = 'running'
      AND p_audit_reason = 'revoked_before_completion')
  ) THEN
    RAISE EXCEPTION 'runtime audit reason is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_audit_reason IN ('missing_expired_or_revoked', 'revoked_before_completion') THEN
    SELECT omnis.lock_active_run_authorization(p_run_id) INTO v_allowed;
    IF v_allowed THEN
      RAISE EXCEPTION 'authorization denial audit does not match an inactive grant' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_next_status = 'running' AND p_expected_status = 'queued' THEN
    IF p_worker_id IS NULL OR p_generation IS DISTINCT FROM v_current.execution_generation
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
      RAISE EXCEPTION 'run lease input is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT omnis.lock_active_run_authorization(p_run_id) INTO v_allowed;
    IF NOT v_allowed THEN RAISE EXCEPTION 'run authorization is no longer active' USING ERRCODE = 'P2004'; END IF;
    UPDATE omnis.runs SET status='running', execution_generation=execution_generation+1,
      lease_owner=p_worker_id, lease_expires_at=now() + (p_lease_seconds * interval '1 second'),
      updated_at=now() WHERE id=p_run_id RETURNING * INTO v_updated;
  ELSIF p_next_status = 'stopping' AND p_expected_status IN ('queued','running') THEN
    UPDATE omnis.runs SET status='stopping', updated_at=now()
      WHERE id=p_run_id RETURNING * INTO v_updated;
  ELSIF p_next_status IN ('completed','failed') AND p_expected_status = 'running' THEN
    IF p_worker_id IS NULL OR p_generation IS NULL OR v_current.lease_owner IS DISTINCT FROM p_worker_id
       OR v_current.execution_generation IS DISTINCT FROM p_generation THEN
      RAISE EXCEPTION 'worker lease is not current' USING ERRCODE = 'P2002';
    END IF;
    IF p_next_status = 'completed' THEN
      SELECT omnis.lock_active_run_authorization(p_run_id) INTO v_allowed;
      IF NOT v_allowed THEN RAISE EXCEPTION 'run authorization is no longer active' USING ERRCODE = 'P2004'; END IF;
    END IF;
    IF p_next_status='completed' AND (p_result_output IS NULL
       OR octet_length(p_result_output) > 262144
       OR jsonb_typeof(p_evidence_refs) <> 'array'
       OR octet_length(p_evidence_refs::text) > 16384) THEN
      RAISE EXCEPTION 'run result is invalid' USING ERRCODE = '22023';
    END IF;
    UPDATE omnis.runs SET status=p_next_status,
      result_output=CASE WHEN p_next_status='completed' THEN p_result_output ELSE result_output END,
      result_evidence_refs=CASE WHEN p_next_status='completed' THEN p_evidence_refs ELSE result_evidence_refs END,
      lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE id=p_run_id RETURNING * INTO v_updated;
    v_task_status := CASE p_next_status WHEN 'completed' THEN 'completed' ELSE 'open' END;
  ELSIF p_next_status = 'cancelled' AND p_expected_status = 'stopping' THEN
    IF p_worker_id IS NOT NULL AND (v_current.lease_owner IS DISTINCT FROM p_worker_id
       OR v_current.execution_generation IS DISTINCT FROM p_generation) THEN
      RAISE EXCEPTION 'worker lease is not current' USING ERRCODE = 'P2002';
    END IF;
    IF p_worker_id IS NULL AND v_current.lease_owner IS NOT NULL
       AND v_current.lease_expires_at > now() THEN
      RAISE EXCEPTION 'run lease is still active' USING ERRCODE = 'P2002';
    END IF;
    UPDATE omnis.runs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
      updated_at=now() WHERE id=p_run_id RETURNING * INTO v_updated;
    v_task_status := 'open';
  ELSIF p_next_status = 'interrupted'
      AND p_expected_status IN ('queued','running','stopping','unknown') THEN
    IF p_expected_status IN ('running','stopping') AND NOT COALESCE(
      (p_worker_id IS NOT NULL AND v_current.lease_owner IS NOT DISTINCT FROM p_worker_id
       AND v_current.execution_generation IS NOT DISTINCT FROM p_generation)
      OR (p_worker_id IS NULL AND v_current.lease_expires_at IS NOT NULL
       AND v_current.lease_expires_at <= now()),
      false
    ) THEN
      RAISE EXCEPTION 'worker lease is not current' USING ERRCODE = 'P2002';
    END IF;
    UPDATE omnis.runs SET status='interrupted', lease_owner=NULL, lease_expires_at=NULL,
      updated_at=now() WHERE id=p_run_id RETURNING * INTO v_updated;
    v_task_status := 'open';
  ELSE
    RAISE EXCEPTION 'run status transition is invalid' USING ERRCODE = 'P2002';
  END IF;

  IF v_task_status IS NOT NULL THEN
    PERFORM omnis.set_task_status_from_run(v_current.task_id, p_run_id, v_task_status);
  END IF;
  v_audit_type := CASE p_next_status
    WHEN 'running' THEN 'operation.started'
    WHEN 'completed' THEN 'operation.completed'
    WHEN 'failed' THEN 'operation.failed'
    WHEN 'cancelled' THEN 'operation.cancelled'
    WHEN 'interrupted' THEN CASE
      WHEN p_audit_reason IN ('missing_expired_or_revoked', 'revoked_before_completion')
        THEN 'authorization.enforcement_denied'
      ELSE 'operation.interrupted' END
    ELSE NULL
  END;
  IF p_next_status = 'failed' THEN
    v_reason := COALESCE(p_audit_reason, 'runtime_failed');
  ELSE
    v_reason := p_audit_reason;
  END IF;
  IF v_audit_type IS NOT NULL AND NOT omnis.append_runtime_authorization_audit(
    p_run_id, v_audit_type, v_reason
  ) THEN
    RAISE EXCEPTION 'runtime audit event could not be associated with the run transition' USING ERRCODE = '23514';
  END IF;
  RETURN v_updated;
END
$function$;

CREATE FUNCTION omnis.project_task_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_run_id text; v_source_id text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  v_run_id := current_setting('omnis.mission_task_run_id', true);
  v_source_id := current_setting('omnis.mission_task_run_event_id', true);
  IF v_run_id IS NULL OR v_source_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM omnis.run_events AS event
      JOIN omnis.runs AS run ON run.id = event.run_id
     WHERE event.id = v_source_id AND run.id = v_run_id AND run.task_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'task status must be changed from a persisted run transition' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.append_mission_event(
    'task.status:' || v_source_id, 'task.status_changed', 'system', 'task_state', false,
    NEW.id, v_run_id, NEW.project_id,
    NULL, jsonb_build_object('fromStatus', OLD.status, 'toStatus', NEW.status), clock_timestamp()
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER mission_task_status_change
  AFTER UPDATE OF status ON omnis.tasks FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION omnis.project_task_status_change();

CREATE FUNCTION omnis.append_run_output(p_run_id text, p_worker_id text, p_generation integer, p_message text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_event omnis.run_events%ROWTYPE; v_sequence integer;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'run output requires runtime identity' USING ERRCODE = '42501';
  END IF;
  IF p_message IS NULL OR length(p_message) > 2000 OR octet_length(p_message) > 8000 THEN
    RAISE EXCEPTION 'run output is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE omnis.runs SET last_event_sequence = last_event_sequence + 1
   WHERE id = p_run_id AND status = 'running' AND lease_owner = p_worker_id
     AND execution_generation = p_generation
   RETURNING last_event_sequence INTO v_sequence;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO omnis.run_events(id, run_id, sequence, event_type, at, source, synthetic, message)
  VALUES ('evt-' || p_run_id || '-' || lpad(v_sequence::text, 6, '0'),
    p_run_id, v_sequence, 'run.output', clock_timestamp(), 'mock', true, p_message)
  RETURNING * INTO v_event;
  RETURN jsonb_build_object('id', v_event.id, 'runId', v_event.run_id,
    'sequence', v_event.sequence, 'type', v_event.event_type,
    'at', to_char(v_event.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'source', v_event.source, 'synthetic', v_event.synthetic, 'message', v_event.message);
END
$function$;

-- Existing task management functions retain their reviewed validation bodies. These wrappers
-- acquire the feed cursor before those functions take idempotency, project, or task locks.
ALTER FUNCTION omnis.create_task(text,text,text,uuid,bytea) RENAME TO create_task_unsequenced;
ALTER FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea) RENAME TO set_task_project_unsequenced;
ALTER FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea) RENAME TO set_task_epic_unsequenced;
CREATE FUNCTION omnis.create_task(p_title text, p_detail text, p_project_id text, p_request_id uuid, p_fingerprint bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, omnis AS $function$
BEGIN
  PERFORM omnis.lock_mission_event_clock();
  RETURN omnis.create_task_unsequenced(p_title,p_detail,p_project_id,p_request_id,p_fingerprint);
END
$function$;
CREATE FUNCTION omnis.set_task_project(p_task_id text,p_expected_association_revision integer,
  p_project_id text,p_request_id uuid,p_fingerprint bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, omnis AS $function$
BEGIN
  PERFORM omnis.lock_mission_event_clock();
  RETURN omnis.set_task_project_unsequenced(p_task_id,p_expected_association_revision,p_project_id,p_request_id,p_fingerprint);
END
$function$;
CREATE FUNCTION omnis.set_task_epic(p_task_id text,p_expected_association_revision integer,
  p_epic_id text,p_request_id uuid,p_fingerprint bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, omnis AS $function$
BEGIN
  PERFORM omnis.lock_mission_event_clock();
  RETURN omnis.set_task_epic_unsequenced(p_task_id,p_expected_association_revision,p_epic_id,p_request_id,p_fingerprint);
END
$function$;

CREATE FUNCTION omnis.list_mission_events(
  p_project_id text, p_task_id text, p_run_id text, p_before_seq bigint, p_limit integer
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'mission event reads require the authorizer identity' USING ERRCODE = '42501';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100 OR p_before_seq < 1 THEN
    RAISE EXCEPTION 'mission event query is invalid' USING ERRCODE = '22023';
  END IF;
  WITH metadata AS MATERIALIZED (
    SELECT clock.feed_epoch, clock.last_seq, clock.history_started_at, clock.history_start_seq
      FROM omnis.mission_event_clock AS clock WHERE singleton = true
  ), candidates AS MATERIALIZED (
    SELECT event.* FROM omnis.mission_events AS event
      WHERE (p_before_seq IS NULL OR event.seq < p_before_seq)
        AND (p_project_id IS NULL OR event.project_id = p_project_id OR event.previous_project_id = p_project_id)
        AND (p_task_id IS NULL OR event.task_id = p_task_id)
        AND (p_run_id IS NULL OR event.run_id = p_run_id)
      ORDER BY event.seq DESC LIMIT p_limit + 1
  ), page_rows AS MATERIALIZED (
    SELECT * FROM candidates ORDER BY seq DESC LIMIT p_limit
  ), resource_check AS MATERIALIZED (
    SELECT (p_project_id IS NULL OR EXISTS (SELECT 1 FROM omnis.projects WHERE id = p_project_id AND owner_id = 'owner'))
       AND (p_task_id IS NULL OR EXISTS (SELECT 1 FROM omnis.tasks WHERE id = p_task_id))
       AND (p_run_id IS NULL OR EXISTS (SELECT 1 FROM omnis.runs WHERE id = p_run_id AND (p_task_id IS NULL OR task_id = p_task_id)))
       AND (p_project_id IS NULL OR (p_task_id IS NULL AND p_run_id IS NULL) OR EXISTS (
         SELECT 1 FROM omnis.tasks AS task
          WHERE task.id = p_task_id AND task.project_id = p_project_id
       ) OR EXISTS (
         SELECT 1 FROM omnis.runs AS run
         JOIN omnis.tasks AS task ON task.id = run.task_id
          WHERE run.id = p_run_id AND task.project_id = p_project_id
       ) OR EXISTS (
         SELECT 1 FROM omnis.mission_events AS context_event
          WHERE (context_event.project_id = p_project_id
              OR context_event.previous_project_id = p_project_id)
            AND (p_task_id IS NULL OR context_event.task_id = p_task_id)
            AND (p_run_id IS NULL OR context_event.run_id = p_run_id)
       )) AS valid
  )
  SELECT jsonb_build_object(
    'observedThroughSeq', metadata.last_seq::text,
    'feedEpoch', metadata.feed_epoch::text,
    'historyStartedAt', to_char(metadata.history_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'historyStartSeq', metadata.history_start_seq::text,
    'resourceExists', resource_check.valid,
    'hasOlder', (SELECT count(*) > p_limit FROM candidates),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', page_event.id, 'seq', page_event.seq::text, 'type', page_event.event_type,
      'occurredAt', to_char(page_event.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'taskId', page_event.task_id, 'projectId', page_event.project_id, 'runId', page_event.run_id,
      'previousProjectId', page_event.previous_project_id, 'actor', page_event.actor,
      'origin', CASE page_event.origin_kind WHEN 'task_state' THEN jsonb_build_object('kind','task_state','synthetic',false)
        ELSE jsonb_build_object('kind','run_event','source','mock','synthetic',true) END,
      'payload', page_event.payload
    ) ORDER BY page_event.seq ASC) FROM page_rows AS page_event), '[]'::jsonb),
    'oldestSeq', (SELECT min(seq)::text FROM page_rows)
  ) INTO v_result FROM metadata CROSS JOIN resource_check;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.list_mission_events_after(
  p_project_id text, p_task_id text, p_run_id text, p_after_seq bigint, p_limit integer
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'mission event reads require the authorizer identity' USING ERRCODE = '42501';
  END IF;
  WITH metadata AS MATERIALIZED (
    SELECT last_seq FROM omnis.mission_event_clock WHERE singleton = true
  ), page_rows AS MATERIALIZED (
    SELECT event.* FROM omnis.mission_events AS event
     WHERE event.seq > p_after_seq
       AND (p_project_id IS NULL OR event.project_id = p_project_id OR event.previous_project_id = p_project_id)
       AND (p_task_id IS NULL OR event.task_id = p_task_id)
       AND (p_run_id IS NULL OR event.run_id = p_run_id)
     ORDER BY event.seq ASC LIMIT p_limit
  ), resource_check AS MATERIALIZED (
    SELECT (p_project_id IS NULL OR EXISTS (SELECT 1 FROM omnis.projects WHERE id = p_project_id AND owner_id = 'owner'))
       AND (p_task_id IS NULL OR EXISTS (SELECT 1 FROM omnis.tasks WHERE id = p_task_id))
       AND (p_run_id IS NULL OR EXISTS (SELECT 1 FROM omnis.runs WHERE id = p_run_id AND (p_task_id IS NULL OR task_id = p_task_id)))
       AND (p_project_id IS NULL OR (p_task_id IS NULL AND p_run_id IS NULL) OR EXISTS (
         SELECT 1 FROM omnis.tasks AS task
          WHERE task.id = p_task_id AND task.project_id = p_project_id
       ) OR EXISTS (
         SELECT 1 FROM omnis.runs AS run
         JOIN omnis.tasks AS task ON task.id = run.task_id
          WHERE run.id = p_run_id AND task.project_id = p_project_id
       ) OR EXISTS (
         SELECT 1 FROM omnis.mission_events AS context_event
          WHERE (context_event.project_id = p_project_id
              OR context_event.previous_project_id = p_project_id)
            AND (p_task_id IS NULL OR context_event.task_id = p_task_id)
            AND (p_run_id IS NULL OR context_event.run_id = p_run_id)
       )) AS valid
  )
  SELECT jsonb_build_object(
    'observedThroughSeq', metadata.last_seq::text,
    'feedEpoch', (SELECT feed_epoch::text FROM omnis.mission_event_clock WHERE singleton = true),
    'resourceExists', resource_check.valid,
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', page_event.id, 'seq', page_event.seq::text, 'type', page_event.event_type,
      'occurredAt', to_char(page_event.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'taskId', page_event.task_id, 'projectId', page_event.project_id, 'runId', page_event.run_id,
      'previousProjectId', page_event.previous_project_id, 'actor', page_event.actor,
      'origin', CASE page_event.origin_kind WHEN 'task_state' THEN jsonb_build_object('kind','task_state','synthetic',false)
        ELSE jsonb_build_object('kind','run_event','source','mock','synthetic',true) END,
      'payload', page_event.payload
    ) ORDER BY page_event.seq ASC) FROM page_rows AS page_event), '[]'::jsonb)
  ) INTO v_result
  FROM metadata CROSS JOIN resource_check;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.mission_event_storage_metrics()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
  SELECT jsonb_build_object(
    'rows', (SELECT count(*) FROM omnis.mission_events),
    'bytes', pg_total_relation_size('omnis.mission_events'::regclass),
    'clockSeq', (SELECT last_seq::text FROM omnis.mission_event_clock WHERE singleton = true)
  )
$function$;

REVOKE ALL ON omnis.mission_event_clock, omnis.mission_events FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.lock_mission_event_clock(),
  omnis.append_mission_event(text,text,text,text,boolean,text,text,text,text,jsonb,timestamptz),
  omnis.reject_mission_event_mutation(), omnis.project_task_created(),
  omnis.project_task_project_audit(), omnis.project_task_epic_audit(),
  omnis.project_run_lifecycle_event(), omnis.project_run_event(),
  omnis.set_task_status_from_run(text,text,text), omnis.project_task_status_change(),
  omnis.admit_run(text,text,text,text,text),
  omnis.transition_run_status(text,text,text,text,integer,integer,text,jsonb,text),
  omnis.append_run_output(text,text,integer,text),
  omnis.create_task_unsequenced(text,text,text,uuid,bytea),
  omnis.set_task_project_unsequenced(text,integer,text,uuid,bytea),
  omnis.set_task_epic_unsequenced(text,integer,text,uuid,bytea),
  omnis.create_task(text,text,text,uuid,bytea),
  omnis.set_task_project(text,integer,text,uuid,bytea),
  omnis.set_task_epic(text,integer,text,uuid,bytea),
  omnis.list_mission_events(text,text,text,bigint,integer),
  omnis.list_mission_events_after(text,text,text,bigint,integer), omnis.mission_event_storage_metrics()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.lock_mission_event_clock(), omnis.set_task_status_from_run(text,text,text),
  omnis.admit_run(text,text,text,text,text),
  omnis.transition_run_status(text,text,text,text,integer,integer,text,jsonb,text),
  omnis.append_run_output(text,text,integer,text), omnis.create_task(text,text,text,uuid,bytea),
  omnis.set_task_project(text,integer,text,uuid,bytea)
  TO omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea) TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.list_mission_events(text,text,text,bigint,integer),
  omnis.list_mission_events_after(text,text,text,bigint,integer), omnis.mission_event_storage_metrics()
  TO omnis_authorizer;

REVOKE UPDATE(status) ON omnis.tasks FROM omnis_runtime;
REVOKE INSERT ON omnis.runs FROM omnis_runtime;
REVOKE INSERT (id, task_id, task_title) ON omnis.runs FROM omnis_runtime;
REVOKE UPDATE(status) ON omnis.runs FROM omnis_runtime;
REVOKE INSERT ON omnis.run_idempotency FROM omnis_runtime;
REVOKE INSERT (idempotency_key, request_fingerprint, run_id)
  ON omnis.run_idempotency FROM omnis_runtime;
REVOKE EXECUTE ON FUNCTION omnis.append_runtime_authorization_audit(text,text,text)
  FROM omnis_runtime;
REVOKE INSERT ON omnis.run_events FROM omnis_runtime;
REVOKE INSERT (id, run_id, sequence, event_type, at, message)
  ON omnis.run_events FROM omnis_runtime;
REVOKE UPDATE(last_event_sequence) ON omnis.runs FROM omnis_runtime;

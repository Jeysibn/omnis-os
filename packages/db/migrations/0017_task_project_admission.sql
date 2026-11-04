ALTER TABLE omnis.tasks
  ADD COLUMN project_id text REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  ADD COLUMN association_revision integer NOT NULL DEFAULT 1
    CHECK (association_revision > 0);

CREATE INDEX tasks_project_id_idx ON omnis.tasks(project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

CREATE TABLE omnis.task_project_management_audit (
  id text PRIMARY KEY CHECK (id ~ '^tpa_[0-9a-f]{32}$'),
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  previous_project_id text REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  project_id text REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (actor_id = 'owner'),
  action text NOT NULL CHECK (action IN (
    'created_assigned', 'assigned', 'unassigned', 'reassigned'
  )),
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (action IN ('created_assigned', 'assigned') AND previous_project_id IS NULL AND project_id IS NOT NULL)
    OR (action = 'unassigned' AND previous_project_id IS NOT NULL AND project_id IS NULL)
    OR (action = 'reassigned' AND previous_project_id IS NOT NULL
        AND project_id IS NOT NULL AND previous_project_id <> project_id)
  )
);
CREATE INDEX task_project_management_audit_target_idx
  ON omnis.task_project_management_audit(task_id, occurred_at DESC);

CREATE FUNCTION omnis.reject_task_project_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'task project audit records are immutable' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER task_project_management_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.task_project_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_task_project_audit_mutation();

CREATE TABLE omnis.task_project_management_idempotency (
  request_id uuid PRIMARY KEY,
  operation text NOT NULL CHECK (operation IN ('task.created', 'task.project_set')),
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION omnis.append_runtime_admission_denial(
  p_authorization_id text,
  p_task_id text,
  p_reason_code text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_authorization_id text;
        v_task_id text;
        v_correlation_id text;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'runtime admission audit requires the runtime database identity'
      USING ERRCODE = '42501';
  END IF;
  IF p_reason_code NOT IN (
    'scope_status_or_expiry_mismatch', 'authorization_missing',
    'admission_authorization_race', 'project_archived'
  ) THEN
    RAISE EXCEPTION 'runtime admission denial reason is not permitted'
      USING ERRCODE = '22023';
  END IF;
  SELECT authorization.id, authorization.task_id, authorization.correlation_id
    INTO v_authorization_id, v_task_id, v_correlation_id
    FROM omnis.runtime_authorizations AS authorization
   WHERE authorization.id = p_authorization_id AND authorization.task_id = p_task_id;
  IF v_task_id IS NULL THEN
    SELECT task.id INTO v_task_id FROM omnis.tasks AS task WHERE task.id = p_task_id;
    v_authorization_id := NULL;
    v_correlation_id := gen_random_uuid()::text;
  END IF;
  INSERT INTO omnis.authorization_audit (
    authorization_id, task_id, event_type, actor_id, effective_identity,
    capability, correlation_id, outcome, reason_code
  ) VALUES (
    v_authorization_id, v_task_id, 'authorization.enforcement_denied',
    'service:omnis-runtime', 'service:omnis-runtime', 'mock.execute',
    COALESCE(v_correlation_id, gen_random_uuid()::text), 'denied', p_reason_code
  );
  RETURN true;
END
$function$;
REVOKE ALL ON FUNCTION omnis.append_runtime_admission_denial(text, text, text)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.append_runtime_admission_denial(text, text, text)
  TO omnis_runtime;

CREATE FUNCTION omnis.create_task(
  p_title text,
  p_detail text,
  p_project_id text,
  p_request_id uuid,
  p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.task_project_management_idempotency%ROWTYPE;
        v_task omnis.tasks%ROWTYPE;
        v_project_status text;
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task creation requires the runtime identity' USING ERRCODE = '42501';
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 3 AND 120
     OR p_detail IS NULL OR length(btrim(p_detail)) NOT BETWEEN 10 AND 2000
     OR (p_request_id IS NULL) <> (p_fingerprint IS NULL)
     OR (p_fingerprint IS NOT NULL AND octet_length(p_fingerprint) <> 32)
     OR (p_project_id IS NOT NULL AND p_request_id IS NULL) THEN
    RAISE EXCEPTION 'task input is invalid' USING ERRCODE = '22023';
  END IF;

  IF p_request_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 2705198701));
    SELECT * INTO v_prior FROM omnis.task_project_management_idempotency
     WHERE request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
      IF v_prior.operation <> 'task.created' OR v_prior.fingerprint <> p_fingerprint THEN
        RAISE EXCEPTION 'task idempotency conflict' USING ERRCODE = '23505';
      END IF;
      RETURN v_prior.receipt;
    END IF;
  END IF;

  IF p_project_id IS NOT NULL THEN
    SELECT project.status INTO v_project_status FROM omnis.projects AS project
     WHERE project.id = p_project_id AND project.owner_id = 'owner' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_project_status = 'archived' THEN
      RAISE EXCEPTION 'project is archived' USING ERRCODE = 'P2001';
    END IF;
  END IF;

  INSERT INTO omnis.tasks(id, title, detail, project_id)
  VALUES (
    'task-' || lpad(nextval('omnis.task_id_seq')::text, 4, '0'),
    btrim(p_title), btrim(p_detail), p_project_id
  )
  RETURNING * INTO v_task;

  IF p_project_id IS NOT NULL THEN
    INSERT INTO omnis.task_project_management_audit(
      id, task_id, previous_project_id, project_id, actor_id, action, request_id
    ) VALUES (
      'tpa_' || replace(gen_random_uuid()::text, '-', ''), v_task.id, NULL,
      p_project_id, 'owner', 'created_assigned', p_request_id
    );
  END IF;

  SELECT jsonb_build_object(
    'id', task.id, 'title', task.title, 'detail', task.detail, 'status', task.status,
    'createdAt', to_char(task.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'projectId', task.project_id, 'associationRevision', task.association_revision
  ) INTO v_result FROM omnis.tasks AS task WHERE task.id = v_task.id;

  IF p_request_id IS NOT NULL THEN
    INSERT INTO omnis.task_project_management_idempotency(
      request_id, operation, fingerprint, task_id, receipt
    ) VALUES (p_request_id, 'task.created', p_fingerprint, v_task.id, v_result);
  END IF;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.set_task_project(
  p_task_id text,
  p_expected_association_revision integer,
  p_project_id text,
  p_request_id uuid,
  p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.task_project_management_idempotency%ROWTYPE;
        v_task omnis.tasks%ROWTYPE;
        v_project_status text;
        v_result jsonb;
        v_action text;
        v_previous_project_id text;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task project changes require the runtime identity' USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL OR length(p_task_id) NOT BETWEEN 1 AND 128
     OR p_expected_association_revision IS NULL OR p_expected_association_revision < 1
     OR p_request_id IS NULL OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'task project input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 2705198701));
  SELECT * INTO v_prior FROM omnis.task_project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'task.project_set' OR v_prior.task_id <> p_task_id
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'task project idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_task FROM omnis.tasks AS task WHERE task.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.association_revision <> p_expected_association_revision THEN
    RAISE EXCEPTION 'task association revision conflict' USING ERRCODE = 'P2002';
  END IF;
  IF EXISTS (SELECT 1 FROM omnis.runs AS run WHERE run.task_id = p_task_id)
     OR EXISTS (
       SELECT 1 FROM omnis.runtime_authorizations AS authorization
        WHERE authorization.task_id = p_task_id
     ) THEN
    RAISE EXCEPTION 'task association is immutable after authorization or run history' USING ERRCODE = 'P2003';
  END IF;

  IF v_task.project_id IS NOT NULL AND v_task.project_id IS DISTINCT FROM p_project_id THEN
    SELECT project.status INTO v_project_status FROM omnis.projects AS project
     WHERE project.id = v_task.project_id FOR SHARE;
    IF v_project_status = 'archived' THEN
      RAISE EXCEPTION 'task association in an archived project is immutable' USING ERRCODE = 'P2001';
    END IF;
  END IF;

  IF p_project_id IS NOT NULL THEN
    SELECT project.status INTO v_project_status FROM omnis.projects AS project
     WHERE project.id = p_project_id AND project.owner_id = 'owner' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_project_status = 'archived' THEN
      RAISE EXCEPTION 'project is archived' USING ERRCODE = 'P2001';
    END IF;
  END IF;

  IF v_task.project_id IS DISTINCT FROM p_project_id THEN
    v_previous_project_id := v_task.project_id;
    v_action := CASE
      WHEN v_task.project_id IS NULL THEN 'assigned'
      WHEN p_project_id IS NULL THEN 'unassigned'
      ELSE 'reassigned'
    END;
    UPDATE omnis.tasks
       SET project_id = p_project_id, association_revision = association_revision + 1
     WHERE id = p_task_id
     RETURNING * INTO v_task;
    INSERT INTO omnis.task_project_management_audit(
      id, task_id, previous_project_id, project_id, actor_id, action, request_id
    ) VALUES (
      'tpa_' || replace(gen_random_uuid()::text, '-', ''), p_task_id,
      v_previous_project_id, p_project_id, 'owner', v_action, p_request_id
    );
  END IF;

  SELECT jsonb_build_object(
    'id', task.id, 'title', task.title, 'detail', task.detail, 'status', task.status,
    'createdAt', to_char(task.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'projectId', task.project_id, 'associationRevision', task.association_revision
  ) INTO v_result FROM omnis.tasks AS task WHERE task.id = p_task_id;
  INSERT INTO omnis.task_project_management_idempotency(
    request_id, operation, fingerprint, task_id, receipt
  ) VALUES (p_request_id, 'task.project_set', p_fingerprint, p_task_id, v_result);
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.enforce_task_project_run_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_project_id text;
        v_project_status text;
BEGIN
  -- Lock task first so direct runtime INSERTs cannot race with a reassignment.
  SELECT task.project_id INTO v_project_id FROM omnis.tasks AS task
   WHERE task.id = NEW.task_id FOR SHARE;
  IF NOT FOUND OR v_project_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Project archive takes FOR UPDATE. This share lock spans the run and queue
  -- transaction: admission wins before archive, or observes the archived row.
  SELECT project.status INTO v_project_status FROM omnis.projects AS project
   WHERE project.id = v_project_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task project was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_project_status = 'archived' THEN
    RAISE EXCEPTION 'task project is archived' USING ERRCODE = 'P2001';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER runs_project_admission_guard
  BEFORE INSERT ON omnis.runs
  FOR EACH ROW EXECUTE FUNCTION omnis.enforce_task_project_run_admission();

REVOKE ALL ON FUNCTION omnis.create_task(text, text, text, uuid, bytea)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.set_task_project(text, integer, text, uuid, bytea)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.enforce_task_project_run_admission()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.reject_task_project_audit_mutation()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE INSERT ON omnis.tasks FROM omnis_runtime;
REVOKE INSERT (id, title, detail, project_id) ON omnis.tasks FROM omnis_runtime;
REVOKE ALL ON SEQUENCE omnis.task_id_seq FROM omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.create_task(text, text, text, uuid, bytea) TO omnis_runtime;
GRANT EXECUTE ON FUNCTION omnis.set_task_project(text, integer, text, uuid, bytea)
  TO omnis_runtime;

REVOKE ALL ON omnis.task_project_management_audit, omnis.task_project_management_idempotency
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;

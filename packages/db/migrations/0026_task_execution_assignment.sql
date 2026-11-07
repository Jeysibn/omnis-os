ALTER TABLE omnis.tasks
  ADD COLUMN execution_agent_id text,
  ADD COLUMN execution_profile_version_no integer,
  ADD COLUMN execution_runtime_id text,
  ADD COLUMN execution_assignment_revision integer NOT NULL DEFAULT 1
    CHECK (execution_assignment_revision > 0),
  ADD CONSTRAINT tasks_execution_profile_fk
    FOREIGN KEY (execution_agent_id, execution_profile_version_no)
    REFERENCES omnis.agent_profile_versions(agent_id, version_no) ON DELETE RESTRICT,
  ADD CONSTRAINT tasks_execution_assignment_shape CHECK (
    (execution_agent_id IS NULL AND execution_profile_version_no IS NULL AND execution_runtime_id IS NULL)
    OR
    (execution_agent_id IS NOT NULL AND execution_profile_version_no IS NOT NULL
      AND execution_runtime_id = 'mock')
  );

CREATE TABLE omnis.task_execution_assignment_audit (
  id text PRIMARY KEY CHECK (id ~ '^tea_[0-9a-f]{32}$'),
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  previous_agent_id text,
  previous_profile_version_no integer,
  previous_runtime_id text,
  agent_id text,
  profile_version_no integer,
  runtime_id text,
  actor_id text NOT NULL CHECK (actor_id = 'owner'),
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (previous_agent_id IS NULL AND previous_profile_version_no IS NULL AND previous_runtime_id IS NULL)
    OR (previous_agent_id IS NOT NULL AND previous_profile_version_no IS NOT NULL
      AND previous_runtime_id = 'mock')
  ),
  CHECK (
    (agent_id IS NULL AND profile_version_no IS NULL AND runtime_id IS NULL)
    OR (agent_id IS NOT NULL AND profile_version_no IS NOT NULL AND runtime_id = 'mock')
  )
);
CREATE INDEX task_execution_assignment_audit_target_idx
  ON omnis.task_execution_assignment_audit(task_id, occurred_at DESC);
CREATE TRIGGER task_execution_assignment_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.task_execution_assignment_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_task_project_audit_mutation();

CREATE TABLE omnis.task_execution_assignment_idempotency (
  request_id uuid PRIMARY KEY,
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bind synthetic connector authorization to the durable task assignment while
-- holding the task row lock, so assignment changes cannot race approval.
CREATE OR REPLACE FUNCTION omnis.validate_connector_authorization_context(
  p_project_id text,
  p_project_revision integer,
  p_task_id text,
  p_task_revision integer,
  p_agent_id text,
  p_profile_version integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  v_project_revision integer;
  v_project_status text;
  v_task_project_id text;
  v_task_revision integer;
  v_task_agent_id text;
  v_task_profile_version integer;
  v_task_runtime_id text;
  v_agent_lifecycle text;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'connector authorization context requires the authorizer identity'
      USING ERRCODE = '42501';
  END IF;

  SELECT project_id, association_revision, execution_agent_id,
         execution_profile_version_no, execution_runtime_id
    INTO v_task_project_id, v_task_revision, v_task_agent_id,
         v_task_profile_version, v_task_runtime_id
    FROM omnis.tasks
   WHERE id = p_task_id
   FOR SHARE;
  IF NOT FOUND OR v_task_project_id <> p_project_id OR v_task_revision <> p_task_revision
     OR v_task_agent_id IS DISTINCT FROM p_agent_id
     OR v_task_profile_version IS DISTINCT FROM p_profile_version
     OR v_task_runtime_id IS DISTINCT FROM 'mock' THEN
    RETURN false;
  END IF;

  SELECT revision, status INTO v_project_revision, v_project_status
    FROM omnis.projects
   WHERE id = p_project_id AND owner_id = 'owner'
   FOR SHARE;
  IF NOT FOUND OR v_project_revision <> p_project_revision OR v_project_status = 'archived' THEN
    RETURN false;
  END IF;

  SELECT lifecycle INTO v_agent_lifecycle
    FROM omnis.agents
   WHERE id = p_agent_id AND owner_id = 'owner'
   FOR SHARE;
  IF NOT FOUND OR v_agent_lifecycle <> 'available' THEN
    RETURN false;
  END IF;

  PERFORM 1 FROM omnis.agent_profile_versions
   WHERE agent_id = p_agent_id AND version_no = p_profile_version
   FOR SHARE;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION omnis.set_task_execution_assignment(
  p_task_id text,
  p_expected_revision integer,
  p_agent_id text,
  p_profile_version_no integer,
  p_runtime_id text,
  p_request_id uuid,
  p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_task omnis.tasks%ROWTYPE;
        v_prior omnis.task_execution_assignment_idempotency%ROWTYPE;
        v_agent omnis.agents%ROWTYPE;
        v_receipt jsonb;
        v_previous_agent_id text;
        v_previous_profile_version_no integer;
        v_previous_runtime_id text;
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task assignment requires the runtime identity' USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL OR length(p_task_id) NOT BETWEEN 1 AND 128
     OR p_expected_revision IS NULL OR p_expected_revision < 1
     OR p_request_id IS NULL OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32
     OR ((p_agent_id IS NULL OR p_profile_version_no IS NULL OR p_runtime_id IS NULL)
         AND NOT (p_agent_id IS NULL AND p_profile_version_no IS NULL AND p_runtime_id IS NULL))
     OR (p_agent_id IS NOT NULL AND p_runtime_id <> 'mock') THEN
    RAISE EXCEPTION 'task execution assignment input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1483387019));
  SELECT * INTO v_prior FROM omnis.task_execution_assignment_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.task_id <> p_task_id OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'task execution assignment idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_task FROM omnis.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.execution_assignment_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'task execution assignment revision conflict' USING ERRCODE = 'P2002';
  END IF;
  IF EXISTS (SELECT 1 FROM omnis.runs WHERE task_id = p_task_id)
     OR EXISTS (SELECT 1 FROM omnis.runtime_authorizations WHERE task_id = p_task_id)
     OR EXISTS (SELECT 1 FROM omnis.connector_authorizations WHERE task_id = p_task_id) THEN
    RAISE EXCEPTION 'task execution assignment is immutable after authorization or run history'
      USING ERRCODE = 'P2003';
  END IF;
  IF p_agent_id IS NOT NULL THEN
    SELECT * INTO v_agent FROM omnis.agents
     WHERE id = p_agent_id AND owner_id = 'owner' FOR SHARE;
    IF NOT FOUND OR v_agent.lifecycle <> 'available'
       OR v_agent.current_version_no IS DISTINCT FROM p_profile_version_no THEN
      RAISE EXCEPTION 'published agent profile is unavailable' USING ERRCODE = 'P2004';
    END IF;
  END IF;

  IF v_task.execution_agent_id IS DISTINCT FROM p_agent_id
     OR v_task.execution_profile_version_no IS DISTINCT FROM p_profile_version_no
     OR v_task.execution_runtime_id IS DISTINCT FROM p_runtime_id THEN
    IF v_task.execution_assignment_revision >= 9007199254740991 THEN
      RAISE EXCEPTION 'task execution assignment revision exhausted' USING ERRCODE = '22003';
    END IF;
    v_previous_agent_id := v_task.execution_agent_id;
    v_previous_profile_version_no := v_task.execution_profile_version_no;
    v_previous_runtime_id := v_task.execution_runtime_id;
    UPDATE omnis.tasks
       SET execution_agent_id = p_agent_id,
           execution_profile_version_no = p_profile_version_no,
           execution_runtime_id = p_runtime_id,
           execution_assignment_revision = execution_assignment_revision + 1
     WHERE id = p_task_id
     RETURNING * INTO v_task;
    INSERT INTO omnis.task_execution_assignment_audit (
      id, task_id, previous_agent_id, previous_profile_version_no, previous_runtime_id,
      agent_id, profile_version_no, runtime_id, actor_id, request_id
    ) VALUES (
      'tea_' || replace(gen_random_uuid()::text, '-', ''), p_task_id,
      v_previous_agent_id, v_previous_profile_version_no, v_previous_runtime_id,
      p_agent_id, p_profile_version_no, p_runtime_id, 'owner', p_request_id
    );
  END IF;

  SELECT jsonb_build_object(
    'id', task.id, 'title', task.title, 'detail', task.detail, 'status', task.status,
    'createdAt', to_char(task.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'projectId', task.project_id, 'associationRevision', task.association_revision,
    'agentId', task.execution_agent_id, 'profileVersion', task.execution_profile_version_no,
    'runtimeId', task.execution_runtime_id, 'assignmentRevision', task.execution_assignment_revision
  ) INTO v_receipt FROM omnis.tasks AS task WHERE task.id = p_task_id;
  INSERT INTO omnis.task_execution_assignment_idempotency(request_id, task_id, fingerprint, receipt)
  VALUES (p_request_id, p_task_id, p_fingerprint, v_receipt);
  RETURN v_receipt;
END
$function$;

REVOKE ALL ON omnis.task_execution_assignment_audit, omnis.task_execution_assignment_idempotency
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.set_task_execution_assignment(text,integer,text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.set_task_execution_assignment(text,integer,text,integer,text,uuid,bytea)
  TO omnis_runtime;

ALTER TABLE omnis.tasks
  ADD CONSTRAINT tasks_project_id_id_unique UNIQUE (project_id, id);

CREATE TABLE omnis.task_epic_associations (
  task_id text PRIMARY KEY,
  project_id text NOT NULL,
  epic_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_epic_associations_task_project_fk
    FOREIGN KEY (project_id, task_id)
    REFERENCES omnis.tasks(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_epic_associations_epic_project_fk
    FOREIGN KEY (project_id, epic_id)
    REFERENCES omnis.project_epics(project_id, id) ON DELETE RESTRICT
);
CREATE INDEX task_epic_associations_epic_task_idx
  ON omnis.task_epic_associations(project_id, epic_id, task_id);

CREATE TABLE omnis.task_epic_management_audit (
  id text PRIMARY KEY CHECK (id ~ '^tea_[0-9a-f]{32}$'),
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  previous_epic_id text,
  epic_id text,
  actor_id text NOT NULL CHECK (actor_id = 'owner'),
  action text NOT NULL CHECK (action IN ('assigned', 'reassigned', 'unassigned')),
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, previous_epic_id)
    REFERENCES omnis.project_epics(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, epic_id)
    REFERENCES omnis.project_epics(project_id, id) ON DELETE RESTRICT,
  CHECK (
    (action = 'assigned' AND previous_epic_id IS NULL AND epic_id IS NOT NULL)
    OR (action = 'reassigned' AND previous_epic_id IS NOT NULL AND epic_id IS NOT NULL
        AND previous_epic_id <> epic_id)
    OR (action = 'unassigned' AND previous_epic_id IS NOT NULL AND epic_id IS NULL)
  )
);
CREATE INDEX task_epic_management_audit_target_idx
  ON omnis.task_epic_management_audit(task_id, occurred_at DESC);

CREATE FUNCTION omnis.reject_task_epic_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'task epic audit records are immutable' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER task_epic_management_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.task_epic_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_task_epic_audit_mutation();

ALTER TABLE omnis.task_project_management_idempotency
  DROP CONSTRAINT task_project_management_idempotency_operation_check;
ALTER TABLE omnis.task_project_management_idempotency
  ADD CONSTRAINT task_project_management_idempotency_operation_check
  CHECK (operation IN ('task.created', 'task.project_set', 'task.epic_set'));

CREATE OR REPLACE FUNCTION omnis.set_task_project(
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
  IF v_task.project_id IS DISTINCT FROM p_project_id
     AND EXISTS (SELECT 1 FROM omnis.task_epic_associations AS association
                  WHERE association.task_id = p_task_id) THEN
    RAISE EXCEPTION 'unlink the task Epic before changing its project' USING ERRCODE = 'P2003';
  END IF;
  IF EXISTS (SELECT 1 FROM omnis.runs AS run WHERE run.task_id = p_task_id)
     OR EXISTS (
       SELECT 1 FROM omnis.runtime_authorizations AS auth_record
        WHERE auth_record.task_id = p_task_id
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

CREATE FUNCTION omnis.get_task_epic(p_task_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'task Epic reads require the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL OR length(p_task_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'task identifier is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object(
    'taskId', task.id,
    'projectId', task.project_id,
    'epic', CASE WHEN epic.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', epic.id, 'projectId', epic.project_id, 'title', epic.title,
      'description', epic.description, 'status', epic.status, 'revision', epic.revision,
      'archivedAt', CASE WHEN epic.archived_at IS NULL THEN NULL ELSE
        to_char(epic.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'createdAt', to_char(epic.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'updatedAt', to_char(epic.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) END,
    'associationRevision', task.association_revision
  ) INTO v_result
    FROM omnis.tasks AS task
    LEFT JOIN omnis.task_epic_associations AS association ON association.task_id = task.id
    LEFT JOIN omnis.project_epics AS epic
      ON epic.project_id = association.project_id AND epic.id = association.epic_id
   WHERE task.id = p_task_id;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.list_project_epic_tasks(
  p_project_id text, p_epic_id text, p_after_created_at timestamptz,
  p_after_task_id text, p_limit integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'Epic task reads require the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR p_epic_id IS NULL OR p_epic_id !~ '^epc_[0-9a-f]{32}$'
     OR (p_after_created_at IS NULL) <> (p_after_task_id IS NULL)
     OR (p_after_task_id IS NOT NULL AND length(p_after_task_id) NOT BETWEEN 1 AND 128)
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Epic task query is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM omnis.projects WHERE id = p_project_id AND owner_id = 'owner')
     OR NOT EXISTS (SELECT 1 FROM omnis.project_epics
                     WHERE project_id = p_project_id AND id = p_epic_id) THEN
    RAISE EXCEPTION 'project or epic was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH observed AS MATERIALIZED (
    SELECT count(*)::integer AS observed_total
      FROM omnis.task_epic_associations AS association
     WHERE association.project_id = p_project_id AND association.epic_id = p_epic_id
  ), page_rows AS (
    SELECT task.id, task.title, task.status, task.created_at, task.association_revision,
           latest.id AS latest_run_id, latest.status AS latest_run_status,
           latest.created_at AS latest_run_created_at,
           latest.updated_at AS latest_run_updated_at
      FROM omnis.task_epic_associations AS association
      JOIN omnis.tasks AS task ON task.id = association.task_id
      LEFT JOIN LATERAL (
        SELECT run.id, run.status, run.created_at, run.updated_at
          FROM omnis.runs AS run WHERE run.task_id = task.id
         ORDER BY run.created_at DESC, run.id DESC LIMIT 1
      ) AS latest ON true
     WHERE association.project_id = p_project_id AND association.epic_id = p_epic_id
       AND (p_after_created_at IS NULL OR (task.created_at, task.id) < (p_after_created_at, p_after_task_id))
     ORDER BY task.created_at DESC, task.id DESC
     LIMIT p_limit + 1
  )
  SELECT jsonb_build_object(
    'tasks', COALESCE(jsonb_agg(jsonb_build_object(
      'id', page_rows.id, 'title', page_rows.title, 'status', page_rows.status,
      'createdAt', to_char(page_rows.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'projectId', p_project_id, 'associationRevision', page_rows.association_revision,
      'latestRun', CASE WHEN page_rows.latest_run_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', page_rows.latest_run_id, 'status', page_rows.latest_run_status,
        'createdAt', to_char(page_rows.latest_run_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updatedAt', to_char(page_rows.latest_run_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) END
    ) ORDER BY page_rows.created_at DESC, page_rows.id DESC)
      FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb),
    'observedTotal', observed.observed_total
  ) INTO v_result
    FROM observed LEFT JOIN page_rows ON true
   GROUP BY observed.observed_total;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.set_task_epic(
  p_task_id text, p_expected_association_revision integer, p_epic_id text,
  p_request_id uuid, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.task_project_management_idempotency%ROWTYPE;
        v_task omnis.tasks%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_existing_epic_id text;
        v_epic omnis.project_epics%ROWTYPE;
        v_action text;
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'task Epic changes require the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL OR length(p_task_id) NOT BETWEEN 1 AND 128
     OR p_expected_association_revision IS NULL OR p_expected_association_revision < 1
     OR (p_epic_id IS NOT NULL AND p_epic_id !~ '^epc_[0-9a-f]{32}$')
     OR p_request_id IS NULL OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'task Epic input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 2705198701));
  SELECT * INTO v_prior FROM omnis.task_project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'task.epic_set' OR v_prior.task_id <> p_task_id
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'task Epic idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_task FROM omnis.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_task.association_revision <> p_expected_association_revision THEN
    RAISE EXCEPTION 'task association revision conflict' USING ERRCODE = 'P2002';
  END IF;
  IF v_task.project_id IS NULL THEN
    IF p_epic_id IS NOT NULL THEN
      RAISE EXCEPTION 'an unprojected task cannot be assigned to an Epic' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO v_project FROM omnis.projects
     WHERE id = v_task.project_id AND owner_id = 'owner' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002'; END IF;
    IF v_project.status = 'archived' THEN
      RAISE EXCEPTION 'Epic associations cannot change on an archived project' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT epic_id INTO v_existing_epic_id FROM omnis.task_epic_associations
   WHERE task_id = p_task_id;
  IF p_epic_id IS NOT NULL THEN
    IF v_task.project_id IS NULL THEN
      RAISE EXCEPTION 'an unprojected task cannot be assigned to an Epic' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_epic FROM omnis.project_epics
     WHERE project_id = v_task.project_id AND id = p_epic_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Epic was not found in the task project' USING ERRCODE = 'P0002'; END IF;
    IF v_epic.status = 'archived' THEN
      RAISE EXCEPTION 'an archived Epic cannot receive task assignments' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_existing_epic_id IS DISTINCT FROM p_epic_id THEN
    IF p_epic_id IS NULL THEN
      DELETE FROM omnis.task_epic_associations WHERE task_id = p_task_id;
    ELSE
      INSERT INTO omnis.task_epic_associations(task_id, project_id, epic_id)
      VALUES (p_task_id, v_task.project_id, p_epic_id)
      ON CONFLICT (task_id) DO UPDATE
        SET project_id = EXCLUDED.project_id, epic_id = EXCLUDED.epic_id,
            updated_at = clock_timestamp();
    END IF;
    UPDATE omnis.tasks SET association_revision = association_revision + 1
     WHERE id = p_task_id RETURNING * INTO v_task;
    v_action := CASE
      WHEN v_existing_epic_id IS NULL THEN 'assigned'
      WHEN p_epic_id IS NULL THEN 'unassigned'
      ELSE 'reassigned'
    END;
    INSERT INTO omnis.task_epic_management_audit(
      id, task_id, project_id, previous_epic_id, epic_id, actor_id, action, request_id
    ) VALUES (
      'tea_' || replace(gen_random_uuid()::text, '-', ''), p_task_id, v_task.project_id,
      v_existing_epic_id, p_epic_id, 'owner', v_action, p_request_id
    );
  END IF;

  SELECT jsonb_build_object(
    'taskId', v_task.id, 'projectId', v_task.project_id, 'epicId', p_epic_id,
    'associationRevision', v_task.association_revision
  ) INTO v_result;
  INSERT INTO omnis.task_project_management_idempotency(
    request_id, operation, fingerprint, task_id, receipt
  ) VALUES (p_request_id, 'task.epic_set', p_fingerprint, p_task_id, v_result);
  RETURN v_result;
END
$function$;

REVOKE ALL ON omnis.task_epic_associations, omnis.task_epic_management_audit
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.reject_task_epic_audit_mutation()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.get_task_epic(text),
  omnis.list_project_epic_tasks(text,text,timestamptz,text,integer),
  omnis.set_task_epic(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.get_task_epic(text),
  omnis.list_project_epic_tasks(text,text,timestamptz,text,integer),
  omnis.set_task_epic(text,integer,text,uuid,bytea)
  TO omnis_authorizer;

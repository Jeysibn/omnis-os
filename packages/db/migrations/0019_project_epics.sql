CREATE TABLE omnis.project_epics (
  id text PRIMARY KEY CHECK (id ~ '^epc_[0-9a-f]{32}$'),
  project_id text NOT NULL REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'completed', 'archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  CONSTRAINT project_epics_archive_state_check
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX project_epics_project_order_idx
  ON omnis.project_epics(project_id, created_at DESC, id DESC);

CREATE TABLE omnis.project_epic_management_audit (
  id text PRIMARY KEY CHECK (id ~ '^pea_[0-9a-f]{32}$'),
  project_id text NOT NULL,
  epic_id text NOT NULL,
  actor_id text NOT NULL CHECK (actor_id = 'owner'),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'archived')),
  request_id uuid NOT NULL,
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (changed_fields <@ ARRAY['title', 'description', 'status']::text[]),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, epic_id)
    REFERENCES omnis.project_epics(project_id, id) ON DELETE RESTRICT
);
CREATE INDEX project_epic_management_audit_target_idx
  ON omnis.project_epic_management_audit(epic_id, occurred_at DESC);

CREATE FUNCTION omnis.reject_project_epic_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'project epic audit records are immutable' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER project_epic_management_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.project_epic_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_project_epic_audit_mutation();

CREATE FUNCTION omnis.list_project_epics(
  p_project_id text, p_after_created_at timestamptz, p_after_id text, p_limit integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'epic reads require the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR (p_after_created_at IS NULL) <> (p_after_id IS NULL)
     OR (p_after_id IS NOT NULL AND p_after_id !~ '^epc_[0-9a-f]{32}$')
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'epic query is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM omnis.projects WHERE id = p_project_id AND owner_id = 'owner') THEN
    RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH epic_rows AS MATERIALIZED (
    SELECT e.id, e.project_id, e.title, e.description, e.status, e.revision,
           e.archived_at, e.created_at, e.updated_at,
           jsonb_build_object(
             'id', e.id, 'projectId', e.project_id, 'title', e.title,
             'description', e.description, 'status', e.status, 'revision', e.revision,
             'archivedAt', CASE WHEN e.archived_at IS NULL THEN NULL ELSE
               to_char(e.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
             'createdAt', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'updatedAt', to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           ) AS epic
      FROM omnis.project_epics e WHERE e.project_id = p_project_id
  ), page_rows AS (
    SELECT * FROM epic_rows e
     WHERE p_after_created_at IS NULL OR (e.created_at, e.id) < (p_after_created_at, p_after_id)
     ORDER BY e.created_at DESC, e.id DESC LIMIT p_limit + 1
  ), stats AS (
    SELECT count(*)::integer AS observed_total FROM epic_rows
  )
  SELECT jsonb_build_object(
    'epics', COALESCE(jsonb_agg(page_rows.epic ORDER BY page_rows.created_at DESC, page_rows.id DESC)
                      FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb),
    'observedTotal', stats.observed_total
  ) INTO v_result
    FROM stats LEFT JOIN page_rows ON true
   GROUP BY stats.observed_total;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.get_project_epic(p_project_id text, p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'epic reads require the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR p_id IS NULL OR p_id !~ '^epc_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'epic identifier is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM omnis.projects WHERE id = p_project_id AND owner_id = 'owner') THEN
    RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT jsonb_build_object(
    'id', e.id, 'projectId', e.project_id, 'title', e.title,
    'description', e.description, 'status', e.status, 'revision', e.revision,
    'archivedAt', CASE WHEN e.archived_at IS NULL THEN NULL ELSE
      to_char(e.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'createdAt', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) INTO v_result
    FROM omnis.project_epics e
   WHERE e.project_id = p_project_id AND e.id = p_id;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.create_project_epic(
  p_id text, p_project_id text, p_title text, p_description text,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'epic management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_id !~ '^epc_[0-9a-f]{32}$'
     OR p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 120
     OR (p_description IS NOT NULL AND length(p_description) > 2000)
     OR p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'epic create input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'epic.created'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'epic idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_project FROM omnis.projects
   WHERE id = p_project_id AND owner_id = 'owner' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_project.status = 'archived' THEN
    RAISE EXCEPTION 'epics cannot change on an archived project' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id, 615019925));
  IF (SELECT count(*) FROM omnis.project_epics WHERE project_id = p_project_id) >= 500 THEN
    RAISE EXCEPTION 'project epic capacity reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO omnis.project_epics(id, project_id, title, description)
  VALUES (p_id, p_project_id, btrim(p_title), p_description);
  INSERT INTO omnis.project_epic_management_audit
    (id, project_id, epic_id, actor_id, action, request_id, changed_fields)
  VALUES ('pea_' || replace(gen_random_uuid()::text, '-', ''), p_project_id, p_id,
          'owner', 'created', p_request_id, ARRAY['title', 'description']::text[]);
  SELECT jsonb_build_object(
    'id', e.id, 'projectId', e.project_id, 'title', e.title, 'description', e.description,
    'status', e.status, 'revision', e.revision, 'archivedAt', NULL,
    'createdAt', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) INTO v_result FROM omnis.project_epics e WHERE e.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'epic.created', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.update_project_epic(
  p_project_id text, p_id text, p_expected_revision integer,
  p_title text, p_description text, p_description_supplied boolean, p_status text,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_epic omnis.project_epics%ROWTYPE;
        v_changed_fields text[] := ARRAY[]::text[];
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'epic management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR p_id IS NULL OR p_id !~ '^epc_[0-9a-f]{32}$'
     OR p_expected_revision IS NULL OR p_expected_revision < 1
     OR (p_title IS NULL AND NOT p_description_supplied AND p_status IS NULL)
     OR (p_title IS NOT NULL AND length(btrim(p_title)) NOT BETWEEN 1 AND 120)
     OR (p_description IS NOT NULL AND length(p_description) > 2000)
     OR p_description_supplied IS NULL
     OR (p_status IS NOT NULL AND p_status NOT IN ('planned', 'in_progress', 'completed'))
     OR p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'epic update input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'epic.updated'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'epic idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_project FROM omnis.projects
   WHERE id = p_project_id AND owner_id = 'owner' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_project.status = 'archived' THEN
    RAISE EXCEPTION 'epics cannot change on an archived project' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_epic FROM omnis.project_epics
   WHERE project_id = p_project_id AND id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'epic was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_epic.status = 'archived' THEN
    RAISE EXCEPTION 'epic is archived' USING ERRCODE = 'P0001';
  END IF;
  IF v_epic.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'epic revision conflict' USING ERRCODE = '40001';
  END IF;
  IF p_status IS NOT NULL AND p_status <> v_epic.status AND NOT (
       (v_epic.status = 'planned' AND p_status IN ('in_progress', 'completed')) OR
       (v_epic.status = 'in_progress' AND p_status = 'completed')
     ) THEN
    RAISE EXCEPTION 'epic lifecycle transition is invalid' USING ERRCODE = 'P0001';
  END IF;

  IF p_title IS NOT NULL AND p_title IS DISTINCT FROM v_epic.title THEN
    v_changed_fields := array_append(v_changed_fields, 'title');
  END IF;
  IF p_description_supplied AND p_description IS DISTINCT FROM v_epic.description THEN
    v_changed_fields := array_append(v_changed_fields, 'description');
  END IF;
  IF p_status IS NOT NULL AND p_status IS DISTINCT FROM v_epic.status THEN
    v_changed_fields := array_append(v_changed_fields, 'status');
  END IF;
  IF cardinality(v_changed_fields) = 0 THEN
    RAISE EXCEPTION 'epic update has no changes' USING ERRCODE = '22023';
  END IF;

  UPDATE omnis.project_epics
     SET title = COALESCE(btrim(p_title), title),
         description = CASE WHEN p_description_supplied THEN p_description ELSE description END,
         status = COALESCE(p_status, status),
         revision = revision + 1,
         updated_at = clock_timestamp()
   WHERE project_id = p_project_id AND id = p_id RETURNING * INTO v_epic;
  INSERT INTO omnis.project_epic_management_audit
    (id, project_id, epic_id, actor_id, action, request_id, changed_fields)
  VALUES ('pea_' || replace(gen_random_uuid()::text, '-', ''), p_project_id, p_id,
          'owner', 'updated', p_request_id, v_changed_fields);
  SELECT jsonb_build_object(
    'id', e.id, 'projectId', e.project_id, 'title', e.title, 'description', e.description,
    'status', e.status, 'revision', e.revision, 'archivedAt', NULL,
    'createdAt', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) INTO v_result FROM omnis.project_epics e WHERE e.project_id = p_project_id AND e.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'epic.updated', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.archive_project_epic(
  p_project_id text, p_id text, p_expected_revision integer,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_epic omnis.project_epics%ROWTYPE;
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'epic management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR p_id IS NULL OR p_id !~ '^epc_[0-9a-f]{32}$'
     OR p_expected_revision IS NULL OR p_expected_revision < 1
     OR p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'epic archive input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'epic.archived'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'epic idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_project FROM omnis.projects
   WHERE id = p_project_id AND owner_id = 'owner' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_project.status = 'archived' THEN
    RAISE EXCEPTION 'epics cannot change on an archived project' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_epic FROM omnis.project_epics
   WHERE project_id = p_project_id AND id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'epic was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_epic.status = 'archived' THEN
    RAISE EXCEPTION 'epic is already archived' USING ERRCODE = 'P0001';
  END IF;
  IF v_epic.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'epic revision conflict' USING ERRCODE = '40001';
  END IF;

  UPDATE omnis.project_epics
     SET status = 'archived', archived_at = clock_timestamp(), revision = revision + 1,
         updated_at = clock_timestamp()
   WHERE project_id = p_project_id AND id = p_id RETURNING * INTO v_epic;
  INSERT INTO omnis.project_epic_management_audit
    (id, project_id, epic_id, actor_id, action, request_id, changed_fields)
  VALUES ('pea_' || replace(gen_random_uuid()::text, '-', ''), p_project_id, p_id,
          'owner', 'archived', p_request_id, ARRAY['status']::text[]);
  SELECT jsonb_build_object(
    'id', e.id, 'projectId', e.project_id, 'title', e.title, 'description', e.description,
    'status', e.status, 'revision', e.revision,
    'archivedAt', to_char(e.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'createdAt', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) INTO v_result FROM omnis.project_epics e WHERE e.project_id = p_project_id AND e.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'epic.archived', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION omnis.reject_project_epic_audit_mutation()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON omnis.project_epics, omnis.project_epic_management_audit
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.list_project_epics(text, timestamptz, text, integer),
  omnis.get_project_epic(text, text),
  omnis.create_project_epic(text, text, text, text, uuid, integer, bytea),
  omnis.update_project_epic(text, text, integer, text, text, boolean, text, uuid, integer, bytea),
  omnis.archive_project_epic(text, text, integer, uuid, integer, bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.list_project_epics(text, timestamptz, text, integer),
  omnis.get_project_epic(text, text),
  omnis.create_project_epic(text, text, text, text, uuid, integer, bytea),
  omnis.update_project_epic(text, text, integer, text, text, boolean, text, uuid, integer, bytea),
  omnis.archive_project_epic(text, text, integer, uuid, integer, bytea)
  TO omnis_authorizer;

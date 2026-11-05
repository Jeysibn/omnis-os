CREATE TABLE omnis.project_milestones (
  id text PRIMARY KEY CHECK (id ~ '^mil_[0-9a-f]{32}$'),
  project_id text NOT NULL REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'completed', 'archived')),
  target_date date,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, id),
  CONSTRAINT project_milestones_archive_state_check
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX project_milestones_project_order_idx
  ON omnis.project_milestones(project_id, created_at DESC, id DESC);

CREATE TABLE omnis.project_milestone_management_audit (
  id text PRIMARY KEY CHECK (id ~ '^pma_[0-9a-f]{32}$'),
  project_id text NOT NULL,
  milestone_id text NOT NULL,
  FOREIGN KEY (project_id, milestone_id)
    REFERENCES omnis.project_milestones(project_id, id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (actor_id = 'owner'),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'archived')),
  request_id uuid NOT NULL,
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (changed_fields <@ ARRAY['title', 'description', 'targetDate', 'status']::text[]),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX project_milestone_management_audit_target_idx
  ON omnis.project_milestone_management_audit(milestone_id, occurred_at DESC);

CREATE FUNCTION omnis.reject_project_milestone_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'project milestone audit records are immutable' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER project_milestone_management_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.project_milestone_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_project_milestone_audit_mutation();

CREATE FUNCTION omnis.list_project_milestones(
  p_project_id text, p_after_created_at timestamptz, p_after_id text, p_limit integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'milestone reads require the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR (p_after_created_at IS NULL) <> (p_after_id IS NULL)
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'milestone query is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM omnis.projects WHERE id = p_project_id AND owner_id = 'owner') THEN
    RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH milestone_rows AS MATERIALIZED (
    SELECT m.id, m.project_id, m.title, m.description, m.status, m.target_date, m.revision,
           m.archived_at, m.created_at, m.updated_at,
           jsonb_build_object(
             'id', m.id, 'projectId', m.project_id, 'title', m.title,
             'description', m.description, 'status', m.status,
             'targetDate', m.target_date, 'revision', m.revision,
             'archivedAt', CASE WHEN m.archived_at IS NULL THEN NULL ELSE
               to_char(m.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
             'createdAt', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'updatedAt', to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           ) AS milestone
      FROM omnis.project_milestones m WHERE m.project_id = p_project_id
  ), page_rows AS (
    SELECT * FROM milestone_rows m
     WHERE p_after_created_at IS NULL OR (m.created_at, m.id) < (p_after_created_at, p_after_id)
     ORDER BY m.created_at DESC, m.id DESC LIMIT p_limit + 1
  ), stats AS (
    SELECT count(*)::integer AS observed_total FROM milestone_rows
  )
  SELECT jsonb_build_object(
    'milestones', COALESCE(jsonb_agg(page_rows.milestone ORDER BY page_rows.created_at DESC, page_rows.id DESC)
                            FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb),
    'observedTotal', stats.observed_total
  ) INTO v_result
    FROM stats LEFT JOIN page_rows ON true
   GROUP BY stats.observed_total;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.get_project_milestone(p_project_id text, p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'milestone reads require the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'milestone identifier is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM omnis.projects WHERE id = p_project_id AND owner_id = 'owner') THEN
    RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT jsonb_build_object(
    'id', m.id, 'projectId', m.project_id, 'title', m.title,
    'description', m.description, 'status', m.status, 'targetDate', m.target_date,
    'revision', m.revision,
    'archivedAt', CASE WHEN m.archived_at IS NULL THEN NULL ELSE
      to_char(m.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'createdAt', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) INTO v_result
    FROM omnis.project_milestones m
   WHERE m.project_id = p_project_id AND m.id = p_id;
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.create_project_milestone(
  p_id text, p_project_id text, p_title text, p_description text, p_target_date date,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'milestone management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_id !~ '^mil_[0-9a-f]{32}$'
     OR p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 120
     OR (p_description IS NOT NULL AND length(p_description) > 2000)
     OR p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'milestone create input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'milestone.created'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'milestone idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_project FROM omnis.projects
   WHERE id = p_project_id AND owner_id = 'owner' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_project.status = 'archived' THEN
    RAISE EXCEPTION 'milestones cannot change on an archived project' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id, 615019924));
  IF (SELECT count(*) FROM omnis.project_milestones WHERE project_id = p_project_id) >= 500 THEN
    RAISE EXCEPTION 'project milestone capacity reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO omnis.project_milestones(id, project_id, title, description, target_date)
  VALUES (p_id, p_project_id, p_title, p_description, p_target_date);
  INSERT INTO omnis.project_milestone_management_audit
    (id, project_id, milestone_id, actor_id, action, request_id, changed_fields)
  VALUES ('pma_' || replace(gen_random_uuid()::text, '-', ''), p_project_id, p_id,
          'owner', 'created', p_request_id, ARRAY['title', 'description', 'targetDate']::text[]);
  SELECT jsonb_build_object(
    'id', m.id, 'projectId', m.project_id, 'title', m.title, 'description', m.description,
    'status', m.status, 'targetDate', m.target_date, 'revision', m.revision, 'archivedAt', NULL,
    'createdAt', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) INTO v_result FROM omnis.project_milestones m WHERE m.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'milestone.created', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.update_project_milestone(
  p_project_id text, p_id text, p_expected_revision integer,
  p_title text, p_description text, p_description_supplied boolean,
  p_target_date date, p_target_date_supplied boolean, p_status text,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_milestone omnis.project_milestones%ROWTYPE;
        v_changed_fields text[] := ARRAY[]::text[];
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'milestone management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR p_id IS NULL OR p_id !~ '^mil_[0-9a-f]{32}$'
     OR p_expected_revision IS NULL OR p_expected_revision < 1
     OR (p_title IS NULL AND NOT p_description_supplied AND NOT p_target_date_supplied AND p_status IS NULL)
     OR (p_title IS NOT NULL AND length(btrim(p_title)) NOT BETWEEN 1 AND 120)
     OR (p_description IS NOT NULL AND length(p_description) > 2000)
     OR (p_status IS NOT NULL AND p_status NOT IN ('planned', 'in_progress', 'completed'))
     OR p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'milestone update input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'milestone.updated'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'milestone idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_project FROM omnis.projects
   WHERE id = p_project_id AND owner_id = 'owner' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_project.status = 'archived' THEN
    RAISE EXCEPTION 'milestones cannot change on an archived project' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_milestone FROM omnis.project_milestones
   WHERE project_id = p_project_id AND id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'milestone was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_milestone.status = 'archived' THEN
    RAISE EXCEPTION 'archived milestone cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF v_milestone.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'milestone revision conflict' USING ERRCODE = '40001';
  END IF;
  IF p_status IS NOT NULL AND p_status IS DISTINCT FROM v_milestone.status
     AND NOT ((v_milestone.status = 'planned' AND p_status IN ('in_progress', 'completed'))
       OR (v_milestone.status = 'in_progress' AND p_status = 'completed')) THEN
    RAISE EXCEPTION 'milestone status transition is invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_title IS NOT NULL AND p_title IS DISTINCT FROM v_milestone.title THEN
    v_changed_fields := array_append(v_changed_fields, 'title');
  END IF;
  IF p_description_supplied AND p_description IS DISTINCT FROM v_milestone.description THEN
    v_changed_fields := array_append(v_changed_fields, 'description');
  END IF;
  IF p_target_date_supplied AND p_target_date IS DISTINCT FROM v_milestone.target_date THEN
    v_changed_fields := array_append(v_changed_fields, 'targetDate');
  END IF;
  IF p_status IS NOT NULL AND p_status IS DISTINCT FROM v_milestone.status THEN
    v_changed_fields := array_append(v_changed_fields, 'status');
  END IF;
  IF cardinality(v_changed_fields) > 0 THEN
    UPDATE omnis.project_milestones
       SET title = COALESCE(p_title, title),
           description = CASE WHEN p_description_supplied THEN p_description ELSE description END,
           target_date = CASE WHEN p_target_date_supplied THEN p_target_date ELSE target_date END,
           status = COALESCE(p_status, status), revision = revision + 1, updated_at = clock_timestamp()
     WHERE project_id = p_project_id AND id = p_id;
    INSERT INTO omnis.project_milestone_management_audit
      (id, project_id, milestone_id, actor_id, action, request_id, changed_fields)
    VALUES ('pma_' || replace(gen_random_uuid()::text, '-', ''), p_project_id, p_id,
            'owner', 'updated', p_request_id, v_changed_fields);
  END IF;
  SELECT jsonb_build_object(
    'id', m.id, 'projectId', m.project_id, 'title', m.title, 'description', m.description,
    'status', m.status, 'targetDate', m.target_date, 'revision', m.revision,
    'archivedAt', CASE WHEN m.archived_at IS NULL THEN NULL ELSE
      to_char(m.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'createdAt', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) INTO v_result FROM omnis.project_milestones m WHERE m.project_id = p_project_id AND m.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'milestone.updated', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.archive_project_milestone(
  p_project_id text, p_id text, p_expected_revision integer,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_milestone omnis.project_milestones%ROWTYPE;
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'milestone management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NULL OR p_project_id !~ '^prj_[0-9a-f]{32}$'
     OR p_id IS NULL OR p_id !~ '^mil_[0-9a-f]{32}$'
     OR p_expected_revision IS NULL OR p_expected_revision < 1
     OR p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'milestone archive input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'milestone.archived'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'milestone idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_project FROM omnis.projects
   WHERE id = p_project_id AND owner_id = 'owner' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_project.status = 'archived' THEN
    RAISE EXCEPTION 'milestones cannot change on an archived project' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_milestone FROM omnis.project_milestones
   WHERE project_id = p_project_id AND id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'milestone was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_milestone.status = 'archived' THEN
    RAISE EXCEPTION 'milestone is already archived' USING ERRCODE = 'P0001';
  END IF;
  IF v_milestone.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'milestone revision conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE omnis.project_milestones
     SET status = 'archived', archived_at = clock_timestamp(), revision = revision + 1,
         updated_at = clock_timestamp()
   WHERE project_id = p_project_id AND id = p_id RETURNING * INTO v_milestone;
  INSERT INTO omnis.project_milestone_management_audit
    (id, project_id, milestone_id, actor_id, action, request_id, changed_fields)
  VALUES ('pma_' || replace(gen_random_uuid()::text, '-', ''), p_project_id, p_id,
          'owner', 'archived', p_request_id, ARRAY['status']::text[]);
  SELECT jsonb_build_object(
    'id', m.id, 'projectId', m.project_id, 'title', m.title, 'description', m.description,
    'status', m.status, 'targetDate', m.target_date, 'revision', m.revision,
    'archivedAt', to_char(m.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'createdAt', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) INTO v_result FROM omnis.project_milestones m WHERE m.project_id = p_project_id AND m.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'milestone.archived', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION omnis.reject_project_milestone_audit_mutation()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON omnis.project_milestones, omnis.project_milestone_management_audit
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.list_project_milestones(text, timestamptz, text, integer),
  omnis.get_project_milestone(text, text),
  omnis.create_project_milestone(text, text, text, text, date, uuid, integer, bytea),
  omnis.update_project_milestone(text, text, integer, text, text, boolean, date, boolean, text, uuid, integer, bytea),
  omnis.archive_project_milestone(text, text, integer, uuid, integer, bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.list_project_milestones(text, timestamptz, text, integer),
  omnis.get_project_milestone(text, text),
  omnis.create_project_milestone(text, text, text, text, date, uuid, integer, bytea),
  omnis.update_project_milestone(text, text, integer, text, text, boolean, date, boolean, text, uuid, integer, bytea)
  TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.archive_project_milestone(text, text, integer, uuid, integer, bytea)
  TO omnis_authorizer;

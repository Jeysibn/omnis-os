ALTER TABLE omnis.projects
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);

ALTER TABLE omnis.project_management_audit
  DROP CONSTRAINT project_management_audit_action_check,
  ADD COLUMN changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD CONSTRAINT project_management_audit_action_check
    CHECK (action IN ('created', 'updated', 'archived')),
  ADD CONSTRAINT project_management_audit_changed_fields_check
    CHECK (changed_fields <@ ARRAY['key', 'name', 'objective', 'priority']::text[]);

-- Existing create receipts represent revision 1 and must satisfy the expanded strict response schema.
UPDATE omnis.project_management_idempotency AS receipt
   SET receipt = receipt.receipt || jsonb_build_object('revision', project.revision)
  FROM omnis.projects AS project
 WHERE receipt.operation = 'project.created'
   AND receipt.receipt ->> 'id' = project.id
   AND NOT (receipt.receipt ? 'revision');

CREATE OR REPLACE FUNCTION omnis.create_project(
  p_id text, p_key text, p_name text, p_objective text, p_priority text,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'project management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'project idempotency data is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'project.created'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'project idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  PERFORM pg_advisory_xact_lock(716824201315);
  IF (SELECT count(*) FROM omnis.projects WHERE owner_id = 'owner') >= 500 THEN
    RAISE EXCEPTION 'project directory capacity reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO omnis.projects(id, owner_id, project_key, name, objective_md, priority)
  VALUES (p_id, 'owner', p_key, p_name, p_objective, p_priority);
  INSERT INTO omnis.project_management_audit
    (id, project_id, actor_id, action, request_id, changed_fields)
  VALUES (
    'pma_' || replace(gen_random_uuid()::text, '-', ''), p_id, 'owner', 'created', p_request_id,
    ARRAY['key', 'name', 'objective', 'priority']::text[]
  );
  SELECT jsonb_build_object(
    'id', p.id, 'ownerId', p.owner_id, 'key', p.project_key, 'name', p.name,
    'objective', p.objective_md, 'status', p.status, 'priority', p.priority,
    'revision', p.revision,
    'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO v_result FROM omnis.projects AS p WHERE p.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'project.created', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION omnis.list_projects()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_total integer;
        v_projects jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'project reads require the authorizer role' USING ERRCODE = '42501';
  END IF;
  WITH project_rows AS MATERIALIZED (
    SELECT p.id, p.created_at, jsonb_build_object(
      'id', p.id, 'ownerId', p.owner_id, 'key', p.project_key, 'name', p.name,
      'status', p.status, 'priority', p.priority, 'revision', p.revision,
      'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) AS project
    FROM omnis.projects p WHERE p.owner_id = 'owner'
  ), stats AS (
    SELECT count(*)::integer AS total FROM project_rows
  ), project_list AS (
    SELECT COALESCE(jsonb_agg(project ORDER BY created_at, id), '[]'::jsonb) AS projects
      FROM project_rows
  )
  SELECT stats.total, project_list.projects INTO v_total, v_projects
    FROM stats CROSS JOIN project_list;
  IF v_total > 500 THEN
    RAISE EXCEPTION 'project directory capacity exceeded' USING ERRCODE = '54000';
  END IF;
  RETURN jsonb_build_object('projects', v_projects, 'total', v_total, 'complete', true);
END
$function$;

CREATE OR REPLACE FUNCTION omnis.get_project(p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'project reads require the authorizer role' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'id', p.id, 'ownerId', p.owner_id, 'key', p.project_key, 'name', p.name,
    'objective', p.objective_md, 'status', p.status, 'priority', p.priority,
    'revision', p.revision,
    'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO v_result FROM omnis.projects p WHERE p.id = p_id AND p.owner_id = 'owner';
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.update_project(
  p_id text, p_expected_revision integer, p_name text, p_objective text, p_priority text,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_changed_fields text[] := ARRAY[]::text[];
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'project management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1
     OR (p_name IS NULL AND p_objective IS NULL AND p_priority IS NULL)
     OR p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'project update input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'project.updated'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'project idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_project FROM omnis.projects
   WHERE id = p_id AND owner_id = 'owner' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_project.status = 'archived' THEN
    RAISE EXCEPTION 'archived project cannot be edited' USING ERRCODE = 'P0001';
  END IF;
  IF v_project.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'project revision conflict' USING ERRCODE = '40001';
  END IF;
  IF p_name IS NOT NULL AND p_name IS DISTINCT FROM v_project.name THEN
    v_changed_fields := array_append(v_changed_fields, 'name');
  END IF;
  IF p_objective IS NOT NULL AND p_objective IS DISTINCT FROM v_project.objective_md THEN
    v_changed_fields := array_append(v_changed_fields, 'objective');
  END IF;
  IF p_priority IS NOT NULL AND p_priority IS DISTINCT FROM v_project.priority THEN
    v_changed_fields := array_append(v_changed_fields, 'priority');
  END IF;
  IF cardinality(v_changed_fields) = 0 THEN
    SELECT jsonb_build_object(
      'id', p.id, 'ownerId', p.owner_id, 'key', p.project_key, 'name', p.name,
      'objective', p.objective_md, 'status', p.status, 'priority', p.priority,
      'revision', p.revision,
      'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) INTO v_result FROM omnis.projects AS p WHERE p.id = p_id;
    INSERT INTO omnis.project_management_idempotency
      (request_id, operation, fingerprint_version, fingerprint, receipt)
    VALUES (p_request_id, 'project.updated', p_fingerprint_version, p_fingerprint, v_result);
    RETURN v_result;
  END IF;

  UPDATE omnis.projects
     SET name = COALESCE(p_name, name),
         objective_md = COALESCE(p_objective, objective_md),
         priority = COALESCE(p_priority, priority),
         revision = revision + 1,
         updated_at = clock_timestamp()
   WHERE id = p_id AND owner_id = 'owner'
   RETURNING * INTO v_project;
  INSERT INTO omnis.project_management_audit
    (id, project_id, actor_id, action, request_id, changed_fields)
  VALUES (
    'pma_' || replace(gen_random_uuid()::text, '-', ''), p_id, 'owner', 'updated', p_request_id,
    v_changed_fields
  );
  SELECT jsonb_build_object(
    'id', p.id, 'ownerId', p.owner_id, 'key', p.project_key, 'name', p.name,
    'objective', p.objective_md, 'status', p.status, 'priority', p.priority,
    'revision', p.revision,
    'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO v_result FROM omnis.projects AS p WHERE p.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'project.updated', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.archive_project(
  p_id text, p_expected_revision integer, p_request_id uuid,
  p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_prior omnis.project_management_idempotency%ROWTYPE;
        v_project omnis.projects%ROWTYPE;
        v_result jsonb;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'project management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1
     OR p_request_id IS NULL OR p_fingerprint_version IS NULL OR p_fingerprint_version < 1
     OR p_fingerprint IS NULL OR octet_length(p_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'project archive input is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 615019923));
  SELECT * INTO v_prior FROM omnis.project_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.operation <> 'project.archived'
       OR v_prior.fingerprint_version <> p_fingerprint_version
       OR v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'project idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.receipt;
  END IF;

  SELECT * INTO v_project FROM omnis.projects
   WHERE id = p_id AND owner_id = 'owner' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_project.status = 'archived' THEN
    RAISE EXCEPTION 'project is already archived' USING ERRCODE = 'P0001';
  END IF;
  IF v_project.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'project revision conflict' USING ERRCODE = '40001';
  END IF;

  UPDATE omnis.projects
     SET status = 'archived', revision = revision + 1, updated_at = clock_timestamp()
   WHERE id = p_id AND owner_id = 'owner'
   RETURNING * INTO v_project;
  INSERT INTO omnis.project_management_audit
    (id, project_id, actor_id, action, request_id, changed_fields)
  VALUES (
    'pma_' || replace(gen_random_uuid()::text, '-', ''), p_id, 'owner', 'archived', p_request_id,
    ARRAY[]::text[]
  );
  SELECT jsonb_build_object(
    'id', p.id, 'ownerId', p.owner_id, 'key', p.project_key, 'name', p.name,
    'objective', p.objective_md, 'status', p.status, 'priority', p.priority,
    'revision', p.revision,
    'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO v_result FROM omnis.projects AS p WHERE p.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'project.archived', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION omnis.update_project(text, integer, text, text, text, uuid, integer, bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.archive_project(text, integer, uuid, integer, bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.update_project(text, integer, text, text, text, uuid, integer, bytea)
  TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.archive_project(text, integer, uuid, integer, bytea)
  TO omnis_authorizer;

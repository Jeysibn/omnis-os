CREATE TABLE omnis.projects (
  id text PRIMARY KEY CHECK (id ~ '^prj_[0-9a-f]{32}$'),
  owner_id text NOT NULL CHECK (owner_id = 'owner'),
  project_key text NOT NULL CHECK (project_key ~ '^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$' AND length(project_key) <= 32),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  objective_md text NOT NULL CHECK (length(btrim(objective_md)) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'active', 'paused', 'completed', 'archived')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, project_key)
);

CREATE INDEX projects_owner_order_idx ON omnis.projects(owner_id, created_at, id);

CREATE TABLE omnis.project_management_audit (
  id text PRIMARY KEY CHECK (id ~ '^pma_[0-9a-f]{32}$'),
  project_id text NOT NULL REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (actor_id = 'owner'),
  action text NOT NULL CHECK (action = 'created'),
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_management_audit_target_idx
  ON omnis.project_management_audit(project_id, occurred_at DESC);

CREATE FUNCTION omnis.reject_project_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'project management audit records are immutable' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER project_management_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.project_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_project_audit_mutation();

CREATE TABLE omnis.project_management_idempotency (
  request_id uuid PRIMARY KEY,
  operation text NOT NULL,
  fingerprint_version integer NOT NULL CHECK (fingerprint_version > 0),
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION omnis.create_project(
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
  INSERT INTO omnis.project_management_audit(id, project_id, actor_id, action, request_id)
  VALUES ('pma_' || replace(gen_random_uuid()::text, '-', ''), p_id, 'owner', 'created', p_request_id);
  SELECT jsonb_build_object(
    'id', p.id, 'ownerId', p.owner_id, 'key', p.project_key, 'name', p.name,
    'objective', p.objective_md, 'status', p.status, 'priority', p.priority,
    'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO v_result FROM omnis.projects AS p WHERE p.id = p_id;
  INSERT INTO omnis.project_management_idempotency
    (request_id, operation, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, 'project.created', p_fingerprint_version, p_fingerprint, v_result);
  RETURN v_result;
END
$function$;

CREATE FUNCTION omnis.list_projects()
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
      'objective', p.objective_md, 'status', p.status, 'priority', p.priority,
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

CREATE FUNCTION omnis.get_project(p_id text)
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
    'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO v_result FROM omnis.projects p WHERE p.id = p_id AND p.owner_id = 'owner';
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION omnis.reject_project_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.create_project(text, text, text, text, text, uuid, integer, bytea)
  FROM PUBLIC, omnis_runtime, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.list_projects() FROM PUBLIC, omnis_runtime, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.get_project(text) FROM PUBLIC, omnis_runtime, omnis_launcher;
REVOKE ALL ON omnis.projects, omnis.project_management_audit, omnis.project_management_idempotency
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.create_project(text, text, text, text, text, uuid, integer, bytea)
  TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.list_projects() TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.get_project(text) TO omnis_authorizer;

ALTER TABLE omnis.departments
  ADD COLUMN archived_at timestamptz;

CREATE TABLE omnis.department_management_audit (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'),
  department_id text NOT NULL REFERENCES omnis.departments(id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (actor_id = 'owner'),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'archived')),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX department_management_audit_target_idx
  ON omnis.department_management_audit(department_id, occurred_at DESC);

CREATE FUNCTION omnis.reject_department_management_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'department management audit records are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER department_management_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.department_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_department_management_audit_mutation();

CREATE FUNCTION omnis.assert_agent_department_active()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
DECLARE
  v_archived_at timestamptz;
BEGIN
  IF NEW.department_id IS NULL THEN RETURN NEW; END IF;
  SELECT archived_at INTO v_archived_at
    FROM omnis.departments
   WHERE id = NEW.department_id AND owner_id = NEW.owner_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent department does not exist for this owner'
      USING ERRCODE = '23503';
  END IF;
  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'archived departments cannot be assigned to agents'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION omnis.guard_department_lifecycle()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'archived departments are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.archived_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM omnis.agents WHERE department_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'departments assigned to agents cannot be archived'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER agents_require_active_department
  BEFORE INSERT OR UPDATE OF department_id, owner_id ON omnis.agents
  FOR EACH ROW EXECUTE FUNCTION omnis.assert_agent_department_active();
CREATE TRIGGER departments_archive_only_when_unreferenced
  BEFORE UPDATE ON omnis.departments
  FOR EACH ROW EXECUTE FUNCTION omnis.guard_department_lifecycle();

CREATE FUNCTION omnis.archive_department(p_department_id text, p_request_id text)
RETURNS TABLE (
  id text,
  slug text,
  name text,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE
  v_department omnis.departments%ROWTYPE;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'department archive requires the authorizer database role'
      USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'department audit request identifier is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_department
    FROM omnis.departments AS department
   WHERE department.id = p_department_id AND department.owner_id = 'owner'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'department was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_department.archived_at IS NOT NULL THEN
    RETURN QUERY SELECT v_department.id, v_department.slug, v_department.name,
                        v_department.archived_at, v_department.created_at, v_department.updated_at;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM omnis.agents WHERE department_id = v_department.id) THEN
    RAISE EXCEPTION 'a department assigned to an agent cannot be archived'
      USING ERRCODE = '23514';
  END IF;
  UPDATE omnis.departments AS department
     SET archived_at = now(), updated_at = now()
   WHERE department.id = v_department.id
   RETURNING department.* INTO v_department;
  INSERT INTO omnis.department_management_audit
    (id, department_id, actor_id, action, request_id)
  VALUES ('dpa_' || replace(gen_random_uuid()::text, '-', ''),
          v_department.id, 'owner', 'archived', p_request_id);
  RETURN QUERY SELECT v_department.id, v_department.slug, v_department.name,
                      v_department.archived_at, v_department.created_at, v_department.updated_at;
END
$function$;

REVOKE ALL ON FUNCTION omnis.reject_department_management_audit_mutation()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.assert_agent_department_active()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.guard_department_lifecycle()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.archive_department(text, text)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON omnis.department_management_audit
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON omnis.departments FROM omnis_authorizer;
GRANT SELECT ON omnis.departments TO omnis_authorizer;
GRANT INSERT (id, slug, name) ON omnis.departments TO omnis_authorizer;
GRANT UPDATE (slug, name, updated_at) ON omnis.departments TO omnis_authorizer;
GRANT INSERT (id, department_id, actor_id, action, request_id)
  ON omnis.department_management_audit TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.archive_department(text, text) TO omnis_authorizer;

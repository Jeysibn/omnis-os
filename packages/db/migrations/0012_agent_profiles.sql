CREATE FUNCTION omnis.is_bounded_string_array(p_value jsonb, p_max_items integer, p_max_chars integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, omnis AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_value) <> 'array' THEN false
    WHEN jsonb_array_length(p_value) > p_max_items THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_value) AS item(value)
       WHERE jsonb_typeof(item.value) <> 'string'
          OR char_length(item.value #>> '{}') < 1
          OR char_length(item.value #>> '{}') > p_max_chars
    )
  END
$function$;

CREATE TABLE omnis.departments (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'),
  owner_id text NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  slug varchar(80) NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name varchar(120) NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug),
  UNIQUE (id, owner_id)
);

CREATE TABLE omnis.agents (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'),
  owner_id text NOT NULL DEFAULT 'owner' CHECK (owner_id = 'owner'),
  department_id text,
  name varchar(120) NOT NULL CHECK (length(btrim(name)) > 0),
  slug varchar(80) NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('draft', 'available', 'archived')),
  archived_at timestamptz,
  current_version_no integer,
  provenance text NOT NULL CHECK (provenance IN ('owner_created', 'demo_seed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL)),
  CHECK ((lifecycle = 'draft') = (current_version_no IS NULL)),
  UNIQUE (owner_id, slug),
  UNIQUE (id, owner_id),
  FOREIGN KEY (department_id, owner_id)
    REFERENCES omnis.departments(id, owner_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE omnis.agent_profile_versions (
  version_id text PRIMARY KEY CHECK (version_id ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'),
  agent_id text NOT NULL REFERENCES omnis.agents(id) ON DELETE RESTRICT,
  version_no integer NOT NULL CHECK (version_no > 0),
  profession varchar(160) NOT NULL CHECK (length(btrim(profession)) > 0),
  seniority varchar(80),
  specialties jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (omnis.is_bounded_string_array(specialties, 32, 100)),
  personality jsonb NOT NULL DEFAULT '{"traits":[],"tone":null,"principles":[]}'::jsonb
    CHECK (jsonb_typeof(personality) = 'object'
      AND personality ?& ARRAY['traits', 'tone', 'principles']
      AND personality - ARRAY['traits', 'tone', 'principles'] = '{}'::jsonb
      AND omnis.is_bounded_string_array(personality->'traits', 32, 100)
      AND omnis.is_bounded_string_array(personality->'principles', 32, 240)
      AND (personality->'tone' = 'null'::jsonb OR
        (jsonb_typeof(personality->'tone') = 'string' AND char_length(personality->>'tone') <= 120))),
  behavior jsonb NOT NULL DEFAULT '{"autonomy":null,"escalation":null}'::jsonb
    CHECK (jsonb_typeof(behavior) = 'object'
      AND behavior ?& ARRAY['autonomy', 'escalation']
      AND behavior - ARRAY['autonomy', 'escalation'] = '{}'::jsonb
      AND (behavior->'autonomy' = 'null'::jsonb OR
        (jsonb_typeof(behavior->'autonomy') = 'string' AND char_length(behavior->>'autonomy') <= 500))
      AND (behavior->'escalation' = 'null'::jsonb OR
        (jsonb_typeof(behavior->'escalation') = 'string' AND char_length(behavior->>'escalation') <= 1000))),
  instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 16384),
  created_by_id text NOT NULL DEFAULT 'owner' CHECK (created_by_id = 'owner'),
  created_by_display_name varchar(120) NOT NULL DEFAULT 'Director'
    CHECK (length(btrim(created_by_display_name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version_no)
);

ALTER TABLE omnis.agents
  ADD CONSTRAINT agents_current_version_fk
  FOREIGN KEY (id, current_version_no)
  REFERENCES omnis.agent_profile_versions(agent_id, version_no)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX agent_profile_versions_history_idx
  ON omnis.agent_profile_versions(agent_id, version_no DESC);

CREATE FUNCTION omnis.reject_agent_profile_version_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'published agent profile versions are immutable; agents and departments are archival-only'
    USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER agent_profile_versions_immutable
  BEFORE UPDATE OR DELETE ON omnis.agent_profile_versions
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_agent_profile_version_mutation();
CREATE TRIGGER agents_archive_instead_of_delete
  BEFORE DELETE ON omnis.agents
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_agent_profile_version_mutation();
CREATE TRIGGER departments_restrict_delete
  BEFORE DELETE ON omnis.departments
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_agent_profile_version_mutation();

CREATE FUNCTION omnis.assert_agent_profile_version_head()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
DECLARE
  v_agent_id text;
  v_current integer;
  v_lifecycle text;
  v_latest integer;
  v_count integer;
BEGIN
  IF TG_TABLE_NAME = 'agents' THEN
    v_agent_id := COALESCE(NEW.id, OLD.id);
  ELSE
    v_agent_id := COALESCE(NEW.agent_id, OLD.agent_id);
  END IF;
  SELECT lifecycle, current_version_no INTO v_lifecycle, v_current
    FROM omnis.agents WHERE id = v_agent_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT max(version_no), count(*)::int INTO v_latest, v_count
    FROM omnis.agent_profile_versions WHERE agent_id = v_agent_id;
  IF (v_lifecycle = 'draft' AND (v_current IS NOT NULL OR v_latest IS NOT NULL)) OR
     (v_lifecycle <> 'draft' AND
       (v_current IS NULL OR v_latest IS DISTINCT FROM v_current OR v_count IS DISTINCT FROM v_latest)) THEN
    RAISE EXCEPTION 'agent lifecycle and published profile head are inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER agents_profile_head_consistent
  AFTER INSERT OR UPDATE ON omnis.agents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION omnis.assert_agent_profile_version_head();
CREATE CONSTRAINT TRIGGER versions_profile_head_consistent
  AFTER INSERT ON omnis.agent_profile_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION omnis.assert_agent_profile_version_head();

REVOKE ALL ON FUNCTION omnis.is_bounded_string_array(jsonb, integer, integer)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.reject_agent_profile_version_mutation()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.assert_agent_profile_version_head()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON omnis.departments, omnis.agents, omnis.agent_profile_versions
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT SELECT ON omnis.departments, omnis.agents, omnis.agent_profile_versions TO omnis_runtime;

ALTER TABLE omnis.agents
  ADD COLUMN draft_revision bigint NOT NULL DEFAULT 0
    CHECK (draft_revision BETWEEN 0 AND 9007199254740991);

CREATE TABLE omnis.agent_profile_drafts (
  agent_id text PRIMARY KEY REFERENCES omnis.agents(id) ON DELETE RESTRICT,
  base_version_no integer,
  profession varchar(160) NOT NULL CHECK (length(btrim(profession)) > 0),
  seniority varchar(80),
  specialties jsonb NOT NULL CHECK (omnis.is_bounded_string_array(specialties, 32, 100)),
  personality jsonb NOT NULL CHECK (jsonb_typeof(personality) = 'object'
    AND personality ?& ARRAY['traits', 'tone', 'principles']
    AND personality - ARRAY['traits', 'tone', 'principles'] = '{}'::jsonb
    AND omnis.is_bounded_string_array(personality->'traits', 32, 100)
    AND omnis.is_bounded_string_array(personality->'principles', 32, 240)
    AND (personality->'tone' = 'null'::jsonb OR
      (jsonb_typeof(personality->'tone') = 'string' AND char_length(personality->>'tone') <= 120))),
  behavior jsonb NOT NULL CHECK (jsonb_typeof(behavior) = 'object'
    AND behavior ?& ARRAY['autonomy', 'escalation']
    AND behavior - ARRAY['autonomy', 'escalation'] = '{}'::jsonb
    AND (behavior->'autonomy' = 'null'::jsonb OR
      (jsonb_typeof(behavior->'autonomy') = 'string' AND char_length(behavior->>'autonomy') <= 500))
    AND (behavior->'escalation' = 'null'::jsonb OR
      (jsonb_typeof(behavior->'escalation') = 'string' AND char_length(behavior->>'escalation') <= 1000))),
  instructions text NOT NULL CHECK (char_length(instructions) <= 16384),
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, base_version_no)
    REFERENCES omnis.agent_profile_versions(agent_id, version_no) ON DELETE RESTRICT
);

CREATE FUNCTION omnis.guard_agent_profile_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_agent omnis.agents%ROWTYPE;
BEGIN
  SELECT * INTO v_agent FROM omnis.agents WHERE id=NEW.agent_id FOR UPDATE;
  IF NOT FOUND OR v_agent.lifecycle='archived' THEN
    RAISE EXCEPTION 'draft cannot be changed for a missing or archived agent' USING ERRCODE='23514';
  END IF;
  IF NEW.revision <> v_agent.draft_revision
     OR NEW.base_version_no IS DISTINCT FROM v_agent.current_version_no THEN
    RAISE EXCEPTION 'agent draft revision does not match its current head' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER agent_profile_drafts_match_agent_head
  BEFORE INSERT OR UPDATE ON omnis.agent_profile_drafts
  FOR EACH ROW EXECUTE FUNCTION omnis.guard_agent_profile_draft();

CREATE OR REPLACE FUNCTION omnis.assert_agent_profile_version_head()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
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

CREATE TABLE omnis.agent_management_audit (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'),
  agent_id text NOT NULL REFERENCES omnis.agents(id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (actor_id = 'owner'),
  action text NOT NULL CHECK (action IN ('created', 'draft_saved', 'profile_published', 'archived')),
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_management_audit_target_idx
  ON omnis.agent_management_audit(agent_id, occurred_at DESC);

CREATE FUNCTION omnis.reject_agent_management_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'agent management audit records are immutable' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER agent_management_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.agent_management_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_agent_management_audit_mutation();

CREATE TABLE omnis.agent_management_idempotency (
  request_id uuid PRIMARY KEY,
  operation text NOT NULL,
  target_agent_id text,
  fingerprint_version integer NOT NULL,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION omnis.agent_management_replay(
  p_request_id uuid, p_operation text, p_target_agent_id text,
  p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_row omnis.agent_management_idempotency%ROWTYPE;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'agent management requires the authorizer role' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 731992041));
  SELECT * INTO v_row FROM omnis.agent_management_idempotency
   WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_row.operation <> p_operation
     OR v_row.target_agent_id IS DISTINCT FROM p_target_agent_id
     OR v_row.fingerprint_version <> p_fingerprint_version
     OR v_row.fingerprint <> p_fingerprint THEN
    RAISE EXCEPTION 'agent management idempotency conflict' USING ERRCODE = '23505';
  END IF;
  RETURN v_row.receipt;
END
$function$;

CREATE FUNCTION omnis.agent_management_remember(
  p_request_id uuid, p_operation text, p_target_agent_id text,
  p_fingerprint_version integer, p_fingerprint bytea, p_receipt jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
BEGIN
  INSERT INTO omnis.agent_management_idempotency
    (request_id, operation, target_agent_id, fingerprint_version, fingerprint, receipt)
  VALUES (p_request_id, p_operation, p_target_agent_id, p_fingerprint_version, p_fingerprint, p_receipt);
END
$function$;

CREATE FUNCTION omnis.create_agent(
  p_id text, p_name text, p_slug text, p_department_id text,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_receipt jsonb; v_agent omnis.agents%ROWTYPE;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN RAISE EXCEPTION 'authorizer required' USING ERRCODE='42501'; END IF;
  v_receipt := omnis.agent_management_replay(p_request_id, 'agent.created', NULL, p_fingerprint_version, p_fingerprint);
  IF v_receipt IS NOT NULL THEN RETURN v_receipt; END IF;
  PERFORM pg_advisory_xact_lock(716824201312);
  IF (SELECT count(*) FROM omnis.agents) >= 1000 THEN
    RAISE EXCEPTION 'agent directory capacity reached' USING ERRCODE = '22023';
  END IF;
  IF p_department_id IS NOT NULL THEN
    PERFORM 1 FROM omnis.departments WHERE id=p_department_id AND owner_id='owner' AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'department unavailable' USING ERRCODE='23503'; END IF;
  END IF;
  INSERT INTO omnis.agents(id, department_id, name, slug, lifecycle, provenance)
  VALUES (p_id, p_department_id, p_name, p_slug, 'draft', 'owner_created') RETURNING * INTO v_agent;
  INSERT INTO omnis.agent_management_audit(id, agent_id, actor_id, action, request_id)
  VALUES ('ama_' || replace(gen_random_uuid()::text, '-', ''), v_agent.id, 'owner', 'created', p_request_id);
  v_receipt := jsonb_build_object('requestId',p_request_id,'operation','agent.created','agentId',v_agent.id,
    'lifecycle',v_agent.lifecycle,'versionId',NULL,'versionNo',NULL,'draftRevision',v_agent.draft_revision,
    'occurredAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  PERFORM omnis.agent_management_remember(p_request_id,'agent.created',NULL,p_fingerprint_version,p_fingerprint,v_receipt);
  RETURN v_receipt;
END
$function$;

CREATE FUNCTION omnis.get_agent_profile_draft(p_agent_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_agent omnis.agents%ROWTYPE; v_draft omnis.agent_profile_drafts%ROWTYPE;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN RAISE EXCEPTION 'authorizer required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_agent FROM omnis.agents WHERE id=p_agent_id AND owner_id='owner';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_draft FROM omnis.agent_profile_drafts WHERE agent_id=p_agent_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('agentId',v_agent.id,'draftRevision',v_agent.draft_revision,
      'baseVersionNo',NULL,'profile',NULL,'updatedAt',NULL);
  END IF;
  RETURN jsonb_build_object('agentId',v_agent.id,'draftRevision',v_agent.draft_revision,
    'baseVersionNo',v_draft.base_version_no,'profile',jsonb_build_object(
      'profession',v_draft.profession,'seniority',v_draft.seniority,'specialties',v_draft.specialties,
      'personality',v_draft.personality,'behavior',v_draft.behavior,'instructions',v_draft.instructions),
    'updatedAt',to_char(v_draft.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END
$function$;

CREATE FUNCTION omnis.save_agent_profile_draft(
  p_agent_id text, p_expected_revision bigint, p_base_version_no integer, p_profile jsonb,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_receipt jsonb; v_agent omnis.agents%ROWTYPE; v_revision bigint;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN RAISE EXCEPTION 'authorizer required' USING ERRCODE='42501'; END IF;
  v_receipt := omnis.agent_management_replay(p_request_id,'profile.draft_saved',p_agent_id,p_fingerprint_version,p_fingerprint);
  IF v_receipt IS NOT NULL THEN RETURN v_receipt; END IF;
  SELECT * INTO v_agent FROM omnis.agents WHERE id=p_agent_id AND owner_id='owner' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent not found' USING ERRCODE='P0002'; END IF;
  IF v_agent.lifecycle='archived' THEN RAISE EXCEPTION 'archived agent' USING ERRCODE='23514'; END IF;
  IF p_expected_revision <> v_agent.draft_revision OR p_base_version_no IS DISTINCT FROM v_agent.current_version_no THEN
    RAISE EXCEPTION 'draft revision conflict' USING ERRCODE='40001';
  END IF;
  IF v_agent.draft_revision >= 9007199254740991 THEN RAISE EXCEPTION 'draft revision exhausted' USING ERRCODE='22003'; END IF;
  v_revision := v_agent.draft_revision + 1;
  UPDATE omnis.agents SET draft_revision=v_revision, updated_at=now() WHERE id=p_agent_id;
  INSERT INTO omnis.agent_profile_drafts(agent_id,base_version_no,profession,seniority,specialties,personality,behavior,instructions,revision,updated_at)
  VALUES(p_agent_id,p_base_version_no,p_profile->>'profession',p_profile->>'seniority',p_profile->'specialties',
    p_profile->'personality',p_profile->'behavior',p_profile->>'instructions',v_revision,now())
  ON CONFLICT(agent_id) DO UPDATE SET base_version_no=excluded.base_version_no, profession=excluded.profession,
    seniority=excluded.seniority,specialties=excluded.specialties,personality=excluded.personality,
    behavior=excluded.behavior,instructions=excluded.instructions,revision=excluded.revision,updated_at=excluded.updated_at;
  INSERT INTO omnis.agent_management_audit(id,agent_id,actor_id,action,request_id)
  VALUES('ama_'||replace(gen_random_uuid()::text,'-',''),p_agent_id,'owner','draft_saved',p_request_id);
  v_receipt:=jsonb_build_object('requestId',p_request_id,'operation','profile.draft_saved','agentId',p_agent_id,
    'lifecycle',v_agent.lifecycle,'versionId',NULL,'versionNo',NULL,'draftRevision',v_revision,
    'occurredAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  PERFORM omnis.agent_management_remember(p_request_id,'profile.draft_saved',p_agent_id,p_fingerprint_version,p_fingerprint,v_receipt);
  RETURN v_receipt;
END
$function$;

CREATE FUNCTION omnis.publish_agent_profile(
  p_agent_id text,p_expected_version_no integer,p_expected_revision bigint,
  p_request_id uuid,p_fingerprint_version integer,p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_receipt jsonb; v_agent omnis.agents%ROWTYPE; v_draft omnis.agent_profile_drafts%ROWTYPE;
  v_version integer; v_version_id text;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN RAISE EXCEPTION 'authorizer required' USING ERRCODE='42501'; END IF;
  v_receipt:=omnis.agent_management_replay(p_request_id,'profile.published',p_agent_id,p_fingerprint_version,p_fingerprint);
  IF v_receipt IS NOT NULL THEN RETURN v_receipt; END IF;
  SELECT * INTO v_agent FROM omnis.agents WHERE id=p_agent_id AND owner_id='owner' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent not found' USING ERRCODE='P0002'; END IF;
  IF v_agent.lifecycle='archived' THEN RAISE EXCEPTION 'archived agent' USING ERRCODE='23514'; END IF;
  IF v_agent.current_version_no IS DISTINCT FROM p_expected_version_no THEN RAISE EXCEPTION 'profile version conflict' USING ERRCODE='40001'; END IF;
  SELECT * INTO v_draft FROM omnis.agent_profile_drafts WHERE agent_id=p_agent_id FOR UPDATE;
  IF NOT FOUND OR v_draft.revision<>p_expected_revision OR v_draft.base_version_no IS DISTINCT FROM v_agent.current_version_no THEN
    RAISE EXCEPTION 'draft revision conflict' USING ERRCODE='40001';
  END IF;
  v_version:=coalesce(v_agent.current_version_no,0)+1;
  v_version_id:='agv_'||replace(gen_random_uuid()::text,'-','');
  INSERT INTO omnis.agent_profile_versions(version_id,agent_id,version_no,profession,seniority,specialties,personality,behavior,instructions)
  VALUES(v_version_id,p_agent_id,v_version,v_draft.profession,v_draft.seniority,v_draft.specialties,v_draft.personality,v_draft.behavior,v_draft.instructions);
  UPDATE omnis.agents SET lifecycle='available',current_version_no=v_version,updated_at=now() WHERE id=p_agent_id;
  DELETE FROM omnis.agent_profile_drafts WHERE agent_id=p_agent_id;
  INSERT INTO omnis.agent_management_audit(id,agent_id,actor_id,action,request_id)
  VALUES('ama_'||replace(gen_random_uuid()::text,'-',''),p_agent_id,'owner','profile_published',p_request_id);
  v_receipt:=jsonb_build_object('requestId',p_request_id,'operation','profile.published','agentId',p_agent_id,
    'lifecycle','available','versionId',v_version_id,'versionNo',v_version,'draftRevision',v_agent.draft_revision,
    'occurredAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  PERFORM omnis.agent_management_remember(p_request_id,'profile.published',p_agent_id,p_fingerprint_version,p_fingerprint,v_receipt);
  RETURN v_receipt;
END
$function$;

CREATE FUNCTION omnis.archive_agent(
  p_agent_id text,p_request_id uuid,p_fingerprint_version integer,p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE v_receipt jsonb; v_agent omnis.agents%ROWTYPE;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN RAISE EXCEPTION 'authorizer required' USING ERRCODE='42501'; END IF;
  v_receipt:=omnis.agent_management_replay(p_request_id,'agent.archived',p_agent_id,p_fingerprint_version,p_fingerprint);
  IF v_receipt IS NOT NULL THEN RETURN v_receipt; END IF;
  SELECT * INTO v_agent FROM omnis.agents WHERE id=p_agent_id AND owner_id='owner' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent not found' USING ERRCODE='P0002'; END IF;
  IF v_agent.lifecycle='draft' THEN RAISE EXCEPTION 'draft cannot be archived' USING ERRCODE='23514'; END IF;
  IF v_agent.lifecycle='available' THEN
    UPDATE omnis.agents SET lifecycle='archived',archived_at=now(),updated_at=now() WHERE id=p_agent_id;
    v_agent.lifecycle:='archived';
    INSERT INTO omnis.agent_management_audit(id,agent_id,actor_id,action,request_id)
    VALUES('ama_'||replace(gen_random_uuid()::text,'-',''),p_agent_id,'owner','archived',p_request_id);
  END IF;
  v_receipt:=jsonb_build_object('requestId',p_request_id,'operation','agent.archived','agentId',p_agent_id,
    'lifecycle',v_agent.lifecycle,'versionId',NULL,'versionNo',NULL,
    'draftRevision',v_agent.draft_revision,
    'occurredAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  PERFORM omnis.agent_management_remember(p_request_id,'agent.archived',p_agent_id,p_fingerprint_version,p_fingerprint,v_receipt);
  RETURN v_receipt;
END
$function$;

REVOKE ALL ON omnis.agent_profile_drafts, omnis.agent_management_audit, omnis.agent_management_idempotency
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.reject_agent_management_audit_mutation() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.guard_agent_profile_draft() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.assert_agent_profile_version_head() FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.agent_management_replay(uuid,text,text,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.agent_management_remember(uuid,text,text,integer,bytea,jsonb) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.create_agent(text,text,text,text,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.get_agent_profile_draft(text) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.save_agent_profile_draft(text,bigint,integer,jsonb,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.publish_agent_profile(text,integer,bigint,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.archive_agent(text,uuid,integer,bytea) FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON omnis.agents, omnis.agent_profile_versions FROM omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.create_agent(text,text,text,text,uuid,integer,bytea) TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.get_agent_profile_draft(text) TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.save_agent_profile_draft(text,bigint,integer,jsonb,uuid,integer,bytea) TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.publish_agent_profile(text,integer,bigint,uuid,integer,bytea) TO omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.archive_agent(text,uuid,integer,bytea) TO omnis_authorizer;

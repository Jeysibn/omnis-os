ALTER TABLE omnis.agents
  ADD COLUMN identity_revision bigint NOT NULL DEFAULT 1
    CHECK (identity_revision BETWEEN 1 AND 9007199254740991);

ALTER TABLE omnis.agent_management_audit
  DROP CONSTRAINT agent_management_audit_action_check,
  ADD CONSTRAINT agent_management_audit_action_check
    CHECK (action IN ('created', 'draft_saved', 'profile_published', 'identity_updated', 'archived'));

CREATE FUNCTION omnis.update_agent_identity(
  p_agent_id text, p_expected_revision bigint, p_name text, p_slug text,
  p_request_id uuid, p_fingerprint_version integer, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
DECLARE
  v_receipt jsonb;
  v_agent omnis.agents%ROWTYPE;
  v_revision bigint;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'authorizer required' USING ERRCODE = '42501';
  END IF;
  v_receipt := omnis.agent_management_replay(
    p_request_id, 'agent.identity_updated', p_agent_id, p_fingerprint_version, p_fingerprint
  );
  IF v_receipt IS NOT NULL THEN RETURN v_receipt; END IF;

  SELECT * INTO v_agent FROM omnis.agents
    WHERE id = p_agent_id AND owner_id = 'owner' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent not found' USING ERRCODE = 'P0002'; END IF;
  IF v_agent.lifecycle = 'archived' THEN
    RAISE EXCEPTION 'archived agent identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF v_agent.identity_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'agent identity revision conflict' USING ERRCODE = '40001';
  END IF;
  IF v_agent.identity_revision >= 9007199254740991 THEN
    RAISE EXCEPTION 'agent identity revision exhausted' USING ERRCODE = '22003';
  END IF;

  v_revision := v_agent.identity_revision + 1;
  UPDATE omnis.agents
    SET name = p_name, slug = p_slug, identity_revision = v_revision, updated_at = now()
    WHERE id = p_agent_id
    RETURNING * INTO v_agent;
  INSERT INTO omnis.agent_management_audit(id, agent_id, actor_id, action, request_id)
    VALUES ('ama_' || replace(gen_random_uuid()::text, '-', ''), p_agent_id, 'owner', 'identity_updated', p_request_id);
  v_receipt := jsonb_build_object(
    'requestId', p_request_id, 'operation', 'agent.identity_updated', 'agentId', p_agent_id,
    'name', v_agent.name, 'slug', v_agent.slug, 'identityRevision', v_agent.identity_revision,
    'updatedAt', to_char(v_agent.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  PERFORM omnis.agent_management_remember(
    p_request_id, 'agent.identity_updated', p_agent_id, p_fingerprint_version, p_fingerprint, v_receipt
  );
  RETURN v_receipt;
END
$function$;

REVOKE ALL ON FUNCTION omnis.update_agent_identity(text,bigint,text,text,uuid,integer,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.update_agent_identity(text,bigint,text,text,uuid,integer,bytea)
  TO omnis_authorizer;

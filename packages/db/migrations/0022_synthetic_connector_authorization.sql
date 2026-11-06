-- Migration 0022 is intentionally independent of the deferred PR #41 migration 0021.
-- It reads only the stable project/task/profile tables present through migration 0020 and
-- creates connector-only authorization records. It does not alter runs, run_events, or
-- any function replaced by 0021. If 0022 is applied before 0021 is later added, the
-- existing migration runner can safely apply 0021 afterward because neither migration
-- references objects created by the other.

CREATE TABLE omnis.connector_authorizations (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  correlation_id uuid NOT NULL UNIQUE,
  requesting_actor text NOT NULL CHECK (requesting_actor = 'owner'),
  project_id text NOT NULL REFERENCES omnis.projects(id) ON DELETE RESTRICT,
  project_revision integer NOT NULL CHECK (project_revision > 0),
  task_id text NOT NULL REFERENCES omnis.tasks(id) ON DELETE RESTRICT,
  task_revision integer NOT NULL CHECK (task_revision > 0),
  agent_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  connector_id text NOT NULL CHECK (connector_id = 'synthetic.codex.fixture'),
  connector_version text NOT NULL CHECK (connector_version = '0.0.0-synthetic.1'),
  provider_id text NOT NULL CHECK (provider_id = 'synthetic'),
  model_id text NOT NULL CHECK (model_id = 'synthetic-text-only-v1'),
  operation text NOT NULL CHECK (operation = 'connector.respond'),
  capabilities jsonb NOT NULL CHECK (capabilities = '[]'::jsonb),
  limits jsonb NOT NULL CHECK (
    jsonb_typeof(limits) = 'object'
    AND limits ?& ARRAY[
      'maxInputTokens', 'maxOutputTokens', 'maxDurationSeconds',
      'maxConcurrentRuns', 'maxUsageUnits', 'maxCostMicrousd'
    ]
    AND limits - ARRAY[
      'maxInputTokens', 'maxOutputTokens', 'maxDurationSeconds',
      'maxConcurrentRuns', 'maxUsageUnits', 'maxCostMicrousd'
    ] = '{}'::jsonb
    AND (limits->>'maxInputTokens')::integer BETWEEN 1 AND 4000
    AND (limits->>'maxOutputTokens')::integer BETWEEN 1 AND 1024
    AND (limits->>'maxDurationSeconds')::integer BETWEEN 1 AND 900
    AND (limits->>'maxConcurrentRuns')::integer = 1
    AND (limits->>'maxUsageUnits')::integer BETWEEN 1 AND 10000
    AND (limits->>'maxCostMicrousd')::integer BETWEEN 1 AND 10000000
  ),
  prompt_digest text NOT NULL CHECK (prompt_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'authorized', 'denied', 'revoked')),
  policy_version text NOT NULL CHECK (policy_version = 'r1p1-synthetic-connector-v1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  consented_at timestamptz,
  decided_at timestamptz,
  decided_by text CHECK (decided_by IS NULL OR decided_by = 'owner'),
  revoked_at timestamptz,
  revoked_by text CHECK (revoked_by IS NULL OR revoked_by = 'owner'),
  revocation_generation integer NOT NULL DEFAULT 0 CHECK (revocation_generation BETWEEN 0 AND 1),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_request_id uuid UNIQUE,
  FOREIGN KEY (agent_id, profile_version)
    REFERENCES omnis.agent_profile_versions(agent_id, version_no) ON DELETE RESTRICT,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status IN ('authorized', 'denied', 'revoked')) = (decided_by IS NOT NULL)),
  CHECK ((status IN ('authorized', 'revoked')) = (consented_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_by IS NOT NULL)),
  CHECK ((status = 'revoked') = (revocation_generation = 1)),
  CHECK ((consumed_at IS NULL) = (consumed_request_id IS NULL))
);
CREATE INDEX connector_authorizations_task_idx
  ON omnis.connector_authorizations(task_id, created_at DESC);
CREATE INDEX connector_authorizations_status_expiry_idx
  ON omnis.connector_authorizations(status, expires_at)
  WHERE status IN ('pending', 'authorized');

CREATE TABLE omnis.connector_execution_attempts (
  id uuid PRIMARY KEY,
  authorization_id uuid NOT NULL UNIQUE
    REFERENCES omnis.connector_authorizations(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status = 'admitted'),
  synthetic boolean NOT NULL CHECK (synthetic IS TRUE),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE omnis.connector_authorization_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id uuid NOT NULL
    REFERENCES omnis.connector_authorizations(id) ON DELETE RESTRICT,
  attempt_id uuid REFERENCES omnis.connector_execution_attempts(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'connector.authorization_requested',
    'connector.authorization_approved',
    'connector.authorization_denied',
    'connector.authorization_revoked',
    'connector.authorization_consumed'
  )),
  actor_id text NOT NULL CHECK (actor_id IN ('owner', 'service:omnis-authorizer')),
  effective_identity text NOT NULL CHECK (
    effective_identity IN ('human:owner', 'service:omnis-authorizer')
  ),
  correlation_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'recorded')),
  revocation_generation integer NOT NULL CHECK (revocation_generation BETWEEN 0 AND 1),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connector_authorization_audit_sequence_idx
  ON omnis.connector_authorization_audit(authorization_id, sequence);
CREATE INDEX connector_authorization_audit_target_idx
  ON omnis.connector_authorization_audit(authorization_id, sequence);

CREATE FUNCTION omnis.reject_connector_authorization_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  RAISE EXCEPTION 'connector authorization audit records are immutable'
    USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER connector_authorization_audit_immutable
  BEFORE UPDATE OR DELETE ON omnis.connector_authorization_audit
  FOR EACH ROW EXECUTE FUNCTION omnis.reject_connector_authorization_audit_mutation();

CREATE FUNCTION omnis.guard_connector_authorization_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, omnis AS $function$
BEGIN
  IF ROW(
    NEW.id, NEW.request_id, NEW.request_fingerprint, NEW.correlation_id,
    NEW.requesting_actor, NEW.project_id, NEW.project_revision, NEW.task_id,
    NEW.task_revision, NEW.agent_id, NEW.profile_version, NEW.connector_id,
    NEW.connector_version, NEW.provider_id, NEW.model_id, NEW.operation,
    NEW.capabilities, NEW.limits, NEW.prompt_digest, NEW.policy_version,
    NEW.created_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.request_id, OLD.request_fingerprint, OLD.correlation_id,
    OLD.requesting_actor, OLD.project_id, OLD.project_revision, OLD.task_id,
    OLD.task_revision, OLD.agent_id, OLD.profile_version, OLD.connector_id,
    OLD.connector_version, OLD.provider_id, OLD.model_id, OLD.operation,
    OLD.capabilities, OLD.limits, OLD.prompt_digest, OLD.policy_version,
    OLD.created_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'connector authorization request bindings are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status IN ('authorized', 'denied')
     AND OLD.decided_at IS NULL AND NEW.decided_at IS NOT NULL
     AND NEW.decided_by = 'owner'
     AND (NEW.status = 'authorized') = (NEW.consented_at IS NOT NULL)
     AND NEW.revocation_generation = 0
     AND NEW.revoked_at IS NULL AND NEW.revoked_by IS NULL
     AND NEW.consumed_at IS NULL AND NEW.consumed_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'authorized' AND NEW.status = 'authorized'
     AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
     AND OLD.consumed_request_id IS NULL AND NEW.consumed_request_id IS NOT NULL
     AND NEW.consented_at = OLD.consented_at
     AND NEW.decided_at = OLD.decided_at AND NEW.decided_by = OLD.decided_by
     AND NEW.revoked_at IS NULL AND NEW.revoked_by IS NULL
     AND NEW.revocation_generation = 0 THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'authorized' AND NEW.status = 'revoked'
     AND NEW.consented_at = OLD.consented_at
     AND NEW.decided_at = OLD.decided_at AND NEW.decided_by = OLD.decided_by
     AND OLD.revocation_generation = 0 AND NEW.revocation_generation = 1
     AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by = 'owner'
     AND NEW.consumed_at IS NOT DISTINCT FROM OLD.consumed_at
     AND NEW.consumed_request_id IS NOT DISTINCT FROM OLD.consumed_request_id THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid connector authorization state transition'
    USING ERRCODE = '55000';
END
$function$;
REVOKE ALL ON FUNCTION omnis.guard_connector_authorization_update() FROM PUBLIC;
CREATE TRIGGER connector_authorization_transition_guard
  BEFORE UPDATE ON omnis.connector_authorizations
  FOR EACH ROW EXECUTE FUNCTION omnis.guard_connector_authorization_update();

-- The SECURITY DEFINER validator locks task before project, matching task association
-- writers, then agent before immutable profile version. Callers cannot read these tables.
CREATE FUNCTION omnis.validate_connector_authorization_context(
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
  v_agent_lifecycle text;
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'connector authorization context requires the authorizer identity'
      USING ERRCODE = '42501';
  END IF;

  SELECT project_id, association_revision INTO v_task_project_id, v_task_revision
    FROM omnis.tasks
   WHERE id = p_task_id
   FOR SHARE;
  IF NOT FOUND OR v_task_project_id <> p_project_id OR v_task_revision <> p_task_revision THEN
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
REVOKE ALL ON FUNCTION omnis.validate_connector_authorization_context(text, integer, text, integer, text, integer)
  FROM PUBLIC, omnis_runtime, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.validate_connector_authorization_context(text, integer, text, integer, text, integer)
  TO omnis_authorizer;

REVOKE ALL ON omnis.connector_authorizations, omnis.connector_execution_attempts,
  omnis.connector_authorization_audit
  FROM PUBLIC, omnis_runtime, omnis_launcher;
GRANT SELECT, INSERT ON omnis.connector_authorizations TO omnis_authorizer;
GRANT UPDATE (
  status, consented_at, decided_at, decided_by, revoked_at, revoked_by,
  revocation_generation, consumed_at, consumed_request_id
) ON omnis.connector_authorizations TO omnis_authorizer;
GRANT SELECT, INSERT ON omnis.connector_execution_attempts TO omnis_authorizer;
GRANT SELECT, INSERT ON omnis.connector_authorization_audit TO omnis_authorizer;
GRANT USAGE ON SCHEMA omnis TO omnis_authorizer;

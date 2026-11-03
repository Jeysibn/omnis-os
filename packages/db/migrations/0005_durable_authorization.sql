CREATE TABLE omnis.runtime_authorizations (
  id text PRIMARY KEY,
  requesting_actor text NOT NULL CHECK (requesting_actor = 'owner'),
  runtime_id text NOT NULL CHECK (runtime_id = 'mock'),
  operation text NOT NULL CHECK (operation = 'execute_task'),
  task_id text NOT NULL REFERENCES omnis.tasks(id),
  capabilities jsonb NOT NULL CHECK (capabilities = '["mock.execute"]'::jsonb),
  scope jsonb NOT NULL CHECK (scope = jsonb_build_object('kind', 'task', 'taskId', task_id)),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'denied', 'revoked')),
  policy_version text NOT NULL,
  correlation_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text CHECK (decided_by IS NULL OR decided_by = 'owner'),
  revoked_at timestamptz,
  revoked_by text CHECK (revoked_by IS NULL OR revoked_by = 'owner'),
  consumed_at timestamptz,
  consumed_run_id text UNIQUE REFERENCES omnis.runs(id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status IN ('authorized', 'denied', 'revoked')) = (decided_by IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((consumed_at IS NULL) = (consumed_run_id IS NULL))
);
CREATE INDEX runtime_authorizations_task_idx ON omnis.runtime_authorizations(task_id, created_at DESC);

CREATE TABLE omnis.authorization_audit (
  id text PRIMARY KEY,
  authorization_id text REFERENCES omnis.runtime_authorizations(id),
  task_id text REFERENCES omnis.tasks(id),
  run_id text REFERENCES omnis.runs(id),
  event_type text NOT NULL CHECK (event_type IN (
    'authorization.requested', 'authorization.approved', 'authorization.denied',
    'authorization.revoked', 'authorization.expired', 'authorization.consumed',
    'authorization.enforcement_denied', 'operation.started', 'operation.completed',
    'operation.failed', 'operation.cancelled', 'operation.interrupted'
  )),
  actor_id text NOT NULL,
  effective_identity text NOT NULL,
  capability text NOT NULL,
  correlation_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'recorded')),
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authorization_audit_auth_idx ON omnis.authorization_audit(authorization_id, occurred_at);
CREATE INDEX authorization_audit_run_idx ON omnis.authorization_audit(run_id, occurred_at);

-- Consume exactly one approved, unexpired, task-scoped authorization in the same
-- transaction that admits its run. The restricted runtime may call this function
-- but cannot approve, revoke, or rewrite an authorization row.
CREATE FUNCTION omnis.consume_run_authorization(
  p_authorization_id text,
  p_task_id text,
  p_actor_id text,
  p_run_id text,
  p_correlation_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
DECLARE
  updated_id text;
BEGIN
  UPDATE omnis.runtime_authorizations
     SET consumed_at = now(), consumed_run_id = p_run_id
   WHERE id = p_authorization_id
     AND requesting_actor = p_actor_id
     AND task_id = p_task_id
     AND runtime_id = 'mock'
     AND operation = 'execute_task'
     AND capabilities = '["mock.execute"]'::jsonb
     AND scope = jsonb_build_object('kind', 'task', 'taskId', p_task_id)
     AND status = 'authorized'
     AND expires_at > now()
     AND revoked_at IS NULL
     AND consumed_at IS NULL
     AND EXISTS (
       SELECT 1 FROM omnis.runs r
        WHERE r.id = p_run_id AND r.task_id = p_task_id AND r.status = 'queued'
     )
  RETURNING id INTO updated_id;

  IF updated_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO omnis.authorization_audit (
    id, authorization_id, task_id, run_id, event_type, actor_id,
    effective_identity, capability, correlation_id, outcome
  ) VALUES (
    'audit-' || p_authorization_id || '-consumed', p_authorization_id, p_task_id,
    p_run_id, 'authorization.consumed', p_actor_id, 'service:omnis-worker',
    'mock.execute', p_correlation_id, 'allowed'
  );
  RETURN true;
END
$function$;

CREATE FUNCTION omnis.lock_active_run_authorization(p_run_id text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, omnis
AS $function$
BEGIN
  PERFORM 1
    FROM omnis.runtime_authorizations a
   WHERE a.consumed_run_id = p_run_id
     AND a.status = 'authorized'
     AND a.expires_at > now()
     AND a.revoked_at IS NULL
   FOR UPDATE;
  RETURN FOUND;
END
$function$;

REVOKE ALL ON FUNCTION omnis.consume_run_authorization(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omnis.consume_run_authorization(text, text, text, text, text) TO omnis_runtime;
REVOKE ALL ON FUNCTION omnis.lock_active_run_authorization(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omnis.lock_active_run_authorization(text) TO omnis_runtime;

GRANT SELECT ON omnis.runtime_authorizations TO omnis_runtime;
GRANT INSERT (
  id, authorization_id, task_id, run_id, event_type, actor_id,
  effective_identity, capability, correlation_id, outcome, reason_code, occurred_at
) ON omnis.authorization_audit TO omnis_runtime;
GRANT SELECT ON omnis.runtime_authorizations TO omnis_authorizer;
GRANT INSERT (
  id, requesting_actor, runtime_id, operation, task_id, capabilities,
  scope, policy_version, correlation_id, expires_at
) ON omnis.runtime_authorizations TO omnis_authorizer;
GRANT UPDATE (status, decided_at, decided_by, revoked_at, revoked_by)
  ON omnis.runtime_authorizations TO omnis_authorizer;
GRANT SELECT, INSERT ON omnis.authorization_audit TO omnis_authorizer;
GRANT SELECT ON omnis.tasks TO omnis_authorizer;

ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis
  REVOKE ALL ON TABLES FROM omnis_runtime, omnis_authorizer;

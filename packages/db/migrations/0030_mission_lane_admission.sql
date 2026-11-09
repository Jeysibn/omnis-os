-- Globally bound Mission Lane writers. The fixed advisory-lock keys below are
-- reserved for this migration and documented to avoid collisions with the
-- existing migration (70463909136523..525) and hashed request locks.
--
-- Lock order: session queue slot -> session admission turnstile (36604) ->
-- transaction active permit -> Mission Lane cursor (70463909136525) ->
-- source/domain locks. The turnstile and queue slot are released immediately
-- after the xact permit is acquired. Active permits are xact-scoped and release
-- on commit, rollback, backend termination, or connection loss. PostgreSQL's
-- lock_timeout bounds admission and cursor waits. A head waiter can briefly
-- leave other permit keys idle while waiting on the first key.
--
-- Active permits: 70463909136600..603 (four). Normal pending slots:
-- 70463909136610..612 (three). Reserved critical pending slot:
-- 70463909136613. Critical operations may use any pending slot. Admission
-- turnstile: 70463909136604; it is released before D5 cursor acquisition.

CREATE FUNCTION omnis.acquire_mission_lane_admission(p_critical boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
DECLARE
  v_queue_key bigint;
  v_queue_keys bigint[];
  v_active_key bigint;
  v_turnstile_key constant bigint := 70463909136604;
BEGIN
  IF session_user NOT IN ('omnis_runtime', 'omnis_authorizer') THEN
    RAISE EXCEPTION 'Mission Lane admission requires an approved writer identity'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS pg_lock
     WHERE pg_lock.locktype='advisory' AND pg_lock.pid=pg_catalog.pg_backend_pid()
       AND pg_lock.granted AND pg_lock.mode='ExclusiveLock' AND pg_lock.objsubid=1
       AND (
         ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint)
           BETWEEN 70463909136600 AND 70463909136604
         OR ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint)
           BETWEEN 70463909136610 AND 70463909136613
       )
  ) THEN
    RAISE EXCEPTION 'Mission Lane admission cannot be re-entered on the same backend'
      USING ERRCODE = 'PML02';
  END IF;

  -- Prefer an immediately available active permit. A request that can become
  -- active must never consume one of the four bounded pending slots merely
  -- because another new writer reached the function at the same time.
  FOREACH v_active_key IN ARRAY ARRAY[
    70463909136600,70463909136601,70463909136602,70463909136603
  ]::bigint[] LOOP
    IF pg_catalog.pg_try_advisory_xact_lock(v_active_key) THEN
      RETURN;
    END IF;
  END LOOP;

  IF p_critical THEN
    v_queue_keys := ARRAY[70463909136610,70463909136611,70463909136612,70463909136613]::bigint[];
  ELSE
    v_queue_keys := ARRAY[70463909136610,70463909136611,70463909136612]::bigint[];
  END IF;

  FOREACH v_queue_key IN ARRAY v_queue_keys LOOP
    IF pg_catalog.pg_try_advisory_lock(v_queue_key) THEN
      EXIT;
    END IF;
    v_queue_key := NULL;
  END LOOP;
  IF v_queue_key IS NULL THEN
    RAISE EXCEPTION 'Mission Lane writer admission queue is full'
      USING ERRCODE = 'PML01';
  END IF;

  BEGIN
    -- Serialize the short queue-to-permit handoff, not the writer transaction.
    -- Re-scan all permits under the turnstile, then unlock it as soon as an
    -- xact-scoped permit is owned. This lets later waiters fill other free slots.
    PERFORM pg_catalog.pg_advisory_lock(v_turnstile_key);
    FOREACH v_active_key IN ARRAY ARRAY[
      70463909136600,70463909136601,70463909136602,70463909136603
    ]::bigint[] LOOP
      IF pg_catalog.pg_try_advisory_xact_lock(v_active_key) THEN
        PERFORM pg_catalog.pg_advisory_unlock(v_turnstile_key);
        PERFORM pg_catalog.pg_advisory_unlock(v_queue_key);
        RETURN;
      END IF;
    END LOOP;

    -- Wait on the first permit only while holding the turnstile. Its xact lock
    -- remains through commit; both session locks are released immediately.
    PERFORM pg_catalog.pg_advisory_xact_lock(70463909136600);
    PERFORM pg_catalog.pg_advisory_unlock(v_turnstile_key);
    PERFORM pg_catalog.pg_advisory_unlock(v_queue_key);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    PERFORM pg_catalog.pg_advisory_unlock(v_turnstile_key);
    PERFORM pg_catalog.pg_advisory_unlock(v_queue_key);
    RAISE;
  END;
END
$function$;

REVOKE ALL ON FUNCTION omnis.acquire_mission_lane_admission(boolean)
  FROM PUBLIC, omnis_launcher, omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.acquire_mission_lane_admission(boolean) TO omnis_runtime;

CREATE OR REPLACE FUNCTION omnis.require_mission_lane_writer_lock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS pg_lock
     WHERE pg_lock.locktype = 'advisory' AND pg_lock.pid = pg_catalog.pg_backend_pid()
       AND pg_lock.granted AND pg_lock.mode = 'ExclusiveLock' AND pg_lock.objsubid = 1
       AND ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint)
         BETWEEN 70463909136600 AND 70463909136603
  ) THEN
    RAISE EXCEPTION 'Mission Lane writers must hold a global admission permit'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS pg_lock
     WHERE pg_lock.locktype = 'advisory' AND pg_lock.pid = pg_catalog.pg_backend_pid()
       AND pg_lock.granted AND pg_lock.mode = 'ExclusiveLock' AND pg_lock.objsubid = 1
       AND ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint) = 70463909136525
  ) THEN
    RAISE EXCEPTION 'Mission Lane writers must acquire the cursor lock before source locks'
      USING ERRCODE = '55000';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION omnis.require_mission_lane_writer_lock()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;

ALTER FUNCTION omnis.create_task(text,text,text,uuid,bytea)
  RENAME TO create_task_mission_lane_admission_impl;
CREATE FUNCTION omnis.create_task(
  p_title text, p_detail text, p_project_id text, p_request_id uuid, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task creation requires the runtime identity' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.acquire_mission_lane_admission(false);
  PERFORM pg_catalog.pg_advisory_xact_lock(70463909136525);
  RETURN omnis.create_task_mission_lane_admission_impl(
    p_title,p_detail,p_project_id,p_request_id,p_fingerprint
  );
END
$function$;
REVOKE ALL ON FUNCTION omnis.create_task_mission_lane_admission_impl(text,text,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.create_task(text,text,text,uuid,bytea)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.create_task(text,text,text,uuid,bytea) TO omnis_runtime;

ALTER FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea)
  RENAME TO set_task_project_mission_lane_admission_impl;
CREATE FUNCTION omnis.set_task_project(
  p_task_id text, p_expected_association_revision integer, p_project_id text,
  p_request_id uuid, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task project changes require the runtime identity' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.acquire_mission_lane_admission(false);
  PERFORM pg_catalog.pg_advisory_xact_lock(70463909136525);
  RETURN omnis.set_task_project_mission_lane_admission_impl(
    p_task_id,p_expected_association_revision,p_project_id,p_request_id,p_fingerprint
  );
END
$function$;
REVOKE ALL ON FUNCTION omnis.set_task_project_mission_lane_admission_impl(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea) TO omnis_runtime;

ALTER FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea)
  RENAME TO set_task_epic_mission_lane_admission_impl;
CREATE FUNCTION omnis.set_task_epic(
  p_task_id text, p_expected_association_revision integer, p_epic_id text,
  p_request_id uuid, p_fingerprint bytea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'task Epic changes require the authorizer identity' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.acquire_mission_lane_admission(false);
  PERFORM pg_catalog.pg_advisory_xact_lock(70463909136525);
  RETURN omnis.set_task_epic_mission_lane_admission_impl(
    p_task_id,p_expected_association_revision,p_epic_id,p_request_id,p_fingerprint
  );
END
$function$;
REVOKE ALL ON FUNCTION omnis.set_task_epic_mission_lane_admission_impl(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea) TO omnis_authorizer;

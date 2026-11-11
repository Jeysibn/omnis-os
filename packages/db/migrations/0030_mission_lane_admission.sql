-- Globally bounded Mission Lane writers. Advisory keys are reserved here and
-- must not overlap migration locks or hashed request locks.
--
-- Lock order: bounded queue slot when waiting -> critical marker for critical
-- work -> turnstile -> transaction active permit -> D5 cursor -> source/domain
-- locks. The critical marker stays held until D5 is acquired, preventing later
-- normal writers from overtaking it. Session locks are released after D5 or on
-- every error/cancel path; active permits and D5 release at transaction end.
--
-- Active permits: 70463909136600..603 (four). Normal queue: 70463909136610..612
-- (three). Critical reserved queue slot: 70463909136613. Turnstile: 70463909136604.
-- Critical marker: 70463909136605.

CREATE FUNCTION omnis.acquire_mission_lane_admission(
  p_critical boolean DEFAULT false, p_remaining_ms integer DEFAULT 3000
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis
SET lock_timeout = '3s' AS $function$
DECLARE
  v_queue_key bigint;
  v_queue_keys bigint[];
  v_active_key bigint;
  v_turnstile_key constant bigint := 70463909136604;
  v_critical_marker_key constant bigint := 70463909136605;
  v_cursor_key constant bigint := 70463909136525;
  v_deadline timestamptz;
  v_remaining_ms integer;
  v_has_queue_slot boolean := false;
  v_has_turnstile boolean := false;
  v_has_critical_marker boolean := false;
  v_has_active_permit boolean := false;
BEGIN
  IF session_user NOT IN ('omnis_runtime', 'omnis_authorizer') THEN
    RAISE EXCEPTION 'Mission Lane admission requires an approved writer identity'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS pg_lock
     WHERE pg_lock.locktype = 'advisory' AND pg_lock.pid = pg_catalog.pg_backend_pid()
       AND pg_lock.granted AND pg_lock.mode = 'ExclusiveLock' AND pg_lock.objsubid = 1
       AND (
         ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint)
           BETWEEN 70463909136600 AND 70463909136605
         OR ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint)
           BETWEEN 70463909136610 AND 70463909136613
       )
  ) THEN
    RAISE EXCEPTION 'Mission Lane admission cannot be re-entered on the same backend'
      USING ERRCODE = 'PML02';
  END IF;

  IF p_remaining_ms IS NULL OR p_remaining_ms < 1 THEN
    RAISE EXCEPTION 'Mission Lane writer deadline expired before admission'
      USING ERRCODE = 'PML02';
  END IF;
  v_deadline := pg_catalog.clock_timestamp()
    + LEAST(p_remaining_ms, 3000) * interval '1 millisecond';

  -- A critical request must register in the bounded pending envelope before
  -- waiting. Normal fast-path requests use a queue slot only if they must wait.
  IF p_critical THEN
    v_queue_keys := ARRAY[70463909136613,70463909136610,70463909136611,70463909136612]::bigint[];
    FOREACH v_queue_key IN ARRAY v_queue_keys LOOP
      IF pg_catalog.pg_try_advisory_lock(v_queue_key) THEN
        v_has_queue_slot := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT v_has_queue_slot THEN
      RAISE EXCEPTION 'Mission Lane writer admission queue is full'
        USING ERRCODE = 'PML01';
    END IF;
  END IF;

  IF p_critical THEN
    v_remaining_ms := floor(extract(epoch FROM (v_deadline - pg_catalog.clock_timestamp())) * 1000)::integer;
    IF v_remaining_ms < 1 THEN
      RAISE EXCEPTION 'Mission Lane writer deadline expired before critical registration'
        USING ERRCODE = 'PML02';
    END IF;
    PERFORM pg_catalog.set_config('lock_timeout', v_remaining_ms::text || 'ms', true);
    PERFORM pg_catalog.pg_advisory_lock(v_critical_marker_key);
    v_has_critical_marker := true;
  END IF;

  -- A normal caller checks before joining the turnstile and rechecks while
  -- holding it. The second check closes the race where critical work registers
  -- after this fast-path check but before permit promotion.
  IF NOT p_critical AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS pg_lock
     WHERE pg_lock.locktype = 'advisory' AND pg_lock.objsubid = 1
       AND ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint) = v_critical_marker_key
       AND pg_lock.mode = 'ExclusiveLock' AND pg_lock.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'Critical Mission Lane work is pending'
      USING ERRCODE = 'PML02';
  END IF;

  -- Serialize permit handoff for both fast-path and queued callers. Critical
  -- work registers first. A writer never waits for an active permit while
  -- holding the turnstile; it releases the turnstile and retries nonblocking
  -- permit acquisition within the original deadline.
  IF p_critical THEN
    v_remaining_ms := floor(extract(epoch FROM (v_deadline - pg_catalog.clock_timestamp())) * 1000)::integer;
    IF v_remaining_ms < 1 THEN
      RAISE EXCEPTION 'Mission Lane writer deadline expired before the turnstile'
        USING ERRCODE = 'PML02';
    END IF;
    PERFORM pg_catalog.set_config('lock_timeout', v_remaining_ms::text || 'ms', true);
    PERFORM pg_catalog.pg_advisory_lock(v_turnstile_key);
    v_has_turnstile := true;
  ELSE
    v_has_turnstile := pg_catalog.pg_try_advisory_lock(v_turnstile_key);
    IF NOT v_has_turnstile THEN
      v_queue_keys := ARRAY[70463909136610,70463909136611,70463909136612]::bigint[];
      FOREACH v_queue_key IN ARRAY v_queue_keys LOOP
        IF pg_catalog.pg_try_advisory_lock(v_queue_key) THEN
          v_has_queue_slot := true;
          EXIT;
        END IF;
      END LOOP;
      IF NOT v_has_queue_slot THEN
        RAISE EXCEPTION 'Mission Lane writer admission queue is full'
          USING ERRCODE = 'PML01';
      END IF;
      v_remaining_ms := floor(extract(epoch FROM (v_deadline - pg_catalog.clock_timestamp())) * 1000)::integer;
      IF v_remaining_ms < 1 THEN
        RAISE EXCEPTION 'Mission Lane writer deadline expired before the turnstile'
          USING ERRCODE = 'PML02';
      END IF;
      PERFORM pg_catalog.set_config('lock_timeout', v_remaining_ms::text || 'ms', true);
      PERFORM pg_catalog.pg_advisory_lock(v_turnstile_key);
      v_has_turnstile := true;
    END IF;
  END IF;

  LOOP
    IF NOT p_critical AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_locks AS pg_lock
       WHERE pg_lock.locktype = 'advisory' AND pg_lock.objsubid = 1
         AND ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint) = v_critical_marker_key
         AND pg_lock.mode = 'ExclusiveLock' AND pg_lock.pid <> pg_catalog.pg_backend_pid()
    ) THEN
      RAISE EXCEPTION 'Critical Mission Lane work is pending'
        USING ERRCODE = 'PML02';
    END IF;

    FOREACH v_active_key IN ARRAY ARRAY[
      70463909136600,70463909136601,70463909136602,70463909136603
    ]::bigint[] LOOP
      IF pg_catalog.pg_try_advisory_xact_lock(v_active_key) THEN
        v_has_active_permit := true;
        EXIT;
      END IF;
    END LOOP;
    EXIT WHEN v_has_active_permit;

    -- A fast-path normal request must not acquire a queue slot while holding
    -- the turnstile. Yield it, reserve bounded capacity, and rejoin the order.
    IF NOT v_has_queue_slot THEN
      PERFORM pg_catalog.pg_advisory_unlock(v_turnstile_key);
      v_has_turnstile := false;
      v_queue_keys := ARRAY[70463909136610,70463909136611,70463909136612]::bigint[];
      FOREACH v_queue_key IN ARRAY v_queue_keys LOOP
        IF pg_catalog.pg_try_advisory_lock(v_queue_key) THEN
          v_has_queue_slot := true;
          EXIT;
        END IF;
      END LOOP;
      IF NOT v_has_queue_slot THEN
        RAISE EXCEPTION 'Mission Lane writer admission queue is full'
          USING ERRCODE = 'PML01';
      END IF;
      v_remaining_ms := floor(extract(epoch FROM (v_deadline - pg_catalog.clock_timestamp())) * 1000)::integer;
      IF v_remaining_ms < 1 THEN
        RAISE EXCEPTION 'Mission Lane writer deadline expired before queue admission'
          USING ERRCODE = 'PML02';
      END IF;
      PERFORM pg_catalog.set_config('lock_timeout', v_remaining_ms::text || 'ms', true);
      PERFORM pg_catalog.pg_advisory_lock(v_turnstile_key);
      v_has_turnstile := true;
    END IF;

    -- Keep the queue slot, but let pending critical work reach the turnstile.
    PERFORM pg_catalog.pg_advisory_unlock(v_turnstile_key);
    v_has_turnstile := false;
    v_remaining_ms := floor(extract(epoch FROM (v_deadline - pg_catalog.clock_timestamp())) * 1000)::integer;
    IF v_remaining_ms < 1 THEN
      RAISE EXCEPTION 'Mission Lane writer deadline expired before permit acquisition'
        USING ERRCODE = 'PML02';
    END IF;
    PERFORM pg_catalog.pg_sleep(LEAST(v_remaining_ms, 10)::double precision / 1000.0);
    v_remaining_ms := floor(extract(epoch FROM (v_deadline - pg_catalog.clock_timestamp())) * 1000)::integer;
    IF v_remaining_ms < 1 THEN
      RAISE EXCEPTION 'Mission Lane writer deadline expired before turnstile retry'
        USING ERRCODE = 'PML02';
    END IF;
    PERFORM pg_catalog.set_config('lock_timeout', v_remaining_ms::text || 'ms', true);
    PERFORM pg_catalog.pg_advisory_lock(v_turnstile_key);
    v_has_turnstile := true;
  END LOOP;

  -- Queue slots represent callers still pending admission. A writer that now
  -- holds an active transaction permit is no longer pending, even if it must
  -- wait for D5; free its queue capacity before entering the cursor wait.
  IF v_has_queue_slot THEN
    PERFORM pg_catalog.pg_advisory_unlock(v_queue_key);
    v_has_queue_slot := false;
  END IF;

  -- Check a second time immediately before waiting for D5. Any normal request
  -- that lost the priority race aborts before a source or event row is touched.
  IF NOT p_critical AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS pg_lock
     WHERE pg_lock.locktype = 'advisory' AND pg_lock.objsubid = 1
       AND ((pg_lock.classid::bigint << 32) | pg_lock.objid::bigint) = v_critical_marker_key
       AND pg_lock.mode = 'ExclusiveLock' AND pg_lock.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'Critical Mission Lane work is pending'
      USING ERRCODE = 'PML02';
  END IF;

  v_remaining_ms := floor(extract(epoch FROM (v_deadline - pg_catalog.clock_timestamp())) * 1000)::integer;
  IF v_remaining_ms < 1 THEN
    RAISE EXCEPTION 'Mission Lane writer deadline expired before the cursor'
      USING ERRCODE = 'PML02';
  END IF;
  PERFORM pg_catalog.set_config('lock_timeout', v_remaining_ms::text || 'ms', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(v_cursor_key);
  IF pg_catalog.clock_timestamp() >= v_deadline THEN
    RAISE EXCEPTION 'Mission Lane writer deadline expired at the cursor'
      USING ERRCODE = 'PML02';
  END IF;

  PERFORM pg_catalog.pg_advisory_unlock(v_turnstile_key);
  v_has_turnstile := false;
  IF v_has_critical_marker THEN
    PERFORM pg_catalog.pg_advisory_unlock(v_critical_marker_key);
    v_has_critical_marker := false;
  END IF;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  IF v_has_turnstile THEN PERFORM pg_catalog.pg_advisory_unlock(v_turnstile_key); END IF;
  IF v_has_queue_slot THEN PERFORM pg_catalog.pg_advisory_unlock(v_queue_key); END IF;
  IF v_has_critical_marker THEN PERFORM pg_catalog.pg_advisory_unlock(v_critical_marker_key); END IF;
  RAISE;
END
$function$;

REVOKE ALL ON FUNCTION omnis.acquire_mission_lane_admission(boolean,integer)
  FROM PUBLIC, omnis_launcher, omnis_authorizer;
GRANT EXECUTE ON FUNCTION omnis.acquire_mission_lane_admission(boolean,integer) TO omnis_runtime;

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
  p_title text, p_detail text, p_project_id text, p_request_id uuid, p_fingerprint bytea,
  p_remaining_ms integer DEFAULT 3000
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task creation requires the runtime identity' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.acquire_mission_lane_admission(false, p_remaining_ms);
  RETURN omnis.create_task_mission_lane_admission_impl(
    p_title,p_detail,p_project_id,p_request_id,p_fingerprint
  );
END
$function$;
REVOKE ALL ON FUNCTION omnis.create_task_mission_lane_admission_impl(text,text,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.create_task(text,text,text,uuid,bytea,integer)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.create_task(text,text,text,uuid,bytea,integer) TO omnis_runtime;

ALTER FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea)
  RENAME TO set_task_project_mission_lane_admission_impl;
CREATE FUNCTION omnis.set_task_project(
  p_task_id text, p_expected_association_revision integer, p_project_id text,
  p_request_id uuid, p_fingerprint bytea, p_remaining_ms integer DEFAULT 3000
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_runtime' THEN
    RAISE EXCEPTION 'task project changes require the runtime identity' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.acquire_mission_lane_admission(false, p_remaining_ms);
  RETURN omnis.set_task_project_mission_lane_admission_impl(
    p_task_id,p_expected_association_revision,p_project_id,p_request_id,p_fingerprint
  );
END
$function$;
REVOKE ALL ON FUNCTION omnis.set_task_project_mission_lane_admission_impl(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea,integer)
  FROM PUBLIC, omnis_authorizer, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.set_task_project(text,integer,text,uuid,bytea,integer) TO omnis_runtime;

ALTER FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea)
  RENAME TO set_task_epic_mission_lane_admission_impl;
CREATE FUNCTION omnis.set_task_epic(
  p_task_id text, p_expected_association_revision integer, p_epic_id text,
  p_request_id uuid, p_fingerprint bytea, p_remaining_ms integer DEFAULT 3000
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis SET lock_timeout = '3s' AS $function$
BEGIN
  IF session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'task Epic changes require the authorizer identity' USING ERRCODE = '42501';
  END IF;
  PERFORM omnis.acquire_mission_lane_admission(false, p_remaining_ms);
  RETURN omnis.set_task_epic_mission_lane_admission_impl(
    p_task_id,p_expected_association_revision,p_epic_id,p_request_id,p_fingerprint
  );
END
$function$;
REVOKE ALL ON FUNCTION omnis.set_task_epic_mission_lane_admission_impl(text,integer,text,uuid,bytea)
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;
REVOKE ALL ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea,integer)
  FROM PUBLIC, omnis_runtime, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.set_task_epic(text,integer,text,uuid,bytea,integer) TO omnis_authorizer;

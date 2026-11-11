CREATE FUNCTION omnis.require_authorizer_task_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, omnis AS $function$
BEGIN
  IF OLD.status = 'in_review'
     AND NEW.status = 'completed'
     AND session_user <> 'omnis_authorizer' THEN
    RAISE EXCEPTION 'Task result completion requires the owner authorizer'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION omnis.require_authorizer_task_completion()
  FROM PUBLIC, omnis_runtime, omnis_authorizer, omnis_launcher;

CREATE TRIGGER mission_lane_authorizer_task_completion
  BEFORE UPDATE OF status ON omnis.tasks
  FOR EACH ROW EXECUTE FUNCTION omnis.require_authorizer_task_completion();

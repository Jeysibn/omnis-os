REVOKE ALL ON FUNCTION omnis.accept_task_result(text,text,uuid)
  FROM PUBLIC, omnis_runtime, omnis_launcher;
GRANT EXECUTE ON FUNCTION omnis.accept_task_result(text,text,uuid) TO omnis_authorizer;

GRANT EXECUTE ON FUNCTION omnis.acquire_mission_lane_admission(boolean,integer)
  TO omnis_authorizer;

-- Existing application sequences retain the grants from 0003. Future application
-- sequences require an explicit migration grant rather than inheriting runtime access.
ALTER DEFAULT PRIVILEGES FOR ROLE omnis_migrator IN SCHEMA omnis
  REVOKE USAGE, SELECT ON SEQUENCES FROM omnis_runtime;

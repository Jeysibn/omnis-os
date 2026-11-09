import { getGateFailures } from './validation-plan.mjs';

const results = {
  validation_mode: process.env.MODE_RESULT,
  checks_core: process.env.CORE_RESULT,
  frontend_browser: process.env.FRONTEND_RESULT,
  frontend_browser_full_suite: process.env.FRONTEND_FULL_SUITE,
  platform_security: process.env.PLATFORM_RESULT,
  database_integration: process.env.DATABASE_RESULT,
  full_stack_browser_integration: process.env.FULL_STACK_RESULT,
  backup_restore: process.env.BACKUP_RESULT,
  container_images: process.env.CONTAINER_RESULT,
};

const sensitive = {
  security_sensitive: process.env.SECURITY_SENSITIVE === 'true',
  container_sensitive: process.env.CONTAINER_SENSITIVE === 'true',
  database_sensitive: process.env.DATABASE_SENSITIVE === 'true',
  full_stack_sensitive: process.env.FULL_STACK_SENSITIVE === 'true',
  full_frontend_sensitive: process.env.FULL_FRONTEND_SENSITIVE === 'true',
};

const failures = getGateFailures({ mode: process.env.MODE, results, sensitive });
if (failures.length > 0) {
  process.stderr.write(`CI validation gate failed: ${failures.join(', ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`CI validation gate passed in ${process.env.MODE} mode.\n`);
}

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const passwordNames = [
  'OMNIS_CI_POSTGRES_ADMIN_PASSWORD',
  'OMNIS_CI_POSTGRES_MIGRATION_PASSWORD',
  'OMNIS_CI_POSTGRES_RUNTIME_PASSWORD',
  'OMNIS_CI_POSTGRES_AUTHORIZER_PASSWORD',
  'OMNIS_CI_POSTGRES_LAUNCHER_PASSWORD',
];

export function createTestDatabaseEnvironment({
  runId,
  runAttempt,
  job,
  createRandomBytes = randomBytes,
}) {
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt) || !/^[a-z0-9-]+$/.test(job)) {
    throw new Error('CI run identity is not safe for a disposable PostgreSQL container name');
  }

  return {
    OMNIS_CI_POSTGRES_CONTAINER_NAME: `omnis-ci-pg-${runId}-${runAttempt}-${job}`,
    ...Object.fromEntries(
      passwordNames.map((name) => [name, createRandomBytes(32).toString('hex')]),
    ),
  };
}

export function registerTestDatabaseEnvironment(environment, githubEnvPath, stdout) {
  const passwords = Object.entries(environment).filter(([name]) => name.endsWith('_PASSWORD'));
  for (const [, password] of passwords) stdout.write(`::add-mask::${password}\n`);

  appendFileSync(
    githubEnvPath,
    Object.entries(environment)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') + '\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const githubEnvPath = process.env.GITHUB_ENV;
  if (!githubEnvPath)
    throw new Error('GITHUB_ENV is required to register disposable database values');
  const environment = createTestDatabaseEnvironment({
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    job: process.env.GITHUB_JOB,
  });
  registerTestDatabaseEnvironment(environment, githubEnvPath, process.stdout);
}

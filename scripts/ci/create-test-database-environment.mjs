import { appendFileSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
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

export function registerTestDatabaseEnvironment(
  environment,
  githubEnvPath,
  credentialsFilePath,
  stdout,
) {
  const passwords = Object.entries(environment).filter(([name]) => name.endsWith('_PASSWORD'));
  for (const [, password] of passwords) stdout.write(`::add-mask::${password}\n`);

  try {
    writeFileSync(
      credentialsFilePath,
      passwords.map(([name, value]) => `${name}=${value}`).join('\n') + '\n',
      { mode: 0o600 },
    );
    chmodSync(credentialsFilePath, 0o600);

    appendFileSync(
      githubEnvPath,
      [
        `OMNIS_CI_POSTGRES_CONTAINER_NAME=${environment.OMNIS_CI_POSTGRES_CONTAINER_NAME}`,
        `OMNIS_CI_POSTGRES_ENV_FILE=${credentialsFilePath}`,
      ].join('\n') + '\n',
    );
  } catch (error) {
    rmSync(credentialsFilePath, { force: true });
    throw error;
  }
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
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error('RUNNER_TEMP is required for disposable database credentials');
  const credentialsFilePath = `${runnerTemp}/omnis-ci-db-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.env.GITHUB_JOB}.env`;
  registerTestDatabaseEnvironment(environment, githubEnvPath, credentialsFilePath, process.stdout);
}

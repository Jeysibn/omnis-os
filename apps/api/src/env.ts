import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { validateApiAuthorizerConfiguration, validateApiNetwork } from './deployment-config.ts';
import {
  executionModeFromEnvironment,
  restrictedDevelopmentFromEnvironment,
  validateRestrictedDevelopmentConfiguration,
} from '@omnis/contracts/execution-mode';

const sessionSecret = process.env.OMNIS_SESSION_SECRET;
const ownerPasswordHash = process.env.OMNIS_OWNER_PASSWORD_HASH;
const internalToken = process.env.OMNIS_INTERNAL_TOKEN;
const authorizerToken = process.env.OMNIS_API_AUTHORIZER_TOKEN;
const authorizerSocketValue = process.env.OMNIS_AUTHORIZER_SOCKET;
const restrictedDevelopment = restrictedDevelopmentFromEnvironment(
  process.env.OMNIS_RESTRICTED_DEVELOPMENT,
);
const executionMode = executionModeFromEnvironment(process.env.OMNIS_EXECUTION_MODE);
validateRestrictedDevelopmentConfiguration({
  restrictedDevelopment,
  configuredMode: executionMode,
  rawMode: process.env.OMNIS_EXECUTION_MODE,
  authorizerToken,
  authorizerSocket: authorizerSocketValue,
  launcherSocket: process.env.OMNIS_SANDBOX_LAUNCHER_SOCKET,
  authorizerSecrets: [
    process.env.OMNIS_AUTHORIZER_DB_PASSWORD,
    process.env.OMNIS_AUTHORIZER_DATABASE_URL,
    process.env.OMNIS_AGENT_IDEMPOTENCY_KEY,
    process.env.OMNIS_CONNECTOR_DECISION_KEY_FILE,
    process.env.OMNIS_BROKER_AUTHORIZER_TOKEN,
  ],
});
const testSessionMaxAgeSeconds = parseTestSessionMaxAgeSeconds(process.env);

if (!sessionSecret || sessionSecret.length < 64) {
  throw new Error('OMNIS_SESSION_SECRET must be generated with `pnpm configure:owner`.');
}
if (!ownerPasswordHash || !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(ownerPasswordHash)) {
  throw new Error('OMNIS_OWNER_PASSWORD_HASH is missing or invalid. Run `pnpm configure:owner`.');
}
if (!internalToken || internalToken.length < 64) {
  throw new Error('OMNIS_INTERNAL_TOKEN must be generated with `pnpm configure:owner`.');
}
validateApiAuthorizerConfiguration({
  restrictedDevelopment,
  token: authorizerToken,
  internalToken,
  socket: authorizerSocketValue,
});

const apiPort = Number(process.env.OMNIS_API_PORT ?? 4100);
const workerPort = Number(process.env.OMNIS_WORKER_PORT ?? 4101);
const workerHost = process.env.OMNIS_WORKER_HOST ?? '127.0.0.1';
const privateCompose = process.env.OMNIS_COMPOSE_PRIVATE === 'true';
const authorizerSocket = restrictedDevelopment
  ? undefined
  : validateAuthorizerSocket(authorizerSocketValue);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)
  throw new Error('OMNIS_API_PORT is invalid.');
if (!Number.isInteger(workerPort) || workerPort < 1 || workerPort > 65535)
  throw new Error('OMNIS_WORKER_PORT is invalid.');
validateApiNetwork(process.env.OMNIS_API_HOST ?? '127.0.0.1', workerHost, privateCompose);
export const env = {
  host: process.env.OMNIS_API_HOST ?? '127.0.0.1',
  port: apiPort,
  allowedOrigin: process.env.OMNIS_ALLOWED_ORIGIN ?? 'http://127.0.0.1:5173',
  sessionSecret,
  ownerPasswordHash,
  internalToken,
  authorizerToken,
  restrictedDevelopment,
  executionMode,
  workerUrl: `http://${workerHost}:${workerPort}`,
  authorizerSocket,
  secureCookies: process.env.OMNIS_SECURE_COOKIES === 'true',
  sessionMaxAgeSeconds: testSessionMaxAgeSeconds,
};

function parseTestSessionMaxAgeSeconds(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment.OMNIS_TEST_SESSION_MAX_AGE_SECONDS;
  if (value === undefined) return undefined;
  if (environment.OMNIS_CI_DISPOSABLE !== 'true' || !/^\d+$/.test(value)) {
    throw new Error(
      'OMNIS_TEST_SESSION_MAX_AGE_SECONDS is available only in the disposable CI harness.',
    );
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 8 * 60 * 60) {
    throw new Error('OMNIS_TEST_SESSION_MAX_AGE_SECONDS must be between 1 and 28800.');
  }
  return seconds;
}

export function validateAuthorizerSocket(value: string | undefined): string {
  if (
    !value ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes('\0')
  ) {
    throw new Error(
      'OMNIS_AUTHORIZER_SOCKET must be configured as an absolute private socket path.',
    );
  }
  if (value === '/run/omnis-authorizer/authorizer.sock') return value;

  const parent = path.dirname(value);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch {
    throw new Error('A custom authorizer socket must be inside an existing private directory.');
  }
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent ||
    parentStat.uid !== (process.getuid?.() ?? -1) ||
    (parentStat.mode & 0o077) !== 0
  ) {
    throw new Error(
      'A custom authorizer socket directory must be private to this process identity.',
    );
  }
  return value;
}

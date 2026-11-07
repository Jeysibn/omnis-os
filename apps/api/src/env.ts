import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { validateApiNetwork } from './deployment-config.ts';

const sessionSecret = process.env.OMNIS_SESSION_SECRET;
const ownerPasswordHash = process.env.OMNIS_OWNER_PASSWORD_HASH;
const internalToken = process.env.OMNIS_INTERNAL_TOKEN;
const authorizerToken = process.env.OMNIS_API_AUTHORIZER_TOKEN;

if (!sessionSecret || sessionSecret.length < 64) {
  throw new Error('OMNIS_SESSION_SECRET must be generated with `pnpm configure:owner`.');
}
if (!ownerPasswordHash || !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(ownerPasswordHash)) {
  throw new Error('OMNIS_OWNER_PASSWORD_HASH is missing or invalid. Run `pnpm configure:owner`.');
}
if (!internalToken || internalToken.length < 64) {
  throw new Error('OMNIS_INTERNAL_TOKEN must be generated with `pnpm configure:owner`.');
}
if (!authorizerToken || authorizerToken.length < 64 || authorizerToken === internalToken) {
  throw new Error(
    'A separate OMNIS_API_AUTHORIZER_TOKEN must be generated with `pnpm configure:owner`.',
  );
}

const apiPort = Number(process.env.OMNIS_API_PORT ?? 4100);
const workerPort = Number(process.env.OMNIS_WORKER_PORT ?? 4101);
const workerHost = process.env.OMNIS_WORKER_HOST ?? '127.0.0.1';
const privateCompose = process.env.OMNIS_COMPOSE_PRIVATE === 'true';
const authorizerSocket = validateAuthorizerSocket(process.env.OMNIS_AUTHORIZER_SOCKET);
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
  workerUrl: `http://${workerHost}:${workerPort}`,
  authorizerSocket,
  secureCookies: process.env.OMNIS_SECURE_COOKIES === 'true',
};

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

const sessionSecret = process.env.OMNIS_SESSION_SECRET;
const ownerPasswordHash = process.env.OMNIS_OWNER_PASSWORD_HASH;
const internalToken = process.env.OMNIS_INTERNAL_TOKEN;

if (!sessionSecret || sessionSecret.length < 64) {
  throw new Error('OMNIS_SESSION_SECRET must be generated with `pnpm configure:owner`.');
}
if (!ownerPasswordHash || !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(ownerPasswordHash)) {
  throw new Error('OMNIS_OWNER_PASSWORD_HASH is missing or invalid. Run `pnpm configure:owner`.');
}
if (!internalToken || internalToken.length < 64) {
  throw new Error('OMNIS_INTERNAL_TOKEN must be generated with `pnpm configure:owner`.');
}

const apiPort = Number(process.env.OMNIS_API_PORT ?? 4100);
const workerPort = Number(process.env.OMNIS_WORKER_PORT ?? 4101);
const workerHost = process.env.OMNIS_WORKER_HOST ?? '127.0.0.1';
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)
  throw new Error('OMNIS_API_PORT is invalid.');
if (!Number.isInteger(workerPort) || workerPort < 1 || workerPort > 65535)
  throw new Error('OMNIS_WORKER_PORT is invalid.');
if (!['127.0.0.1', '::1', 'localhost'].includes(workerHost)) {
  throw new Error('The initial Omnis OS worker must bind to loopback.');
}

export const env = {
  host: process.env.OMNIS_API_HOST ?? '127.0.0.1',
  port: apiPort,
  allowedOrigin: process.env.OMNIS_ALLOWED_ORIGIN ?? 'http://127.0.0.1:5173',
  sessionSecret,
  ownerPasswordHash,
  internalToken,
  workerUrl: `http://${workerHost}:${workerPort}`,
  secureCookies: process.env.OMNIS_SECURE_COOKIES === 'true',
};

if (env.host !== '127.0.0.1' && env.host !== '::1' && env.host !== 'localhost') {
  throw new Error('The initial Omnis OS API must bind to loopback.');
}

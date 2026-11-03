import path from 'node:path';

const socketPath = process.env.OMNIS_AUTHORIZER_SOCKET ?? '/run/omnis-authorizer/authorizer.sock';
const serviceToken = process.env.OMNIS_API_AUTHORIZER_TOKEN;
const password = process.env.OMNIS_AUTHORIZER_DB_PASSWORD;
const configuredDatabaseUrl = process.env.OMNIS_AUTHORIZER_DATABASE_URL;

if (!path.isAbsolute(socketPath)) throw new Error('Authorizer socket path must be absolute.');
if (!serviceToken || serviceToken.length < 64) {
  throw new Error('OMNIS_API_AUTHORIZER_TOKEN must be generated with `pnpm configure:owner`.');
}
if (!configuredDatabaseUrl && (!password || password.length < 32)) {
  throw new Error('OMNIS_AUTHORIZER_DB_PASSWORD must be configured for the authorizer.');
}

const databaseUrl = configuredDatabaseUrl;
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (parsed.username !== 'omnis_authorizer') {
    throw new Error('The authorizer database connection must use the omnis_authorizer role.');
  }
  if (!['127.0.0.1', '::1', 'localhost', 'postgres'].includes(parsed.hostname)) {
    throw new Error('The authorizer database must use approved local Compose networking.');
  }
}

export const env = {
  socketPath,
  serviceToken,
  databaseUrl:
    databaseUrl ??
    `postgresql://omnis_authorizer:${encodeURIComponent(password!)}@${process.env.OMNIS_DB_HOST ?? '127.0.0.1'}:${process.env.OMNIS_DB_PORT ?? '5432'}/${process.env.OMNIS_DB_NAME ?? 'omnis'}`,
};

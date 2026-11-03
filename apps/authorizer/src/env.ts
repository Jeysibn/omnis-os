const port = Number(process.env.OMNIS_AUTHORIZER_PORT ?? 4102);
const host = process.env.OMNIS_AUTHORIZER_HOST ?? '127.0.0.1';
const serviceToken = process.env.OMNIS_API_AUTHORIZER_TOKEN;
const password = process.env.OMNIS_AUTHORIZER_DB_PASSWORD;
const configuredDatabaseUrl = process.env.OMNIS_AUTHORIZER_DATABASE_URL;

if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error(
    'The authorizer must bind to loopback until a private authenticated transport is configured.',
  );
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('OMNIS_AUTHORIZER_PORT must be a valid TCP port.');
}
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
  host,
  port,
  serviceToken,
  databaseUrl:
    databaseUrl ??
    `postgresql://omnis_authorizer:${encodeURIComponent(password!)}@${process.env.OMNIS_DB_HOST ?? '127.0.0.1'}:${process.env.OMNIS_DB_PORT ?? '5432'}/${process.env.OMNIS_DB_NAME ?? 'omnis'}`,
};

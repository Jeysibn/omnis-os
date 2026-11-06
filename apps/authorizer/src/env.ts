import path from 'node:path';

const socketPath = process.env.OMNIS_AUTHORIZER_SOCKET ?? '/run/omnis-authorizer/authorizer.sock';
const brokerSocketPath = process.env.OMNIS_BROKER_AUTHORIZER_SOCKET;
const serviceToken = process.env.OMNIS_API_AUTHORIZER_TOKEN;
const brokerServiceToken = process.env.OMNIS_BROKER_AUTHORIZER_TOKEN;
const decisionSigningKeyFile = process.env.OMNIS_CONNECTOR_DECISION_KEY_FILE;
const decisionSigningKeyId = process.env.OMNIS_CONNECTOR_DECISION_KEY_ID;
const decisionSigningKeyNotBefore = process.env.OMNIS_CONNECTOR_DECISION_KEY_NOT_BEFORE;
const decisionSigningKeyNotAfter = process.env.OMNIS_CONNECTOR_DECISION_KEY_NOT_AFTER;
const password = process.env.OMNIS_AUTHORIZER_DB_PASSWORD;
const configuredDatabaseUrl = process.env.OMNIS_AUTHORIZER_DATABASE_URL;
const configuredIdempotencyKey = process.env.OMNIS_AGENT_IDEMPOTENCY_KEY;
const configuredIdempotencyKeyVersion = Number(
  process.env.OMNIS_AGENT_IDEMPOTENCY_KEY_VERSION ?? '1',
);

if (!path.isAbsolute(socketPath)) throw new Error('Authorizer socket path must be absolute.');
const brokerConfiguration = [
  brokerSocketPath,
  brokerServiceToken,
  decisionSigningKeyFile,
  decisionSigningKeyId,
  decisionSigningKeyNotBefore,
  decisionSigningKeyNotAfter,
];
const brokerConfigurationCount = brokerConfiguration.filter(Boolean).length;
if (brokerConfigurationCount !== 0 && brokerConfigurationCount !== brokerConfiguration.length) {
  throw new Error(
    'Synthetic broker authorizer IPC requires all broker socket and signing settings.',
  );
}
if (!serviceToken || serviceToken.length < 64) {
  throw new Error('OMNIS_API_AUTHORIZER_TOKEN must be generated with `pnpm configure:owner`.');
}
if (
  brokerConfigurationCount &&
  (!brokerServiceToken ||
    !/^[a-f0-9]{64,128}$/i.test(brokerServiceToken) ||
    brokerServiceToken === serviceToken)
) {
  throw new Error('OMNIS_BROKER_AUTHORIZER_TOKEN must be distinct and at least 256 bits.');
}
if (brokerSocketPath && !path.isAbsolute(brokerSocketPath)) {
  throw new Error('Broker authorizer socket path must be absolute.');
}
if (brokerSocketPath === socketPath) {
  throw new Error('Broker and API authorizer sockets must be different paths.');
}
if (decisionSigningKeyFile && !path.isAbsolute(decisionSigningKeyFile)) {
  throw new Error('Connector decision signing key path must be absolute.');
}
const brokerSocketMode = Number.parseInt(
  process.env.OMNIS_BROKER_AUTHORIZER_SOCKET_MODE ?? '600',
  8,
);
if (![0o600, 0o660].includes(brokerSocketMode)) {
  throw new Error('Broker authorizer socket mode must be 600 or 660.');
}
if (!configuredDatabaseUrl && (!password || password.length < 32)) {
  throw new Error('OMNIS_AUTHORIZER_DB_PASSWORD must be configured for the authorizer.');
}
if (!configuredIdempotencyKey || !/^[0-9a-f]{64}$/i.test(configuredIdempotencyKey)) {
  throw new Error('OMNIS_AGENT_IDEMPOTENCY_KEY must be a generated 256-bit hexadecimal key.');
}
if (!Number.isSafeInteger(configuredIdempotencyKeyVersion) || configuredIdempotencyKeyVersion < 1) {
  throw new Error('OMNIS_AGENT_IDEMPOTENCY_KEY_VERSION must be a positive integer.');
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
  brokerSocketPath,
  serviceToken,
  brokerServiceToken,
  decisionSigningKeyFile,
  decisionSigningKeyId,
  decisionSigningKeyNotBefore,
  decisionSigningKeyNotAfter,
  brokerSocketMode,
  databaseUrl:
    databaseUrl ??
    `postgresql://omnis_authorizer:${encodeURIComponent(password!)}@${process.env.OMNIS_DB_HOST ?? '127.0.0.1'}:${process.env.OMNIS_DB_PORT ?? '5432'}/${process.env.OMNIS_DB_NAME ?? 'omnis'}`,
  agentIdempotencyKey: Buffer.from(configuredIdempotencyKey, 'hex'),
  agentIdempotencyKeyVersion: configuredIdempotencyKeyVersion,
};

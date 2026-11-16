import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OMNIS_SESSION_SECRET = 'restricted-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH = `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN = 'restricted-worker-token-'.padEnd(64, 'x');
process.env.OMNIS_RESTRICTED_DEVELOPMENT = 'true';
process.env.OMNIS_EXECUTION_MODE = 'disabled';
delete process.env.OMNIS_API_AUTHORIZER_TOKEN;
delete process.env.OMNIS_AUTHORIZER_SOCKET;
delete process.env.OMNIS_SANDBOX_LAUNCHER_SOCKET;
delete process.env.OMNIS_AUTHORIZER_DB_PASSWORD;
delete process.env.OMNIS_AUTHORIZER_DATABASE_URL;
delete process.env.OMNIS_AGENT_IDEMPOTENCY_KEY;
delete process.env.OMNIS_CONNECTOR_DECISION_KEY_FILE;
delete process.env.OMNIS_BROKER_AUTHORIZER_TOKEN;

const { env } = await import('./env.ts');

test('restricted API startup requires no Authorizer or launcher configuration', () => {
  assert.equal(env.restrictedDevelopment, true);
  assert.equal(env.executionMode, 'disabled');
  assert.equal(env.authorizerToken, undefined);
  assert.equal(env.authorizerSocket, undefined);
});

import assert from 'node:assert/strict';
import Fastify, { type preHandlerHookHandler } from 'fastify';
import test from 'node:test';

process.env.OMNIS_SESSION_SECRET = 'restricted-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH = `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN = 'restricted-worker-token-'.padEnd(64, 'x');
process.env.OMNIS_RESTRICTED_DEVELOPMENT = 'true';
process.env.OMNIS_EXECUTION_MODE = 'disabled';
delete process.env.OMNIS_API_AUTHORIZER_TOKEN;
delete process.env.OMNIS_AUTHORIZER_SOCKET;
delete process.env.OMNIS_SANDBOX_LAUNCHER_SOCKET;

const { requireAuthorizerFeature } = await import('./auth.ts');

test('Authorizer-backed routes preserve owner and CSRF checks before returning unavailable', async () => {
  const app = Fastify();
  let handlerCalls = 0;
  const requireOwner: preHandlerHookHandler = async (request, reply) => {
    if (request.headers['x-test-owner'] !== 'owner') {
      return reply.code(401).send({ error: { code: 'unauthorized' } });
    }
  };
  const requireCsrf: preHandlerHookHandler = async (request, reply) => {
    if (request.headers['x-test-csrf'] !== 'valid') {
      return reply.code(403).send({ error: { code: 'csrf_rejected' } });
    }
  };
  app.get(
    '/api/v1/authorizer-backed',
    { preHandler: [requireOwner, requireCsrf, requireAuthorizerFeature] },
    async () => {
      handlerCalls += 1;
      return { ok: true };
    },
  );

  try {
    const anonymous = await app.inject({ url: '/api/v1/authorizer-backed' });
    assert.equal(anonymous.statusCode, 401);
    const csrfDenied = await app.inject({
      url: '/api/v1/authorizer-backed',
      headers: { 'x-test-owner': 'owner' },
    });
    assert.equal(csrfDenied.statusCode, 403);
    const unavailable = await app.inject({
      url: '/api/v1/authorizer-backed',
      headers: { 'x-test-owner': 'owner', 'x-test-csrf': 'valid' },
    });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().error.code, 'authorizer_unavailable');
    assert.equal(handlerCalls, 0);
  } finally {
    await app.close();
  }
});

import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  AuthorizationDecisionSchema,
  AuthorizationSchema,
  CreateAuthorizationSchema,
  type Authorization,
} from '@omnis/contracts';

export type AuthorizerStore = {
  request(taskId: string, actor: 'owner', correlationId: string): Promise<Authorization>;
  decide(id: string, actor: 'owner', decision: 'approve' | 'deny'): Promise<Authorization>;
  revoke(id: string, actor: 'owner'): Promise<Authorization>;
  get(id: string): Promise<Authorization | undefined>;
};

export function createAuthorizerApp(input: {
  store: AuthorizerStore;
  serviceToken: string;
  checkDatabase: () => Promise<void>;
}): FastifyInstance {
  const app = Fastify({
    logger: { redact: ['req.headers.x-omnis-authorizer-token', 'req.headers.cookie'] },
  });

  app.get('/internal/v1/health', async (_request, reply) => {
    try {
      await input.checkDatabase();
      return { status: 'ok', product: 'Omnis OS', service: 'authorizer' };
    } catch {
      return reply.code(503).send({
        error: {
          code: 'authorizer_unavailable',
          message: 'The authorization store is unavailable.',
        },
      });
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.url === '/internal/v1/health') return;
    const supplied = request.headers['x-omnis-authorizer-token'];
    const candidate = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
    const expected = Buffer.from(input.serviceToken);
    const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (!matches) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'Control-plane authentication failed.' },
      });
    }
  });

  app.post('/internal/v1/authorizations', async (request, reply) => {
    const parsed = CreateAuthorizationSchema.safeParse(request.body);
    const requestId = request.headers['idempotency-key'];
    if (!parsed.success || typeof requestId !== 'string' || !isUuid(requestId)) {
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Authorization request is invalid.' },
      });
    }
    try {
      const authorization = await input.store.request(parsed.data.taskId, 'owner', requestId);
      return reply.code(201).send(AuthorizationSchema.parse(authorization));
    } catch (error) {
      return sendStoreError(error, reply);
    }
  });

  app.get<{ Params: { authorizationId: string } }>(
    '/internal/v1/authorizations/:authorizationId',
    async (request, reply) => {
      if (!isUuid(request.params.authorizationId)) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_input', message: 'Authorization ID is invalid.' } });
      }
      const authorization = await input.store.get(request.params.authorizationId);
      return authorization
        ? AuthorizationSchema.parse(authorization)
        : reply
            .code(404)
            .send({ error: { code: 'not_found', message: 'Authorization was not found.' } });
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/internal/v1/authorizations/:authorizationId/decision',
    async (request, reply) => {
      const parsed = AuthorizationDecisionSchema.safeParse(request.body);
      if (!parsed.success || !isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Authorization decision is invalid.' },
        });
      }
      try {
        const authorization = await input.store.decide(
          request.params.authorizationId,
          'owner',
          parsed.data.decision,
        );
        return AuthorizationSchema.parse(authorization);
      } catch (error) {
        return sendStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/internal/v1/authorizations/:authorizationId/revoke',
    async (request, reply) => {
      if (!isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Authorization ID is invalid.' },
        });
      }
      try {
        const authorization = await input.store.revoke(request.params.authorizationId, 'owner');
        return AuthorizationSchema.parse(authorization);
      } catch (error) {
        return sendStoreError(error, reply);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Authorizer request failed.',
    );
    const decisionOutcomeUnknown =
      request.method !== 'GET' && request.url.startsWith('/internal/v1/authorizations');
    return reply.code(503).send({
      error: {
        code: decisionOutcomeUnknown ? 'authorization_outcome_unknown' : 'authorizer_unavailable',
        message: decisionOutcomeUnknown
          ? 'The authorizer could not confirm whether the decision committed. Read the authorization state or retry with the same idempotency key.'
          : 'The authorization store is unavailable.',
      },
    });
  });

  return app;
}

function sendStoreError(error: unknown, reply: FastifyReply) {
  if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
    return reply.code(503).send({
      error: {
        code: 'authorization_busy',
        message:
          'The authorization change was not committed because its database row is busy. Retry.',
      },
    });
  }
  if (error instanceof Error && error.message === 'Authorization task was not found.') {
    return reply.code(404).send({ error: { code: 'not_found', message: error.message } });
  }
  if (
    error instanceof Error &&
    (error.message.includes('Authorization is missing') ||
      error.message.includes('Only an active') ||
      error.message.includes('idempotency key belongs'))
  ) {
    return reply.code(409).send({
      error: {
        code: 'invalid_transition',
        message: 'Authorization state does not allow this operation.',
      },
    });
  }
  throw error;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

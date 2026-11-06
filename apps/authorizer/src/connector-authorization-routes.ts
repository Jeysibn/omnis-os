import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ConnectorAuthorizationDecisionSchema,
  ConnectorAuthorizationRequestSchema,
  ConnectorAuthorizationSchema,
} from '@omnis/contracts/connector-authorization';
import {
  ConnectorAuthorizationStoreError,
  type PostgresConnectorAuthorizationStore,
} from '@omnis/db';

export type ConnectorAuthorizerStore = Pick<
  PostgresConnectorAuthorizationStore,
  'request' | 'get' | 'decide' | 'revoke'
>;

export function registerConnectorAuthorizationRoutes(
  app: FastifyInstance,
  store: ConnectorAuthorizerStore,
): void {
  app.post('/internal/v1/connector-authorizations', async (request, reply) => {
    const parsed = ConnectorAuthorizationRequestSchema.safeParse(request.body);
    const requestId = request.headers['idempotency-key'];
    if (!parsed.success || typeof requestId !== 'string' || !isUuid(requestId)) {
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Connector authorization request is invalid.' },
      });
    }
    try {
      const authorization = await store.request(parsed.data, requestId);
      return reply.code(201).send(ConnectorAuthorizationSchema.parse(authorization));
    } catch (error) {
      return sendConnectorStoreError(error, reply);
    }
  });

  app.get<{ Params: { authorizationId: string } }>(
    '/internal/v1/connector-authorizations/:authorizationId',
    async (request, reply) => {
      if (!isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Connector authorization ID is invalid.' },
        });
      }
      const authorization = await store.get(request.params.authorizationId);
      return authorization
        ? ConnectorAuthorizationSchema.parse(authorization)
        : reply.code(404).send({
            error: { code: 'not_found', message: 'Connector authorization was not found.' },
          });
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/internal/v1/connector-authorizations/:authorizationId/decision',
    async (request, reply) => {
      const parsed = ConnectorAuthorizationDecisionSchema.safeParse(request.body);
      if (!parsed.success || !isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Connector authorization decision is invalid.' },
        });
      }
      try {
        const authorization = await store.decide(
          request.params.authorizationId,
          'owner',
          parsed.data,
        );
        return ConnectorAuthorizationSchema.parse(authorization);
      } catch (error) {
        return sendConnectorStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/internal/v1/connector-authorizations/:authorizationId/revoke',
    async (request, reply) => {
      if (!isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Connector authorization ID is invalid.' },
        });
      }
      try {
        const authorization = await store.revoke(request.params.authorizationId, 'owner');
        return ConnectorAuthorizationSchema.parse(authorization);
      } catch (error) {
        return sendConnectorStoreError(error, reply);
      }
    },
  );
}

function sendConnectorStoreError(error: unknown, reply: FastifyReply) {
  if (error instanceof ConnectorAuthorizationStoreError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message },
    });
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
    return reply.code(503).send({
      error: { code: 'authorization_busy', message: 'Retry the connector authorization change.' },
    });
  }
  throw error;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

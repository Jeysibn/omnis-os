import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  BrokerAttemptResponseSchema,
  BrokerBeginSubmissionRequestSchema,
  BrokerConsumeRequestSchema,
  BrokerConsumeResponseSchema,
  BrokerRecoveryRequestSchema,
  BrokerRecoveryResponseSchema,
  BrokerRecordEventRequestSchema,
} from '@omnis/contracts/broker-ipc';
import type {
  ConnectorAuthorizationRequest,
  ConnectorExecutionAttempt,
} from '@omnis/contracts/connector-authorization';
import type {
  ConnectorDecisionEnvelope,
  SyntheticProviderEvent,
} from '@omnis/contracts/connector-broker';
import { ConnectorAuthorizationStoreError, type BrokerAdmission } from '@omnis/db';

export type BrokerIpcStore = {
  consumeForBroker(
    authorizationId: string,
    request: ConnectorAuthorizationRequest,
    requestId: string,
  ): Promise<BrokerAdmission>;
  beginSyntheticSubmission(
    attemptId: string,
    envelope: ConnectorDecisionEnvelope,
    renderedRequest: string,
  ): Promise<ConnectorExecutionAttempt>;
  recordSyntheticProviderEvent(
    attemptId: string,
    event: SyntheticProviderEvent,
  ): Promise<ConnectorExecutionAttempt>;
  listBrokerRecoveryCandidates(
    limit: number,
    afterAttemptId: string | null,
  ): Promise<ConnectorExecutionAttempt[]>;
};

const brokerIdentity = 'omnis-synthetic-broker';

/** A broker-only HTTP surface intended to listen on a separately ACLed Unix socket. */
export function createBrokerAuthorizerIpcApp(input: {
  store: BrokerIpcStore;
  brokerServiceToken: string;
  apiServiceToken: string;
}): FastifyInstance {
  if (
    !/^[a-f0-9]{64,128}$/i.test(input.brokerServiceToken) ||
    input.brokerServiceToken === input.apiServiceToken
  ) {
    throw new Error('Broker authorizer IPC requires a distinct 256-bit service token.');
  }

  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: {
      redact: ['req.headers.authorization', 'req.headers.x-omnis-service-identity'],
    },
  });

  app.addHook('preHandler', async (request, reply) => {
    const identity = request.headers['x-omnis-service-identity'];
    const authorization = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${input.brokerServiceToken}`);
    const candidate =
      typeof authorization === 'string' ? Buffer.from(authorization) : Buffer.alloc(0);
    const tokenMatches =
      candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (identity !== brokerIdentity || !tokenMatches) {
      return reply.code(401).send({
        error: { code: 'unauthorized_broker', message: 'Broker IPC authentication failed.' },
      });
    }
  });

  app.post('/internal/broker/v1/admissions', async (request, reply) => {
    const parsed = BrokerConsumeRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply);
    try {
      const admission = await input.store.consumeForBroker(
        parsed.data.authorizationId,
        parsed.data.request,
        parsed.data.requestId,
      );
      return BrokerConsumeResponseSchema.parse({ version: parsed.data.version, ...admission });
    } catch (error) {
      return sendBrokerStoreError(error, reply);
    }
  });

  app.post('/internal/broker/v1/submissions/begin', async (request, reply) => {
    const parsed = BrokerBeginSubmissionRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply);
    try {
      const attempt = await input.store.beginSyntheticSubmission(
        parsed.data.attemptId,
        parsed.data.envelope,
        parsed.data.renderedRequest,
      );
      return BrokerAttemptResponseSchema.parse({ version: parsed.data.version, attempt });
    } catch (error) {
      return sendBrokerStoreError(error, reply);
    }
  });

  app.post('/internal/broker/v1/provider-events', async (request, reply) => {
    const parsed = BrokerRecordEventRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply);
    try {
      const attempt = await input.store.recordSyntheticProviderEvent(
        parsed.data.attemptId,
        parsed.data.event,
      );
      return BrokerAttemptResponseSchema.parse({ version: parsed.data.version, attempt });
    } catch (error) {
      return sendBrokerStoreError(error, reply);
    }
  });

  app.post('/internal/broker/v1/recovery/list', async (request, reply) => {
    const parsed = BrokerRecoveryRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply);
    try {
      const attempts = await input.store.listBrokerRecoveryCandidates(
        parsed.data.limit,
        parsed.data.afterAttemptId,
      );
      return BrokerRecoveryResponseSchema.parse({ version: parsed.data.version, attempts });
    } catch (error) {
      return sendBrokerStoreError(error, reply);
    }
  });

  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'Broker IPC operation not found.' } }),
  );
  app.setErrorHandler((error, _request, reply) => {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      if (error.statusCode === 400 || error.statusCode === 413) {
        return reply.code(error.statusCode).send({
          error: { code: 'invalid_input', message: 'Broker IPC request is invalid.' },
        });
      }
    }
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Broker authorizer IPC failed.',
    );
    return reply.code(503).send({
      error: {
        code: 'authorization_outcome_unknown',
        message: 'The authorizer could not confirm the durable operation result.',
      },
    });
  });

  return app;
}

function invalidInput(reply: FastifyReply) {
  return reply
    .code(400)
    .send({ error: { code: 'invalid_input', message: 'Broker IPC request is invalid.' } });
}

function sendBrokerStoreError(error: unknown, reply: FastifyReply) {
  if (error instanceof ConnectorAuthorizationStoreError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: 'Broker authorization operation was rejected.' },
    });
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
    return reply.code(503).send({
      error: {
        code: 'authorization_busy',
        message: 'The authorization store is busy; no provider submission is permitted.',
      },
    });
  }
  throw error;
}

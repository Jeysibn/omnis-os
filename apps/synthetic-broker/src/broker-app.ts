import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ConnectorAuthorizationRequestSchema,
  createRenderedRequestDigest,
} from '@omnis/contracts/connector-authorization';
import {
  verifyConnectorDecisionEnvelope,
  type ConnectorDecisionEnvelope,
  type VerificationKey,
} from '@omnis/contracts/connector-broker';
import { SyntheticFakeProviderSubmissionResponseSchema } from '@omnis/contracts/broker-ipc';
import type { AuthorizerClient } from './authorizer-client.ts';
import { FakeProviderResponseError, type FakeProviderClient } from './fake-provider-client.ts';
import { reconcileAttempt } from './reconcile-attempt.ts';

const RequestSchema = z
  .object({
    version: z.literal('omnis.synthetic-broker.v1'),
    authorizationId: z.string().uuid(),
    requestId: z.string().uuid(),
    request: ConnectorAuthorizationRequestSchema,
    renderedRequest: z
      .string()
      .min(1)
      .max(32_000)
      .refine((value) => !value.includes('\0') && value.trim().length > 0),
  })
  .strict();

export function createSyntheticBrokerApp(input: {
  callerToken: string;
  brokerInstanceId?: string;
  verificationKeys: VerificationKey[];
  authorizer: Pick<AuthorizerClient, 'admit' | 'begin' | 'record' | 'claim'> &
    Partial<Pick<AuthorizerClient, 'lookup'>>;
  provider: Pick<FakeProviderClient, 'submit' | 'events'> & {
    cancel?: FakeProviderClient['cancel'];
  };
}) {
  const { callerToken, verificationKeys, authorizer, provider } = input;
  const brokerInstanceId = input.brokerInstanceId ?? randomUUID();

  const busyAttempts = new Set<string>();
  let activeSubmissions = 0;
  let activeProjections = 0;

  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: false,
    disableRequestLogging: true,
  });

  app.addHook('preHandler', async (request, reply) => {
    const header = request.headers.authorization;
    if (header !== `Bearer ${callerToken}`) {
      return reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Broker authentication failed.' } });
    }
  });

  async function handleSubmission(
    request: FastifyRequest,
    reply: FastifyReply,
    projectionOnly: boolean,
  ) {
    const parsed = (
      projectionOnly ? RequestSchema.omit({ renderedRequest: true }) : RequestSchema
    ).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_input' } });
    const input = {
      ...parsed.data,
      renderedRequest:
        'renderedRequest' in parsed.data && typeof parsed.data.renderedRequest === 'string'
          ? parsed.data.renderedRequest
          : '',
    };
    if (
      !projectionOnly &&
      createRenderedRequestDigest(input.renderedRequest) !== input.request.promptDigest
    ) {
      return reply.code(403).send({ error: { code: 'request_binding_failed' } });
    }
    if (!projectionOnly && busyAttempts.has(input.requestId))
      return reply.code(409).send({ error: { code: 'attempt_in_progress' } });
    if ((projectionOnly ? activeProjections : activeSubmissions) >= 1)
      return reply.code(429).send({ error: { code: 'concurrency_limit' } });
    if (projectionOnly) activeProjections += 1;
    else {
      activeSubmissions += 1;
      busyAttempts.add(input.requestId);
    }
    try {
      const admission = await (
        projectionOnly
          ? (authorizer.lookup?.bind(authorizer) ??
              (() => {
                throw new Error('Lookup unavailable.');
              }))
          : authorizer.admit.bind(authorizer)
      )(input.authorizationId, input.requestId, input.request);
      const retryingExistingAttempt = admission.attempt.status !== 'admitted';
      const envelope = retryingExistingAttempt
        ? verifyPersistedDecisionEnvelope(admission.envelope, verificationKeys)
        : verifyConnectorDecisionEnvelope(admission.envelope, verificationKeys);
      if (
        envelope.claims.authorizationId !== input.authorizationId ||
        envelope.claims.requestId !== input.requestId ||
        envelope.claims.attemptId !== admission.attempt.id ||
        envelope.claims.runId !== admission.attempt.id ||
        admission.attempt.authorizationId !== input.authorizationId ||
        admission.attempt.requestId !== input.requestId ||
        envelope.claims.promptDigest !== input.request.promptDigest ||
        envelope.claims.capabilities.length !== 0 ||
        envelope.claims.connectorId !== 'synthetic.codex.fixture' ||
        envelope.claims.connectorVersion !== '0.0.0-synthetic.1' ||
        envelope.claims.providerId !== 'synthetic' ||
        envelope.claims.modelId !== 'synthetic-text-only-v1' ||
        envelope.claims.operation !== 'connector.respond' ||
        envelope.claims.projectId !== input.request.projectId ||
        envelope.claims.projectRevision !== input.request.projectRevision ||
        envelope.claims.taskId !== input.request.taskId ||
        envelope.claims.taskRevision !== input.request.taskRevision ||
        envelope.claims.agentId !== input.request.agentId ||
        envelope.claims.profileVersion !== input.request.profileVersion ||
        !sameLimits(envelope.claims.limits, input.request.limits)
      )
        throw new Error('Authorizer envelope binding did not match the broker request.');

      if (projectionOnly) {
        return reply.send({
          attemptId: admission.attempt.id,
          correlationId: envelope.claims.correlationId,
          status: admission.attempt.status,
          ...(admission.attempt.cancelRequestedAt
            ? { cancellationRequestedAt: admission.attempt.cancelRequestedAt }
            : {}),
          outcomeRecordedAt: admission.attempt.updatedAt ?? admission.attempt.createdAt,
          submitted: Boolean(admission.attempt.submissionStartedAt),
          ...(admission.attempt.responseText
            ? { responseText: admission.attempt.responseText }
            : {}),
        });
      }
      if (retryingExistingAttempt) {
        const claim = await authorizer.claim(admission.attempt.id, brokerInstanceId);
        if (!claim.owned)
          return reply.code(503).send({ error: { code: 'attempt_owned_elsewhere' } });
        const attempt = await reconcileAttempt(
          authorizer,
          provider,
          brokerInstanceId,
          claim.attempt,
        );

        const result = {
          attemptId: attempt.id,
          correlationId: envelope.claims.correlationId,
          status: attempt.status,
          submitted: Boolean(
            attempt.submissionStartedAt ||
            attempt.providerSubmissionId ||
            ['submitting', 'accepted', 'running', 'unknown'].includes(attempt.status),
          ),
          ...(attempt.responseText ? { responseText: attempt.responseText } : {}),
        };
        return reply
          .code(['submitting', 'unknown'].includes(attempt.status) ? 202 : 200)
          .send(result);
      }

      const started = await authorizer.begin(
        admission.attempt.id,
        brokerInstanceId,
        envelope,
        input.renderedRequest,
      );
      if (started.status !== 'submitting')
        throw new Error('Authorizer did not persist the submission boundary.');

      let providerResponse;
      try {
        providerResponse = SyntheticFakeProviderSubmissionResponseSchema.parse(
          await provider.submit(admission.attempt.id, envelope, input.renderedRequest),
        );
      } catch (error) {
        if (error instanceof FakeProviderResponseError && error.status === 422) {
          const failed = await authorizer.record(
            admission.attempt.id,
            brokerInstanceId,
            started.brokerGeneration,
            {
              eventId: `rejected:${admission.attempt.id}`,
              status: 'failed',
            },
          );
          return reply.code(200).send({
            attemptId: admission.attempt.id,
            correlationId: envelope.claims.correlationId,
            status: failed.status,
            submitted: false,
          });
        }
        // Once the request may have crossed the network, record uncertainty and never POST again.
        await authorizer.record(admission.attempt.id, brokerInstanceId, started.brokerGeneration, {
          eventId: `unknown:${admission.attempt.id}`,
          status: 'unknown',
          usage: {
            kind: 'unknown',
            reason: 'submission_uncertain',
            billingExposure: 'unknown',
          },
        });
        return reply.code(202).send({
          attemptId: admission.attempt.id,
          correlationId: envelope.claims.correlationId,
          status: 'unknown',
          submitted: true,
        });
      }
      if (providerResponse.attemptId !== admission.attempt.id)
        throw new Error('Provider correlation mismatch.');
      const accepted = await authorizer.record(
        admission.attempt.id,
        brokerInstanceId,
        started.brokerGeneration,
        providerResponse.event,
      );
      if (providerResponse.event.status === 'accepted') {
        const completion = await provider.events(
          admission.attempt.id,
          providerResponse.providerSubmissionId,
        );
        const persisted = await authorizer.record(
          admission.attempt.id,
          brokerInstanceId,
          started.brokerGeneration,
          completion.event,
        );
        return reply.code(200).send({
          attemptId: admission.attempt.id,
          correlationId: envelope.claims.correlationId,
          status: persisted.status,
          submitted: true,
          responseText: persisted.responseText ?? undefined,
        });
      }
      return reply.code(200).send({
        attemptId: admission.attempt.id,
        correlationId: envelope.claims.correlationId,
        status: accepted.status,
        submitted: true,
      });
    } catch {
      return reply.code(503).send({
        error: {
          code: 'broker_unavailable',
          message: 'Synthetic authorization or execution could not be confirmed.',
        },
      });
    } finally {
      if (projectionOnly) activeProjections -= 1;
      else {
        busyAttempts.delete(input.requestId);
        activeSubmissions -= 1;
      }
    }
  }
  app.post('/internal/broker/v1/submit', (request, reply) =>
    handleSubmission(request, reply, false),
  );
  app.post('/internal/broker/v1/projection', (request, reply) =>
    handleSubmission(request, reply, true),
  );

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found' } }),
  );
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    if (statusCode === 413 || statusCode === 400)
      return reply.code(statusCode).send({ error: { code: 'invalid_input' } });
    return reply.code(503).send({ error: { code: 'broker_unavailable' } });
  });

  return app;
}

function sameLimits(
  decision: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxDurationSeconds: number;
    maxConcurrentRuns: 1;
    maxUsageUnits: number;
    maxCostMicrousd: number;
  },
  request: typeof decision,
): boolean {
  return (
    decision.maxInputTokens === request.maxInputTokens &&
    decision.maxOutputTokens === request.maxOutputTokens &&
    decision.maxDurationSeconds === request.maxDurationSeconds &&
    decision.maxConcurrentRuns === request.maxConcurrentRuns &&
    decision.maxUsageUnits === request.maxUsageUnits &&
    decision.maxCostMicrousd === request.maxCostMicrousd
  );
}

function verifyPersistedDecisionEnvelope(
  envelope: ConnectorDecisionEnvelope,
  anchors: readonly VerificationKey[],
) {
  const historicalExpiry = Math.min(
    Date.parse(envelope.expiresAt) - 1,
    Date.parse(envelope.claims.grantExpiresAt) - 1,
  );
  if (!Number.isFinite(historicalExpiry))
    throw new Error('Persisted decision envelope expiry is invalid.');
  return verifyConnectorDecisionEnvelope(
    envelope,
    anchors,
    new Date(Math.min(Date.now(), historicalExpiry)),
  );
}

import { createPublicKey } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import {
  ConnectorAuthorizationRequestSchema,
  createRenderedRequestDigest,
} from '@omnis/contracts/connector-authorization';
import {
  verifyConnectorDecisionEnvelope,
  type VerificationKey,
} from '@omnis/contracts/connector-broker';
import { SyntheticFakeProviderSubmissionResponseSchema } from '@omnis/contracts/broker-ipc';
import { readConfig } from './config.ts';
import { AuthorizerClient } from './authorizer-client.ts';
import { FakeProviderClient, FakeProviderResponseError } from './fake-provider-client.ts';

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

const config = readConfig();
const verificationKeys = parseTrustAnchors(config.trustAnchors);
const authorizer = new AuthorizerClient(config.authorizerSocketPath, config.authorizerToken);
const provider = new FakeProviderClient(config.providerToken);
const busyAttempts = new Set<string>();
let activeSubmissions = 0;

const app = Fastify({
  bodyLimit: 64 * 1024,
  logger: false,
  disableRequestLogging: true,
});

// Recovery never repeats a submission. Orphaned `submitting` attempts become unknown.
await reconcileDurableAttempts();

app.addHook('preHandler', async (request, reply) => {
  const header = request.headers.authorization;
  if (header !== `Bearer ${config.callerToken}`) {
    return reply
      .code(401)
      .send({ error: { code: 'unauthorized', message: 'Broker authentication failed.' } });
  }
});

app.post('/internal/broker/v1/submit', async (request, reply) => {
  const parsed = RequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_input' } });
  const input = parsed.data;
  if (createRenderedRequestDigest(input.renderedRequest) !== input.request.promptDigest) {
    return reply.code(403).send({ error: { code: 'request_binding_failed' } });
  }
  if (busyAttempts.has(input.requestId))
    return reply.code(409).send({ error: { code: 'attempt_in_progress' } });
  if (activeSubmissions >= 1) return reply.code(429).send({ error: { code: 'concurrency_limit' } });
  activeSubmissions += 1;
  busyAttempts.add(input.requestId);
  try {
    const admission = await authorizer.admit(input.authorizationId, input.requestId, input.request);
    const envelope = verifyConnectorDecisionEnvelope(admission.envelope, verificationKeys);
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

    const started = await authorizer.begin(admission.attempt.id, envelope, input.renderedRequest);
    if (started.status !== 'submitting')
      throw new Error('Authorizer did not persist the submission boundary.');

    let providerResponse;
    try {
      providerResponse = SyntheticFakeProviderSubmissionResponseSchema.parse(
        await provider.submit(admission.attempt.id, envelope, input.renderedRequest),
      );
    } catch (error) {
      if (error instanceof FakeProviderResponseError && error.status === 422) {
        const failed = await authorizer.record(admission.attempt.id, {
          eventId: `rejected:${admission.attempt.id}`,
          status: 'failed',
        });
        return reply.code(200).send({
          attemptId: admission.attempt.id,
          correlationId: envelope.claims.correlationId,
          status: failed.status,
          submitted: false,
        });
      }
      // Once the request may have crossed the network, record uncertainty and never POST again.
      await authorizer.record(admission.attempt.id, {
        eventId: `unknown:${admission.attempt.id}`,
        status: 'unknown',
        usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
      });
      return reply
        .code(202)
        .send({ attemptId: admission.attempt.id, status: 'unknown', submitted: true });
    }
    if (providerResponse.attemptId !== admission.attempt.id)
      throw new Error('Provider correlation mismatch.');
    const accepted = await authorizer.record(admission.attempt.id, providerResponse.event);
    if (providerResponse.event.status === 'accepted') {
      const completion = await provider.events(
        admission.attempt.id,
        providerResponse.providerSubmissionId,
      );
      const persisted = await authorizer.record(admission.attempt.id, completion.event);
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
    busyAttempts.delete(input.requestId);
    activeSubmissions -= 1;
  }
});

app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found' } }));
app.setErrorHandler((error, _request, reply) => {
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode
      : undefined;
  if (statusCode === 413 || statusCode === 400)
    return reply.code(statusCode).send({ error: { code: 'invalid_input' } });
  return reply.code(503).send({ error: { code: 'broker_unavailable' } });
});

await mkdir(path.dirname(config.socketPath), { recursive: true, mode: 0o750 });
const existing = await lstat(config.socketPath).catch((error: NodeJS.ErrnoException) =>
  error.code === 'ENOENT' ? undefined : Promise.reject(error),
);
if (existing) {
  if (!existing.isSocket() || existing.uid !== (process.getuid?.() ?? -1))
    throw new Error('Refusing to replace an unowned broker socket.');
  await rm(config.socketPath);
}
await app.listen({ path: config.socketPath });
await chmod(config.socketPath, 0o660);
const recoveryTimer = setInterval(() => {
  void reconcileDurableAttempts().catch(() => undefined);
}, 2_000);
recoveryTimer.unref();

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  clearInterval(recoveryTimer);
  void app.close().finally(() => rm(config.socketPath, { force: true }));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

async function reconcileDurableAttempts(): Promise<void> {
  for (let cursor: string | null = null; ;) {
    const page = await authorizer.recovery(100, cursor);
    for (const attempt of page) {
      if (attempt.status === 'submitting') {
        await authorizer.record(attempt.id, {
          eventId: `restart-unknown:${attempt.id}`,
          status: 'unknown',
          usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
        });
        continue;
      }
      if (
        attempt.cancelRequestedAt &&
        attempt.providerSubmissionId &&
        ['accepted', 'running', 'unknown'].includes(attempt.status)
      ) {
        try {
          const cancellation = await provider.cancel(attempt.id, attempt.providerSubmissionId);
          if (cancellation.cancellation === 'confirmed' && cancellation.event) {
            await authorizer.record(attempt.id, cancellation.event);
          }
        } catch {
          // Without a correlated interrupted event the durable cancellation remains pending.
        }
      }
    }
    if (page.length < 100) break;
    cursor = page.at(-1)!.id;
  }
}

function parseTrustAnchors(source: string): VerificationKey[] {
  const entries = z
    .array(
      z
        .object({
          keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
          publicKeyPem: z.string().min(1).max(4096),
          notBefore: z.string().datetime(),
          notAfter: z.string().datetime(),
        })
        .strict(),
    )
    .min(1)
    .max(8)
    .parse(JSON.parse(source) as unknown);
  return entries.map((entry) => ({
    keyId: entry.keyId,
    publicKey: createPublicKey(entry.publicKeyPem),
    notBefore: entry.notBefore,
    notAfter: entry.notAfter,
  }));
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

import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import {
  SyntheticFakeProviderCancellationRequestSchema,
  SyntheticFakeProviderSubmissionRequestSchema,
} from '@omnis/contracts/broker-ipc';
import {
  verifyConnectorDecisionEnvelope,
  type VerificationKey,
} from '@omnis/contracts/connector-broker';

const tokenPath = process.env.OMNIS_FAKE_PROVIDER_TOKEN_FILE;
const token = tokenPath ? readFileSync(tokenPath, 'utf8').trim() : undefined;
if (!token || token.length < 32) throw new Error('Synthetic fake-provider token is required.');
const fixtures = z
  .record(
    z.string().uuid(),
    z.enum([
      'completed',
      'rejected',
      'delayed',
      'timeout',
      'fail-before-acceptance',
      'lost-ack',
      'cancel-requested',
      'cancel-confirmed',
      'delayed-cancel-confirmed',
      'duplicate-event',
      'conflicting-event',
    ]),
  )
  .parse(JSON.parse(process.env.OMNIS_FAKE_PROVIDER_FIXTURES ?? '{}') as unknown);
const trustAnchors = readTrustAnchors(process.env.OMNIS_FAKE_PROVIDER_TRUST_ANCHORS ?? '[]');
const submissions = new Map<
  string,
  { digest: string; attemptId: string; fixture: string; response: unknown; events: unknown[] }
>();

const server = createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    if (!response.destroyed && !response.headersSent)
      send(response, 400, { error: 'invalid_input' });
  });
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.url === '/healthz' && request.method === 'GET')
    return send(response, 200, { ok: true, synthetic: true });
  const auth = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
    return send(response, 401, { error: 'unauthorized' });
  if (request.url === '/v1/submissions' && request.method === 'POST') {
    const body = await readBody(request);
    const parsed = SyntheticFakeProviderSubmissionRequestSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return send(response, 400, { error: 'invalid_input' });
    if (trustAnchors.length === 0)
      return send(response, 503, { error: 'synthetic_trust_anchor_missing' });
    try {
      const verified = verifyConnectorDecisionEnvelope(parsed.data.envelope, trustAnchors);
      if (
        verified.claims.attemptId !== parsed.data.attemptId ||
        verified.claims.promptDigest !== createRenderedRequestDigest(parsed.data.renderedRequest) ||
        verified.claims.capabilities.length !== 0 ||
        verified.claims.providerId !== 'synthetic' ||
        verified.claims.modelId !== 'synthetic-text-only-v1'
      )
        return send(response, 422, { error: 'scope_mismatch' });
    } catch {
      return send(response, 422, { error: 'decision_invalid' });
    }
    const { attemptId } = parsed.data;
    const digest = createHash('sha256').update(body).digest('hex');
    const previous = submissions.get(attemptId);
    if (previous)
      return previous.digest === digest
        ? send(response, 200, previous.response)
        : send(response, 409, { error: 'idempotency_conflict' });
    const fixture = fixtures[attemptId] ?? 'completed';
    if (fixture === 'fail-before-acceptance') return send(response, 422, { error: 'not_accepted' });
    if (fixture === 'rejected') return send(response, 422, { error: 'fixture_rejected' });
    if (fixture === 'delayed') await new Promise((resolve) => setTimeout(resolve, 1500));
    if (fixture === 'timeout') await new Promise((resolve) => setTimeout(resolve, 6000));
    const providerSubmissionId = `synthetic-${attemptId}`;
    const acceptedEvent = {
      eventId: `accepted-${attemptId}`,
      status: 'accepted' as const,
      providerSubmissionId,
    };
    const completion = {
      version: 'omnis.fake-provider.v1',
      attemptId,
      event: {
        eventId: `completed-${attemptId}`,
        status: 'completed' as const,
        providerSubmissionId,
        usage: {
          kind: 'measured' as const,
          source: 'synthetic-provider' as const,
          billingExposure: 'synthetic-only' as const,
          inputUnits: 1,
          outputUnits: 1,
        },
        responseText: 'Synthetic provider response.',
      },
    };
    const result = {
      version: 'omnis.fake-provider.v1',
      attemptId,
      providerSubmissionId,
      event: acceptedEvent,
    };
    const providerEvents =
      fixture === 'duplicate-event'
        ? [
            { version: 'omnis.fake-provider.v1', attemptId, event: acceptedEvent },
            { version: 'omnis.fake-provider.v1', attemptId, event: acceptedEvent },
          ]
        : fixture === 'conflicting-event'
          ? [
              { version: 'omnis.fake-provider.v1', attemptId, event: acceptedEvent },
              {
                ...completion,
                event: { ...completion.event, eventId: acceptedEvent.eventId },
              },
            ]
          : [{ version: 'omnis.fake-provider.v1', attemptId, event: acceptedEvent }, completion];
    submissions.set(attemptId, {
      digest,
      attemptId,
      fixture,
      response: result,
      events: providerEvents,
    });
    if (fixture === 'lost-ack') {
      response.destroy();
      return;
    }
    return send(response, 200, result);
  }
  const eventsMatch = request.url?.match(/^\/v1\/submissions\/([A-Za-z0-9._~-]{1,128})\/events$/);
  if (request.method === 'GET' && eventsMatch) {
    const providerSubmissionId = eventsMatch[1];
    const found = [...submissions.values()].find((item) =>
      JSON.stringify(item.response).includes(providerSubmissionId ?? ''),
    );
    return found
      ? send(response, 200, found.events.at(-1))
      : send(response, 404, { error: 'unknown_submission' });
  }
  const cancelMatch = request.url?.match(/^\/v1\/submissions\/([A-Za-z0-9._~-]{1,128})$/);
  if (request.method === 'DELETE' && cancelMatch) {
    const body = await readBody(request);
    const parsed = SyntheticFakeProviderCancellationRequestSchema.safeParse(JSON.parse(body));
    if (!parsed.success || parsed.data.providerSubmissionId !== cancelMatch[1])
      return send(response, 400, { error: 'invalid_input' });
    const submission = submissions.get(parsed.data.attemptId);
    if (!submission) return send(response, 404, { error: 'unknown_submission' });
    if (submission.fixture === 'delayed-cancel-confirmed')
      await new Promise((resolve) => setTimeout(resolve, 250));
    if (['cancel-confirmed', 'delayed-cancel-confirmed'].includes(submission.fixture)) {
      return send(response, 200, {
        version: 'omnis.fake-provider.v1',
        attemptId: parsed.data.attemptId,
        cancellation: 'confirmed',
        event: {
          eventId: `interrupted-${parsed.data.attemptId}`,
          status: 'interrupted',
          providerSubmissionId: cancelMatch[1],
        },
      });
    }
    return send(response, 200, {
      version: 'omnis.fake-provider.v1',
      attemptId: parsed.data.attemptId,
      cancellation: 'requested',
    });
  }
  return send(response, 404, { error: 'not_found' });
}
server.listen(8787, '0.0.0.0');

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      value += chunk;
      if (Buffer.byteLength(value) > 64 * 1024) {
        reject(new Error('request too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(value));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify(value));
}

function readTrustAnchors(source: string): VerificationKey[] {
  const schema = z
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
    .max(8);
  return schema.parse(JSON.parse(source) as unknown).map((entry) => ({
    keyId: entry.keyId,
    publicKey: createPublicKey(entry.publicKeyPem),
    notBefore: entry.notBefore,
    notAfter: entry.notAfter,
  }));
}

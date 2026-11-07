import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

export const FakeProviderFixturesSchema = z.record(
  z.union([z.string().uuid(), z.literal('default')]),
  z.enum([
    'completed',
    'delayed-events',
    'delayed-cancel-confirmed-events',
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
);

export type FakeProviderFixture = z.infer<typeof FakeProviderFixturesSchema>[string];

export function createSyntheticFakeProviderServer(input: {
  token: string;
  fixtures: Record<string, FakeProviderFixture>;
  trustAnchors: VerificationKey[];
}): Server {
  const { token, fixtures, trustAnchors } = input;
  const submissions = new Map<
    string,
    {
      digest: string;
      attemptId: string;
      fixture: string;
      providerSubmissionId: string;
      response: unknown;
      events: unknown[];
      eventReads: number;
    }
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
          verified.claims.promptDigest !==
            createRenderedRequestDigest(parsed.data.renderedRequest) ||
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
      const fixture = fixtures[attemptId] ?? fixtures.default ?? 'completed';
      if (fixture === 'fail-before-acceptance')
        return send(response, 422, { error: 'not_accepted' });
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
        providerSubmissionId,
        response: result,
        events: providerEvents,
        eventReads: 0,
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
      if (!found) return send(response, 404, { error: 'unknown_submission' });
      if (
        ['delayed-events', 'delayed-cancel-confirmed-events'].includes(found.fixture) &&
        found.eventReads === 0
      ) {
        found.eventReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 8_000));
      } else {
        found.eventReads += 1;
      }
      return send(response, 200, found.events.at(-1));
    }
    const cancelMatch = request.url?.match(/^\/v1\/submissions\/([A-Za-z0-9._~-]{1,128})$/);
    if (request.method === 'DELETE' && cancelMatch) {
      const body = await readBody(request);
      const parsed = SyntheticFakeProviderCancellationRequestSchema.safeParse(JSON.parse(body));
      if (!parsed.success || parsed.data.providerSubmissionId !== cancelMatch[1])
        return send(response, 400, { error: 'invalid_input' });
      const submission = submissions.get(parsed.data.attemptId);
      if (!submission) return send(response, 404, { error: 'unknown_submission' });
      if (submission.providerSubmissionId !== cancelMatch[1])
        return send(response, 409, { error: 'provider_submission_mismatch' });
      if (
        ['delayed-cancel-confirmed', 'delayed-cancel-confirmed-events'].includes(submission.fixture)
      )
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (
        [
          'cancel-confirmed',
          'delayed-cancel-confirmed',
          'delayed-cancel-confirmed-events',
        ].includes(submission.fixture)
      ) {
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

  return server;
}

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

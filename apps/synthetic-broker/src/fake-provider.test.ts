import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { signConnectorDecisionEnvelope } from '@omnis/contracts/connector-broker';
import { createSyntheticFakeProviderServer } from './fake-provider-app.ts';

const token = 'synthetic-provider-test-token'.padEnd(64, 'x');
const renderedRequest = 'Synthetic provider endpoint test request.';
const keyPair = generateKeyPairSync('ed25519');
const now = new Date();
const notBefore = new Date(now.getTime() - 60_000).toISOString();
const notAfter = new Date(now.getTime() + 10 * 60_000).toISOString();
const attemptId = randomUUID();
const cancelAttemptId = randomUUID();
const delayedCancelAttemptId = randomUUID();
const fixtures = {
  [attemptId]: 'completed',
  [cancelAttemptId]: 'cancel-confirmed',
  [delayedCancelAttemptId]: 'delayed-cancel-confirmed-events',
} as const;
const server = createSyntheticFakeProviderServer({
  token,
  fixtures,
  trustAnchors: [{ keyId: 'test-key', publicKey: keyPair.publicKey, notBefore, notAfter }],
});
let origin: string;

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function submission(attempt: string) {
  const authorizationId = randomUUID();
  const requestId = randomUUID();
  const issuedAt = new Date();
  const envelope = signConnectorDecisionEnvelope(
    {
      authorizationId,
      decisionId: authorizationId,
      decision: {
        status: 'authorized',
        decidedBy: 'owner',
        decidedAt: issuedAt.toISOString(),
        consentedAt: issuedAt.toISOString(),
      },
      principal: { kind: 'owner', id: 'owner' },
      runId: attempt,
      attemptId: attempt,
      requestId,
      correlationId: randomUUID(),
      projectId: `prj_${'1'.repeat(32)}`,
      projectRevision: 1,
      taskId: 'task-1',
      taskRevision: 1,
      agentId: 'agent-1',
      profileVersion: 1,
      promptDigest: createRenderedRequestDigest(renderedRequest),
      connectorId: 'synthetic.codex.fixture',
      connectorVersion: '0.0.0-synthetic.1',
      providerId: 'synthetic',
      modelId: 'synthetic-text-only-v1',
      operation: 'connector.respond',
      capabilities: [],
      limits: {
        maxInputTokens: 100,
        maxOutputTokens: 30,
        maxDurationSeconds: 60,
        maxConcurrentRuns: 1,
        maxUsageUnits: 200,
        maxCostMicrousd: 1,
      },
      revocationGeneration: 0,
      grantExpiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
      nonce: randomUUID(),
    },
    {
      keyId: 'test-key',
      privateKey: keyPair.privateKey,
      notBefore,
      notAfter,
    },
    issuedAt,
  );
  return {
    version: 'omnis.fake-provider.v1',
    attemptId: attempt,
    envelope,
    renderedRequest,
  };
}

describe('synthetic fake-provider HTTP boundary', () => {
  it('validates authentication and request shape before accepting a submission', async () => {
    const payload = submission(randomUUID());
    const unauthorized = await fetch(`${origin}/v1/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(unauthorized.status, 401);

    const invalid = await fetch(`${origin}/v1/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'omnis.fake-provider.v1' }),
    });
    assert.equal(invalid.status, 400);
  });

  it('verifies the signed request, is idempotent, and exposes the correlated completion event', async () => {
    const payload = submission(attemptId);
    const submit = () =>
      fetch(`${origin}/v1/submissions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    const accepted = await submit();
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.attemptId, attemptId);
    assert.equal(acceptedBody.event.status, 'accepted');

    const repeated = await submit();
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), acceptedBody);

    const reissuedEnvelope = signConnectorDecisionEnvelope(
      payload.envelope.claims,
      {
        keyId: 'test-key',
        privateKey: keyPair.privateKey,
        notBefore,
        notAfter,
      },
      new Date(Date.parse(payload.envelope.issuedAt) + 1_000),
    );
    const conflict = await fetch(`${origin}/v1/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, envelope: reissuedEnvelope }),
    });
    assert.equal(conflict.status, 409);

    const events = await fetch(
      `${origin}/v1/submissions/${encodeURIComponent(acceptedBody.providerSubmissionId)}/events`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(events.status, 200);
    const eventBody = await events.json();
    assert.equal(eventBody.attemptId, attemptId);
    assert.equal(eventBody.event.status, 'completed');
    assert.equal(eventBody.event.responseText, 'Synthetic provider response.');
  });

  it('rejects a request whose text no longer matches the signed digest', async () => {
    const payload = submission(randomUUID());
    const response = await fetch(`${origin}/v1/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, renderedRequest: `${renderedRequest} changed` }),
    });
    assert.equal(response.status, 400);
  });

  it('returns only a correlated interruption when the cancellation fixture confirms it', async () => {
    const payload = submission(cancelAttemptId);
    const accepted = await fetch(`${origin}/v1/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const acceptedBody = await accepted.json();
    const mismatchedCancellation = await fetch(
      `${origin}/v1/submissions/${encodeURIComponent(`wrong-${acceptedBody.providerSubmissionId}`)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 'omnis.fake-provider.v1',
          attemptId: cancelAttemptId,
          providerSubmissionId: `wrong-${acceptedBody.providerSubmissionId}`,
        }),
      },
    );
    assert.equal(mismatchedCancellation.status, 409);

    const cancelled = await fetch(
      `${origin}/v1/submissions/${encodeURIComponent(acceptedBody.providerSubmissionId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 'omnis.fake-provider.v1',
          attemptId: cancelAttemptId,
          providerSubmissionId: acceptedBody.providerSubmissionId,
        }),
      },
    );
    assert.equal(cancelled.status, 200);
    const body = await cancelled.json();
    assert.equal(body.attemptId, cancelAttemptId);
    assert.equal(body.cancellation, 'confirmed');
    assert.equal(body.event.status, 'interrupted');
  });

  it('keeps a delayed cancellation fixture at accepted until confirmed interruption', async () => {
    const payload = submission(delayedCancelAttemptId);
    const accepted = await fetch(`${origin}/v1/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.event.status, 'accepted');

    const pendingEvents = await fetch(
      `${origin}/v1/submissions/${encodeURIComponent(acceptedBody.providerSubmissionId)}/events`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(pendingEvents.status, 200);
    assert.equal((await pendingEvents.json()).event.status, 'accepted');

    const cancelled = await fetch(
      `${origin}/v1/submissions/${encodeURIComponent(acceptedBody.providerSubmissionId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 'omnis.fake-provider.v1',
          attemptId: delayedCancelAttemptId,
          providerSubmissionId: acceptedBody.providerSubmissionId,
        }),
      },
    );
    assert.equal(cancelled.status, 200);
    const cancellationBody = await cancelled.json();
    assert.equal(cancellationBody.cancellation, 'confirmed');
    assert.equal(cancellationBody.event.status, 'interrupted');

    const events = await fetch(
      `${origin}/v1/submissions/${encodeURIComponent(acceptedBody.providerSubmissionId)}/events`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(events.status, 200);
    const eventBody = await events.json();
    assert.equal(eventBody.event.status, 'interrupted');
    assert.equal(eventBody.event.eventId, cancellationBody.event.eventId);
  });
});

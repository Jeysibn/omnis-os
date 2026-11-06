import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  signConnectorDecisionEnvelope,
  SyntheticProviderEventSchema,
} from '@omnis/contracts/connector-broker';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { DeterministicSyntheticProvider, SyntheticBrokerHarness } from './synthetic-broker.ts';

const now = new Date('2026-11-06T00:00:00.000Z');
const renderedRequest = 'Synthetic rendered request fixture.';
const baseClaims = {
  authorizationId: 'ad8d2347-e595-45a6-bdb1-9d27df401534',
  decisionId: 'ad8d2347-e595-45a6-bdb1-9d27df401534',
  decision: {
    status: 'authorized' as const,
    decidedBy: 'owner' as const,
    decidedAt: now.toISOString(),
    consentedAt: now.toISOString(),
  },
  principal: { kind: 'owner' as const, id: 'owner' as const },
  runId: 'e2404bc2-e90b-4fca-a773-1673ff4c0a0d',
  attemptId: 'e2404bc2-e90b-4fca-a773-1673ff4c0a0d',
  requestId: '81ff14eb-242b-4351-bd04-efbf3d8f0b8c',
  correlationId: '680ca526-9b8d-4c85-9164-7bdbf1e6d616',
  projectId: `prj_${'1'.repeat(32)}`,
  projectRevision: 3,
  taskId: 'task-1',
  taskRevision: 7,
  agentId: 'agent-1',
  profileVersion: 4,
  promptDigest: createRenderedRequestDigest(renderedRequest),
  connectorId: 'synthetic.codex.fixture' as const,
  connectorVersion: '0.0.0-synthetic.1' as const,
  providerId: 'synthetic' as const,
  modelId: 'synthetic-text-only-v1' as const,
  operation: 'connector.respond' as const,
  capabilities: [] as [],
  limits: {
    maxInputTokens: 100,
    maxOutputTokens: 30,
    maxDurationSeconds: 60,
    maxConcurrentRuns: 1 as const,
    maxUsageUnits: 200,
    maxCostMicrousd: 1,
  },
  revocationGeneration: 0 as const,
  grantExpiresAt: '2026-11-06T00:05:00.000Z',
  nonce: '84bfb169-eafb-458a-920a-fde256e33a76',
};

class TestAuthorizer {
  status = new Map<
    string,
    | 'admitted'
    | 'submitting'
    | 'accepted'
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'unknown'
  >([[baseClaims.attemptId, 'admitted']]);
  events = new Set<string>();
  revoked = false;
  async beginSyntheticSubmission(id: string) {
    if (this.revoked || this.status.get(id) !== 'admitted') throw new Error('not admissible');
    this.status.set(id, 'submitting');
    return { status: 'submitting' as const };
  }
  async recordSyntheticProviderEvent(
    id: string,
    event: {
      eventId: string;
      status: 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
    },
  ) {
    const current = this.status.get(id);
    if (!current) throw new Error('missing attempt');
    if (this.events.has(event.eventId)) return { status: current };
    const allowed: Record<string, string[]> = {
      submitting: ['accepted', 'failed', 'unknown', 'interrupted'],
      accepted: ['running', 'completed', 'failed', 'unknown', 'interrupted'],
      running: ['completed', 'failed', 'unknown', 'interrupted'],
      unknown: ['accepted', 'running', 'completed', 'failed', 'interrupted'],
    };
    if (!allowed[current]?.includes(event.status)) throw new Error('stale event');
    this.events.add(event.eventId);
    this.status.set(id, event.status);
    return { status: event.status };
  }
}

function fixture(scenario: ConstructorParameters<typeof DeterministicSyntheticProvider>[0]) {
  const pair = generateKeyPairSync('ed25519');
  const key = {
    keyId: 'fixture-key',
    privateKey: pair.privateKey,
    notBefore: '2026-11-05T00:00:00.000Z',
    notAfter: '2026-11-07T00:00:00.000Z',
  };
  const envelope = signConnectorDecisionEnvelope(baseClaims, key, now);
  const authorizer = new TestAuthorizer();
  const provider = new DeterministicSyntheticProvider(scenario);
  const broker = new SyntheticBrokerHarness(authorizer, provider, [
    {
      keyId: key.keyId,
      publicKey: pair.publicKey,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
    },
  ]);
  return { authorizer, provider, broker, envelope };
}

describe('synthetic broker lifecycle harness', () => {
  it('submits once after durable admission and records a successful measured response', async () => {
    const f = fixture({
      kind: 'completed',
      providerSubmissionId: 'fake-sub-1',
      acceptedEventId: 'accepted-1',
      completedEventId: 'completed-1',
      responseText: 'Synthetic fixture answer.',
      usage: {
        kind: 'measured',
        source: 'synthetic-provider',
        inputUnits: 4,
        outputUnits: 7,
        billingExposure: 'synthetic-only',
      },
    });
    assert.deepEqual(await f.broker.submit(f.envelope, renderedRequest, now), {
      attemptId: baseClaims.attemptId,
      status: 'completed',
      submitted: true,
      mayHaveReachedProvider: true,
      responseText: 'Synthetic fixture answer.',
    });
    assert.equal(f.provider.submissions.length, 1);
    await assert.rejects(f.broker.submit(f.envelope, renderedRequest, now), /not admissible/);
    assert.equal(f.provider.submissions.length, 1);
  });

  it('keeps acceptance with a lost response unknown and does not retry after restart', async () => {
    const f = fixture({ kind: 'accepted_response_lost', eventId: 'lost-1' });
    assert.equal((await f.broker.submit(f.envelope, renderedRequest, now)).status, 'unknown');
    await assert.rejects(f.broker.submit(f.envelope, renderedRequest, now), /not admissible/);
    assert.equal(f.provider.submissions.length, 1);

    const crashed = fixture({
      kind: 'accepted',
      providerSubmissionId: 'unused',
      eventId: 'unused',
    });
    await crashed.authorizer.beginSyntheticSubmission(baseClaims.attemptId);
    assert.equal(
      (await crashed.broker.recover(baseClaims.attemptId, 'restart-unknown')).status,
      'unknown',
    );
    assert.equal(crashed.provider.submissions.length, 0);
  });

  it('fails closed for forged, wrong-audience, expired, and wrong-key envelopes', async () => {
    const f = fixture({ kind: 'unavailable' });
    const forged = {
      ...f.envelope,
      claims: { ...f.envelope.claims, promptDigest: `sha256:${'b'.repeat(64)}` },
    };
    await assert.rejects(f.broker.submit(forged, renderedRequest, now));
    await assert.rejects(
      f.broker.submit({ ...f.envelope, audience: 'other' }, renderedRequest, now),
    );
    await assert.rejects(
      f.broker.submit(f.envelope, renderedRequest, new Date('2026-11-06T00:01:00.000Z')),
    );
    const noTrust = new SyntheticBrokerHarness(f.authorizer, f.provider, []);
    await assert.rejects(noTrust.submit(f.envelope, renderedRequest, now));
    assert.equal(f.provider.submissions.length, 0);

    const wrongRequest = fixture({
      kind: 'accepted',
      providerSubmissionId: 'wrong-prompt',
      eventId: 'wrong-prompt',
    });
    await assert.rejects(
      wrongRequest.broker.submit(wrongRequest.envelope, 'different rendered request', now),
      /does not match the signed digest/,
    );
    assert.equal(wrongRequest.provider.submissions.length, 0);
    assert.equal(wrongRequest.authorizer.status.get(baseClaims.attemptId), 'admitted');
  });

  it('serializes parallel use of one attempt and honors revocation before submission', async () => {
    const f = fixture({
      kind: 'accepted',
      providerSubmissionId: 'parallel-sub',
      eventId: 'parallel-accepted',
    });
    const outcomes = await Promise.allSettled([
      f.broker.submit(f.envelope, renderedRequest, now),
      f.broker.submit(f.envelope, renderedRequest, now),
    ]);
    assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
    assert.equal(f.provider.submissions.length, 1);

    const revoked = fixture({
      kind: 'accepted',
      providerSubmissionId: 'revoked-sub',
      eventId: 'revoked-accepted',
    });
    revoked.authorizer.revoked = true;
    await assert.rejects(
      revoked.broker.submit(revoked.envelope, renderedRequest, now),
      /not admissible/,
    );
    assert.equal(revoked.provider.submissions.length, 0);
  });

  it('fails closed when the authorizer is unavailable before submission and preserves uncertainty after a lost commit', async () => {
    const before = fixture({
      kind: 'accepted',
      providerSubmissionId: 'unavailable-sub',
      eventId: 'unavailable-accepted',
    });
    before.authorizer.beginSyntheticSubmission = async () => {
      throw new Error('authorizer unavailable');
    };
    await assert.rejects(
      before.broker.submit(before.envelope, renderedRequest, now),
      /authorizer unavailable/,
    );
    assert.equal(before.provider.submissions.length, 0);

    const after = fixture({
      kind: 'accepted',
      providerSubmissionId: 'lost-commit-sub',
      eventId: 'lost-commit-event',
    });
    after.authorizer.recordSyntheticProviderEvent = async () => {
      throw new Error('authorizer unavailable');
    };
    await assert.rejects(
      after.broker.submit(after.envelope, renderedRequest, now),
      /authorizer unavailable/,
    );
    assert.equal(after.provider.submissions.length, 1);
    assert.equal(after.authorizer.status.get(baseClaims.attemptId), 'submitting');
    await assert.rejects(
      after.broker.submit(after.envelope, renderedRequest, now),
      /not admissible/,
    );
    assert.equal(after.provider.submissions.length, 1);
  });

  it('records definite rejection and post-send failure without claiming zero usage', async () => {
    const rejected = fixture({ kind: 'rejected', eventId: 'reject-1' });
    assert.equal(
      (await rejected.broker.submit(rejected.envelope, renderedRequest, now)).status,
      'failed',
    );
    const failed = fixture({
      kind: 'failed_after_submission',
      providerSubmissionId: 'fake-sub-2',
      eventId: 'failed-1',
    });
    assert.equal(
      (await failed.broker.submit(failed.envelope, renderedRequest, now)).status,
      'failed',
    );
  });

  it('does not retry a possibly sent request on timeout, provider outage, or duplicate response', async () => {
    for (const scenario of [
      { kind: 'timeout_before_confirmation' as const, eventId: 'timeout-1' },
      {
        kind: 'duplicate' as const,
        first: { kind: 'accepted_response_lost' as const, eventId: 'duplicate-1' },
      },
    ]) {
      const f = fixture(scenario);
      const result = await f.broker.submit(f.envelope, renderedRequest, now);
      assert.ok(['unknown'].includes(result.status));
      assert.equal(f.provider.submissions.length, 1);
    }
    const unavailable = fixture({ kind: 'unavailable' });
    const unavailableResult = await unavailable.broker.submit(
      unavailable.envelope,
      renderedRequest,
      now,
    );
    assert.equal(unavailableResult.status, 'failed');
    assert.equal(unavailableResult.mayHaveReachedProvider, false);
    assert.equal(unavailable.provider.submissions.length, 1);
  });

  it('rejects credential canaries in broker events and does not echo them in errors or results', async () => {
    const canary = 'SYNTHETIC-CREDENTIAL-CANARY-DO-NOT-LOG';
    const f = fixture({
      kind: 'completed',
      providerSubmissionId: 'canary-test-sub',
      acceptedEventId: 'canary-test-accepted',
      completedEventId: 'canary-test-completed',
      responseText: 'Synthetic fixture response.',
    });
    const response = JSON.stringify(await f.broker.submit(f.envelope, renderedRequest, now));
    assert.equal(response.includes(canary), false);
    const invalidEvent = SyntheticProviderEventSchema.safeParse({
      eventId: 'canary-event',
      status: 'failed',
      credentialCanary: canary,
    });
    assert.equal(invalidEvent.success, false);
    const error = invalidEvent.success ? '' : 'Synthetic provider event is invalid.';
    assert.equal(error.includes(canary), false);
    assert.equal(JSON.stringify(f.provider.submissions).includes(canary), false);
    assert.equal(JSON.stringify(f.provider.requests).includes(canary), false);
  });
});

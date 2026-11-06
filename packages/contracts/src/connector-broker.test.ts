import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  ConnectorDecisionEnvelopeSchema,
  ConnectorDecisionEnvelopeClaimsSchema,
  ConnectorExecutionStatusSchema,
  UsageProvenanceSchema,
  assertTrustAnchorRotationWindow,
  canonicalizeConnectorDecisionClaims,
  signConnectorDecisionEnvelope,
  verifyConnectorDecisionEnvelope,
} from './connector-broker.ts';

const timestamp = '2026-11-06T00:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;

function claims() {
  return {
    authorizationId: 'ad8d2347-e595-45a6-bdb1-9d27df401534',
    decisionId: 'ad8d2347-e595-45a6-bdb1-9d27df401534',
    decision: {
      status: 'authorized' as const,
      decidedBy: 'owner' as const,
      decidedAt: timestamp,
      consentedAt: timestamp,
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
    promptDigest: digest,
    connectorId: 'synthetic.codex.fixture',
    connectorVersion: '0.0.0-synthetic.1',
    providerId: 'synthetic',
    modelId: 'synthetic-text-only-v1',
    operation: 'connector.respond',
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
}

describe('synthetic connector broker contracts', () => {
  it('accepts only the fixed owner-approved, tool-empty envelope claims', () => {
    assert.equal(ConnectorDecisionEnvelopeClaimsSchema.parse(claims()).providerId, 'synthetic');
    assert.equal(
      ConnectorDecisionEnvelopeSchema.safeParse({
        version: 'omnis.connector-decision.v1',
        issuer: 'omnis-authorizer',
        audience: 'omnis-synthetic-broker',
        algorithm: 'Ed25519',
        keyId: 'synthetic-key-1',
        issuedAt: timestamp,
        expiresAt: '2026-11-06T00:00:30.000Z',
        claims: claims(),
        signature: Buffer.alloc(64).toString('base64url'),
      }).success,
      true,
    );
  });

  it('rejects authority fields, nonempty capabilities, and changed provider scope', () => {
    assert.equal(
      ConnectorDecisionEnvelopeClaimsSchema.safeParse({ ...claims(), approved: true }).success,
      false,
    );
    assert.equal(
      ConnectorDecisionEnvelopeClaimsSchema.safeParse({
        ...claims(),
        capabilities: ['shell'],
      }).success,
      false,
    );
    assert.equal(
      ConnectorDecisionEnvelopeClaimsSchema.safeParse({
        ...claims(),
        providerId: 'openai',
      }).success,
      false,
    );
  });

  it('requires one broker execution identity and canonicalizes claims independent of key order', () => {
    assert.equal(
      ConnectorDecisionEnvelopeClaimsSchema.safeParse({
        ...claims(),
        runId: '7020478b-7434-4547-8cdd-c49797583e39',
      }).success,
      false,
    );
    const first = claims();
    const second = Object.fromEntries(Object.entries(first).reverse());
    assert.equal(
      canonicalizeConnectorDecisionClaims(first),
      canonicalizeConnectorDecisionClaims(second),
    );
  });

  it('represents unknown usage without fabricated zero measurements', () => {
    assert.deepEqual(
      UsageProvenanceSchema.parse({
        kind: 'unknown',
        reason: 'submission_uncertain',
        billingExposure: 'unknown',
      }),
      {
        kind: 'unknown',
        reason: 'submission_uncertain',
        billingExposure: 'unknown',
      },
    );
    assert.equal(
      UsageProvenanceSchema.safeParse({
        kind: 'unknown',
        inputUnits: 0,
        outputUnits: 0,
        reason: 'submission_uncertain',
        billingExposure: 'unknown',
      }).success,
      false,
    );
  });

  it('models only supported durable lifecycle states', () => {
    for (const state of [
      'admitted',
      'submitting',
      'accepted',
      'running',
      'completed',
      'failed',
      'interrupted',
      'unknown',
    ]) {
      assert.equal(ConnectorExecutionStatusSchema.parse(state), state);
    }
    assert.equal(ConnectorExecutionStatusSchema.safeParse('retrying').success, false);
  });

  it('signs and verifies a short-lived audience-bound decision using an explicit trust anchor', () => {
    const pair = generateKeyPairSync('ed25519');
    const now = new Date('2026-11-06T00:00:00.000Z');
    const key = {
      keyId: 'fixture-key-1',
      privateKey: pair.privateKey,
      notBefore: '2026-11-05T00:00:00.000Z',
      notAfter: '2026-11-07T00:00:00.000Z',
    };
    const envelope = signConnectorDecisionEnvelope(claims(), key, now);
    assert.throws(
      () => signConnectorDecisionEnvelope(claims(), { ...key, notBefore: 'bad' }, now),
      /validity window/,
    );
    assert.equal(
      verifyConnectorDecisionEnvelope(
        envelope,
        [
          {
            keyId: key.keyId,
            publicKey: pair.publicKey,
            notBefore: key.notBefore,
            notAfter: key.notAfter,
          },
        ],
        now,
      ).claims.authorizationId,
      claims().authorizationId,
    );
    assert.throws(() => verifyConnectorDecisionEnvelope(envelope, [], now), /unknown or retired/);
    assert.throws(
      () =>
        verifyConnectorDecisionEnvelope(
          envelope,
          [
            {
              keyId: key.keyId,
              publicKey: pair.publicKey,
              notBefore: key.notBefore,
              notAfter: key.notAfter,
            },
          ],
          new Date('2026-11-06T00:01:00.000Z'),
        ),
      /expired/,
    );
    assert.throws(
      () =>
        assertTrustAnchorRotationWindow([
          {
            keyId: 'old',
            publicKey: pair.publicKey,
            notBefore: '2026-11-05T00:00:00.000Z',
            notAfter: '2026-11-06T00:02:00.000Z',
          },
          {
            keyId: 'new',
            publicKey: pair.publicKey,
            notBefore: '2026-11-06T00:00:00.000Z',
            notAfter: '2026-11-07T00:00:00.000Z',
          },
        ]),
      /overlap exceeds 60 seconds/,
    );
    assert.throws(
      () =>
        verifyConnectorDecisionEnvelope(
          envelope,
          [
            {
              keyId: key.keyId,
              publicKey: pair.publicKey,
              notBefore: 'not-a-date',
              notAfter: 'also-not-a-date',
            },
          ],
          now,
        ),
      /validity window is malformed/,
    );
  });
});

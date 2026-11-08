import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { signConnectorDecisionEnvelope } from '@omnis/contracts/connector-broker';
import { createSyntheticBrokerApp } from './broker-app.ts';

const authorizationId = 'ad8d2347-e595-45a6-bdb1-9d27df401534';
const attemptId = 'e2404bc2-e90b-4fca-a773-1673ff4c0a0d';
const requestId = '81ff14eb-242b-4351-bd04-efbf3d8f0b8c';
const correlationId = '680ca526-9b8d-4c85-9164-7bdbf1e6d616';
const renderedRequest = 'Synthetic rendered request fixture.';
const now = new Date();
const keyPair = generateKeyPairSync('ed25519');
const envelope = signConnectorDecisionEnvelope(
  {
    authorizationId,
    decisionId: authorizationId,
    decision: {
      status: 'authorized',
      decidedBy: 'owner',
      decidedAt: now.toISOString(),
      consentedAt: now.toISOString(),
    },
    principal: { kind: 'owner', id: 'owner' },
    runId: attemptId,
    attemptId,
    requestId,
    correlationId,
    projectId: `prj_${'1'.repeat(32)}`,
    projectRevision: 3,
    taskId: 'task-1',
    taskRevision: 7,
    agentId: 'agent-1',
    profileVersion: 4,
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
    grantExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    nonce: '84bfb169-eafb-458a-920a-fde256e33a76',
  },
  {
    keyId: 'test-key',
    privateKey: keyPair.privateKey,
    notBefore: new Date(now.getTime() - 60_000).toISOString(),
    notAfter: new Date(now.getTime() + 10 * 60_000).toISOString(),
  },
  now,
);

const request = {
  version: 'omnis.synthetic-broker.v1',
  authorizationId,
  requestId,
  request: {
    projectId: `prj_${'1'.repeat(32)}`,
    projectRevision: 3,
    taskId: 'task-1',
    taskRevision: 7,
    agentId: 'agent-1',
    profileVersion: 4,
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
  },
  renderedRequest,
};

describe('synthetic broker submission boundary', () => {
  it('reads a late terminal attempt without admission, claims, provider access or resubmission', async () => {
    const forbidden = async () => {
      throw new Error('Mutation or provider access forbidden');
    };
    let reads = 0;
    const app = createSyntheticBrokerApp({
      callerToken: 'a'.repeat(96),
      verificationKeys: [
        {
          keyId: 'test-key',
          publicKey: keyPair.publicKey,
          notBefore: new Date(now.getTime() - 60_000).toISOString(),
          notAfter: new Date(now.getTime() + 600_000).toISOString(),
        },
      ],
      authorizer: {
        admit: forbidden,
        begin: forbidden,
        record: forbidden,
        claim: forbidden,
        lookup: async () => {
          reads++;
          return {
            version: 'omnis.broker-authorizer-ipc.v1' as const,
            envelope,
            attempt: {
              id: attemptId,
              authorizationId,
              requestId,
              status: 'completed',
              synthetic: true,
              createdAt: now.toISOString(),
              brokerGeneration: 2,
              brokerLeaseExpiresAt: null,
              submissionStartedAt: now.toISOString(),
              responseText: 'Late authoritative synthetic output',
            },
          };
        },
      },
      provider: { submit: forbidden, events: forbidden },
    });
    const projectionRequest = Object.fromEntries(
      Object.entries(request).filter(([key]) => key !== 'renderedRequest'),
    );
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/projection',
        payload: projectionRequest,
      });
      assert.equal(denied.statusCode, 401);
      for (let index = 0; index < 3; index++) {
        const result = await app.inject({
          method: 'POST',
          url:
            index === 2
              ? '/internal/broker/v1/projection?variant=1'
              : '/internal/broker/v1/projection',
          headers: { authorization: `Bearer ${'a'.repeat(96)}` },
          payload: projectionRequest,
        });
        assert.equal(result.statusCode, 200);
        assert.equal(result.json().status, 'completed');
        assert.equal(result.json().attemptId, attemptId);
      }
      assert.equal(reads, 3);
    } finally {
      await app.close();
    }
  });

  it('returns authorizer-signed correlation for an uncertain provider submission', async () => {
    const attempt = {
      id: attemptId,
      authorizationId,
      requestId,
      status: 'admitted' as const,
      synthetic: true as const,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      brokerGeneration: 0,
      brokerLeaseExpiresAt: null,
      submissionStartedAt: null,
      providerSubmissionId: null,
      cancelRequestedAt: null,
    };
    const recordedEvents: string[] = [];
    let providerCalls = 0;
    let replayAttempt = false;
    const app = createSyntheticBrokerApp({
      callerToken: 'a'.repeat(96),
      verificationKeys: [
        {
          keyId: 'test-key',
          publicKey: keyPair.publicKey,
          notBefore: new Date(now.getTime() - 60_000).toISOString(),
          notAfter: new Date(now.getTime() + 10 * 60_000).toISOString(),
        },
      ],
      authorizer: {
        async admit() {
          return {
            version: 'omnis.broker-authorizer-ipc.v1' as const,
            attempt: replayAttempt
              ? { ...attempt, status: 'unknown' as const, submissionStartedAt: now.toISOString() }
              : attempt,
            envelope,
          };
        },
        async begin() {
          assert.equal(replayAttempt, false, 'Unknown attempts must not begin another submission.');
          return {
            ...attempt,
            status: 'submitting' as const,
            brokerGeneration: 1,
            brokerLeaseExpiresAt: now.toISOString(),
          };
        },
        async claim() {
          return {
            version: 'omnis.broker-authorizer-ipc.v1',
            owned: true,
            attempt: {
              ...attempt,
              status: 'unknown' as const,
              submissionStartedAt: now.toISOString(),
              brokerGeneration: 1,
              brokerLeaseExpiresAt: null,
            },
          };
        },
        async record(_id, _instance, _generation, event) {
          recordedEvents.push(event.eventId);
          replayAttempt = true;
          return { ...attempt, status: event.status };
        },
      },
      provider: {
        async submit() {
          providerCalls += 1;
          throw new Error('fixture simulates an uncertain network acknowledgement');
        },
        async events() {
          throw new Error('events must not be fetched after an uncertain submission');
        },
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/submit',
        headers: { authorization: `Bearer ${'a'.repeat(96)}` },
        payload: request,
      });
      assert.equal(response.statusCode, 202);
      assert.deepEqual(response.json(), {
        attemptId,
        correlationId,
        status: 'unknown',
        submitted: true,
      });

      const replay = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/submit',
        headers: { authorization: `Bearer ${'a'.repeat(96)}` },
        payload: request,
      });
      assert.equal(replay.statusCode, 202);
      assert.deepEqual(replay.json(), {
        attemptId,
        correlationId,
        status: 'unknown',
        submitted: true,
      });
      assert.equal(providerCalls, 1);
      assert.deepEqual(recordedEvents, [`unknown:${attemptId}`]);
    } finally {
      await app.close();
    }
  });

  it('resolves the same request from a durable accepted attempt without submitting again', async () => {
    const acceptedAttempt = {
      id: attemptId,
      authorizationId,
      requestId,
      status: 'accepted' as const,
      synthetic: true as const,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      submissionStartedAt: now.toISOString(),
      brokerGeneration: 2,
      brokerLeaseExpiresAt: now.toISOString(),
      providerSubmissionId: `synthetic-${attemptId}`,
      cancelRequestedAt: null,
    };
    const completion = {
      eventId: `completed-${attemptId}`,
      status: 'completed' as const,
      providerSubmissionId: `synthetic-${attemptId}`,
      usage: {
        kind: 'measured' as const,
        source: 'synthetic-provider' as const,
        inputUnits: 1,
        outputUnits: 1,
        billingExposure: 'synthetic-only' as const,
      },
      responseText: 'Recovered synthetic result.',
    };
    let submitCalls = 0;
    let eventLookups = 0;
    const app = createSyntheticBrokerApp({
      callerToken: 'a'.repeat(96),
      verificationKeys: [
        {
          keyId: 'test-key',
          publicKey: keyPair.publicKey,
          notBefore: new Date(now.getTime() - 60_000).toISOString(),
          notAfter: new Date(now.getTime() + 10 * 60_000).toISOString(),
        },
      ],
      authorizer: {
        async admit() {
          return {
            version: 'omnis.broker-authorizer-ipc.v1' as const,
            attempt: acceptedAttempt,
            envelope,
          };
        },
        async begin() {
          throw new Error('An accepted attempt must not begin a new submission.');
        },
        async claim() {
          return {
            version: 'omnis.broker-authorizer-ipc.v1',
            owned: true,
            attempt: acceptedAttempt,
          };
        },
        async record(_id, _instance, _generation, event) {
          assert.equal(event.eventId, completion.eventId);
          return {
            ...acceptedAttempt,
            status: 'completed' as const,
            responseText: completion.responseText,
          };
        },
      },
      provider: {
        async submit() {
          submitCalls += 1;
          throw new Error('An accepted attempt must not be submitted again.');
        },
        async events() {
          eventLookups += 1;
          return {
            version: 'omnis.fake-provider.v1' as const,
            attemptId,
            event: completion,
          };
        },
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/submit',
        headers: { authorization: `Bearer ${'a'.repeat(96)}` },
        payload: request,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        attemptId,
        correlationId,
        status: 'completed',
        submitted: true,
        responseText: 'Recovered synthetic result.',
      });
      assert.equal(submitCalls, 0);
      assert.equal(eventLookups, 1);
    } finally {
      await app.close();
    }
  });
});

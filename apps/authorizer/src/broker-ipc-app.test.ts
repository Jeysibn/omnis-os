import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { signConnectorDecisionEnvelope } from '@omnis/contracts/connector-broker';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { createBrokerAuthorizerIpcApp, type BrokerIpcStore } from './broker-ipc-app.ts';

const now = new Date('2026-11-06T00:00:00.000Z');
const authorizationId = 'ad8d2347-e595-45a6-bdb1-9d27df401534';
const attemptId = 'e2404bc2-e90b-4fca-a773-1673ff4c0a0d';
const requestId = '81ff14eb-242b-4351-bd04-efbf3d8f0b8c';
const renderedRequest = 'Synthetic rendered request fixture.';
const brokerToken = 'a'.repeat(96);
const apiToken = 'b'.repeat(96);
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
    correlationId: '680ca526-9b8d-4c85-9164-7bdbf1e6d616',
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
    grantExpiresAt: '2026-11-06T00:05:00.000Z',
    nonce: '84bfb169-eafb-458a-920a-fde256e33a76',
  },
  {
    keyId: 'test-key',
    privateKey: keyPair.privateKey,
    notBefore: '2026-11-05T00:00:00.000Z',
    notAfter: '2026-11-07T00:00:00.000Z',
  },
  now,
);
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

function harness() {
  const calls: string[] = [];
  const store: BrokerIpcStore = {
    async consumeForBroker(id) {
      calls.push(`consume:${id}`);
      return { attempt, envelope };
    },
    async beginSyntheticSubmission(id) {
      calls.push(`begin:${id}`);
      return {
        ...attempt,
        status: 'submitting',
        brokerGeneration: 1,
        brokerLeaseExpiresAt: now.toISOString(),
      };
    },
    async recordSyntheticProviderEvent(id, _brokerInstanceId, _generation, event) {
      calls.push(`event:${id}:${event.eventId}`);
      return { ...attempt, status: event.status };
    },
    async claimBrokerRecoveryAttempt(id) {
      calls.push(`claim:${id}`);
      return { attempt, owned: true };
    },
    async listBrokerRecoveryCandidates(limit, afterAttemptId) {
      calls.push(`recover:${limit}:${afterAttemptId ?? 'start'}`);
      return [attempt];
    },
  };
  const app = createBrokerAuthorizerIpcApp({
    store,
    brokerServiceToken: brokerToken,
    apiServiceToken: apiToken,
  });
  return { app, calls };
}

const brokerHeaders = {
  'x-omnis-service-identity': 'omnis-synthetic-broker',
  authorization: `Bearer ${brokerToken}`,
};

describe('broker-only authorizer IPC', () => {
  it('refuses to reuse the API service credential as broker authority', () => {
    assert.throws(
      () =>
        createBrokerAuthorizerIpcApp({
          store: {} as BrokerIpcStore,
          brokerServiceToken: apiToken,
          apiServiceToken: apiToken,
        }),
      /distinct 256-bit service token/,
    );
  });

  it('requires broker identity and a separate broker token before any lifecycle operation', async () => {
    const { app, calls } = harness();
    try {
      const path = '/internal/broker/v1/admissions';
      const payload = { version: 'omnis.broker-authorizer-ipc.v1' };
      for (const headers of [
        {},
        { ...brokerHeaders, 'x-omnis-service-identity': 'omnis-api' },
        {
          'x-omnis-service-identity': 'omnis-synthetic-broker',
          authorization: `Bearer ${apiToken}`,
        },
      ]) {
        const response = await app.inject({ method: 'POST', url: path, headers, payload });
        assert.equal(response.statusCode, 401);
      }
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('exposes only the versioned broker lifecycle and recovery operations', async () => {
    const { app, calls } = harness();
    try {
      const admission = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/admissions',
        headers: brokerHeaders,
        payload: {
          version: 'omnis.broker-authorizer-ipc.v1',
          authorizationId,
          requestId,
          request: {
            projectId: `prj_${'1'.repeat(32)}`,
            projectRevision: 3,
            taskId: 'task-1',
            taskRevision: 7,
            agentId: 'agent-1',
            profileVersion: 4,
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
            promptDigest: createRenderedRequestDigest(renderedRequest),
          },
        },
      });
      assert.equal(admission.statusCode, 200);
      assert.equal(admission.json().attempt.id, attemptId);
      assert.equal(admission.json().envelope.audience, 'omnis-synthetic-broker');
      assert.equal(JSON.stringify(admission.json()).includes('privateKey'), false);

      const begin = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/submissions/begin',
        headers: brokerHeaders,
        payload: {
          version: 'omnis.broker-authorizer-ipc.v1',
          attemptId,
          brokerInstanceId: 'c22db4c2-27bc-4b1d-a73e-236199111111',
          envelope,
          renderedRequest,
        },
      });
      assert.equal(begin.statusCode, 200);
      assert.equal(begin.json().attempt.status, 'submitting');

      const event = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/provider-events',
        headers: brokerHeaders,
        payload: {
          version: 'omnis.broker-authorizer-ipc.v1',
          attemptId,
          brokerInstanceId: 'c22db4c2-27bc-4b1d-a73e-236199111111',
          brokerGeneration: 1,
          event: {
            eventId: 'lost-response-1',
            status: 'unknown',
            usage: {
              kind: 'unknown',
              reason: 'submission_uncertain',
              billingExposure: 'unknown',
            },
          },
        },
      });
      assert.equal(event.statusCode, 200);
      assert.equal(event.json().attempt.status, 'unknown');

      const recovery = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/recovery/list',
        headers: brokerHeaders,
        payload: {
          version: 'omnis.broker-authorizer-ipc.v1',
          limit: 10,
          afterAttemptId: null,
        },
      });
      assert.equal(recovery.statusCode, 200);
      assert.equal(recovery.json().attempts[0].id, attemptId);
      const claim = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/recovery/claim',
        headers: brokerHeaders,
        payload: {
          version: 'omnis.broker-authorizer-ipc.v1',
          attemptId,
          brokerInstanceId: 'c22db4c2-27bc-4b1d-a73e-236199111111',
        },
      });
      assert.equal(claim.statusCode, 200);
      assert.equal(claim.json().owned, true);
      assert.deepEqual(calls, [
        `consume:${authorizationId}`,
        `begin:${attemptId}`,
        `event:${attemptId}:lost-response-1`,
        'recover:10:start',
        `claim:${attemptId}`,
      ]);

      const ownerRoute = await app.inject({
        method: 'POST',
        url: `/internal/v1/connector-authorizations/${authorizationId}/decision`,
        headers: brokerHeaders,
        payload: {
          decision: 'approve',
          promptDigestConfirmation: createRenderedRequestDigest(renderedRequest),
        },
      });
      assert.equal(ownerRoute.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it('rejects forged owner attribution and malformed versioned requests before store access', async () => {
    const { app, calls } = harness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/admissions',
        headers: brokerHeaders,
        payload: {
          version: 'omnis.broker-authorizer-ipc.v1',
          authorizationId,
          requestId,
          actor: 'owner',
          request: {},
        },
      });
      assert.equal(response.statusCode, 400);
      const malformedJson = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/recovery/list',
        headers: { ...brokerHeaders, 'content-type': 'application/json' },
        payload: '{ malformed',
      });
      assert.equal(malformedJson.statusCode, 400);
      const tooLarge = await app.inject({
        method: 'POST',
        url: '/internal/broker/v1/recovery/list',
        headers: brokerHeaders,
        payload: { oversized: 'x'.repeat(65 * 1024) },
      });
      assert.equal(tooLarge.statusCode, 413);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('fails closed when the store cannot confirm a durable mutation', async () => {
    const { app } = harness();
    await app.close();
    const appUnavailable = createBrokerAuthorizerIpcApp({
      store: {
        async consumeForBroker() {
          throw new Error('synthetic database unavailable');
        },
        async beginSyntheticSubmission() {
          throw new Error('synthetic database unavailable');
        },
        async recordSyntheticProviderEvent() {
          throw new Error('synthetic database unavailable');
        },
        async claimBrokerRecoveryAttempt() {
          throw new Error('synthetic database unavailable');
        },
        async listBrokerRecoveryCandidates() {
          throw new Error('synthetic database unavailable');
        },
      },
      brokerServiceToken: brokerToken,
      apiServiceToken: apiToken,
    });
    try {
      const response = await appUnavailable.inject({
        method: 'POST',
        url: '/internal/broker/v1/provider-events',
        headers: brokerHeaders,
        payload: {
          version: 'omnis.broker-authorizer-ipc.v1',
          attemptId,
          brokerInstanceId: 'c22db4c2-27bc-4b1d-a73e-236199111111',
          brokerGeneration: 1,
          event: { eventId: 'event-1', status: 'unknown' },
        },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'authorization_outcome_unknown');
    } finally {
      await appUnavailable.close();
    }
  });

  it('serves the broker-only contract over a private Unix socket', async () => {
    const { app } = harness();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'omnis-broker-ipc-'));
    const socketPath = path.join(directory, 'broker.sock');
    try {
      await app.listen({ path: socketPath });
      await chmod(socketPath, 0o600);
      assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
      const result = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath,
            method: 'POST',
            path: '/internal/broker/v1/admissions',
            headers: {
              ...brokerHeaders,
              'content-type': 'application/json',
            },
          },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify({ version: 'omnis.broker-authorizer-ipc.v1' }));
      });
      assert.equal(result, 400);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

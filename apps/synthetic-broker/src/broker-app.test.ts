import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { createSyntheticBrokerApp } from './broker-app.ts';

const callerToken = 'synthetic-broker-test-token'.padEnd(64, 'x');
const renderedRequest = 'A revoked synthetic request fixture.';
const requestId = randomUUID();
const authorizationId = randomUUID();
const request = {
  projectId: `prj_${'a'.repeat(32)}`,
  projectRevision: 1,
  taskId: 'task-revoked-worker',
  taskRevision: 1,
  agentId: 'synthetic-worker-test',
  profileVersion: 1,
  connectorId: 'synthetic.codex.fixture',
  connectorVersion: '0.0.0-synthetic.1',
  providerId: 'synthetic',
  modelId: 'synthetic-text-only-v1',
  operation: 'connector.respond',
  capabilities: [],
  limits: {
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxDurationSeconds: 30,
    maxConcurrentRuns: 1,
    maxUsageUnits: 100,
    maxCostMicrousd: 100,
  },
  promptDigest: createRenderedRequestDigest(renderedRequest),
};

test('records a correlated fake-broker call before the revoked grant is rejected', async () => {
  const brokerCalls: string[] = [];
  const app = createSyntheticBrokerApp({
    callerToken,
    verificationKeys: [],
    onSubmissionCall: (seenRequestId) => brokerCalls.push(seenRequestId),
    authorizer: {
      admit: async () => {
        throw new Error('The synthetic authorization was revoked.');
      },
      begin: async () => {
        throw new Error('A revoked request must not begin submission.');
      },
      record: async () => {
        throw new Error('A revoked request must not record a provider result.');
      },
      claim: async () => {
        throw new Error('A revoked request must not claim an attempt.');
      },
    },
    provider: {
      submit: async () => {
        throw new Error('A revoked request must not reach the fake provider.');
      },
      events: async () => {
        throw new Error('A revoked request must not read provider events.');
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/broker/v1/submit',
      headers: { authorization: `Bearer ${callerToken}` },
      payload: {
        version: 'omnis.synthetic-broker.v1',
        authorizationId,
        requestId,
        request,
        renderedRequest,
      },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(brokerCalls, [requestId]);
  } finally {
    await app.close();
  }
});

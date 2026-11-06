import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SyntheticTaskRunRequestSchema,
  SyntheticTaskRunResponseSchema,
  SyntheticTaskRunEventsResponseSchema,
  SyntheticTaskRunEventsQuerySchema,
  syntheticTaskRunTestMode,
} from './synthetic-task-run.ts';

const request = {
  version: 'omnis.synthetic-task-run.v1',
  authorizationId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  request: {
    projectId: `prj_${'a'.repeat(32)}`,
    projectRevision: 1,
    taskId: 'task-0001',
    taskRevision: 1,
    agentId: 'fixture-agent',
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
    promptDigest: `sha256:${'b'.repeat(64)}`,
  },
  renderedRequest: 'synthetic test request',
};

describe('synthetic task-to-broker contract', () => {
  it('accepts only a versioned, fixed synthetic request with no caller authority fields', () => {
    assert.equal(SyntheticTaskRunRequestSchema.safeParse(request).success, true);
    assert.equal(
      SyntheticTaskRunRequestSchema.safeParse({ ...request, ownerId: 'owner' }).success,
      false,
    );
    assert.equal(
      SyntheticTaskRunRequestSchema.safeParse({
        ...request,
        request: { ...request.request, capabilities: ['shell'] },
      }).success,
      false,
    );
  });

  it('requires a completed response body for completed outcomes', () => {
    assert.equal(
      SyntheticTaskRunResponseSchema.safeParse({
        version: 'omnis.synthetic-task-run.v1',
        taskId: 'task-0001',
        authorizationId: request.authorizationId,
        requestId: request.requestId,
        correlationId: '55555555-5555-4555-8555-555555555555',
        attemptId: '33333333-3333-4333-8333-333333333333',
        status: 'completed',
        submitted: true,
        usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
      }).success,
      false,
    );
  });

  it('validates bounded, ordered synthetic task-run event history', () => {
    const event = {
      attemptId: '33333333-3333-4333-8333-333333333333',
      sequence: 4,
      eventType: 'connector.execution_completed',
      outcome: 'recorded',
      revocationGeneration: 0,
      occurredAt: '2026-11-07T00:00:00.000Z',
    };
    assert.equal(
      SyntheticTaskRunEventsResponseSchema.safeParse({
        version: 'omnis.synthetic-task-run-events.v1',
        authorizationId: request.authorizationId,
        taskId: request.request.taskId,
        events: [event],
        page: { nextAfter: null },
      }).success,
      true,
    );
    assert.equal(
      SyntheticTaskRunEventsResponseSchema.safeParse({
        version: 'omnis.synthetic-task-run-events.v1',
        authorizationId: request.authorizationId,
        taskId: request.request.taskId,
        events: [{ ...event, prompt: 'must not be exposed' }],
        page: { nextAfter: null },
      }).success,
      false,
    );
    assert.equal(SyntheticTaskRunEventsQuerySchema.safeParse({ after: '-1' }).success, false);
    assert.equal(SyntheticTaskRunEventsQuerySchema.safeParse({ after: ['1'] }).success, false);
    assert.equal(SyntheticTaskRunEventsQuerySchema.safeParse({ limit: '101' }).success, false);
    assert.equal(
      SyntheticTaskRunEventsResponseSchema.safeParse({
        version: 'omnis.synthetic-task-run-events.v1',
        authorizationId: request.authorizationId,
        taskId: request.request.taskId,
        events: [event],
        page: { nextAfter: 5 },
      }).success,
      false,
    );
  });

  it('keeps broker routes off by default and rejects enabling them outside test mode', () => {
    assert.equal(syntheticTaskRunTestMode({ NODE_ENV: 'production' }), false);
    assert.equal(
      syntheticTaskRunTestMode({ NODE_ENV: 'test', OMNIS_SYNTHETIC_BROKER_TEST_MODE: '1' }),
      true,
    );
    assert.throws(
      () =>
        syntheticTaskRunTestMode({ NODE_ENV: 'production', OMNIS_SYNTHETIC_BROKER_TEST_MODE: '1' }),
      /only be enabled in test mode/,
    );
  });
});

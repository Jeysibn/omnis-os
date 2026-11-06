import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Run, Task } from '@omnis/contracts';
import {
  createRenderedRequestDigest,
  type ConnectorAuthorizationRequest,
} from '@omnis/contracts/connector-authorization';
import { renderSyntheticConnectorRequest } from '@omnis/contracts/synthetic-connector-prompt';
import type { SyntheticBrokerRun } from '@omnis/db';
import type {
  SyntheticTaskRunRequest,
  SyntheticTaskRunResponse,
} from '@omnis/contracts/synthetic-task-run';
import { SyntheticBrokerRunCoordinator } from './synthetic-broker-run-coordinator.ts';

const task: Task = {
  id: 'task-0001',
  title: 'Synthetic worker task',
  detail: 'Return a bounded synthetic result.',
  status: 'open',
  createdAt: '2026-11-07T00:00:00.000Z',
  projectId: `prj_${'a'.repeat(32)}`,
  associationRevision: 1,
};
const profile = {
  versionId: 'profile_version_1',
  agentId: 'fixture-agent',
  versionNo: 1,
  profession: 'Synthetic assistant',
  seniority: null,
  specialties: ['testing'],
  personality: { traits: ['careful'], tone: 'plain', principles: [] },
  behavior: { autonomy: 'No external actions.', escalation: null },
  instructions: 'Return a synthetic answer.',
  createdBy: { id: 'owner', displayName: 'Owner' },
  createdAt: '2026-11-07T00:00:00.000Z',
};
const renderedRequest = renderSyntheticConnectorRequest(task, profile);
const binding: ConnectorAuthorizationRequest = {
  projectId: task.projectId!,
  projectRevision: 1,
  taskId: task.id,
  taskRevision: task.associationRevision!,
  agentId: profile.agentId,
  profileVersion: profile.versionNo,
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
const run: Run = {
  id: '33333333-3333-4333-8333-333333333333',
  taskId: task.id,
  taskTitle: task.title,
  status: 'queued',
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
};
const link: SyntheticBrokerRun = {
  run,
  authorizationId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  correlationId: run.id,
  binding,
  attemptId: null,
};

function coordinator(
  options: {
    brokerResult?: unknown;
    brokerError?: boolean;
    taskOverride?: Task;
    profileVersion?: number;
  } = {},
) {
  const calls: unknown[] = [];
  const brokerRequests: SyntheticTaskRunRequest[] = [];
  const resultCalls: unknown[] = [];
  const store = {
    getSyntheticBrokerRun: async () => link,
    getSyntheticBrokerRunByAuthorization: async () => link,
    getTask: async () => options.taskOverride ?? task,
    beginSyntheticBrokerRun: async () => ({
      run: { ...run, status: 'running' },
      started: true,
      events: [],
      generation: 1,
    }),
    renewSyntheticBrokerLease: async () => 'renewed',
    finishSyntheticBrokerRun: async (
      _runId: string,
      _worker: string,
      generation: number,
      result: unknown,
    ) => {
      resultCalls.push({ generation, result });
      return { run: { ...run, status: (result as { status: string }).status }, events: [] };
    },
    requestSyntheticBrokerStop: async () => ({ run: { ...run, status: 'stopping' }, events: [] }),
    admitSyntheticBrokerRun: async (
      input: unknown,
      enqueue: (tx: never, data: { runId: string }) => Promise<string | null>,
    ) => {
      await enqueue({ executeSql: async () => ({ rows: [] }) } as never, { runId: run.id });
      return { run, created: true, events: [] };
    },
  };
  const profiles = {
    getVersion: async () => ({
      agent: { id: profile.agentId },
      version: { ...profile, versionNo: options.profileVersion ?? profile.versionNo },
      isCurrent: true,
    }),
  };
  const instance = new SyntheticBrokerRunCoordinator({
    store: store as never,
    profiles: profiles as never,
    broker: {
      execute: async (_taskId, request) => {
        brokerRequests.push(request);
        if (options.brokerError) throw new Error('synthetic broker response lost');
        return (options.brokerResult ?? {
          version: 'omnis.synthetic-task-run.v1',
          taskId: task.id,
          authorizationId: link.authorizationId,
          requestId: link.requestId,
          correlationId: link.correlationId,
          attemptId: '44444444-4444-4444-8444-444444444444',
          status: 'completed',
          submitted: true,
          usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
          responseText: 'Synthetic result',
        }) as SyntheticTaskRunResponse;
      },
    },
    enqueue: async (_tx, data) => {
      calls.push(data);
      return `job-${data.runId}`;
    },
    publish: () => {},
  });
  return { instance, calls, brokerRequests, resultCalls, store };
}

describe('synthetic broker task run coordinator', () => {
  it('queues only the canonical Run ID and reconstructs the exact approved prompt at execution', async () => {
    const fixture = coordinator();
    const admitted = await fixture.instance.admit({
      taskId: task.id,
      authorizationId: link.authorizationId,
      requestId: link.requestId,
      correlationId: link.correlationId,
      binding,
    });
    assert.equal(admitted.run.id, run.id);
    assert.deepEqual(fixture.calls, [{ runId: run.id }]);

    await fixture.instance.handleQueueJob({ runId: run.id });
    const request = fixture.brokerRequests[0]!;
    assert.equal(request.renderedRequest, renderedRequest);
    assert.equal(request.request.promptDigest, binding.promptDigest);
    assert.deepEqual(fixture.resultCalls[0], {
      generation: 1,
      result: {
        attemptId: '44444444-4444-4444-8444-444444444444',
        status: 'completed',
        responseText: 'Synthetic result',
      },
    });
  });

  it('keeps a lost broker response unknown and never changes the retry identity', async () => {
    const fixture = coordinator({ brokerError: true });
    await fixture.instance.handleQueueJob({ runId: run.id });
    assert.deepEqual(fixture.resultCalls, [{ generation: 1, result: { status: 'unknown' } }]);
    assert.equal(fixture.brokerRequests.length, 1);
  });

  it('rejects changed immutable inputs before the broker call', async () => {
    const fixture = coordinator({ taskOverride: { ...task, detail: 'changed after approval' } });
    await fixture.instance.handleQueueJob({ runId: run.id });
    assert.equal(fixture.calls.length, 0);
    assert.deepEqual(fixture.resultCalls, [{ generation: 1, result: { status: 'failed' } }]);
  });

  it('rejects a substituted immutable profile version before the broker call', async () => {
    const fixture = coordinator({ profileVersion: 2 });
    await fixture.instance.handleQueueJob({ runId: run.id });
    assert.equal(fixture.brokerRequests.length, 0);
    assert.deepEqual(fixture.resultCalls, [{ generation: 1, result: { status: 'failed' } }]);
  });

  it('accepts a missing correlation only for a submitted unknown outcome', async () => {
    const fixture = coordinator({
      brokerResult: {
        version: 'omnis.synthetic-task-run.v1',
        taskId: task.id,
        authorizationId: link.authorizationId,
        requestId: link.requestId,
        attemptId: '44444444-4444-4444-8444-444444444444',
        status: 'unknown',
        submitted: true,
        usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
      },
    });
    await fixture.instance.handleQueueJob({ runId: run.id });
    assert.equal(
      (fixture.resultCalls[0] as { result: { status: string } }).result.status,
      'unknown',
    );
  });
});

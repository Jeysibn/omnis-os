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
  agentId: 'fixture-agent',
  profileVersion: 1,
  runtimeId: 'mock',
  assignmentRevision: 1,
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
  generation: 1,
  authorizationId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  correlationId: run.id,
  binding,
  attemptId: null,
};

function coordinator(
  options: {
    projectionRead?: () => Promise<SyntheticTaskRunResponse>;
    brokerResult?: unknown;
    brokerError?: boolean;
    brokerSequence?: Array<unknown | Error>;
    recoveryTimeoutMs?: number;
    taskOverride?: Task;
    profileVersion?: number;
  } = {},
) {
  const calls: unknown[] = [];
  const brokerRequests: SyntheticTaskRunRequest[] = [];
  const resultCalls: unknown[] = [];
  const executionOrder: string[] = [];
  let brokerCall = 0;
  const store = {
    listUnknownSyntheticRuns: async () => [link],
    reconcileSyntheticBrokerRun: async (_link: unknown, evidence: unknown) => {
      resultCalls.push(evidence);
      return [];
    },
    getSyntheticBrokerRun: async () => link,
    getSyntheticBrokerRunByAuthorization: async () => link,
    getTask: async () => options.taskOverride ?? task,
    beginSyntheticBrokerRun: async () => ({
      run: { ...run, status: 'running' },
      started: true,
      events: [],
      generation: 1,
    }),
    recordSyntheticBrokerSubmissionRequested: async () => {
      executionOrder.push('submission-requested-event');
      return { run: { ...run, status: 'running' }, events: [] };
    },
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
      ...(options.projectionRead ? { reconcile: options.projectionRead } : {}),
      execute: async (_taskId, request) => {
        executionOrder.push('broker-execute');
        brokerRequests.push(request);
        const sequenceResult = options.brokerSequence?.[brokerCall++];
        if (sequenceResult instanceof Error) throw sequenceResult;
        if (sequenceResult !== undefined) return sequenceResult as SyntheticTaskRunResponse;
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
    recoveryTimeoutMs: options.recoveryTimeoutMs ?? 50,
  });
  return { instance, calls, brokerRequests, resultCalls, executionOrder, store };
}

describe('synthetic broker task run coordinator', () => {
  it('reconciles after the original job finished using only the read-only boundary', async () => {
    const evidence: SyntheticTaskRunResponse = {
      version: 'omnis.synthetic-task-run.v1',
      taskId: task.id,
      authorizationId: link.authorizationId,
      requestId: link.requestId,
      correlationId: link.correlationId,
      attemptId: '44444444-4444-4444-8444-444444444444',
      status: 'completed',
      submitted: true,
      responseText: 'Late synthetic result',
      usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
    };
    let unavailable = true;
    const fixture = coordinator({
      projectionRead: async () => {
        if (unavailable) throw new Error('Authorizer unavailable');
        return evidence;
      },
    });
    const discover = fixture.store.listUnknownSyntheticRuns;
    fixture.store.listUnknownSyntheticRuns = async () => {
      throw new Error('Disposable PostgreSQL temporarily unavailable');
    };
    await assert.rejects(
      fixture.instance.reconcileUnknownRuns(),
      /PostgreSQL temporarily unavailable/,
    );
    assert.equal(fixture.resultCalls.length, 0);
    fixture.store.listUnknownSyntheticRuns = discover;
    await fixture.instance.reconcileUnknownRuns();
    assert.equal(fixture.resultCalls.length, 0);
    unavailable = false;
    await fixture.instance.reconcileUnknownRuns();
    assert.deepEqual(fixture.resultCalls, [evidence]);
    assert.equal(fixture.brokerRequests.length, 0);
    assert.equal(fixture.calls.length, 0);
  });

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
    assert.deepEqual(fixture.executionOrder, ['submission-requested-event', 'broker-execute']);
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

  it('recovers a lost broker response using the same authorization and request identity', async () => {
    const result = {
      version: 'omnis.synthetic-task-run.v1',
      taskId: task.id,
      authorizationId: link.authorizationId,
      requestId: link.requestId,
      correlationId: link.correlationId,
      attemptId: '44444444-4444-4444-8444-444444444444',
      status: 'completed',
      submitted: true,
      usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
      responseText: 'Recovered result',
    };
    const fixture = coordinator({
      brokerSequence: [new Error('synthetic broker response lost'), result],
      recoveryTimeoutMs: 1_000,
    });
    await fixture.instance.handleQueueJob({ runId: run.id });
    assert.deepEqual(fixture.resultCalls, [
      {
        generation: 1,
        result: {
          attemptId: result.attemptId,
          status: 'completed',
          responseText: 'Recovered result',
        },
      },
    ]);
    assert.equal(fixture.brokerRequests.length, 2);
    assert.deepEqual(fixture.brokerRequests[0], fixture.brokerRequests[1]);
  });

  it('leaves the Run unknown after bounded broker recovery cannot confirm an outcome', async () => {
    const fixture = coordinator({ brokerError: true, recoveryTimeoutMs: 300 });
    await fixture.instance.handleQueueJob({ runId: run.id });
    assert.deepEqual(fixture.resultCalls, [{ generation: 1, result: { status: 'unknown' } }]);
    assert.ok(fixture.brokerRequests.length > 1);
    assert.ok(fixture.brokerRequests.every((request) => request === fixture.brokerRequests[0]));
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

  it('keeps an unknown response without correlation uncertain and does not bind its attempt', async () => {
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
    assert.deepEqual(fixture.resultCalls, [{ generation: 1, result: { status: 'unknown' } }]);
  });

  it('does not persist a completed result with a different correlation identity', async () => {
    const fixture = coordinator({
      brokerResult: {
        version: 'omnis.synthetic-task-run.v1',
        taskId: task.id,
        authorizationId: link.authorizationId,
        requestId: link.requestId,
        correlationId: '55555555-5555-4555-8555-555555555555',
        attemptId: '44444444-4444-4444-8444-444444444444',
        status: 'completed',
        submitted: true,
        usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
        responseText: 'Unbound response',
      },
    });
    await fixture.instance.handleQueueJob({ runId: run.id });
    assert.deepEqual(fixture.resultCalls, [{ generation: 1, result: { status: 'unknown' } }]);
  });
});

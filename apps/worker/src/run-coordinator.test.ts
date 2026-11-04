import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Run, Task } from '@omnis/contracts';
import { StoreError, type PostgresRunStore } from '@omnis/db';
import { MockRuntimeAdapter, type RuntimeAdapter } from '@omnis/runtime-adapters';
import { CoordinatorError, RunCoordinator } from './run-coordinator.ts';
import { SandboxError } from '@omnis/runtime-adapters/sandbox-error';

const authId = '11111111-1111-4111-8111-111111111111';
const authorizationRecord = {
  id: authId,
  requestingActor: 'owner' as const,
  runtimeId: 'mock' as const,
  operation: 'execute_task' as const,
  taskId: 'task-0001',
  capabilities: ['mock.execute'] as ['mock.execute'],
  scope: { kind: 'task' as const, taskId: 'task-0001' },
  status: 'authorized' as const,
  policyVersion: 'r1g4-mock-v1',
  correlationId: authId,
  expiresAt: '2999-01-01T00:00:00.000Z',
  createdAt: '2026-11-03T00:00:00.000Z',
  decidedAt: '2026-11-03T00:00:00.000Z',
  decidedBy: 'owner' as const,
  revokedAt: null,
  revokedBy: null,
  consumedAt: null,
  consumedRunId: null,
};
const defaultAuthorizationStore = {
  get: async (id: string) => (id === authId ? authorizationRecord : undefined),
  getForRun: async () => authorizationRecord,
};
const emptyAuthorizationStore = {
  get: async () => undefined,
  getForRun: async () => undefined,
  recordEnforcementDenied: async () => undefined,
};

function testCoordinator(
  store: PostgresRunStore,
  queue: ConstructorParameters<typeof RunCoordinator>[1],
  runtime: RuntimeAdapter,
  heartbeatIntervalMs?: number,
  authorizations: unknown = defaultAuthorizationStore,
) {
  return new RunCoordinator(store, queue, runtime, authorizations as never, heartbeatIntervalMs);
}

describe('durable mock run coordinator', () => {
  it('validates and forwards bounded project workspace reads without touching run state', async () => {
    const calls: Array<{ projectId: string; query: unknown }> = [];
    const coordinator = testCoordinator(
      {
        listProjectWorkspaceTasks: async (projectId: string, query: unknown) => {
          calls.push({ projectId, query });
          return {
            tasks: [],
            page: { observedTotal: 0, complete: true, nextCursor: null },
          };
        },
      } as unknown as PostgresRunStore,
      { send: async () => null, findJobs: async () => [] },
      new MockRuntimeAdapter(),
    );
    const projectId = `prj_${'a'.repeat(32)}`;
    assert.deepEqual(await coordinator.listProjectWorkspaceTasks(projectId, { limit: '25' }), {
      tasks: [],
      page: { observedTotal: 0, complete: true, nextCursor: null },
    });
    assert.deepEqual(calls, [{ projectId, query: { limit: 25 } }]);
    await assert.rejects(
      coordinator.listProjectWorkspaceTasks(projectId, { limit: '101' }),
      (error: unknown) =>
        error instanceof CoordinatorError &&
        error.statusCode === 422 &&
        error.code === 'invalid_input',
    );
  });

  it('translates archived-project admission failures into a stable conflict', async () => {
    const denials: string[] = [];
    const coordinator = testCoordinator(
      {
        admitRun: async () => {
          throw new StoreError(
            'project_archived',
            'Archived-project task associations cannot be changed or admitted to run.',
            409,
          );
        },
      } as unknown as PostgresRunStore,
      { send: async () => 'job', findJobs: async () => [] },
      new MockRuntimeAdapter(),
      undefined,
      {
        ...defaultAuthorizationStore,
        recordEnforcementDenied: async (
          _authorizationId: string,
          _taskId: string,
          reason: string,
        ) => {
          denials.push(reason);
        },
      },
    );
    await assert.rejects(
      coordinator.startRun('task-0001', 'idempotency-key-0001', authId),
      (error: unknown) =>
        error instanceof CoordinatorError &&
        error.code === 'project_archived' &&
        error.statusCode === 409 &&
        error.message ===
          'Archived-project task associations cannot be changed or admitted to run.',
    );
    assert.deepEqual(denials, ['project_archived']);
  });

  it('rejects admission without independent Omnis authorization', async () => {
    let admissions = 0;
    const coordinator = testCoordinator(
      {
        admitRun: async () => {
          admissions += 1;
        },
      } as unknown as PostgresRunStore,
      { send: async () => 'job', findJobs: async () => [] },
      new MockRuntimeAdapter(),
      undefined,
      emptyAuthorizationStore,
    );
    await assert.rejects(
      coordinator.startRun('task-0001', 'idempotency-key-0001', authId),
      (error: unknown) => error instanceof CoordinatorError && error.code === 'invalid_transition',
    );
    assert.equal(admissions, 0);
  });

  it('fails closed when durable authorization lookup is unavailable', async () => {
    let admissions = 0;
    const coordinator = testCoordinator(
      {
        admitRun: async () => {
          admissions += 1;
        },
      } as unknown as PostgresRunStore,
      { send: async () => 'job', findJobs: async () => [] },
      new MockRuntimeAdapter(),
      undefined,
      {
        get: async () => {
          throw new Error('database unavailable');
        },
      },
    );
    await assert.rejects(
      coordinator.startRun('task-0001', 'idempotency-key-0001', authId),
      /database unavailable/,
    );
    assert.equal(admissions, 0);
  });

  it('surfaces database admission lock timeouts as an explicit retryable 503', async () => {
    const coordinator = testCoordinator(
      {
        admitRun: async () => {
          throw Object.assign(new Error('lock timeout'), { code: '55P03' });
        },
      } as unknown as PostgresRunStore,
      { send: async () => 'job', findJobs: async () => [] },
      new MockRuntimeAdapter(),
    );
    await assert.rejects(
      coordinator.startRun('task-0001', 'idempotency-key-0001', authId),
      (error: unknown) =>
        error instanceof CoordinatorError &&
        error.code === 'admission_busy' &&
        error.statusCode === 503 &&
        /no run was admitted/.test(error.message),
    );
  });

  it('rechecks authorization before claiming queued work and interrupts a revoked grant', async () => {
    let revoked = false;
    let interrupted = false;
    const run = {
      id: 'run-0001',
      taskId: 'task-0001',
      taskTitle: 'Test',
      status: 'queued',
      runtimeKind: 'mock',
      synthetic: true,
      usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    } as Run;
    const store = {
      admitRun: async () => ({ run, created: true, events: [] }),
      getRun: async () => run,
      interruptQueuedRun: async () => {
        interrupted = true;
        return { events: [] };
      },
      listActiveRunIds: async () => [],
    } as unknown as PostgresRunStore;
    const coordinator = testCoordinator(
      store,
      { send: async () => 'job', findJobs: async () => [] },
      new MockRuntimeAdapter(),
      undefined,
      {
        get: async () => authorizationRecord,
        getForRun: async () => ({
          ...authorizationRecord,
          status: revoked ? 'revoked' : 'authorized',
        }),
      } as never,
    );
    await coordinator.startRun(run.taskId, 'idempotency-key-0001', authId);
    revoked = true;
    await coordinator.handleQueueJob({ runId: run.id });
    assert.equal(interrupted, true);
  });
  it('admits queue work with automatic retries disabled', async () => {
    let capturedOptions: unknown;
    let capturedIdempotencyKey = '';
    let created = true;
    const run: Run = {
      id: 'run-0001',
      taskId: 'task-0001',
      taskTitle: 'Inspect files',
      status: 'queued',
      runtimeKind: 'mock',
      synthetic: true,
      usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    const store = {
      admitRun: async (
        _taskId: string,
        idempotencyKey: string,
        _authorizationId: string,
        enqueue: (tx: never, data: { runId: string }) => Promise<string | null>,
      ) => {
        capturedIdempotencyKey = idempotencyKey;
        const jobId = await enqueue({ executeSql: async () => ({ rows: [] }) } as never, {
          runId: run.id,
        });
        assert.equal(jobId, 'job-0001');
        return { run, created, events: [] };
      },
    } as unknown as PostgresRunStore;
    const queue = {
      send: async (_name: string, data: { runId: string }, options: unknown) => {
        assert.deepEqual(data, { runId: run.id });
        capturedOptions = options;
        return 'job-0001';
      },
      findJobs: async () => [],
    };
    const coordinator = testCoordinator(store, queue, new MockRuntimeAdapter());

    const first = await coordinator.startRun('task-0001', 'idempotency-key-0001', authId);
    assert.equal(first.created, true);
    assert.equal(capturedIdempotencyKey, 'idempotency-key-0001');
    const options = capturedOptions as {
      retryLimit: number;
      retryDelay: number;
      expireInSeconds: number;
      heartbeatSeconds: number;
      db: { executeSql?: unknown };
    };
    assert.equal(options.retryLimit, 0);
    assert.equal(options.retryDelay, 0);
    assert.equal(options.expireInSeconds, 60);
    assert.equal(options.heartbeatSeconds, 10);
    assert.equal(typeof options.db.executeSql, 'function');

    created = false;
    const retry = await coordinator.startRun('task-0001', 'idempotency-key-0001', authId);
    assert.equal(retry.created, false);
    assert.equal(retry.run.id, first.run.id);
  });

  it('rejects malformed durable job payloads before touching the store', async () => {
    const coordinator = testCoordinator(
      {} as PostgresRunStore,
      {
        send: async () => null,
        findJobs: async () => [],
      },
      new MockRuntimeAdapter(),
    );
    await assert.rejects(
      coordinator.handleQueueJob({ runId: '../../anything' }),
      /durable mock job payload is invalid/,
    );
  });

  it('rejects a task whose schema is invalid before reaching persistence', async () => {
    const coordinator = testCoordinator(
      {} as PostgresRunStore,
      {
        send: async () => null,
        findJobs: async () => [],
      },
      new MockRuntimeAdapter(),
    );
    await assert.rejects(
      coordinator.createTask({ title: 'x', detail: '' }),
      (error: unknown) => error instanceof CoordinatorError && error.code === 'invalid_input',
    );
  });

  it('marks a lost queued job interrupted instead of allowing an automatic retry', async () => {
    let interruptedRunId = '';
    const event = {
      id: 'evt-run-0001-0001',
      runId: 'run-0001',
      sequence: 1,
      at: '2026-11-02T00:00:00.000Z',
      type: 'run.interrupted' as const,
      source: 'mock' as const,
      synthetic: true as const,
      message: 'The durable queue job failed before starting.',
    };
    const store = {
      reconcileExpiredRuns: async () => [],
      listQueuedJobs: async () => [{ runId: 'run-0001', status: 'queued', jobId: 'job-0001' }],
      interruptQueuedRun: async (runId: string) => {
        interruptedRunId = runId;
        return { run: {} as Run, events: [{ runId, event }] };
      },
    } as unknown as PostgresRunStore;
    const queue = {
      send: async () => null,
      findJobs: async () => [{ id: 'job-0001', state: 'failed' as const }],
    };
    const coordinator = testCoordinator(store, queue, new MockRuntimeAdapter());

    await coordinator.reconcileExpiredRuns();
    assert.equal(interruptedRunId, 'run-0001');
  });

  it('acknowledges stopping work after the queue confirms its job is terminal', async () => {
    let acknowledgedRunId = '';
    const store = {
      reconcileExpiredRuns: async () => [],
      listQueuedJobs: async () => [{ runId: 'run-0001', status: 'stopping', jobId: 'job-0001' }],
      cancelRunAfterQueueTerminal: async (runId: string) => {
        acknowledgedRunId = runId;
        return { run: {} as Run, events: [] };
      },
    } as unknown as PostgresRunStore;
    const queue = {
      send: async () => null,
      findJobs: async () => [{ id: 'job-0001', state: 'failed' as const }],
    };
    const coordinator = testCoordinator(store, queue, new MockRuntimeAdapter());

    await coordinator.reconcileExpiredRuns();
    assert.equal(acknowledgedRunId, 'run-0001');
  });

  it('acknowledges a stop observed through the durable lease heartbeat', async () => {
    const now = '2026-11-02T00:00:00.000Z';
    const run: Run = {
      id: 'run-0001',
      taskId: 'task-0001',
      taskTitle: 'Inspect files',
      status: 'running',
      runtimeKind: 'mock',
      synthetic: true,
      usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
      createdAt: now,
      updatedAt: now,
    };
    const task: Task = {
      id: 'task-0001',
      title: 'Inspect files',
      detail: 'List files without changing them.',
      status: 'open',
      createdAt: now,
    };
    let cancellationAcknowledged = false;
    const store = {
      getRun: async () => ({ ...run, status: 'queued' as const }),
      beginExecution: async () => ({ run, started: true, generation: 1, events: [] }),
      getTask: async () => task,
      renewLease: async () => 'stop_requested' as const,
      cancelRun: async () => {
        cancellationAcknowledged = true;
        return { run: { ...run, status: 'cancelled' }, events: [] };
      },
      appendOutput: async () => undefined,
    } as unknown as PostgresRunStore;
    const coordinator = testCoordinator(
      store,
      { send: async () => null, findJobs: async () => [] },
      new MockRuntimeAdapter(),
      10,
    );

    await coordinator.handleQueueJob({ runId: run.id });
    assert.equal(cancellationAcknowledged, true);
  });

  it('uses the injected sandbox runtime and persists its successful output', async () => {
    let taskSeen: Task | undefined;
    const { coordinator, state } = lifecycleHarness({
      kind: 'mock',
      discoverCapabilities: () => new MockRuntimeAdapter().discoverCapabilities(),
      execute: async (input) => {
        taskSeen = input.task;
        assert.equal(input.signal.aborted, false);
        return { output: 'Synthetic sandbox result.' };
      },
    });

    await coordinator.handleQueueJob({ runId: lifecycleRun.id });

    assert.deepEqual(taskSeen, lifecycleTask);
    assert.equal(state.completedOutput, 'Synthetic sandbox result.');
    assert.equal(state.failureMessage, undefined);
  });

  it('passes PostgreSQL active leases to sandbox orphan recovery after reconciliation', async () => {
    let resolvedCandidates: readonly string[] = [];
    const store = {
      reconcileExpiredRuns: async () => [],
      listQueuedJobs: async () => [],
      listActiveRunIds: async (candidateIds?: readonly string[]) => {
        resolvedCandidates = candidateIds ?? [];
        return candidateIds?.filter((runId) => runId === 'run-0002') ?? [];
      },
    } as unknown as PostgresRunStore;
    const runtime: RuntimeAdapter = {
      kind: 'mock',
      discoverCapabilities: () => new MockRuntimeAdapter().discoverCapabilities(),
      cleanupOrphanedExecutions: async (resolveActiveRunIds) => {
        const activeRunIds = await resolveActiveRunIds(['run-0001', 'run-0002']);
        assert.deepEqual(activeRunIds, ['run-0002']);
      },
      execute: async () => ({ output: 'Synthetic test result.' }),
    };
    const coordinator = testCoordinator(
      store,
      { send: async () => null, findJobs: async () => [] },
      runtime,
    );

    await coordinator.reconcileExpiredRuns();

    assert.deepEqual(resolvedCandidates, ['run-0001', 'run-0002']);
  });

  it('maps a sandbox timeout to a safe failed-run message', async () => {
    const { coordinator, state } = lifecycleHarness(failingRuntime(new SandboxError('timed_out')));

    await coordinator.handleQueueJob({ runId: lifecycleRun.id });

    assert.equal(state.failureMessage, 'The sandbox execution exceeded its time limit.');
  });

  it('does not persist raw sandbox crash details', async () => {
    const crash = new SandboxError('crashed');
    Object.defineProperty(crash, 'message', { value: 'secret path /tmp/private-token' });
    const { coordinator, state } = lifecycleHarness(failingRuntime(crash));

    await coordinator.handleQueueJob({ runId: lifecycleRun.id });

    assert.equal(state.failureMessage, 'The sandboxed mock process exited unexpectedly.');
    assert.equal(state.failureMessage?.includes('private-token'), false);
  });

  it('aborts the sandbox runtime and acknowledges operator cancellation', async () => {
    let runtimeStarted: (() => void) | undefined;
    let sawAbort = false;
    const runtime: RuntimeAdapter = {
      kind: 'mock',
      discoverCapabilities: () => new MockRuntimeAdapter().discoverCapabilities(),
      execute: ({ signal }) =>
        new Promise((_resolve, reject) => {
          runtimeStarted?.();
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(new SandboxError('cancelled'));
            },
            { once: true },
          );
        }),
    };
    const { coordinator, state } = lifecycleHarness(runtime);
    const started = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });
    const execution = coordinator.handleQueueJob({ runId: lifecycleRun.id });
    await started;
    await coordinator.stopRun(lifecycleRun.id);
    await execution;

    assert.equal(sawAbort, true);
    assert.equal(state.cancelled, true);
    assert.equal(state.failureMessage, undefined);
  });

  it('records interruption when sandbox termination cannot be confirmed', async () => {
    let runtimeStarted: (() => void) | undefined;
    const runtime: RuntimeAdapter = {
      kind: 'mock',
      discoverCapabilities: () => new MockRuntimeAdapter().discoverCapabilities(),
      execute: ({ signal }) =>
        new Promise((_resolve, reject) => {
          runtimeStarted?.();
          signal.addEventListener('abort', () => reject(new SandboxError('termination_failed')), {
            once: true,
          });
        }),
    };
    const { coordinator, state } = lifecycleHarness(runtime);
    const started = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });
    const execution = coordinator.handleQueueJob({ runId: lifecycleRun.id });
    await started;
    await coordinator.stopRun(lifecycleRun.id);
    await execution;

    assert.equal(state.cancelled, false);
    assert.equal(state.interrupted, true);
    assert.equal(
      state.interruptionMessage,
      'The sandbox stop could not be confirmed. The run was interrupted for safety.',
    );
  });
});

const lifecycleRun: Run = {
  id: 'run-0001',
  taskId: 'task-0001',
  taskTitle: 'Inspect files',
  status: 'running',
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
};

const lifecycleTask: Task = {
  id: lifecycleRun.taskId,
  title: lifecycleRun.taskTitle,
  detail: 'Read-only mock task input.',
  status: 'open',
  createdAt: lifecycleRun.createdAt,
};

function failingRuntime(error: Error): RuntimeAdapter {
  return {
    kind: 'mock',
    discoverCapabilities: () => new MockRuntimeAdapter().discoverCapabilities(),
    execute: async () => {
      throw error;
    },
  };
}

function lifecycleHarness(runtime: RuntimeAdapter): {
  coordinator: RunCoordinator;
  state: {
    completedOutput?: string;
    failureMessage?: string;
    cancelled: boolean;
    interrupted: boolean;
    interruptionMessage?: string;
  };
} {
  const state: {
    completedOutput?: string;
    failureMessage?: string;
    cancelled: boolean;
    interrupted: boolean;
    interruptionMessage?: string;
  } = {
    cancelled: false,
    interrupted: false,
  };
  const store = {
    getRun: async () => ({ ...lifecycleRun, status: 'queued' as const }),
    beginExecution: async () => ({ run: lifecycleRun, started: true, generation: 1, events: [] }),
    getTask: async () => lifecycleTask,
    renewLease: async () => 'renewed' as const,
    appendOutput: async () => undefined,
    completeRun: async (_runId: string, _workerId: string, _generation: number, output: string) => {
      state.completedOutput = output;
      return { run: { ...lifecycleRun, status: 'completed' as const }, events: [] };
    },
    failRun: async (_runId: string, _workerId: string, _generation: number, message: string) => {
      state.failureMessage = message;
      return { run: { ...lifecycleRun, status: 'failed' as const }, events: [] };
    },
    requestStop: async () => ({
      run: { ...lifecycleRun, status: 'stopping' as const },
      events: [],
    }),
    cancelRun: async () => {
      state.cancelled = true;
      return { run: { ...lifecycleRun, status: 'cancelled' as const }, events: [] };
    },
    interruptRun: async (
      _runId: string,
      _workerId: string,
      _generation: number,
      message?: string,
    ) => {
      state.interrupted = true;
      if (message !== undefined) state.interruptionMessage = message;
      return { run: { ...lifecycleRun, status: 'interrupted' as const }, events: [] };
    },
  } as unknown as PostgresRunStore;
  const coordinator = testCoordinator(
    store,
    { send: async () => null, findJobs: async () => [] },
    runtime,
    60_000,
  );
  return { coordinator, state };
}

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FindJobsOptions, JobWithMetadata, SendOptions } from 'pg-boss';
import { StoreError, type DurableEvent, type PostgresRunStore } from '@omnis/db';
import {
  CreateTaskSchema,
  RunEventSchema,
  RunSchema,
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceTaskPageSchema,
  SetTaskExecutionAssignmentSchema,
  type ProjectWorkspaceTaskPage,
  SetTaskProjectSchema,
  TaskSchema,
  type CreateTaskInput,
  type Run,
  type RunEvent,
  type Task,
} from '@omnis/contracts';
import { evaluateAllowedUse } from '@omnis/policy';
import type { RuntimeAuthorizationReader } from '@omnis/db';
import type { RuntimeAdapter } from '@omnis/runtime-adapters';
import { SandboxError } from '@omnis/runtime-adapters/sandbox-error';

export class CoordinatorError extends Error {
  readonly code:
    | 'invalid_input'
    | 'not_found'
    | 'invalid_transition'
    | 'project_archived'
    | 'concurrency_limit'
    | 'admission_busy'
    | 'conflict'
    | 'invalid_cursor';
  readonly statusCode: 400 | 404 | 409 | 422 | 503;

  constructor(
    code:
      | 'invalid_input'
      | 'not_found'
      | 'invalid_transition'
      | 'project_archived'
      | 'concurrency_limit'
      | 'admission_busy'
      | 'conflict'
      | 'invalid_cursor',
    message: string,
    statusCode: 400 | 404 | 409 | 422 | 503,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const QueueRunSchema = z.object({ runId: z.string().regex(/^run-[0-9]{4,}$/) });
export const queueName = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{2,63}$/)
  .parse(process.env.OMNIS_QUEUE_NAME ?? 'omnis-mock-run');
const runLeaseSeconds = 30;
const leaseHeartbeatMs = 5_000;
type AbortCause = 'cancel-requested' | 'claim-lost' | 'worker-shutdown' | 'persistence-failed';
type ActiveExecution = { controller: AbortController; promise: Promise<void> };

export class RunCoordinator {
  private readonly emitter = new EventEmitter();
  private readonly workerId = randomUUID();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly runtime: RuntimeAdapter;
  private readonly authorizations: RuntimeAuthorizationReader;
  private shuttingDown = false;
  private readonly store: PostgresRunStore;
  private readonly heartbeatIntervalMs: number;
  private readonly queue: {
    send(name: string, data?: object | null, options?: SendOptions): Promise<string | null>;
    findJobs(
      name: string,
      options?: FindJobsOptions,
    ): Promise<Array<Pick<JobWithMetadata, 'id' | 'state'>>>;
  };

  constructor(
    store: PostgresRunStore,
    queue: RunCoordinator['queue'],
    runtime: RuntimeAdapter,
    authorizations: RuntimeAuthorizationReader,
    heartbeatIntervalMs = leaseHeartbeatMs,
  ) {
    this.store = store;
    this.queue = queue;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.runtime = runtime;
    this.authorizations = authorizations;
  }

  async createTask(input: CreateTaskInput, requestId?: string): Promise<Task> {
    const parsed = CreateTaskSchema.safeParse(input);
    if (!parsed.success) throw new CoordinatorError('invalid_input', 'Task input is invalid.', 400);
    return translateStoreError(() => this.store.createTask(parsed.data, requestId));
  }

  async setTaskProject(taskId: string, input: unknown, requestId: string): Promise<Task> {
    const parsed = SetTaskProjectSchema.safeParse(input);
    if (!parsed.success)
      throw new CoordinatorError('invalid_input', 'Task project input is invalid.', 400);
    return translateStoreError(() => this.store.setTaskProject(taskId, parsed.data, requestId));
  }

  async setTaskExecutionAssignment(
    taskId: string,
    input: unknown,
    requestId: string,
  ): Promise<Task> {
    const parsed = SetTaskExecutionAssignmentSchema.safeParse(input);
    if (!parsed.success)
      throw new CoordinatorError(
        'invalid_input',
        'Task execution assignment input is invalid.',
        400,
      );
    return translateStoreError(() =>
      this.store.setTaskExecutionAssignment(taskId, parsed.data, requestId),
    );
  }

  async listTasks(): Promise<Task[]> {
    return this.store.listTasks();
  }

  async listProjectWorkspaceTasks(
    projectId: string,
    query: unknown,
  ): Promise<ProjectWorkspaceTaskPage> {
    const parsed = ProjectWorkspaceQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new CoordinatorError('invalid_input', 'Project workspace query is invalid.', 422);
    return translateStoreError(async () =>
      ProjectWorkspaceTaskPageSchema.parse(
        await this.store.listProjectWorkspaceTasks(projectId, parsed.data),
      ),
    );
  }

  async startRun(
    taskId: string,
    idempotencyKey: string,
    authorizationId: string,
  ): Promise<{ run: Run; created: boolean }> {
    const authorization = await this.authorizations.get(authorizationId);
    if (
      !authorization ||
      authorization.status !== 'authorized' ||
      authorization.runtimeId !== 'mock' ||
      authorization.operation !== 'execute_task' ||
      authorization.taskId !== taskId ||
      authorization.scope.taskId !== taskId ||
      !authorization.capabilities.includes('mock.execute') ||
      authorization.expiresAt <= new Date().toISOString() ||
      authorization.requestingActor !== 'owner'
    ) {
      await this.authorizations.recordEnforcementDenied(
        authorizationId,
        taskId,
        authorization ? 'scope_status_or_expiry_mismatch' : 'authorization_missing',
      );
      throw new CoordinatorError(
        'invalid_transition',
        'Runtime authorization is missing or invalid.',
        409,
      );
    }
    if (
      !evaluateAllowedUse(this.runtime.discoverCapabilities().allowedUse, 'interactive').allowed
    ) {
      throw new CoordinatorError(
        'invalid_transition',
        'Mock runtime is not allowed for interactive use.',
        409,
      );
    }
    let result: Awaited<ReturnType<PostgresRunStore['admitRun']>>;
    try {
      result = await translateStoreError(() =>
        this.store.admitRun(taskId, idempotencyKey, authorizationId, (db, data) =>
          this.queue.send(queueName, data, {
            retryLimit: 0,
            retryDelay: 0,
            expireInSeconds: 60,
            heartbeatSeconds: 10,
            db,
          }),
        ),
      );
    } catch (error) {
      if (
        error instanceof CoordinatorError &&
        ['invalid_transition', 'project_archived'].includes(error.code)
      ) {
        await this.authorizations.recordEnforcementDenied(
          authorizationId,
          taskId,
          error.code === 'project_archived' ? 'project_archived' : 'admission_authorization_race',
        );
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
        throw new CoordinatorError(
          'admission_busy',
          'Run admission is temporarily busy. Retry the request; no run was admitted.',
          503,
        );
      }
      throw error;
    }
    this.publish(result.events);
    return { run: RunSchema.parse(result.run), created: result.created };
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return translateStoreError(() => this.store.getRun(runId));
  }

  async listRuns(): Promise<Run[]> {
    return this.store.listRuns();
  }

  async getEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    return translateStoreError(() => this.store.getEvents(runId, afterSequence));
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }

  publishExternalEvents(events: DurableEvent[]): void {
    this.publish(events);
  }

  async stopRun(runId: string): Promise<Run> {
    const result = await translateStoreError(() => this.store.requestStop(runId));
    this.publish(result.events);
    const active = this.active.get(runId);
    if (active && !active.controller.signal.aborted) active.controller.abort('cancel-requested');
    return RunSchema.parse(result.run);
  }

  async handleQueueJob(data: unknown, jobSignal?: AbortSignal): Promise<void> {
    const parsed = QueueRunSchema.safeParse(data);
    if (!parsed.success) throw new Error('The durable mock job payload is invalid.');
    const { runId } = parsed.data;
    if (this.shuttingDown || this.active.has(runId)) return;

    const controller = new AbortController();
    let claimWasLost = false;
    const onJobAbort = () => {
      claimWasLost = true;
      if (!controller.signal.aborted) controller.abort('claim-lost' satisfies AbortCause);
    };
    jobSignal?.addEventListener('abort', onJobAbort, { once: true });
    const promise = this.execute(runId, controller, () => claimWasLost);
    this.active.set(runId, { controller, promise });
    try {
      await promise;
    } finally {
      jobSignal?.removeEventListener('abort', onJobAbort);
      this.active.delete(runId);
    }
  }

  async reconcileExpiredRuns(): Promise<void> {
    const events = await this.store.reconcileExpiredRuns();
    for (const pending of await this.store.listQueuedJobs()) {
      const jobs = pending.jobId
        ? await this.queue.findJobs(queueName, { id: pending.jobId, limit: 1 })
        : [];
      const job = jobs[0];
      if (job && ['created', 'active'].includes(job.state)) continue;
      const message = job
        ? `The durable queue job entered ${job.state} before execution began. It was not retried automatically.`
        : 'The durable queue job is missing before execution began. It was not retried automatically.';
      if (pending.status === 'stopping') {
        const cancelled = await this.store.cancelRunAfterQueueTerminal(pending.runId);
        if (cancelled) events.push(...cancelled.events);
      } else {
        const interrupted = await this.store.interruptQueuedRun(pending.runId, message);
        if (interrupted) events.push(...interrupted.events);
      }
    }
    this.publish(events);
    if (this.runtime.cleanupOrphanedExecutions) {
      await this.runtime.cleanupOrphanedExecutions((candidateRunIds) =>
        this.store.listActiveRunIds(candidateRunIds),
      );
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const execution of this.active.values()) {
      if (!execution.controller.signal.aborted) {
        execution.controller.abort('worker-shutdown' satisfies AbortCause);
      }
    }
    await Promise.allSettled([...this.active.values()].map((execution) => execution.promise));
  }

  private async execute(
    runId: string,
    controller: AbortController,
    claimWasLost: () => boolean,
  ): Promise<void> {
    const queued = await this.store.getRun(runId);
    if (!queued) throw new CoordinatorError('not_found', 'Run was not found.', 404);
    const authorization = await this.authorizations.getForRun(runId);
    if (
      !authorization ||
      authorization.status !== 'authorized' ||
      authorization.taskId !== queued.taskId ||
      authorization.scope.taskId !== queued.taskId ||
      !authorization.capabilities.includes('mock.execute') ||
      authorization.expiresAt <= new Date().toISOString()
    ) {
      const denied = await this.store.interruptQueuedRun(
        runId,
        'Runtime authorization expired or was revoked before execution.',
      );
      if (denied) this.publish(denied.events);
      return;
    }
    const begun = await this.store.beginExecution(runId, this.workerId, runLeaseSeconds);
    this.publish(begun.events);
    if (!begun.started) return;
    const generation = begun.generation;

    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || controller.signal.aborted) return;
      heartbeatBusy = true;
      void this.store
        .renewLease(runId, this.workerId, generation, runLeaseSeconds)
        .then((renewed) => {
          if (renewed === 'stop_requested' && !controller.signal.aborted) {
            controller.abort('cancel-requested' satisfies AbortCause);
          } else if (!renewed && !controller.signal.aborted) {
            claimWasLost = () => true;
            controller.abort('claim-lost' satisfies AbortCause);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            controller.abort('persistence-failed' satisfies AbortCause);
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, this.heartbeatIntervalMs);

    let eventWrites = Promise.resolve();
    try {
      let output: string;
      try {
        const task = await this.store.getTask(begun.run.taskId);
        if (!task) throw new Error('The persisted task for this run is missing.');
        const result = await this.runtime.execute({
          runId,
          lease: { workerId: this.workerId, generation },
          task: TaskSchema.parse(task),
          signal: controller.signal,
          emit: (event) => {
            eventWrites = eventWrites.then(async () => {
              const durable = await this.store.appendOutput(
                runId,
                this.workerId,
                generation,
                event.message,
              );
              if (durable) this.publish([{ runId, event: durable }]);
            });
            void eventWrites.catch(() => {
              if (!controller.signal.aborted) {
                controller.abort('persistence-failed' satisfies AbortCause);
              }
            });
          },
        });
        output = result.output;
        await eventWrites;
      } catch (runtimeError) {
        await eventWrites;
        if (runtimeError instanceof SandboxError && runtimeError.code === 'termination_failed') {
          const result = await this.store.interruptRun(
            runId,
            this.workerId,
            generation,
            'The sandbox stop could not be confirmed. The run was interrupted for safety.',
          );
          if (result) this.publish(result.events);
          return;
        }
        if (controller.signal.aborted) {
          const cause = controller.signal.reason as AbortCause | undefined;
          if (cause === 'cancel-requested') {
            const result = await this.store.cancelRun(runId, this.workerId, generation);
            this.publish(result.events);
          } else {
            const result = await this.store.interruptRun(
              runId,
              this.workerId,
              generation,
              claimWasLost()
                ? 'The durable job lease was lost. The run was not retried automatically.'
                : 'The worker stopped before the run reached a terminal state. The run was not retried automatically.',
            );
            if (result) this.publish(result.events);
          }
          return;
        }
        const message = safeRuntimeFailureMessage(runtimeError);
        const failed = await this.store.failRun(runId, this.workerId, generation, message);
        this.publish(failed.events);
        return;
      }

      if (controller.signal.aborted) {
        const cause = controller.signal.reason as AbortCause | undefined;
        if (cause === 'cancel-requested') {
          const result = await this.store.cancelRun(runId, this.workerId, generation);
          this.publish(result.events);
        } else {
          const result = await this.store.interruptRun(runId, this.workerId, generation);
          if (result) this.publish(result.events);
        }
        return;
      }

      const completed = await this.store.completeRun(runId, this.workerId, generation, output, []);
      this.publish(completed.events);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private publish(events: DurableEvent[]): void {
    for (const { runId, event } of events) {
      // The database commit precedes this call. Subscribers can always recover missed events by cursor.
      this.emitter.emit(runId, RunEventSchema.parse(event));
    }
  }
}

function safeRuntimeFailureMessage(error: unknown): string {
  if (!(error instanceof SandboxError)) {
    return 'The mock runtime failed inside its isolated execution environment.';
  }

  switch (error.code) {
    case 'timed_out':
      return 'The sandbox execution exceeded its time limit.';
    case 'output_limit':
      return 'The sandbox exceeded its output limit.';
    case 'unavailable':
    case 'launch_failed':
      return 'The sandbox could not be started.';
    case 'crashed':
      return 'The sandboxed mock process exited unexpectedly.';
    case 'cancelled':
      return 'The sandbox execution was cancelled.';
    case 'termination_failed':
      return 'The sandbox stop could not be confirmed. The run was interrupted for safety.';
  }
}

async function translateStoreError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof StoreError) {
      throw new CoordinatorError(error.code, error.message, error.statusCode);
    }
    throw error;
  }
}

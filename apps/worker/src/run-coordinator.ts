import { EventEmitter } from 'node:events';
import {
  CreateTaskSchema,
  RunEventSchema,
  RunSchema,
  TaskSchema,
  type CreateTaskInput,
  type Run,
  type RunEvent,
  type Task,
} from '@omnis/contracts';
import { evaluateAllowedUse } from '@omnis/policy';
import { MockRuntimeAdapter } from '@omnis/runtime-adapters';

export class CoordinatorError extends Error {
  readonly code:
    'invalid_input' | 'not_found' | 'invalid_transition' | 'concurrency_limit' | 'conflict';
  readonly statusCode: 400 | 404 | 409;

  constructor(
    code: 'invalid_input' | 'not_found' | 'invalid_transition' | 'concurrency_limit' | 'conflict',
    message: string,
    statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class RunCoordinator {
  private readonly tasks = new Map<string, Task>();
  private readonly runs = new Map<string, Run>();
  private readonly events = new Map<string, RunEvent[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly idempotency = new Map<string, { fingerprint: string; runId: string }>();
  private readonly emitter = new EventEmitter();
  private taskCount = 0;
  private runCount = 0;
  private activeRuns = 0;
  private readonly runtime = new MockRuntimeAdapter();

  createTask(input: CreateTaskInput): Task {
    const parsed = CreateTaskSchema.safeParse(input);
    if (!parsed.success) throw new CoordinatorError('invalid_input', 'Task input is invalid.', 400);
    this.taskCount += 1;
    const task = TaskSchema.parse({
      id: `task-${String(this.taskCount).padStart(4, '0')}`,
      ...parsed.data,
      status: 'open',
      createdAt: new Date().toISOString(),
    });
    this.tasks.set(task.id, task);
    return task;
  }

  listTasks(): Task[] {
    return [...this.tasks.values()].reverse();
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  startRun(taskId: string, idempotencyKey: string): { run: Run; created: boolean } {
    const fingerprint = JSON.stringify({ taskId });
    const previous = this.idempotency.get(idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new CoordinatorError(
          'conflict',
          'Idempotency key was already used for another task.',
          409,
        );
      }
      const run = this.runs.get(previous.runId);
      if (!run) throw new CoordinatorError('conflict', 'Prior run state is unavailable.', 409);
      return { run, created: false };
    }

    const task = this.tasks.get(taskId);
    if (!task) throw new CoordinatorError('not_found', 'Task was not found.', 404);
    if (
      !evaluateAllowedUse(this.runtime.discoverCapabilities().allowedUse, 'interactive').allowed
    ) {
      throw new CoordinatorError(
        'invalid_transition',
        'Mock runtime is not allowed for interactive use.',
        409,
      );
    }
    if (this.activeRuns >= 1) {
      throw new CoordinatorError(
        'concurrency_limit',
        'The local mock worker is at its one-run limit.',
        409,
      );
    }

    this.runCount += 1;
    const now = new Date().toISOString();
    const run = RunSchema.parse({
      id: `run-${String(this.runCount).padStart(4, '0')}`,
      taskId: task.id,
      taskTitle: task.title,
      status: 'queued',
      runtimeKind: 'mock',
      synthetic: true,
      usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
      createdAt: now,
      updatedAt: now,
    });
    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    this.idempotency.set(idempotencyKey, { fingerprint, runId: run.id });
    this.appendEvent(
      run.id,
      'run.queued',
      'Admitted by the local mock worker. No external runtime is connected.',
    );
    this.updateTask(task.id, 'in_progress');
    this.activeRuns += 1;
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    void this.execute(run.id, task, controller);
    return { run: this.getRun(run.id)!, created: true };
  }

  getRun(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  listRuns(): Run[] {
    return [...this.runs.values()].reverse();
  }

  getEvents(runId: string, afterSequence = 0): RunEvent[] {
    if (!this.runs.has(runId)) throw new CoordinatorError('not_found', 'Run was not found.', 404);
    return (this.events.get(runId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    if (!this.runs.has(runId)) throw new CoordinatorError('not_found', 'Run was not found.', 404);
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }

  stopRun(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new CoordinatorError('not_found', 'Run was not found.', 404);
    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') {
      throw new CoordinatorError('invalid_transition', `Cannot stop a ${run.status} run.`, 409);
    }
    if (run.status !== 'stopping') {
      this.updateRun(runId, 'stopping');
      this.appendEvent(
        runId,
        'run.stop_requested',
        'Stop requested; waiting for the mock worker to acknowledge it.',
      );
      this.controllers.get(runId)?.abort();
    }
    return this.runs.get(runId)!;
  }

  private async execute(runId: string, task: Task, controller: AbortController): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (controller.signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
      this.updateRun(runId, 'running');
      this.appendEvent(runId, 'run.started', 'Mock runtime started this synthetic run.');
      const result = await this.runtime.execute({
        runId,
        task,
        signal: controller.signal,
        emit: (event) => this.appendEvent(runId, event.type, event.message),
      });
      this.updateRun(runId, 'completed');
      this.appendEvent(runId, 'run.completed', result.output);
      this.updateTask(task.id, 'completed');
    } catch (error) {
      if (controller.signal.aborted) {
        this.updateRun(runId, 'cancelled');
        this.appendEvent(runId, 'run.cancelled', 'Mock worker acknowledged cancellation.');
        this.updateTask(task.id, 'open');
      } else {
        this.updateRun(runId, 'failed');
        this.appendEvent(
          runId,
          'run.failed',
          error instanceof Error ? error.message : 'Unknown mock error.',
        );
      }
    } finally {
      this.activeRuns -= 1;
      this.controllers.delete(runId);
    }
  }

  private appendEvent(runId: string, type: RunEvent['type'], message: string): void {
    const runEvents = this.events.get(runId);
    if (!runEvents) return;
    const event = RunEventSchema.parse({
      id: `evt-${runId}-${String(runEvents.length + 1).padStart(4, '0')}`,
      runId,
      sequence: runEvents.length + 1,
      at: new Date().toISOString(),
      type,
      source: 'mock',
      synthetic: true,
      message,
    });
    runEvents.push(event);
    this.emitter.emit(runId, event);
  }

  private updateRun(runId: string, status: Run['status']): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const allowed: Record<Run['status'], Run['status'][]> = {
      queued: ['running', 'stopping'],
      running: ['stopping', 'completed', 'failed'],
      stopping: ['cancelled', 'failed'],
      completed: [],
      cancelled: [],
      failed: [],
      unknown: [],
    };
    if (!allowed[run.status].includes(status)) {
      throw new CoordinatorError(
        'invalid_transition',
        `Cannot transition a ${run.status} run to ${status}.`,
        409,
      );
    }
    this.runs.set(runId, RunSchema.parse({ ...run, status, updatedAt: new Date().toISOString() }));
  }

  private updateTask(taskId: string, status: Task['status']): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.tasks.set(taskId, TaskSchema.parse({ ...task, status }));
  }
}

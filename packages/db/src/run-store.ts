import {
  CreateTaskSchema,
  RunEventSchema,
  RunSchema,
  SetTaskProjectSchema,
  TaskIdSchema,
  TaskSchema,
  type CreateTaskInput,
  type Run,
  type RunEvent,
  type RunEventType,
  type Task,
} from '@omnis/contracts';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { asPgBossTransaction, inTransaction, type PgBossTransaction } from './database.ts';
import { createHash, randomUUID } from 'node:crypto';

export type StoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'invalid_transition'
  | 'project_archived'
  | 'concurrency_limit'
  | 'conflict';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly statusCode: 400 | 404 | 409;

  constructor(code: StoreErrorCode, message: string, statusCode: 400 | 404 | 409) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

type TaskRow = QueryResultRow & {
  id: string;
  title: string;
  detail: string;
  status: Task['status'];
  created_at: Date | string;
  project_id?: string | null;
  association_revision?: number | string;
};

type RunRow = QueryResultRow & {
  id: string;
  task_id: string;
  task_title: string;
  status: Run['status'];
  lease_owner: string | null;
  execution_generation: number;
  lease_expires_at: Date | string | null;
  runtime_kind: 'mock';
  synthetic: true;
  usage: Run['usage'];
  created_at: Date | string;
  updated_at: Date | string;
};

type EventRow = QueryResultRow & {
  id: string;
  run_id: string;
  sequence: number | string;
  event_type: RunEventType;
  at: Date | string;
  source: 'mock';
  synthetic: true;
  message: string;
};

export type DurableEvent = { runId: string; event: RunEvent };
export type EnqueueRun = (
  transaction: PgBossTransaction,
  data: { runId: string },
) => Promise<string | null>;

const admissionLock = '70463909136524';
// Interrupted is terminal: its attempt will never be replayed, but a fresh explicit
// idempotency key may admit new work. Unknown stays blocking until reconciled.
const activeStatuses = ['queued', 'running', 'stopping', 'unknown'] as const;
const terminalStatuses = new Set<Run['status']>([
  'completed',
  'cancelled',
  'failed',
  'unknown',
  'interrupted',
]);

export class PostgresRunStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async createTask(input: CreateTaskInput, requestId?: string): Promise<Task> {
    const parsed = CreateTaskSchema.safeParse(input);
    if (!parsed.success) throw new StoreError('invalid_input', 'Task input is invalid.', 400);
    if (parsed.data.projectId && !requestId)
      throw new StoreError(
        'invalid_input',
        'An Idempotency-Key is required when creating a project task.',
        400,
      );
    if (requestId && !isUuid(requestId))
      throw new StoreError('invalid_input', 'Idempotency-Key is invalid.', 400);
    const fingerprint = requestId ? taskFingerprint('task.created', parsed.data) : null;
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.create_task($1,$2,$3,$4,$5) AS result',
        [
          parsed.data.title,
          parsed.data.detail,
          parsed.data.projectId ?? null,
          requestId ?? null,
          fingerprint,
        ],
      );
      return TaskSchema.parse(result.rows[0]?.result);
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async setTaskProject(taskId: string, inputValue: unknown, requestId: string): Promise<Task> {
    const parsedTaskId = TaskIdSchema.safeParse(taskId);
    const parsed = SetTaskProjectSchema.safeParse(inputValue);
    if (!parsedTaskId.success || !parsed.success || !isUuid(requestId))
      throw new StoreError('invalid_input', 'Task project input is invalid.', 400);
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.set_task_project($1,$2,$3,$4,$5) AS result',
        [
          parsedTaskId.data,
          parsed.data.expectedAssociationRevision,
          parsed.data.projectId,
          requestId,
          taskFingerprint('task.project_set', { taskId: parsedTaskId.data, input: parsed.data }),
        ],
      );
      return TaskSchema.parse(result.rows[0]?.result);
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async listTasks(): Promise<Task[]> {
    const result = await this.pool.query<TaskRow>(
      'SELECT id, title, detail, status, created_at, project_id, association_revision FROM omnis.tasks ORDER BY created_at DESC, id DESC',
    );
    return result.rows.map(mapTask);
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const result = await this.pool.query<TaskRow>(
      'SELECT id, title, detail, status, created_at, project_id, association_revision FROM omnis.tasks WHERE id = $1',
      [taskId],
    );
    return result.rows[0] ? mapTask(result.rows[0]) : undefined;
  }

  async admitRun(
    taskId: string,
    idempotencyKey: string,
    authorizationId: string,
    enqueue: EnqueueRun,
  ): Promise<{
    run: Run;
    created: boolean;
    events: DurableEvent[];
  }> {
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      throw new StoreError('invalid_input', 'Idempotency-Key is invalid.', 400);
    }
    const fingerprint = JSON.stringify({ taskId, authorizationId });
    return inTransaction(this.pool, async (client) => {
      // Bound waits on row locks and the publicly callable capacity lock. The
      // transaction rolls back on timeout, before admission state is committed.
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [admissionLock]);
      const previous = await client.query<
        QueryResultRow & { request_fingerprint: string; run_id: string }
      >(
        'SELECT request_fingerprint, run_id FROM omnis.run_idempotency WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_fingerprint !== fingerprint) {
          throw new StoreError(
            'conflict',
            'Idempotency key was already used for another task.',
            409,
          );
        }
        const runResult = await client.query<RunRow>(`${runSelect} WHERE r.id = $1`, [
          previous.rows[0].run_id,
        ]);
        if (!runResult.rows[0])
          throw new StoreError('conflict', 'Prior run state is unavailable.', 409);
        return { run: mapRun(runResult.rows[0]), created: false, events: [] };
      }

      // Lock the exact grant before locking the task. Revocation takes the grant
      // lock first when it is unconsumed, so the FK KEY SHARE acquired by its
      // audit insert cannot form the former task→grant / grant→task deadlock.
      const authorizationLock = await client.query<{ allowed: boolean }>(
        'SELECT omnis.lock_run_authorization_for_admission($1, $2) AS allowed',
        [authorizationId, taskId],
      );
      if (!authorizationLock.rows[0]?.allowed) {
        throw new StoreError(
          'invalid_transition',
          'An active task-scoped authorization is required.',
          409,
        );
      }

      const taskResult = await client.query<TaskRow>(
        'SELECT id, title, detail, status, created_at, project_id, association_revision FROM omnis.tasks WHERE id = $1 FOR UPDATE',
        [taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new StoreError('not_found', 'Task was not found.', 404);

      const active = await client.query(
        'SELECT id FROM omnis.runs WHERE status = ANY($1::text[]) LIMIT 1',
        [activeStatuses],
      );
      if (active.rowCount) {
        throw new StoreError(
          'concurrency_limit',
          'A run is active or needs interruption review.',
          409,
        );
      }

      const created = await client.query<RunRow>(
        `
          INSERT INTO omnis.runs (id, task_id, task_title)
          VALUES (
            'run-' || lpad(nextval('omnis.run_id_seq')::text, 4, '0'),
            $1, $2
          )
          RETURNING id, task_id, task_title, status, runtime_kind, synthetic, usage,
            created_at, updated_at
        `,
        [task.id, task.title],
      );
      const run = mapRun(created.rows[0]!);
      const authorization = await client.query<{ allowed: boolean }>(
        'SELECT omnis.consume_run_authorization($1, $2, $3, $4) AS allowed',
        [authorizationId, task.id, run.id, randomUUID()],
      );
      if (!authorization.rows[0]?.allowed) {
        throw new StoreError(
          'invalid_transition',
          'An active task-scoped authorization is required.',
          409,
        );
      }
      const queuedEvent = await appendEvent(
        client,
        run.id,
        'run.queued',
        'Admitted by the local mock worker. No external runtime is connected.',
      );

      // pg-boss writes the durable job in this exact transaction. A crash cannot commit only one side.
      const jobId = await enqueue(asPgBossTransaction(client), { runId: run.id });
      if (!jobId) throw new StoreError('conflict', 'The durable mock job was not admitted.', 409);
      await client.query('UPDATE omnis.runs SET pg_boss_job_id = $2 WHERE id = $1', [
        run.id,
        jobId,
      ]);
      await client.query(
        'INSERT INTO omnis.run_idempotency (idempotency_key, request_fingerprint, run_id) VALUES ($1, $2, $3)',
        [idempotencyKey, fingerprint, run.id],
      );
      await client.query("UPDATE omnis.tasks SET status = 'in_progress' WHERE id = $1", [task.id]);
      return { run, created: true, events: [{ runId: run.id, event: queuedEvent }] };
    }).catch((error: unknown) => {
      if ((error as { code?: string })?.code === 'P2001') return mapStoreError(error);
      throw error;
    });
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const result = await this.pool.query<RunRow>(`${runSelect} WHERE r.id = $1`, [runId]);
    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  async listRuns(): Promise<Run[]> {
    const result = await this.pool.query<RunRow>(
      `${runSelect} ORDER BY r.created_at DESC, r.id DESC`,
    );
    return result.rows.map(mapRun);
  }

  async getEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    const exists = await this.pool.query('SELECT 1 FROM omnis.runs WHERE id = $1', [runId]);
    if (!exists.rowCount) throw new StoreError('not_found', 'Run was not found.', 404);
    const result = await this.pool.query<EventRow>(
      `
        SELECT id, run_id, sequence, event_type, at, source, synthetic, message
        FROM omnis.run_events
        WHERE run_id = $1 AND sequence > $2
        ORDER BY sequence ASC
      `,
      [runId, afterSequence],
    );
    return result.rows.map(mapEvent);
  }

  async beginExecution(
    runId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<{
    run: Run;
    started: boolean;
    events: DurableEvent[];
    generation: number;
  }> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (current.status === 'stopping') {
        const result = await client.query<RunRow>(
          `
            UPDATE omnis.runs
            SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 RETURNING ${runColumns}
          `,
          [runId],
        );
        await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [
          current.task_id,
        ]);
        const event = await appendEvent(
          client,
          runId,
          'run.cancelled',
          'Mock worker acknowledged cancellation before execution.',
        );
        return {
          run: mapRun(result.rows[0]!),
          started: false,
          generation: current.execution_generation,
          events: [{ runId, event }],
        };
      }
      if (current.status !== 'queued')
        return {
          run: mapRun(current),
          started: false,
          generation: current.execution_generation,
          events: [],
        };

      const authorizationLock = await client.query<{ allowed: boolean }>(
        'SELECT omnis.lock_active_run_authorization($1) AS allowed',
        [runId],
      );
      if (!authorizationLock.rows[0]?.allowed) {
        const interrupted = await client.query<RunRow>(
          `UPDATE omnis.runs SET status='interrupted', updated_at=now()
            WHERE id=$1 AND status='queued' RETURNING ${runColumns}`,
          [runId],
        );
        await client.query("UPDATE omnis.tasks SET status='open' WHERE id=$1", [current.task_id]);
        await appendRunAuthorizationAudit(
          client,
          runId,
          'authorization.enforcement_denied',
          'missing_expired_or_revoked',
        );
        const event = await appendEvent(
          client,
          runId,
          'run.interrupted',
          'Authorization is unavailable, expired, or revoked. The run was not executed.',
        );
        return {
          run: mapRun(interrupted.rows[0]!),
          started: false,
          generation: current.execution_generation,
          events: [{ runId, event }],
        };
      }

      const result = await client.query<RunRow>(
        `
          UPDATE omnis.runs
          SET status = 'running', execution_generation = execution_generation + 1,
              lease_owner = $2, lease_expires_at = now() + ($3::int * interval '1 second'), updated_at = now()
          WHERE id = $1 AND status = 'queued'
          RETURNING ${runColumns}
        `,
        [runId, workerId, leaseSeconds],
      );
      await appendRunAuthorizationAudit(client, runId, 'operation.started');
      const event = await appendEvent(
        client,
        runId,
        'run.started',
        'Mock runtime started this synthetic run.',
      );
      return {
        run: mapRun(result.rows[0]!),
        started: true,
        generation: result.rows[0]!.execution_generation,
        events: [{ runId, event }],
      };
    });
  }

  async appendOutput(
    runId: string,
    workerId: string,
    generation: number,
    message: string,
  ): Promise<RunEvent | undefined> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (
        current.status !== 'running' ||
        current.lease_owner !== workerId ||
        current.execution_generation !== generation
      )
        return undefined;
      return appendEvent(client, runId, 'run.output', message);
    });
  }

  async renewLease(
    runId: string,
    workerId: string,
    generation: number,
    leaseSeconds: number,
  ): Promise<boolean | 'stop_requested'> {
    try {
      return await inTransaction(this.pool, async (client) => {
        await client.query("SET LOCAL lock_timeout = '3s'");
        const selected = await client.query<RunRow>(`${runSelect} WHERE r.id = $1 FOR UPDATE`, [
          runId,
        ]);
        const current = selected.rows[0];
        if (!current) return false;
        if (current.lease_owner !== workerId || current.execution_generation !== generation) {
          return false;
        }
        if (current.status === 'stopping') return 'stop_requested';
        if (current.status !== 'running') return false;

        // Revocation also locks run then grant. Recheck under the grant row lock
        // after acquiring the run lock so a pre-revocation statement snapshot
        // cannot renew a lease after revocation commits.
        const authorization = await client.query<{ allowed: boolean }>(
          'SELECT omnis.lock_active_run_authorization($1) AS allowed',
          [runId],
        );
        if (!authorization.rows[0]?.allowed) return false;

        const renewed = await client.query(
          `UPDATE omnis.runs
              SET lease_expires_at = now() + ($4::int * interval '1 second'), updated_at = now()
            WHERE id = $1 AND lease_owner = $2 AND execution_generation = $3
              AND status = 'running' AND lease_expires_at > now()`,
          [runId, workerId, generation, leaseSeconds],
        );
        return renewed.rowCount === 1;
      });
    } catch (error) {
      // inTransaction has rolled back before this handler runs. A timed-out
      // heartbeat is a lost renewal and causes the worker to stop safely; it
      // must never be reported as a lease extension.
      if (isPostgresLockTimeout(error)) return false;
      throw error;
    }
  }

  async requestStop(runId: string): Promise<{ run: Run; events: DurableEvent[] }> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (terminalStatuses.has(current.status)) {
        throw new StoreError('invalid_transition', `Cannot stop a ${current.status} run.`, 409);
      }
      if (current.status === 'stopping') return { run: mapRun(current), events: [] };
      if (current.status !== 'queued' && current.status !== 'running') {
        throw new StoreError('invalid_transition', `Cannot stop a ${current.status} run.`, 409);
      }
      const updated = await client.query<RunRow>(
        `
          UPDATE omnis.runs SET status = 'stopping', updated_at = now()
          WHERE id = $1 RETURNING ${runColumns}
        `,
        [runId],
      );
      const event = await appendEvent(
        client,
        runId,
        'run.stop_requested',
        'Stop requested; waiting for the mock worker to acknowledge it.',
      );
      return { run: mapRun(updated.rows[0]!), events: [{ runId, event }] };
    });
  }

  async completeRun(
    runId: string,
    workerId: string,
    generation: number,
    output: string,
    evidenceRefs: string[] = [],
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (
        current.status === 'stopping' &&
        (current.lease_owner !== workerId || current.execution_generation !== generation)
      ) {
        throw new StoreError(
          'conflict',
          'The current worker does not own this execution generation.',
          409,
        );
      }
      if (current.status === 'stopping') {
        const cancelled = await client.query<RunRow>(
          `
            UPDATE omnis.runs SET status = 'cancelled', lease_owner = NULL,
              lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 RETURNING ${runColumns}
          `,
          [runId],
        );
        await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [
          current.task_id,
        ]);
        const event = await appendEvent(
          client,
          runId,
          'run.cancelled',
          'Mock worker acknowledged cancellation.',
        );
        await appendRunAuthorizationAudit(client, runId, 'operation.cancelled');
        return { run: mapRun(cancelled.rows[0]!), events: [{ runId, event }] };
      }
      const authorizationLock = await client.query<{ allowed: boolean }>(
        'SELECT omnis.lock_active_run_authorization($1) AS allowed',
        [runId],
      );
      if (!authorizationLock.rows[0]?.allowed) {
        const interrupted = await client.query<RunRow>(
          `UPDATE omnis.runs SET status='interrupted', lease_owner=NULL,
             lease_expires_at=NULL, updated_at=now() WHERE id=$1 RETURNING ${runColumns}`,
          [runId],
        );
        await client.query("UPDATE omnis.tasks SET status='open' WHERE id=$1", [current.task_id]);
        await appendRunAuthorizationAudit(
          client,
          runId,
          'authorization.enforcement_denied',
          'revoked_before_completion',
        );
        const event = await appendEvent(
          client,
          runId,
          'run.interrupted',
          'Authorization was revoked or expired before completion was committed.',
        );
        return { run: mapRun(interrupted.rows[0]!), events: [{ runId, event }] };
      }
      if (
        current.status !== 'running' ||
        current.lease_owner !== workerId ||
        current.execution_generation !== generation
      ) {
        throw new StoreError(
          'invalid_transition',
          `The worker no longer owns this execution (state=${current.status}, ownerMatches=${current.lease_owner === workerId}).`,
          409,
        );
      }
      const updated = await client.query<RunRow>(
        `
          UPDATE omnis.runs SET status = 'completed', result_output = $3,
            result_evidence_refs = $4::jsonb, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2 AND execution_generation = $5 RETURNING ${runColumns}
        `,
        [runId, workerId, output, JSON.stringify(evidenceRefs), generation],
      );
      await client.query("UPDATE omnis.tasks SET status = 'completed' WHERE id = $1", [
        current.task_id,
      ]);
      const event = await appendEvent(client, runId, 'run.completed', output);
      await appendRunAuthorizationAudit(client, runId, 'operation.completed');
      return { run: mapRun(updated.rows[0]!), events: [{ runId, event }] };
    });
  }

  async cancelRun(
    runId: string,
    workerId: string,
    generation: number,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (current.status !== 'stopping') {
        if (terminalStatuses.has(current.status)) {
          throw new StoreError('invalid_transition', `Cannot cancel a ${current.status} run.`, 409);
        }
        throw new StoreError(
          'invalid_transition',
          'A stop request is required before cancellation.',
          409,
        );
      }
      if (current.lease_owner !== workerId || current.execution_generation !== generation) {
        throw new StoreError('conflict', 'The current worker does not own this run.', 409);
      }
      const updated = await client.query<RunRow>(
        `
          UPDATE omnis.runs SET status = 'cancelled', lease_owner = NULL,
            lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING ${runColumns}
        `,
        [runId],
      );
      await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [current.task_id]);
      const event = await appendEvent(
        client,
        runId,
        'run.cancelled',
        'Mock worker acknowledged cancellation.',
      );
      await appendRunAuthorizationAudit(client, runId, 'operation.cancelled');
      return { run: mapRun(updated.rows[0]!), events: [{ runId, event }] };
    });
  }

  async failRun(
    runId: string,
    workerId: string,
    generation: number,
    message: string,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (current.status === 'stopping') {
        if (current.lease_owner !== workerId || current.execution_generation !== generation) {
          throw new StoreError(
            'conflict',
            'The current worker does not own this execution generation.',
            409,
          );
        }
        return this.cancelLocked(client, current);
      }
      if (
        current.status !== 'running' ||
        current.lease_owner !== workerId ||
        current.execution_generation !== generation
      ) {
        throw new StoreError(
          'invalid_transition',
          'The worker no longer owns this execution.',
          409,
        );
      }
      const updated = await client.query<RunRow>(
        `
          UPDATE omnis.runs SET status = 'failed', lease_owner = NULL,
            lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING ${runColumns}
        `,
        [runId],
      );
      await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [current.task_id]);
      const event = await appendEvent(client, runId, 'run.failed', message);
      await appendRunAuthorizationAudit(client, runId, 'operation.failed', 'runtime_failed');
      return { run: mapRun(updated.rows[0]!), events: [{ runId, event }] };
    });
  }

  async interruptRun(
    runId: string,
    workerId: string,
    generation: number,
    message = 'The worker stopped before the run reached a terminal state.',
  ): Promise<{ run: Run; events: DurableEvent[] } | undefined> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (!['running', 'stopping'].includes(current.status)) return undefined;
      if (current.lease_owner !== workerId || current.execution_generation !== generation)
        return undefined;
      const updated = await client.query<RunRow>(
        `
          UPDATE omnis.runs SET status = 'interrupted', lease_owner = NULL,
            lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING ${runColumns}
        `,
        [runId],
      );
      await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [current.task_id]);
      const event = await appendEvent(client, runId, 'run.interrupted', message);
      await appendRunAuthorizationAudit(client, runId, 'operation.interrupted');
      return { run: mapRun(updated.rows[0]!), events: [{ runId, event }] };
    });
  }

  async reconcileExpiredRuns(): Promise<DurableEvent[]> {
    return inTransaction(this.pool, async (client) => {
      const expired = await client.query<RunRow>(
        `
          SELECT ${runColumns}
          FROM omnis.runs
          WHERE status IN ('running', 'stopping') AND lease_expires_at <= now()
          ORDER BY lease_expires_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 100
        `,
      );
      const events: DurableEvent[] = [];
      for (const row of expired.rows) {
        await client.query(
          `
            UPDATE omnis.runs SET status = 'interrupted', lease_owner = NULL,
              lease_expires_at = NULL, updated_at = now()
            WHERE id = $1
          `,
          [row.id],
        );
        await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [row.task_id]);
        const event = await appendEvent(
          client,
          row.id,
          'run.interrupted',
          'The execution lease expired. It was not retried automatically.',
        );
        events.push({ runId: row.id, event });
      }
      return events;
    });
  }

  async listActiveRunIds(runIds?: readonly string[]): Promise<string[]> {
    if (runIds?.length === 0) return [];
    const result = await this.pool.query<QueryResultRow & { id: string }>(
      `
        SELECT id FROM omnis.runs
        WHERE status IN ('running', 'stopping') AND lease_expires_at > now()
          AND ($1::text[] IS NULL OR id = ANY($1::text[]))
        ORDER BY lease_expires_at ASC
      `,
      [runIds ?? null],
    );
    return result.rows.map((row) => row.id);
  }

  async listQueuedJobs(): Promise<
    Array<{ runId: string; status: 'queued' | 'stopping'; jobId: string | null }>
  > {
    const result = await this.pool.query<
      QueryResultRow & { id: string; status: 'queued' | 'stopping'; pg_boss_job_id: string | null }
    >(
      `
        SELECT id, status, pg_boss_job_id FROM omnis.runs
        WHERE status = 'queued' AND lease_owner IS NULL
           OR status = 'stopping'
        ORDER BY created_at ASC
        LIMIT 1000
      `,
    );
    return result.rows.map((row) => ({
      runId: row.id,
      status: row.status,
      jobId: row.pg_boss_job_id,
    }));
  }

  async interruptQueuedRun(
    runId: string,
    message: string,
  ): Promise<{ run: Run; events: DurableEvent[] } | undefined> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (current.status === 'stopping' && !current.lease_owner) {
        // No worker ever claimed this stop-requested job; the reconciler acknowledges
        // cancellation after pg-boss confirms the job cannot begin.
        return this.cancelLocked(client, current);
      }
      if (current.status !== 'queued') return undefined;
      const updated = await client.query<RunRow>(
        `
          UPDATE omnis.runs SET status = 'interrupted', updated_at = now()
          WHERE id = $1 AND status = 'queued' RETURNING ${runColumns}
        `,
        [runId],
      );
      if (!updated.rows[0]) return undefined;
      await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [current.task_id]);
      const event = await appendEvent(client, runId, 'run.interrupted', message);
      return { run: mapRun(updated.rows[0]), events: [{ runId, event }] };
    });
  }

  async cancelRunAfterQueueTerminal(
    runId: string,
  ): Promise<{ run: Run; events: DurableEvent[] } | undefined> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (current.status !== 'stopping') return undefined;
      return this.cancelLocked(client, current);
    });
  }

  private async cancelLocked(
    client: PoolClient,
    current: RunRow,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    const updated = await client.query<RunRow>(
      `
        UPDATE omnis.runs SET status = 'cancelled', lease_owner = NULL,
          lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING ${runColumns}
      `,
      [current.id],
    );
    await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [current.task_id]);
    const event = await appendEvent(
      client,
      current.id,
      'run.cancelled',
      'Mock worker acknowledged cancellation.',
    );
    await appendRunAuthorizationAudit(client, current.id, 'operation.cancelled');
    return { run: mapRun(updated.rows[0]!), events: [{ runId: current.id, event }] };
  }
}

function isPostgresLockTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03';
}

async function appendRunAuthorizationAudit(
  client: PoolClient,
  runId: string,
  eventType: string,
  reasonCode: string | null = null,
): Promise<void> {
  const result = await client.query<{ recorded: boolean }>(
    'SELECT omnis.append_runtime_authorization_audit($1, $2, $3) AS recorded',
    [runId, eventType, reasonCode],
  );
  if (!result.rows[0]?.recorded) {
    throw new StoreError(
      'invalid_transition',
      'The runtime audit event could not be associated with an authorized run.',
      409,
    );
  }
}

const runColumns = `id, task_id, task_title, status, lease_owner, lease_expires_at, execution_generation,
  runtime_kind, synthetic, usage, created_at, updated_at`;
const runSelect = `SELECT ${runColumns} FROM omnis.runs r`;

async function lockRun(client: PoolClient, runId: string): Promise<RunRow> {
  const result = await client.query<RunRow>(`${runSelect} WHERE r.id = $1 FOR UPDATE`, [runId]);
  if (!result.rows[0]) throw new StoreError('not_found', 'Run was not found.', 404);
  return result.rows[0];
}

async function appendEvent(
  client: PoolClient,
  runId: string,
  type: RunEventType,
  message: string,
): Promise<RunEvent> {
  const sequenceResult = await client.query<
    QueryResultRow & { last_event_sequence: number; updated_at: Date | string }
  >(
    `
      UPDATE omnis.runs
      SET last_event_sequence = last_event_sequence + 1, updated_at = now()
      WHERE id = $1
      RETURNING last_event_sequence, updated_at
    `,
    [runId],
  );
  const runSequence = sequenceResult.rows[0];
  if (!runSequence) throw new StoreError('not_found', 'Run was not found.', 404);
  const event = RunEventSchema.parse({
    id: `evt-${runId}-${String(runSequence.last_event_sequence).padStart(4, '0')}`,
    runId,
    sequence: runSequence.last_event_sequence,
    at: asIso(runSequence.updated_at),
    type,
    source: 'mock',
    synthetic: true,
    message: message.slice(0, 2000),
  });
  await client.query(
    `
    INSERT INTO omnis.run_events (id, run_id, sequence, event_type, at, message)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [event.id, event.runId, event.sequence, event.type, event.at, event.message],
  );
  return event;
}

function mapTask(row: TaskRow): Task {
  return TaskSchema.parse({
    id: row.id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    createdAt: asIso(row.created_at),
    projectId: row.project_id ?? null,
    associationRevision: Number(row.association_revision ?? 1),
  });
}

function taskFingerprint(operation: string, value: unknown): Buffer {
  return createHash('sha256')
    .update(JSON.stringify({ operation, input: value }))
    .digest();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mapStoreError(error: unknown): never {
  const code = (error as { code?: string })?.code;
  if (code === 'P0002') throw new StoreError('not_found', 'Task or project was not found.', 404);
  if (code === 'P2001')
    throw new StoreError(
      'project_archived',
      'Archived-project task associations cannot be changed or admitted to run.',
      409,
    );
  if (code === 'P2002' || code === 'P2003' || code === '23505' || code === '40001')
    throw new StoreError('conflict', 'Task project association conflicts with current state.', 409);
  if (code === '22023' || code === '22001' || code === '23514')
    throw new StoreError('invalid_input', 'Task input is invalid.', 400);
  if (code === '55P03')
    throw new StoreError('concurrency_limit', 'Task admission is busy; retry the request.', 409);
  throw error;
}

function mapRun(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    status: row.status,
    runtimeKind: row.runtime_kind,
    synthetic: row.synthetic,
    usage: row.usage,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

function mapEvent(row: EventRow): RunEvent {
  return RunEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    at: asIso(row.at),
    type: row.event_type,
    source: row.source,
    synthetic: row.synthetic,
    message: row.message,
  });
}

function asIso(value: Date | string): string {
  return new Date(value).toISOString();
}

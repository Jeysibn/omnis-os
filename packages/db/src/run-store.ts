import {
  CreateTaskSchema,
  ProjectIdSchema,
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceTaskPageSchema,
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
  type ProjectWorkspaceTaskPage,
} from '@omnis/contracts';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { asPgBossTransaction, inTransaction, type PgBossTransaction } from './database.ts';
import { createHmac, createHash, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';

export type StoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'invalid_transition'
  | 'project_archived'
  | 'concurrency_limit'
  | 'conflict'
  | 'invalid_cursor';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly statusCode: 400 | 404 | 409 | 422;

  constructor(code: StoreErrorCode, message: string, statusCode: 400 | 404 | 409 | 422) {
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

type WorkspaceCursor = {
  version: 1;
  projectId: string;
  lastCreatedAt: string;
  lastTaskId: string;
};

type WorkspaceTaskRow = QueryResultRow & {
  id: string | null;
  title: string | null;
  status: Task['status'] | null;
  created_at: Date | string | null;
  cursor_created_at: string | null;
  association_revision: number | string | null;
  latest_run_id: string | null;
  latest_run_status: Run['status'] | null;
  latest_run_created_at: Date | string | null;
  latest_run_updated_at: Date | string | null;
  observed_total: string;
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

// Interrupted is terminal: its attempt will never be replayed, but a fresh explicit
// idempotency key may admit new work. Unknown stays blocking until reconciled.
const terminalStatuses = new Set<Run['status']>([
  'completed',
  'cancelled',
  'failed',
  'unknown',
  'interrupted',
]);

function deriveWorkspaceCursorKey(internalToken: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(internalToken, 'utf8'),
      Buffer.from('omnis-os/ao-105/project-workspace-cursor/v1', 'utf8'),
      Buffer.from('project-workspace-page-signature', 'utf8'),
      32,
    ),
  );
}

function workspaceCursorSignature(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update('omnis-project-workspace-cursor-v1:')
    .update(payload)
    .digest();
}

function decodeWorkspaceCursor(encoded: string, projectId: string, key: Buffer): WorkspaceCursor {
  try {
    const [payload, signature, extra] = encoded.split('.');
    if (!payload || !signature || extra !== undefined) throw new Error('Invalid cursor.');
    const decoded = Buffer.from(signature, 'base64url');
    const expected = workspaceCursorSignature(payload, key);
    if (
      decoded.length !== expected.length ||
      !timingSafeEqual(decoded, expected) ||
      decoded.toString('base64url') !== signature
    )
      throw new Error('Invalid cursor.');
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(json);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value && value.version === 1) ||
      !('projectId' in value && value.projectId === projectId) ||
      !('lastCreatedAt' in value && typeof value.lastCreatedAt === 'string') ||
      !('lastTaskId' in value && typeof value.lastTaskId === 'string') ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.lastCreatedAt) ||
      !Number.isFinite(Date.parse(value.lastCreatedAt)) ||
      value.lastTaskId.length < 1 ||
      value.lastTaskId.length > 128 ||
      value.lastTaskId.includes('\0') ||
      Buffer.from(payload, 'base64url').toString('base64url') !== payload
    )
      throw new Error('Invalid cursor.');
    return value as WorkspaceCursor;
  } catch {
    throw new StoreError('invalid_cursor', 'Project workspace cursor is invalid.', 422);
  }
}

function encodeWorkspaceCursor(cursor: WorkspaceCursor, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${workspaceCursorSignature(payload, key).toString('base64url')}`;
}

export class PostgresRunStore {
  private readonly pool: Pool;
  private readonly workspaceCursorKey?: Buffer;

  constructor(pool: Pool, internalToken?: string) {
    this.pool = pool;
    if (internalToken !== undefined) {
      if (internalToken.length < 32) throw new Error('Worker internal token is invalid.');
      this.workspaceCursorKey = deriveWorkspaceCursorKey(internalToken);
    }
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

  async listProjectWorkspaceTasks(
    projectIdValue: string,
    queryValue: unknown,
  ): Promise<ProjectWorkspaceTaskPage> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const query = ProjectWorkspaceQuerySchema.safeParse(queryValue);
    if (!projectId.success || !query.success)
      throw new StoreError('invalid_input', 'Project workspace query is invalid.', 400);
    if (!this.workspaceCursorKey)
      throw new Error('Project workspace cursor key is not configured.');
    const cursor = query.data.cursor
      ? decodeWorkspaceCursor(query.data.cursor, projectId.data, this.workspaceCursorKey)
      : undefined;
    const limit = query.data.limit ?? 50;
    const result = await this.pool.query<WorkspaceTaskRow>(
      `
        WITH observed AS MATERIALIZED (
          SELECT count(*)::text AS observed_total
          FROM omnis.tasks
          WHERE project_id = $1
        )
        SELECT task.id, task.title, task.status, task.created_at,
               to_char(task.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 AS cursor_created_at,
               task.association_revision, observed.observed_total,
               latest.id AS latest_run_id, latest.status AS latest_run_status,
               latest.created_at AS latest_run_created_at,
               latest.updated_at AS latest_run_updated_at
        FROM observed
        LEFT JOIN LATERAL (
          SELECT current_task.id, current_task.title, current_task.status,
                 current_task.created_at, current_task.association_revision
          FROM omnis.tasks AS current_task
          WHERE current_task.project_id = $1
            AND ($2::timestamptz IS NULL OR
                 (current_task.created_at, current_task.id) < ($2::timestamptz, $3::text))
          ORDER BY current_task.created_at DESC, current_task.id DESC
          LIMIT $4
        ) AS task ON true
        LEFT JOIN LATERAL (
          SELECT run.id, run.status, run.created_at, run.updated_at
          FROM omnis.runs AS run
          WHERE run.task_id = task.id
          ORDER BY run.created_at DESC, run.id DESC
          LIMIT 1
        ) AS latest ON task.id IS NOT NULL
        ORDER BY task.created_at DESC NULLS LAST, task.id DESC NULLS LAST
      `,
      [projectId.data, cursor?.lastCreatedAt ?? null, cursor?.lastTaskId ?? null, limit + 1],
    );
    const observedTotal = Number(result.rows[0]?.observed_total ?? 0);
    if (!Number.isSafeInteger(observedTotal) || observedTotal < 0)
      throw new Error('Project workspace task count is outside the supported range.');
    const rows = result.rows.filter((row): row is WorkspaceTaskRow & { id: string } =>
      Boolean(row.id),
    );
    const hasNext = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const lastRow = pageRows.at(-1);
    const nextCursor =
      hasNext && lastRow?.cursor_created_at
        ? encodeWorkspaceCursor(
            {
              version: 1,
              projectId: projectId.data,
              lastCreatedAt: lastRow.cursor_created_at,
              lastTaskId: lastRow.id,
            },
            this.workspaceCursorKey,
          )
        : null;
    return ProjectWorkspaceTaskPageSchema.parse({
      tasks: pageRows.map((row) => ({
        id: requiredWorkspaceValue(row.id),
        title: requiredWorkspaceValue(row.title),
        status: requiredWorkspaceValue(row.status),
        createdAt: asIso(requiredWorkspaceValue(row.created_at)),
        projectId: projectId.data,
        associationRevision: Number(requiredWorkspaceValue(row.association_revision)),
        latestRun: row.latest_run_id
          ? {
              id: row.latest_run_id,
              status: requiredWorkspaceValue(row.latest_run_status),
              createdAt: asIso(requiredWorkspaceValue(row.latest_run_created_at)),
              updatedAt: asIso(requiredWorkspaceValue(row.latest_run_updated_at)),
            }
          : null,
      })),
      page: {
        observedTotal,
        complete: nextCursor === null,
        nextCursor,
      },
    });
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
    return this.inMissionEventTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '3s'");
      const admission = await client.query<{
        result: { created: boolean; run: { id: string } };
      }>('SELECT omnis.admit_run($1,$2,$3,$4,$5) AS result', [
        taskId,
        authorizationId,
        idempotencyKey,
        fingerprint,
        randomUUID(),
      ]);
      const result = admission.rows[0]?.result;
      if (!result?.run?.id)
        throw new StoreError('conflict', 'Run admission returned no run identity.', 409);
      const selectedRun = await client.query<RunRow>(`${runSelect} WHERE r.id = $1`, [
        result.run.id,
      ]);
      if (!selectedRun.rows[0])
        throw new StoreError('conflict', 'Prior run state is unavailable.', 409);
      if (!result.created) return { run: mapRun(selectedRun.rows[0]), created: false, events: [] };

      const queuedEvent = await appendEvent(
        client,
        result.run.id,
        'run.queued',
        'Admitted by the local mock worker. No external runtime is connected.',
      );

      // pg-boss writes the durable job in this exact transaction. A crash cannot commit only one side.
      const jobId = await enqueue(asPgBossTransaction(client), { runId: result.run.id });
      if (!jobId) throw new StoreError('conflict', 'The durable mock job was not admitted.', 409);
      await client.query('UPDATE omnis.runs SET pg_boss_job_id = $2 WHERE id = $1', [
        result.run.id,
        jobId,
      ]);
      const updatedRun = await client.query<RunRow>(`${runSelect} WHERE r.id = $1`, [
        result.run.id,
      ]);
      return {
        run: mapRun(updatedRun.rows[0]!),
        created: true,
        events: [{ runId: result.run.id, event: queuedEvent }],
      };
    }).catch((error: unknown) => {
      return mapStoreError(error);
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
    return this.inMissionEventTransaction(async (client) => {
      const current = await lockRun(client, runId);
      if (current.status === 'stopping') {
        const updated = await transitionRunStatus(client, {
          runId,
          expectedStatus: 'stopping',
          nextStatus: 'cancelled',
        });
        const event = await appendEvent(
          client,
          runId,
          'run.cancelled',
          'Mock worker acknowledged cancellation before execution.',
        );
        return {
          run: mapRun(updated),
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
        const updated = await transitionRunStatus(client, {
          runId,
          expectedStatus: 'queued',
          nextStatus: 'interrupted',
          auditReason: 'missing_expired_or_revoked',
        });
        const event = await appendEvent(
          client,
          runId,
          'run.interrupted',
          'Authorization is unavailable, expired, or revoked. The run was not executed.',
        );
        return {
          run: mapRun(updated),
          started: false,
          generation: current.execution_generation,
          events: [{ runId, event }],
        };
      }

      const updated = await transitionRunStatus(client, {
        runId,
        expectedStatus: 'queued',
        nextStatus: 'running',
        workerId,
        generation: current.execution_generation,
        leaseSeconds,
      });
      const event = await appendEvent(
        client,
        runId,
        'run.started',
        'Mock runtime started this synthetic run.',
      );
      return {
        run: mapRun(updated),
        started: true,
        generation: updated.execution_generation,
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
      const appended = await client.query<{ result: unknown }>(
        'SELECT omnis.append_run_output($1,$2,$3,$4) AS result',
        [runId, workerId, generation, message],
      );
      return appended.rows[0]?.result ? RunEventSchema.parse(appended.rows[0].result) : undefined;
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
    return this.inMissionEventTransaction(async (client) => {
      const current = await lockRun(client, runId);
      if (terminalStatuses.has(current.status)) {
        throw new StoreError('invalid_transition', `Cannot stop a ${current.status} run.`, 409);
      }
      if (current.status === 'stopping') return { run: mapRun(current), events: [] };
      if (current.status !== 'queued' && current.status !== 'running') {
        throw new StoreError('invalid_transition', `Cannot stop a ${current.status} run.`, 409);
      }
      const updated = await transitionRunStatus(client, {
        runId,
        expectedStatus: current.status,
        nextStatus: 'stopping',
      });
      const event = await appendEvent(
        client,
        runId,
        'run.stop_requested',
        'Stop requested; waiting for the mock worker to acknowledge it.',
      );
      return { run: mapRun(updated), events: [{ runId, event }] };
    });
  }

  async completeRun(
    runId: string,
    workerId: string,
    generation: number,
    output: string,
    evidenceRefs: string[] = [],
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    return this.inMissionEventTransaction(async (client) => {
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
        const cancelled = await transitionRunStatus(client, {
          runId,
          expectedStatus: 'stopping',
          nextStatus: 'cancelled',
          workerId,
          generation,
        });
        const event = await appendEvent(
          client,
          runId,
          'run.cancelled',
          'Mock worker acknowledged cancellation.',
        );
        return { run: mapRun(cancelled.rows[0]!), events: [{ runId, event }] };
      }
      const authorizationLock = await client.query<{ allowed: boolean }>(
        'SELECT omnis.lock_active_run_authorization($1) AS allowed',
        [runId],
      );
      if (!authorizationLock.rows[0]?.allowed) {
        const interrupted = await transitionRunStatus(client, {
          runId,
          expectedStatus: 'running',
          nextStatus: 'interrupted',
          workerId,
          generation,
          auditReason: 'revoked_before_completion',
        });
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
      const updated = await transitionRunStatus(client, {
        runId,
        expectedStatus: 'running',
        nextStatus: 'completed',
        workerId,
        generation,
        output,
        evidenceRefs,
      });
      const event = await appendEvent(client, runId, 'run.completed', output);
      return { run: mapRun(updated), events: [{ runId, event }] };
    });
  }

  async cancelRun(
    runId: string,
    workerId: string,
    generation: number,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    return this.inMissionEventTransaction(async (client) => {
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
      const updated = await transitionRunStatus(client, {
        runId,
        expectedStatus: 'stopping',
        nextStatus: 'cancelled',
        workerId,
        generation,
      });
      const event = await appendEvent(
        client,
        runId,
        'run.cancelled',
        'Mock worker acknowledged cancellation.',
      );
      return { run: mapRun(updated), events: [{ runId, event }] };
    });
  }

  async failRun(
    runId: string,
    workerId: string,
    generation: number,
    message: string,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    return this.inMissionEventTransaction(async (client) => {
      const current = await lockRun(client, runId);
      if (current.status === 'stopping') {
        if (current.lease_owner !== workerId || current.execution_generation !== generation) {
          throw new StoreError(
            'conflict',
            'The current worker does not own this execution generation.',
            409,
          );
        }
        return this.cancelLocked(client, current, workerId, generation);
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
      const updated = await transitionRunStatus(client, {
        runId,
        expectedStatus: 'running',
        nextStatus: 'failed',
        workerId,
        generation,
        auditReason: 'runtime_failed',
      });
      const event = await appendEvent(client, runId, 'run.failed', message);
      return { run: mapRun(updated), events: [{ runId, event }] };
    });
  }

  async interruptRun(
    runId: string,
    workerId: string,
    generation: number,
    message = 'The worker stopped before the run reached a terminal state.',
  ): Promise<{ run: Run; events: DurableEvent[] } | undefined> {
    return this.inMissionEventTransaction(async (client) => {
      const current = await lockRun(client, runId);
      if (!['running', 'stopping'].includes(current.status)) return undefined;
      if (current.lease_owner !== workerId || current.execution_generation !== generation)
        return undefined;
      const updated = await transitionRunStatus(client, {
        runId,
        expectedStatus: current.status,
        nextStatus: 'interrupted',
        workerId,
        generation,
      });
      const event = await appendEvent(client, runId, 'run.interrupted', message);
      return { run: mapRun(updated), events: [{ runId, event }] };
    });
  }

  async reconcileExpiredRuns(): Promise<DurableEvent[]> {
    return this.inMissionEventTransaction(async (client) => {
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
        await transitionRunStatus(client, {
          runId: row.id,
          expectedStatus: row.status,
          nextStatus: 'interrupted',
        });
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
    return this.inMissionEventTransaction(async (client) => {
      const current = await lockRun(client, runId);
      if (current.status === 'stopping' && !current.lease_owner) {
        // No worker ever claimed this stop-requested job; the reconciler acknowledges
        // cancellation after pg-boss confirms the job cannot begin.
        return this.cancelLocked(client, current);
      }
      if (current.status !== 'queued') return undefined;
      const updated = await transitionRunStatus(client, {
        runId,
        expectedStatus: 'queued',
        nextStatus: 'interrupted',
      });
      const event = await appendEvent(client, runId, 'run.interrupted', message);
      return { run: mapRun(updated), events: [{ runId, event }] };
    });
  }

  async cancelRunAfterQueueTerminal(
    runId: string,
  ): Promise<{ run: Run; events: DurableEvent[] } | undefined> {
    return this.inMissionEventTransaction(async (client) => {
      const current = await lockRun(client, runId);
      if (current.status !== 'stopping') return undefined;
      return this.cancelLocked(client, current);
    });
  }

  private async inMissionEventTransaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query('SELECT omnis.lock_mission_event_clock()');
      return action(client);
    });
  }

  private async cancelLocked(
    client: PoolClient,
    current: RunRow,
    workerId?: string,
    generation?: number,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    const updated = await transitionRunStatus(client, {
      runId: current.id,
      expectedStatus: 'stopping',
      nextStatus: 'cancelled',
      workerId: workerId ?? null,
      generation: generation ?? null,
    });
    const event = await appendEvent(
      client,
      current.id,
      'run.cancelled',
      'Mock worker acknowledged cancellation.',
    );
    return { run: mapRun(updated), events: [{ runId: current.id, event }] };
  }
}

function isPostgresLockTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03';
}

async function transitionRunStatus(
  client: PoolClient,
  input: {
    runId: string;
    expectedStatus: Run['status'];
    nextStatus: Run['status'];
    workerId?: string | null;
    generation?: number | null;
    leaseSeconds?: number | null;
    output?: string | null;
    evidenceRefs?: string[];
    auditReason?: string | null;
  },
): Promise<RunRow> {
  const result = await client.query<RunRow>(
    `SELECT * FROM omnis.transition_run_status($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.runId,
      input.expectedStatus,
      input.nextStatus,
      input.workerId ?? null,
      input.generation ?? null,
      input.leaseSeconds ?? null,
      input.output ?? null,
      JSON.stringify(input.evidenceRefs ?? []),
      input.auditReason ?? null,
    ],
  );
  const updated = result.rows[0];
  if (!updated) throw new StoreError('invalid_transition', 'Run transition was not applied.', 409);
  return updated;
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
  if (type === 'run.output')
    throw new Error('Run output must use the lease-checked append function.');
  // Lifecycle messages are generated by the database transition trigger from a closed,
  // non-sensitive template. Caller-provided text must not be able to rewrite run history.
  void message;
  const result = await client.query<EventRow>(
    `SELECT id, run_id, sequence, event_type, at, source, synthetic, message
       FROM omnis.run_events WHERE run_id = $1 AND event_type = $2
       ORDER BY sequence DESC LIMIT 1`,
    [runId, type],
  );
  if (!result.rows[0])
    throw new StoreError('invalid_transition', 'Run lifecycle event is unavailable.', 409);
  return mapEvent(result.rows[0]);
}

function requiredWorkspaceValue<T>(value: T | null): T {
  if (value === null) throw new Error('Project workspace query returned an incomplete task row.');
  return value;
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
  if (code === 'P2004')
    throw new StoreError(
      'invalid_transition',
      'An active task-scoped authorization is required.',
      409,
    );
  if (code === 'P2005')
    throw new StoreError('concurrency_limit', 'A run is active or needs interruption review.', 409);
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

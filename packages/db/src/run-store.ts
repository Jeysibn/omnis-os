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
import {
  ConnectorAuthorizationRequestSchema,
  type ConnectorAuthorizationRequest,
} from '@omnis/contracts/connector-authorization';
import {
  ConnectorExecutionStatusSchema,
  type ConnectorExecutionStatus,
} from '@omnis/contracts/connector-broker';

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
  connector_authorization_id?: string | null;
  connector_request_id?: string | null;
  connector_correlation_id?: string | null;
  connector_request_binding?: unknown;
  connector_attempt_id?: string | null;
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

export type SyntheticBrokerRun = {
  run: Run;
  authorizationId: string;
  requestId: string;
  correlationId: string;
  binding: ConnectorAuthorizationRequest;
  attemptId: string | null;
};

export type SyntheticBrokerRunResult = {
  attemptId?: string;
  status: ConnectorExecutionStatus;
  responseText?: string;
};

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

  /**
   * Creates only a canonical Run projection and a durable queue job. The
   * connector grant and attempt remain authoritative in the authorizer store.
   */
  async admitSyntheticBrokerRun(
    input: {
      runId: string;
      taskId: string;
      authorizationId: string;
      requestId: string;
      correlationId: string;
      binding: ConnectorAuthorizationRequest;
    },
    enqueue: EnqueueRun,
  ): Promise<{ run: Run; created: boolean; events: DurableEvent[] }> {
    const binding = ConnectorAuthorizationRequestSchema.safeParse(input.binding);
    if (
      !isUuid(input.runId) ||
      !isUuid(input.authorizationId) ||
      !isUuid(input.requestId) ||
      !isUuid(input.correlationId) ||
      !binding.success ||
      input.runId !== input.correlationId ||
      binding.data.taskId !== input.taskId
    ) {
      throw new StoreError('invalid_input', 'Synthetic Run binding is invalid.', 400);
    }
    if (input.requestId.length < 16 || input.requestId.length > 128) {
      throw new StoreError('invalid_input', 'Idempotency-Key is invalid.', 400);
    }
    const fingerprint = JSON.stringify({
      kind: 'synthetic-broker-run-v1',
      runId: input.runId,
      taskId: input.taskId,
      authorizationId: input.authorizationId,
      requestId: input.requestId,
      correlationId: input.correlationId,
      binding: binding.data,
    });

    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [admissionLock]);
      const previous = await client.query<
        QueryResultRow & { request_fingerprint: string; run_id: string }
      >(
        'SELECT request_fingerprint, run_id FROM omnis.run_idempotency WHERE idempotency_key = $1',
        [input.requestId],
      );
      if (previous.rows[0]) {
        if (
          previous.rows[0].request_fingerprint !== fingerprint ||
          previous.rows[0].run_id !== input.runId
        ) {
          throw new StoreError(
            'conflict',
            'Idempotency key was already used for another run.',
            409,
          );
        }
        const existing = await client.query<RunRow>(`${runSelect} WHERE r.id = $1`, [input.runId]);
        if (!existing.rows[0])
          throw new StoreError('conflict', 'Prior run state is unavailable.', 409);
        return { run: mapRun(existing.rows[0]), created: false, events: [] };
      }

      const taskResult = await client.query<TaskRow>(
        'SELECT id, title, detail, status, created_at, project_id, association_revision FROM omnis.tasks WHERE id = $1 FOR UPDATE',
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new StoreError('not_found', 'Task was not found.', 404);
      if (
        task.project_id !== binding.data.projectId ||
        Number(task.association_revision) !== binding.data.taskRevision ||
        task.status === 'completed'
      ) {
        throw new StoreError('conflict', 'The approved task context has changed.', 409);
      }

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
        `INSERT INTO omnis.runs
           (id, task_id, task_title, connector_authorization_id, connector_request_id,
            connector_correlation_id, connector_request_binding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING ${runColumns}`,
        [
          input.runId,
          task.id,
          task.title,
          input.authorizationId,
          input.requestId,
          input.correlationId,
          JSON.stringify(binding.data),
        ],
      );
      const run = mapRun(created.rows[0]!);
      const event = await appendEvent(
        client,
        run.id,
        'run.queued',
        'Queued as a synthetic broker run. No real provider or runtime is connected.',
      );
      const jobId = await enqueue(asPgBossTransaction(client), { runId: run.id });
      if (!jobId)
        throw new StoreError('conflict', 'The durable synthetic job was not admitted.', 409);
      await client.query('UPDATE omnis.runs SET pg_boss_job_id = $2 WHERE id = $1', [
        run.id,
        jobId,
      ]);
      await client.query(
        'INSERT INTO omnis.run_idempotency (idempotency_key, request_fingerprint, run_id) VALUES ($1, $2, $3)',
        [input.requestId, fingerprint, run.id],
      );
      await client.query("UPDATE omnis.tasks SET status = 'in_progress' WHERE id = $1", [task.id]);
      return { run, created: true, events: [{ runId: run.id, event }] };
    });
  }

  async getSyntheticBrokerRun(runId: string): Promise<SyntheticBrokerRun | undefined> {
    const result = await this.pool.query<RunRow>(`${runSelect} WHERE r.id = $1`, [runId]);
    const row = result.rows[0];
    if (!row || !row.connector_authorization_id) return undefined;
    const binding = ConnectorAuthorizationRequestSchema.parse(row.connector_request_binding);
    if (
      !row.connector_request_id ||
      !row.connector_correlation_id ||
      row.connector_correlation_id !== row.id ||
      binding.taskId !== row.task_id
    ) {
      throw new StoreError('conflict', 'Persisted synthetic Run binding is invalid.', 409);
    }
    return {
      run: mapRun(row),
      authorizationId: row.connector_authorization_id,
      requestId: row.connector_request_id,
      correlationId: row.connector_correlation_id,
      binding,
      attemptId: row.connector_attempt_id ?? null,
    };
  }

  async getSyntheticBrokerRunByAuthorization(
    authorizationId: string,
  ): Promise<SyntheticBrokerRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `${runSelect} WHERE r.connector_authorization_id = $1`,
      [authorizationId],
    );
    const row = result.rows[0];
    return row ? this.getSyntheticBrokerRun(row.id) : undefined;
  }

  async beginSyntheticBrokerRun(
    runId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<{ run: Run; started: boolean; events: DurableEvent[]; generation: number }> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (!current.connector_authorization_id) {
        throw new StoreError('invalid_transition', 'The run is not a synthetic broker run.', 409);
      }
      if (current.status === 'stopping') {
        const cancelled = await client.query<RunRow>(
          `UPDATE omnis.runs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
             updated_at=now() WHERE id=$1 RETURNING ${runColumns}`,
          [runId],
        );
        await client.query("UPDATE omnis.tasks SET status='open' WHERE id=$1", [current.task_id]);
        const event = await appendEvent(
          client,
          runId,
          'run.cancelled',
          'Cancellation was confirmed before the synthetic broker job started.',
        );
        return {
          run: mapRun(cancelled.rows[0]!),
          started: false,
          events: [{ runId, event }],
          generation: current.execution_generation,
        };
      }
      if (current.status !== 'queued') {
        return {
          run: mapRun(current),
          started: false,
          events: [],
          generation: current.execution_generation,
        };
      }
      const updated = await client.query<RunRow>(
        `UPDATE omnis.runs SET status='running', lease_owner=$2,
           lease_expires_at=now()+($3::text || ' seconds')::interval,
           execution_generation=execution_generation+1, updated_at=now()
         WHERE id=$1 RETURNING ${runColumns}`,
        [runId, workerId, leaseSeconds],
      );
      const event = await appendEvent(
        client,
        runId,
        'run.started',
        'Synthetic broker execution started.',
      );
      return {
        run: mapRun(updated.rows[0]!),
        started: true,
        generation: updated.rows[0]!.execution_generation,
        events: [{ runId, event }],
      };
    });
  }

  async renewSyntheticBrokerLease(
    runId: string,
    workerId: string,
    generation: number,
    leaseSeconds: number,
  ): Promise<'renewed' | 'stop_requested' | false> {
    const result = await this.pool.query<QueryResultRow & { status: string }>(
      `UPDATE omnis.runs SET lease_expires_at=now()+($4::text || ' seconds')::interval,
         updated_at=now()
       WHERE id=$1 AND connector_authorization_id IS NOT NULL AND lease_owner=$2
         AND execution_generation=$3 AND status IN ('running','stopping')
         AND lease_expires_at > now()
       RETURNING status`,
      [runId, workerId, generation, leaseSeconds],
    );
    if (!result.rows[0]) return false;
    return result.rows[0].status === 'stopping' ? 'stop_requested' : 'renewed';
  }

  async requestSyntheticBrokerStop(
    runId: string,
    authorizationId: string,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (current.connector_authorization_id !== authorizationId) {
        throw new StoreError('not_found', 'Synthetic Run was not found.', 404);
      }
      if (terminalStatuses.has(current.status)) return { run: mapRun(current), events: [] };
      if (current.status === 'stopping') return { run: mapRun(current), events: [] };
      const updated = await client.query<RunRow>(
        `UPDATE omnis.runs SET status='stopping', updated_at=now()
         WHERE id=$1 RETURNING ${runColumns}`,
        [runId],
      );
      const event = await appendEvent(
        client,
        runId,
        'run.stop_requested',
        'Owner cancellation was requested; provider termination is not yet confirmed.',
      );
      return { run: mapRun(updated.rows[0]!), events: [{ runId, event }] };
    });
  }

  async finishSyntheticBrokerRun(
    runId: string,
    workerId: string,
    generation: number,
    result: SyntheticBrokerRunResult,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    if (!ConnectorExecutionStatusSchema.safeParse(result.status).success) {
      throw new StoreError('invalid_input', 'Synthetic broker result is invalid.', 400);
    }
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (
        !current.connector_authorization_id ||
        current.lease_owner !== workerId ||
        current.execution_generation !== generation ||
        !['running', 'stopping'].includes(current.status)
      ) {
        throw new StoreError('conflict', 'The worker no longer owns this synthetic Run.', 409);
      }
      const nextStatus: Run['status'] =
        result.status === 'completed'
          ? 'completed'
          : result.status === 'failed'
            ? 'failed'
            : result.status === 'interrupted'
              ? current.status === 'stopping'
                ? 'cancelled'
                : 'interrupted'
              : 'unknown';
      const updated = await client.query<RunRow>(
        `UPDATE omnis.runs SET status=$4, result_output=$5,
           connector_attempt_id=COALESCE($6, connector_attempt_id),
           lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND execution_generation=$3
           AND lease_expires_at > now()
         RETURNING ${runColumns}`,
        [
          runId,
          workerId,
          generation,
          nextStatus,
          nextStatus === 'completed' ? (result.responseText ?? null) : null,
          result.attemptId ?? null,
        ],
      );
      if (!updated.rows[0]) throw new StoreError('conflict', 'The worker lost its Run lease.', 409);
      if (nextStatus === 'completed') {
        await client.query("UPDATE omnis.tasks SET status='completed' WHERE id=$1", [
          current.task_id,
        ]);
      } else if (nextStatus !== 'unknown') {
        await client.query("UPDATE omnis.tasks SET status='open' WHERE id=$1", [current.task_id]);
      }
      const eventType: RunEventType =
        nextStatus === 'completed'
          ? 'run.completed'
          : nextStatus === 'failed'
            ? 'run.failed'
            : nextStatus === 'cancelled'
              ? 'run.cancelled'
              : nextStatus === 'unknown'
                ? 'run.outcome_unknown'
                : 'run.interrupted';
      const message =
        nextStatus === 'completed'
          ? (result.responseText ?? 'Synthetic broker run completed.')
          : nextStatus === 'failed'
            ? 'Synthetic broker execution failed; see the authorized attempt record for details.'
            : nextStatus === 'cancelled'
              ? 'The synthetic provider confirmed interruption.'
              : nextStatus === 'interrupted'
                ? 'Synthetic broker execution stopped before a terminal result was confirmed.'
                : 'The broker outcome is unknown. Do not resubmit this request.';
      const event = await appendEvent(client, runId, eventType, message);
      return { run: mapRun(updated.rows[0]), events: [{ runId, event }] };
    });
  }

  async recordSyntheticBrokerSubmissionRequested(
    runId: string,
    workerId: string,
    generation: number,
  ): Promise<{ run: Run; events: DurableEvent[] }> {
    return inTransaction(this.pool, async (client) => {
      const current = await lockRun(client, runId);
      if (
        !current.connector_authorization_id ||
        current.status !== 'running' ||
        current.lease_owner !== workerId ||
        current.execution_generation !== generation ||
        !current.lease_expires_at
      ) {
        throw new StoreError('conflict', 'The worker no longer owns this synthetic Run.', 409);
      }
      const lease = await client.query<{ valid: boolean }>(
        'SELECT $1::timestamptz > now() AS valid',
        [current.lease_expires_at],
      );
      if (!lease.rows[0]?.valid) {
        throw new StoreError('conflict', 'The worker no longer owns this synthetic Run.', 409);
      }
      const event = await appendEvent(
        client,
        runId,
        'run.provider_submission_requested',
        'The broker submission was requested. Provider acceptance is not yet confirmed.',
      );
      const updated = await client.query<RunRow>(`${runSelect} WHERE r.id=$1`, [runId]);
      if (!updated.rows[0]) throw new StoreError('not_found', 'Run was not found.', 404);
      return { run: mapRun(updated.rows[0]), events: [{ runId, event }] };
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
      if (current.connector_authorization_id) {
        throw new StoreError(
          'invalid_transition',
          'Synthetic broker runs must be cancelled through owner grant revocation.',
          409,
        );
      }
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
        const submission = row.connector_authorization_id
          ? await client.query<{ requested: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM omnis.run_events
                 WHERE run_id = $1 AND event_type = 'run.provider_submission_requested'
               ) AS requested`,
              [row.id],
            )
          : undefined;
        const submissionRequested = submission?.rows[0]?.requested ?? false;
        const nextStatus = submissionRequested
          ? 'unknown'
          : row.connector_authorization_id && row.status === 'stopping'
            ? 'cancelled'
            : 'interrupted';
        await client.query(
          `
            UPDATE omnis.runs SET status = $2, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = now()
            WHERE id = $1
          `,
          [row.id, nextStatus],
        );
        if (nextStatus !== 'unknown') {
          await client.query("UPDATE omnis.tasks SET status = 'open' WHERE id = $1", [row.task_id]);
        }
        const event = await appendEvent(
          client,
          row.id,
          nextStatus === 'unknown'
            ? 'run.outcome_unknown'
            : nextStatus === 'cancelled'
              ? 'run.cancelled'
              : 'run.interrupted',
          nextStatus === 'unknown'
            ? 'The worker lease expired before the broker result was confirmed. The attempt was not retried; reconcile its authorizer record.'
            : nextStatus === 'cancelled'
              ? 'Cancellation was confirmed before broker submission began.'
              : row.connector_authorization_id
                ? 'The worker lease expired before broker submission began. The execution was not retried automatically.'
                : 'The execution lease expired. The run was not replayed automatically.',
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
          AND connector_authorization_id IS NULL
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
    if (!current.connector_authorization_id)
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
  runtime_kind, synthetic, usage, created_at, updated_at, connector_authorization_id,
  connector_request_id, connector_correlation_id, connector_request_binding, connector_attempt_id`;
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
    authorizationId: row.connector_authorization_id ?? null,
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

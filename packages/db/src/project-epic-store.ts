import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArchiveEpicSchema,
  CreateEpicSchema,
  EpicIdSchema,
  EpicListQuerySchema,
  EpicListResponseSchema,
  EpicSchema,
  ProjectIdSchema,
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceTaskPageSchema,
  SetTaskEpicSchema,
  TaskEpicAssociationSchema,
  TaskEpicResponseSchema,
  TaskIdSchema,
  UpdateEpicSchema,
  type Epic,
  type EpicListResponse,
  type ProjectWorkspaceTaskPage,
  type TaskEpicAssociation,
  type TaskEpicResponse,
} from '@omnis/contracts';
import type { Pool } from 'pg';
import { AgentProfileStoreError, assertNoCredentialMaterial } from './agent-profile-store.ts';
import { createHash } from 'node:crypto';

type DbError = { code?: string };
type Cursor = { version: 1; projectId: string; lastCreatedAt: string; lastEpicId: string };
type DbList = { epics: unknown[]; observedTotal: number };
type EpicTaskCursor = {
  version: 1;
  projectId: string;
  epicId: string;
  lastCreatedAt: string;
  lastTaskId: string;
};
type DbTaskList = { tasks: unknown[]; observedTotal: number };

export type EpicStoreErrorCode =
  'not_found' | 'conflict' | 'invalid_input' | 'invalid_transition' | 'limit' | 'invalid_cursor';

export class EpicStoreError extends Error {
  readonly code: EpicStoreErrorCode;
  readonly statusCode: 404 | 409 | 422 | 503;

  constructor(code: EpicStoreErrorCode, statusCode: 404 | 409 | 422 | 503) {
    const messages: Record<EpicStoreErrorCode, string> = {
      not_found: 'Project or epic was not found.',
      conflict: 'The epic revision or idempotency key conflicts with existing state.',
      invalid_input: 'Epic input is invalid.',
      invalid_transition: 'The project or epic lifecycle does not allow this change.',
      limit: 'The epic directory capacity was reached.',
      invalid_cursor: 'Epic pagination cursor is invalid.',
    };
    super(messages[code]);
    this.name = 'EpicStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function mapDatabaseError(error: unknown): never {
  const code = (error as DbError)?.code;
  if (code === 'P0002') throw new EpicStoreError('not_found', 404);
  if (code === '23505' || code === '40001') throw new EpicStoreError('conflict', 409);
  if (code === 'P0001') throw new EpicStoreError('invalid_transition', 409);
  if (code === '54000') throw new EpicStoreError('limit', 503);
  if (['22023', '22001', '23502', '23514', '22P02'].includes(code ?? ''))
    throw new EpicStoreError('invalid_input', 422);
  throw error;
}

function deriveCursorSigningKey(key: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      key,
      Buffer.from('omnis-os/ao-105/project-epics/cursor/v1', 'utf8'),
      Buffer.from('epic-page-signature', 'utf8'),
      32,
    ),
  );
}

function cursorSignature(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update('omnis-project-epics-cursor-v1:')
    .update(payload)
    .digest();
}

function decodeCursor(encoded: string, projectId: string, key: Buffer): Cursor {
  try {
    const [payload, signature, extra] = encoded.split('.');
    if (!payload || !signature || extra !== undefined) throw new Error('Invalid cursor.');
    const supplied = Buffer.from(signature, 'base64url');
    const expected = cursorSignature(payload, key);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      supplied.toString('base64url') !== signature
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
      !('lastEpicId' in value && typeof value.lastEpicId === 'string') ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.lastCreatedAt) ||
      !Number.isFinite(Date.parse(value.lastCreatedAt)) ||
      !EpicIdSchema.safeParse(value.lastEpicId).success ||
      Buffer.from(payload, 'base64url').toString('base64url') !== payload
    )
      throw new Error('Invalid cursor.');
    return value as Cursor;
  } catch {
    throw new EpicStoreError('invalid_cursor', 422);
  }
}

function encodeCursor(cursor: Cursor, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${cursorSignature(payload, key).toString('base64url')}`;
}

function deriveEpicTaskCursorKey(key: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      key,
      Buffer.from('omnis-os/ao-105/project-epics/tasks-cursor/v1', 'utf8'),
      Buffer.from('epic-task-page-signature', 'utf8'),
      32,
    ),
  );
}

function epicTaskCursorSignature(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update('omnis-project-epic-tasks-cursor-v1:')
    .update(payload)
    .digest();
}

function decodeEpicTaskCursor(
  encoded: string,
  projectId: string,
  epicId: string,
  key: Buffer,
): EpicTaskCursor {
  try {
    const [payload, signature, extra] = encoded.split('.');
    if (!payload || !signature || extra !== undefined) throw new Error('Invalid cursor.');
    const supplied = Buffer.from(signature, 'base64url');
    const expected = epicTaskCursorSignature(payload, key);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      supplied.toString('base64url') !== signature
    )
      throw new Error('Invalid cursor.');
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(json);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value && value.version === 1) ||
      !('projectId' in value && value.projectId === projectId) ||
      !('epicId' in value && value.epicId === epicId) ||
      !('lastCreatedAt' in value && typeof value.lastCreatedAt === 'string') ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(
        value.lastCreatedAt,
      ) ||
      !Number.isFinite(Date.parse(value.lastCreatedAt)) ||
      !('lastTaskId' in value && TaskIdSchema.safeParse(value.lastTaskId).success) ||
      Buffer.from(payload, 'base64url').toString('base64url') !== payload
    )
      throw new Error('Invalid cursor.');
    return value as EpicTaskCursor;
  } catch {
    throw new EpicStoreError('invalid_cursor', 422);
  }
}

function encodeEpicTaskCursor(cursor: EpicTaskCursor, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${epicTaskCursorSignature(payload, key).toString('base64url')}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertSafeInput(value: unknown): void {
  try {
    assertNoCredentialMaterial(value);
  } catch (error) {
    if (error instanceof AgentProfileStoreError) throw new EpicStoreError('invalid_input', 422);
    throw error;
  }
}

export class PostgresProjectEpicStore {
  private readonly pool: Pool;
  private readonly signingKey: Buffer;
  private readonly cursorSigningKey: Buffer;
  private readonly epicTaskCursorKey: Buffer;
  private readonly keyVersion: number;

  constructor(pool: Pool, signingKey: Buffer, keyVersion = 1) {
    if (signingKey.length !== 32 || !Number.isSafeInteger(keyVersion) || keyVersion < 1)
      throw new Error('Project epic signing key configuration is invalid.');
    this.pool = pool;
    this.signingKey = Buffer.from(signingKey);
    this.cursorSigningKey = deriveCursorSigningKey(signingKey);
    this.epicTaskCursorKey = deriveEpicTaskCursorKey(signingKey);
    this.keyVersion = keyVersion;
  }

  async list(projectIdValue: string, queryValue: unknown = {}): Promise<EpicListResponse> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const query = EpicListQuerySchema.safeParse(queryValue);
    if (!projectId.success || !query.success) throw new EpicStoreError('invalid_input', 422);
    const limit = query.data.limit ?? 50;
    const cursor = query.data.cursor
      ? decodeCursor(query.data.cursor, projectId.data, this.cursorSigningKey)
      : undefined;
    try {
      const result = await this.pool.query<{ result: DbList }>(
        'SELECT omnis.list_project_epics($1,$2,$3,$4) AS result',
        [projectId.data, cursor?.lastCreatedAt ?? null, cursor?.lastEpicId ?? null, limit],
      );
      const value = result.rows[0]?.result;
      if (!value || !Array.isArray(value.epics) || !Number.isSafeInteger(value.observedTotal))
        throw new Error('Epic list database response is invalid.');
      const hasNext = value.epics.length > limit;
      const epics = value.epics.slice(0, limit).map((epic) => EpicSchema.parse(epic));
      const last = epics.at(-1);
      const nextCursor =
        hasNext && last
          ? encodeCursor(
              {
                version: 1,
                projectId: projectId.data,
                lastCreatedAt: last.createdAt,
                lastEpicId: last.id,
              },
              this.cursorSigningKey,
            )
          : null;
      return EpicListResponseSchema.parse({
        epics,
        page: {
          observedTotal: value.observedTotal,
          complete: nextCursor === null,
          nextCursor,
        },
      });
    } catch (error) {
      if (error instanceof EpicStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async get(projectIdValue: string, epicIdValue: string): Promise<Epic | undefined> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const epicId = EpicIdSchema.safeParse(epicIdValue);
    if (!projectId.success || !epicId.success) throw new EpicStoreError('invalid_input', 422);
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.get_project_epic($1,$2) AS result',
        [projectId.data, epicId.data],
      );
      const value = result.rows[0]?.result;
      return value === null ? undefined : EpicSchema.parse(value);
    } catch (error) {
      if (error instanceof EpicStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async getTaskEpic(taskIdValue: string): Promise<TaskEpicResponse | undefined> {
    const taskId = TaskIdSchema.safeParse(taskIdValue);
    if (!taskId.success) throw new EpicStoreError('invalid_input', 422);
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.get_task_epic($1) AS result',
        [taskId.data],
      );
      const value = result.rows[0]?.result;
      return value === null || value === undefined
        ? undefined
        : TaskEpicResponseSchema.parse(value);
    } catch (error) {
      if (error instanceof EpicStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async setTaskEpic(
    taskIdValue: string,
    inputValue: unknown,
    requestId: string,
  ): Promise<TaskEpicAssociation> {
    const taskId = TaskIdSchema.safeParse(taskIdValue);
    const input = SetTaskEpicSchema.safeParse(inputValue);
    if (!taskId.success || !input.success || !isUuid(requestId))
      throw new EpicStoreError('invalid_input', 422);
    const fingerprint = createHash('sha256')
      .update('omnis-task-epic-association-idempotency:v1\0')
      .update(JSON.stringify({ taskId: taskId.data, input: input.data }))
      .digest();
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.set_task_epic($1,$2,$3,$4,$5) AS result',
        [
          taskId.data,
          input.data.expectedAssociationRevision,
          input.data.epicId,
          requestId,
          fingerprint,
        ],
      );
      return TaskEpicAssociationSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof EpicStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async listTasks(
    projectIdValue: string,
    epicIdValue: string,
    queryValue: unknown = {},
  ): Promise<ProjectWorkspaceTaskPage> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const epicId = EpicIdSchema.safeParse(epicIdValue);
    const query = ProjectWorkspaceQuerySchema.safeParse(queryValue);
    if (!projectId.success || !epicId.success || !query.success)
      throw new EpicStoreError('invalid_input', 422);
    const limit = query.data.limit ?? 50;
    const cursor = query.data.cursor
      ? decodeEpicTaskCursor(query.data.cursor, projectId.data, epicId.data, this.epicTaskCursorKey)
      : undefined;
    try {
      const result = await this.pool.query<{ result: DbTaskList }>(
        'SELECT omnis.list_project_epic_tasks($1,$2,$3,$4,$5) AS result',
        [
          projectId.data,
          epicId.data,
          cursor?.lastCreatedAt ?? null,
          cursor?.lastTaskId ?? null,
          limit,
        ],
      );
      const value = result.rows[0]?.result;
      if (!value || !Array.isArray(value.tasks) || !Number.isSafeInteger(value.observedTotal))
        throw new Error('Epic task list database response is invalid.');
      const hasNext = value.tasks.length > limit;
      const tasks = value.tasks.slice(0, limit);
      const parsedTasks = tasks.map((task) =>
        ProjectWorkspaceTaskPageSchema.shape.tasks.element.parse(task),
      );
      const nextCursor =
        hasNext && parsedTasks.length > 0
          ? encodeEpicTaskCursor(
              {
                version: 1,
                projectId: projectId.data,
                epicId: epicId.data,
                lastCreatedAt: parsedTasks.at(-1)!.createdAt,
                lastTaskId: parsedTasks.at(-1)!.id,
              },
              this.epicTaskCursorKey,
            )
          : null;
      return ProjectWorkspaceTaskPageSchema.parse({
        tasks: parsedTasks,
        page: {
          observedTotal: value.observedTotal,
          complete: nextCursor === null,
          nextCursor,
        },
      });
    } catch (error) {
      if (error instanceof EpicStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async create(projectIdValue: string, inputValue: unknown, requestId: string): Promise<Epic> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const parsed = CreateEpicSchema.safeParse(inputValue);
    if (!projectId.success || !parsed.success || !isUuid(requestId))
      throw new EpicStoreError('invalid_input', 422);
    const input = parsed.data;
    assertSafeInput(input);
    const id = `epc_${randomUUID().replaceAll('-', '')}`;
    const fingerprint = this.fingerprint('epic.created', { projectId: projectId.data, input });
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.create_project_epic($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          id,
          projectId.data,
          input.title,
          input.description ?? null,
          requestId,
          this.keyVersion,
          fingerprint,
        ],
      );
      return EpicSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof EpicStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async update(
    projectIdValue: string,
    epicIdValue: string,
    inputValue: unknown,
    requestId: string,
  ): Promise<Epic> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const epicId = EpicIdSchema.safeParse(epicIdValue);
    const parsed = UpdateEpicSchema.safeParse(inputValue);
    if (!projectId.success || !epicId.success || !parsed.success || !isUuid(requestId))
      throw new EpicStoreError('invalid_input', 422);
    const input = parsed.data;
    assertSafeInput({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    const fingerprint = this.fingerprint('epic.updated', {
      projectId: projectId.data,
      epicId: epicId.data,
      input,
    });
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.update_project_epic($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
        [
          projectId.data,
          epicId.data,
          input.expectedRevision,
          input.title ?? null,
          input.description ?? null,
          input.description !== undefined,
          input.status ?? null,
          requestId,
          this.keyVersion,
          fingerprint,
        ],
      );
      return EpicSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof EpicStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async archive(
    projectIdValue: string,
    epicIdValue: string,
    inputValue: unknown,
    requestId: string,
  ): Promise<Epic> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const epicId = EpicIdSchema.safeParse(epicIdValue);
    const parsed = ArchiveEpicSchema.safeParse(inputValue);
    if (!projectId.success || !epicId.success || !parsed.success || !isUuid(requestId))
      throw new EpicStoreError('invalid_input', 422);
    const fingerprint = this.fingerprint('epic.archived', {
      projectId: projectId.data,
      epicId: epicId.data,
      input: parsed.data,
    });
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.archive_project_epic($1,$2,$3,$4,$5,$6) AS result',
        [
          projectId.data,
          epicId.data,
          parsed.data.expectedRevision,
          requestId,
          this.keyVersion,
          fingerprint,
        ],
      );
      return EpicSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof EpicStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  private fingerprint(operation: string, value: unknown): Buffer {
    return createHmac('sha256', this.signingKey)
      .update('omnis-project-epic-management-idempotency:v1\0')
      .update(JSON.stringify({ operation, value }))
      .digest();
  }
}

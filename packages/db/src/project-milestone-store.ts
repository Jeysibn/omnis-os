import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArchiveMilestoneSchema,
  CreateMilestoneSchema,
  MilestoneIdSchema,
  MilestoneListQuerySchema,
  MilestoneListResponseSchema,
  MilestoneSchema,
  ProjectIdSchema,
  UpdateMilestoneSchema,
  type Milestone,
  type MilestoneListResponse,
} from '@omnis/contracts';
import type { Pool } from 'pg';
import { AgentProfileStoreError, assertNoCredentialMaterial } from './agent-profile-store.ts';

type DbError = { code?: string };
type Cursor = { version: 1; projectId: string; lastCreatedAt: string; lastMilestoneId: string };
type DbList = { milestones: unknown[]; observedTotal: number };

export type MilestoneStoreErrorCode =
  'not_found' | 'conflict' | 'invalid_input' | 'invalid_transition' | 'limit' | 'invalid_cursor';

export class MilestoneStoreError extends Error {
  readonly code: MilestoneStoreErrorCode;
  readonly statusCode: 404 | 409 | 422 | 503;

  constructor(code: MilestoneStoreErrorCode, statusCode: 404 | 409 | 422 | 503) {
    const messages: Record<MilestoneStoreErrorCode, string> = {
      not_found: 'Project or milestone was not found.',
      conflict: 'The milestone revision or idempotency key conflicts with existing state.',
      invalid_input: 'Milestone input is invalid.',
      invalid_transition: 'The project or milestone lifecycle does not allow this change.',
      limit: 'The milestone directory capacity was reached.',
      invalid_cursor: 'Milestone pagination cursor is invalid.',
    };
    super(messages[code]);
    this.name = 'MilestoneStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function mapDatabaseError(error: unknown): never {
  const code = (error as DbError)?.code;
  if (code === 'P0002') throw new MilestoneStoreError('not_found', 404);
  if (code === '23505' || code === '40001') throw new MilestoneStoreError('conflict', 409);
  if (code === 'P0001') throw new MilestoneStoreError('invalid_transition', 409);
  if (code === '54000') throw new MilestoneStoreError('limit', 503);
  if (['22023', '22001', '23502', '23514', '22P02'].includes(code ?? ''))
    throw new MilestoneStoreError('invalid_input', 422);
  throw error;
}

function deriveCursorSigningKey(key: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      key,
      Buffer.from('omnis-os/ao-105/project-milestones/cursor/v1', 'utf8'),
      Buffer.from('milestone-page-signature', 'utf8'),
      32,
    ),
  );
}

function cursorSignature(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update('omnis-project-milestones-cursor-v1:')
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
      !('lastMilestoneId' in value && typeof value.lastMilestoneId === 'string') ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.lastCreatedAt) ||
      !Number.isFinite(Date.parse(value.lastCreatedAt)) ||
      !MilestoneIdSchema.safeParse(value.lastMilestoneId).success ||
      Buffer.from(payload, 'base64url').toString('base64url') !== payload
    )
      throw new Error('Invalid cursor.');
    return value as Cursor;
  } catch {
    throw new MilestoneStoreError('invalid_cursor', 422);
  }
}

function encodeCursor(cursor: Cursor, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${cursorSignature(payload, key).toString('base64url')}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertSafeInput(value: unknown): void {
  try {
    assertNoCredentialMaterial(value);
  } catch (error) {
    if (error instanceof AgentProfileStoreError)
      throw new MilestoneStoreError('invalid_input', 422);
    throw error;
  }
}

export class PostgresProjectMilestoneStore {
  private readonly pool: Pool;
  private readonly signingKey: Buffer;
  private readonly cursorSigningKey: Buffer;
  private readonly keyVersion: number;

  constructor(pool: Pool, signingKey: Buffer, keyVersion = 1) {
    if (signingKey.length !== 32 || !Number.isSafeInteger(keyVersion) || keyVersion < 1)
      throw new Error('Project milestone signing key configuration is invalid.');
    this.pool = pool;
    this.signingKey = Buffer.from(signingKey);
    this.cursorSigningKey = deriveCursorSigningKey(signingKey);
    this.keyVersion = keyVersion;
  }

  async list(projectIdValue: string, queryValue: unknown = {}): Promise<MilestoneListResponse> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const query = MilestoneListQuerySchema.safeParse(queryValue);
    if (!projectId.success || !query.success) throw new MilestoneStoreError('invalid_input', 422);
    const limit = query.data.limit ?? 50;
    const cursor = query.data.cursor
      ? decodeCursor(query.data.cursor, projectId.data, this.cursorSigningKey)
      : undefined;
    try {
      const result = await this.pool.query<{ result: DbList }>(
        'SELECT omnis.list_project_milestones($1,$2,$3,$4) AS result',
        [projectId.data, cursor?.lastCreatedAt ?? null, cursor?.lastMilestoneId ?? null, limit],
      );
      const value = result.rows[0]?.result;
      if (!value || !Array.isArray(value.milestones) || !Number.isSafeInteger(value.observedTotal))
        throw new Error('Milestone list database response is invalid.');
      const hasNext = value.milestones.length > limit;
      const milestones = value.milestones
        .slice(0, limit)
        .map((milestone) => MilestoneSchema.parse(milestone));
      const last = milestones.at(-1);
      const nextCursor =
        hasNext && last
          ? encodeCursor(
              {
                version: 1,
                projectId: projectId.data,
                lastCreatedAt: last.createdAt,
                lastMilestoneId: last.id,
              },
              this.cursorSigningKey,
            )
          : null;
      return MilestoneListResponseSchema.parse({
        milestones,
        page: {
          observedTotal: value.observedTotal,
          complete: nextCursor === null,
          nextCursor,
        },
      });
    } catch (error) {
      if (error instanceof MilestoneStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async get(projectIdValue: string, milestoneIdValue: string): Promise<Milestone | undefined> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const milestoneId = MilestoneIdSchema.safeParse(milestoneIdValue);
    if (!projectId.success || !milestoneId.success)
      throw new MilestoneStoreError('invalid_input', 422);
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.get_project_milestone($1,$2) AS result',
        [projectId.data, milestoneId.data],
      );
      const value = result.rows[0]?.result;
      return value === null ? undefined : MilestoneSchema.parse(value);
    } catch (error) {
      if (error instanceof MilestoneStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async create(projectIdValue: string, inputValue: unknown, requestId: string): Promise<Milestone> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const parsed = CreateMilestoneSchema.safeParse(inputValue);
    if (!projectId.success || !parsed.success || !isUuid(requestId))
      throw new MilestoneStoreError('invalid_input', 422);
    const input = parsed.data;
    assertSafeInput(input);
    const id = `mil_${randomUUID().replaceAll('-', '')}`;
    const fingerprint = this.fingerprint('milestone.created', { projectId: projectId.data, input });
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.create_project_milestone($1,$2,$3,$4,$5,$6,$7,$8) AS result',
        [
          id,
          projectId.data,
          input.title,
          input.description ?? null,
          input.targetDate ?? null,
          requestId,
          this.keyVersion,
          fingerprint,
        ],
      );
      return MilestoneSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof MilestoneStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async update(
    projectIdValue: string,
    milestoneIdValue: string,
    inputValue: unknown,
    requestId: string,
  ): Promise<Milestone> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const milestoneId = MilestoneIdSchema.safeParse(milestoneIdValue);
    const parsed = UpdateMilestoneSchema.safeParse(inputValue);
    if (!projectId.success || !milestoneId.success || !parsed.success || !isUuid(requestId))
      throw new MilestoneStoreError('invalid_input', 422);
    const input = parsed.data;
    assertSafeInput({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    const fingerprint = this.fingerprint('milestone.updated', {
      projectId: projectId.data,
      milestoneId: milestoneId.data,
      input,
    });
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.update_project_milestone($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS result',
        [
          projectId.data,
          milestoneId.data,
          input.expectedRevision,
          input.title ?? null,
          input.description ?? null,
          input.description !== undefined,
          input.targetDate ?? null,
          input.targetDate !== undefined,
          input.status ?? null,
          requestId,
          this.keyVersion,
          fingerprint,
        ],
      );
      return MilestoneSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof MilestoneStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async archive(
    projectIdValue: string,
    milestoneIdValue: string,
    inputValue: unknown,
    requestId: string,
  ): Promise<Milestone> {
    const projectId = ProjectIdSchema.safeParse(projectIdValue);
    const milestoneId = MilestoneIdSchema.safeParse(milestoneIdValue);
    const parsed = ArchiveMilestoneSchema.safeParse(inputValue);
    if (!projectId.success || !milestoneId.success || !parsed.success || !isUuid(requestId))
      throw new MilestoneStoreError('invalid_input', 422);
    const fingerprint = this.fingerprint('milestone.archived', {
      projectId: projectId.data,
      milestoneId: milestoneId.data,
      input: parsed.data,
    });
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.archive_project_milestone($1,$2,$3,$4,$5,$6) AS result',
        [
          projectId.data,
          milestoneId.data,
          parsed.data.expectedRevision,
          requestId,
          this.keyVersion,
          fingerprint,
        ],
      );
      return MilestoneSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof MilestoneStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  private fingerprint(operation: string, value: unknown): Buffer {
    return createHmac('sha256', this.signingKey)
      .update('omnis-project-milestone-management-idempotency:v1\0')
      .update(JSON.stringify({ operation, value }))
      .digest();
  }
}

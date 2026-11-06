import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  CreateProjectSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  UpdateProjectSchema,
  ArchiveProjectSchema,
} from '@omnis/contracts';
import type {
  CreateProjectInput,
  Project,
  ProjectListResponse,
  UpdateProjectInput,
} from '@omnis/contracts';
import { AgentProfileStoreError, assertNoCredentialMaterial } from './agent-profile-store.ts';

type DbError = { code?: string };

export type ProjectStoreErrorCode =
  'not_found' | 'conflict' | 'invalid_input' | 'invalid_transition' | 'limit';

export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode;
  readonly statusCode: 404 | 409 | 422 | 503;

  constructor(code: ProjectStoreErrorCode, statusCode: 404 | 409 | 422 | 503) {
    const messages: Record<ProjectStoreErrorCode, string> = {
      not_found: 'Project was not found.',
      conflict: 'A project with this key already exists or the idempotency key was reused.',
      invalid_input: 'Project input is invalid.',
      invalid_transition: 'The project lifecycle does not allow this change.',
      limit: 'The project directory capacity was reached.',
    };
    super(messages[code]);
    this.name = 'ProjectStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function mapDatabaseError(error: unknown): never {
  const code = (error as DbError)?.code;
  if (code === 'P0002') throw new ProjectStoreError('not_found', 404);
  if (code === '23505' || code === '40001') throw new ProjectStoreError('conflict', 409);
  if (code === 'P0001') throw new ProjectStoreError('invalid_transition', 409);
  if (code === '54000') throw new ProjectStoreError('limit', 503);
  if (['22023', '22001', '23502', '23514', '22P02'].includes(code ?? ''))
    throw new ProjectStoreError('invalid_input', 422);
  throw error;
}

export class PostgresProjectManagementStore {
  private readonly pool: Pool;
  private readonly signingKey: Buffer;
  private readonly keyVersion: number;

  constructor(pool: Pool, signingKey: Buffer, keyVersion = 1) {
    if (signingKey.length !== 32 || !Number.isSafeInteger(keyVersion) || keyVersion < 1)
      throw new Error('Project idempotency key configuration is invalid.');
    this.pool = pool;
    this.signingKey = Buffer.from(signingKey);
    this.keyVersion = keyVersion;
  }

  async list(): Promise<ProjectListResponse> {
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.list_projects() AS result',
      );
      return ProjectListResponseSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async get(id: string): Promise<Project | undefined> {
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.get_project($1) AS result',
        [id],
      );
      const value = result.rows[0]?.result;
      return value === null ? undefined : ProjectSchema.parse(value);
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async create(inputValue: unknown, requestId: string): Promise<Project> {
    const parsed = CreateProjectSchema.safeParse(inputValue);
    if (!parsed.success) throw new ProjectStoreError('invalid_input', 422);
    const input: CreateProjectInput = parsed.data;
    try {
      assertNoCredentialMaterial(input);
    } catch (error) {
      if (error instanceof AgentProfileStoreError)
        throw new ProjectStoreError('invalid_input', 422);
      throw error;
    }
    const id = `prj_${randomUUID().replaceAll('-', '')}`;
    const fingerprint = this.fingerprint('project.created', input);
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.create_project($1,$2,$3,$4,$5,$6,$7,$8) AS result',
        [
          id,
          input.key,
          input.name,
          input.objective,
          input.priority,
          requestId,
          this.keyVersion,
          fingerprint,
        ],
      );
      return ProjectSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async update(id: string, inputValue: unknown, requestId: string): Promise<Project> {
    const parsed = UpdateProjectSchema.safeParse(inputValue);
    if (!parsed.success) throw new ProjectStoreError('invalid_input', 422);
    const input: UpdateProjectInput = parsed.data;
    try {
      assertNoCredentialMaterial({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.objective === undefined ? {} : { objective: input.objective }),
      });
    } catch (error) {
      if (error instanceof AgentProfileStoreError)
        throw new ProjectStoreError('invalid_input', 422);
      throw error;
    }
    const fingerprint = this.fingerprint('project.updated', { projectId: id, input });
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.update_project($1,$2,$3,$4,$5,$6,$7,$8) AS result',
        [
          id,
          input.expectedRevision,
          input.name ?? null,
          input.objective ?? null,
          input.priority ?? null,
          requestId,
          this.keyVersion,
          fingerprint,
        ],
      );
      return ProjectSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async archive(id: string, inputValue: unknown, requestId: string): Promise<Project> {
    const parsed = ArchiveProjectSchema.safeParse(inputValue);
    if (!parsed.success) throw new ProjectStoreError('invalid_input', 422);
    const input = parsed.data;
    const fingerprint = this.fingerprint('project.archived', { projectId: id, input });
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.archive_project($1,$2,$3,$4,$5) AS result',
        [id, input.expectedRevision, requestId, this.keyVersion, fingerprint],
      );
      return ProjectSchema.parse(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  private fingerprint(operation: string, value: unknown): Buffer {
    return createHmac('sha256', this.signingKey)
      .update('omnis-project-management-idempotency:v1\0')
      .update(JSON.stringify({ operation, input: value }))
      .digest();
  }
}

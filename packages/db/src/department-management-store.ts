import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Department, CreateDepartmentInput } from '@omnis/contracts';
import { inTransaction } from './database.ts';
import { AgentProfileStoreError, assertNoCredentialMaterial } from './agent-profile-store.ts';

type DepartmentRow = {
  id: string;
  slug: string;
  name: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type DepartmentStoreErrorCode =
  'not_found' | 'conflict' | 'invalid_transition' | 'invalid_input' | 'limit';

export class DepartmentStoreError extends Error {
  readonly code: DepartmentStoreErrorCode;
  readonly statusCode: 404 | 409 | 422 | 503;

  constructor(code: DepartmentStoreErrorCode, message: string, statusCode: 404 | 409 | 422 | 503) {
    super(message);
    this.name = 'DepartmentStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const departmentColumns = `id, slug, name, archived_at, created_at, updated_at`;

function assertSafeDepartmentInput(input: CreateDepartmentInput): void {
  try {
    assertNoCredentialMaterial(input);
  } catch (error) {
    if (error instanceof AgentProfileStoreError) {
      throw new DepartmentStoreError('invalid_input', 'Department input is invalid.', 422);
    }
    throw error;
  }
}

function mapDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function auditId(): string {
  return `dpa_${randomUUID().replaceAll('-', '')}`;
}

async function recordAudit(
  client: PoolClient,
  departmentId: string,
  action: 'created' | 'updated' | 'archived',
  requestId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO omnis.department_management_audit
       (id, department_id, actor_id, action, request_id)
     VALUES ($1, $2, 'owner', $3, $4)`,
    [auditId(), departmentId, action, requestId],
  );
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === '23505';
}

export class PostgresDepartmentManagementStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async list(includeArchived = false): Promise<{ departments: Department[]; total: number }> {
    const result = await this.pool.query<DepartmentRow>(
      `SELECT ${departmentColumns} FROM omnis.departments
        WHERE $1::boolean OR archived_at IS NULL
        ORDER BY lower(name), id LIMIT 501`,
      [includeArchived],
    );
    if (result.rows.length > 500) {
      throw new DepartmentStoreError('limit', 'Department directory limit exceeded.', 503);
    }
    const departments = result.rows.map(mapDepartment);
    return { departments, total: departments.length };
  }

  async create(input: CreateDepartmentInput, requestId: string): Promise<Department> {
    assertSafeDepartmentInput(input);
    return inTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['716824201311']);
      const count = await client.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM omnis.departments',
      );
      if (Number(count.rows[0]?.total ?? '0') >= 500) {
        throw new DepartmentStoreError('limit', 'Department directory limit exceeded.', 422);
      }
      const id = `dep_${randomUUID().replaceAll('-', '')}`;
      const result = await client.query<DepartmentRow>(
        `INSERT INTO omnis.departments (id, slug, name)
         VALUES ($1, $2, $3) RETURNING ${departmentColumns}`,
        [id, input.slug, input.name],
      );
      await recordAudit(client, id, 'created', requestId);
      return mapDepartment(result.rows[0]!);
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new DepartmentStoreError(
          'conflict',
          'A department with this slug already exists.',
          409,
        );
      }
      throw error;
    });
  }

  async update(id: string, input: CreateDepartmentInput, requestId: string): Promise<Department> {
    assertSafeDepartmentInput(input);
    return inTransaction(this.pool, async (client) => {
      const current = await this.lockDepartment(client, id);
      if (!current) throw new DepartmentStoreError('not_found', 'Department was not found.', 404);
      if (current.archived_at) {
        throw new DepartmentStoreError(
          'invalid_transition',
          'Archived departments cannot be changed.',
          409,
        );
      }
      const result = await client.query<DepartmentRow>(
        `UPDATE omnis.departments SET slug = $2, name = $3, updated_at = now()
          WHERE id = $1 RETURNING ${departmentColumns}`,
        [id, input.slug, input.name],
      );
      await recordAudit(client, id, 'updated', requestId);
      return mapDepartment(result.rows[0]!);
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new DepartmentStoreError(
          'conflict',
          'A department with this slug already exists.',
          409,
        );
      }
      throw error;
    });
  }

  async archive(id: string, requestId: string): Promise<Department> {
    try {
      const result = await this.pool.query<DepartmentRow>(
        `SELECT * FROM omnis.archive_department($1, $2)`,
        [id, requestId],
      );
      if (!result.rows[0])
        throw new DepartmentStoreError('not_found', 'Department was not found.', 404);
      return mapDepartment(result.rows[0]);
    } catch (error) {
      if (error instanceof DepartmentStoreError) throw error;
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'P0002')
          throw new DepartmentStoreError('not_found', 'Department was not found.', 404);
        if (error.code === '23514')
          throw new DepartmentStoreError(
            'invalid_transition',
            'A department assigned to an agent cannot be archived.',
            409,
          );
      }
      throw error;
    }
  }

  private async lockDepartment(client: PoolClient, id: string): Promise<DepartmentRow | undefined> {
    const result = await client.query<DepartmentRow>(
      `SELECT ${departmentColumns} FROM omnis.departments WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0];
  }
}

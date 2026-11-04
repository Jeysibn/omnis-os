import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { Department, Project, ProjectListResponse } from '@omnis/contracts';
import { inTransaction } from './database.ts';
import { PostgresDepartmentManagementStore } from './department-management-store.ts';
import type { PostgresAgentLifecycleStore } from './agent-lifecycle-store.ts';
import type { PostgresProjectManagementStore } from './project-management-store.ts';

export type AuthorizationStatus = 'pending' | 'authorized' | 'denied' | 'revoked' | 'expired';
export type RuntimeAuthorizationRecord = {
  id: string;
  requestingActor: 'owner';
  runtimeId: 'mock';
  operation: 'execute_task';
  taskId: string;
  capabilities: ['mock.execute'];
  scope: { kind: 'task'; taskId: string };
  status: AuthorizationStatus;
  policyVersion: string;
  correlationId: string;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: 'owner' | null;
  revokedAt: string | null;
  revokedBy: 'owner' | null;
  consumedAt: string | null;
  consumedRunId: string | null;
};

export interface RuntimeAuthorizationReader {
  get(id: string): Promise<RuntimeAuthorizationRecord | undefined>;
  getForRun(runId: string): Promise<RuntimeAuthorizationRecord | undefined>;
  recordEnforcementDenied(
    authorizationId: string,
    taskId: string,
    reasonCode: string,
  ): Promise<void>;
}

type AuthorizationRow = QueryResultRow & {
  id: string;
  requesting_actor: 'owner';
  runtime_id: 'mock';
  operation: 'execute_task';
  task_id: string;
  capabilities: ['mock.execute'];
  scope: { kind: 'task'; taskId: string };
  status: AuthorizationStatus;
  policy_version: string;
  correlation_id: string;
  expires_at: Date | string;
  created_at: Date | string;
  decided_at: Date | string | null;
  decided_by: 'owner' | null;
  revoked_at: Date | string | null;
  revoked_by: 'owner' | null;
  consumed_at: Date | string | null;
  consumed_run_id: string | null;
};

const selectAuthorization = `
  SELECT id, requesting_actor, runtime_id, operation, task_id, capabilities, scope,
    CASE WHEN status IN ('pending', 'authorized') AND expires_at <= now() THEN 'expired'
      ELSE status END AS status,
    policy_version, correlation_id, expires_at, created_at, decided_at, decided_by,
    revoked_at, revoked_by, consumed_at, consumed_run_id
  FROM omnis.runtime_authorizations`;

/**
 * Separates trusted owner lifecycle writes from restricted worker reads. The
 * authorizer pool must use the dedicated omnis_authorizer login; it is never
 * exposed to adapters or sandbox processes.
 */
export class PostgresAuthorizationStore {
  private readonly runtime: Pool;
  private readonly authorizer: Pool;
  private readonly departmentManagement: PostgresDepartmentManagementStore;
  readonly agentLifecycle: PostgresAgentLifecycleStore | undefined;
  readonly projectManagement: PostgresProjectManagementStore | undefined;

  constructor(
    runtime: Pool,
    authorizer: Pool,
    options: {
      agentLifecycle?: PostgresAgentLifecycleStore;
      projectManagement?: PostgresProjectManagementStore;
    } = {},
  ) {
    this.runtime = runtime;
    this.authorizer = authorizer;
    this.departmentManagement = new PostgresDepartmentManagementStore(authorizer);
    this.agentLifecycle = options.agentLifecycle;
    this.projectManagement = options.projectManagement;
  }

  listProjects(): Promise<ProjectListResponse> {
    return this.requireProjectManagement().list();
  }

  getProject(id: string): Promise<Project | undefined> {
    return this.requireProjectManagement().get(id);
  }

  createProject(input: unknown, requestId: string): Promise<Project> {
    return this.requireProjectManagement().create(input, requestId);
  }

  updateProject(id: string, input: unknown, requestId: string): Promise<Project> {
    return this.requireProjectManagement().update(id, input, requestId);
  }

  archiveProject(id: string, input: unknown, requestId: string): Promise<Project> {
    return this.requireProjectManagement().archive(id, input, requestId);
  }

  private requireProjectManagement(): PostgresProjectManagementStore {
    if (!this.projectManagement) throw new Error('Project management store is unavailable.');
    return this.projectManagement;
  }

  listDepartments(includeArchived = false): Promise<{ departments: Department[]; total: number }> {
    return this.departmentManagement.list(includeArchived);
  }

  createDepartment(input: { slug: string; name: string }, requestId: string): Promise<Department> {
    return this.departmentManagement.create(input, requestId);
  }

  updateDepartment(
    id: string,
    input: { slug: string; name: string },
    requestId: string,
  ): Promise<Department> {
    return this.departmentManagement.update(id, input, requestId);
  }

  archiveDepartment(id: string, requestId: string): Promise<Department> {
    return this.departmentManagement.archive(id, requestId);
  }

  async request(
    taskId: string,
    actor: 'owner',
    correlationId: string = randomUUID(),
  ): Promise<RuntimeAuthorizationRecord> {
    return inTransaction(this.authorizer, async (client) => {
      const prior = await client.query<AuthorizationRow>(
        `${selectAuthorization} WHERE correlation_id=$1 FOR UPDATE`,
        [correlationId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].task_id !== taskId) {
          throw new Error('Authorization idempotency key belongs to a different task.');
        }
        return mapAuthorization(prior.rows[0]);
      }

      const task = await client.query('SELECT 1 FROM omnis.tasks WHERE id = $1', [taskId]);
      if (!task.rowCount) throw new Error('Authorization task was not found.');
      const result = await client.query<AuthorizationRow>(
        `INSERT INTO omnis.runtime_authorizations (
           id, requesting_actor, runtime_id, operation, task_id, capabilities, scope,
           policy_version, correlation_id, expires_at
         ) VALUES ($1, $2, 'mock', 'execute_task', $3, '["mock.execute"]',
           jsonb_build_object('kind','task','taskId',$3::text), 'r1g4-mock-v1', $4,
           now() + interval '20 minutes')
         ON CONFLICT (correlation_id) DO NOTHING
         RETURNING *`,
        [randomUUID(), actor, taskId, correlationId],
      );
      if (!result.rows[0]) {
        const raced = await client.query<AuthorizationRow>(
          `${selectAuthorization} WHERE correlation_id=$1`,
          [correlationId],
        );
        if (!raced.rows[0] || raced.rows[0].task_id !== taskId) {
          throw new Error('Authorization idempotency key belongs to a different task.');
        }
        return mapAuthorization(raced.rows[0]);
      }
      await appendAudit(client, {
        authorizationId: result.rows[0].id,
        taskId,
        eventType: 'authorization.requested',
        actorId: actor,
        effectiveIdentity: 'human:owner',
        correlationId,
        outcome: 'recorded',
      });
      return mapAuthorization(result.rows[0]);
    });
  }

  async decide(
    id: string,
    actor: 'owner',
    decision: 'approve' | 'deny',
  ): Promise<RuntimeAuthorizationRecord> {
    return inTransaction(this.authorizer, async (client) => {
      const locked = await client.query<AuthorizationRow>(
        `${selectAuthorization} WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = locked.rows[0];
      const requestedStatus = decision === 'approve' ? 'authorized' : 'denied';
      if (current?.status === requestedStatus) return mapAuthorization(current);
      if (
        !current ||
        current.status !== 'pending' ||
        new Date(current.expires_at).getTime() <= Date.now()
      ) {
        throw new Error('Authorization is missing, expired, or already decided.');
      }
      const status = requestedStatus;
      const result = await client.query<AuthorizationRow>(
        `UPDATE omnis.runtime_authorizations
            SET status = $2, decided_at = now(), decided_by = $3
          WHERE id = $1 AND status = 'pending' AND expires_at > now()
          RETURNING *`,
        [id, status, actor],
      );
      if (!result.rows[0]) throw new Error('Authorization decision lost a concurrent race.');
      await appendAudit(client, {
        authorizationId: id,
        taskId: current.task_id,
        eventType: decision === 'approve' ? 'authorization.approved' : 'authorization.denied',
        actorId: actor,
        effectiveIdentity: 'human:owner',
        correlationId: current.correlation_id,
        outcome: decision === 'approve' ? 'allowed' : 'denied',
        reasonCode: decision === 'deny' ? 'owner_denied' : null,
      });
      return mapAuthorization(result.rows[0]);
    });
  }

  async revoke(id: string, actor: 'owner'): Promise<RuntimeAuthorizationRecord> {
    let revoked = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.authorizer.query<{ outcome: string }>(
        'SELECT omnis.revoke_run_authorization($1, $2) AS outcome',
        [id, actor],
      );
      const outcome = result.rows[0]?.outcome;
      if (outcome === 'revoked') {
        revoked = true;
        break;
      }
      if (outcome !== 'retry_consumed' && outcome !== 'retry_unconsumed') break;
    }
    const updated = await this.get(id);
    if (!revoked && updated?.status !== 'revoked') {
      throw new Error('Only an active authorization can be revoked.');
    }
    if (!updated) throw new Error('Revoked authorization could not be reloaded.');
    return updated;
  }

  async get(id: string): Promise<RuntimeAuthorizationRecord | undefined> {
    const result = await this.authorizer.query<AuthorizationRow>(
      `${selectAuthorization} WHERE id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (row?.status === 'expired') {
      await this.authorizer.query(
        `INSERT INTO omnis.authorization_audit (
           authorization_id, task_id, event_type, actor_id, effective_identity,
           capability, correlation_id, outcome, reason_code
         ) SELECT a.id, a.task_id, 'authorization.expired', 'service:omnis-authorizer',
           'service:omnis-authorizer', 'mock.execute', a.correlation_id, 'recorded', 'time_elapsed'
           FROM omnis.runtime_authorizations a
          WHERE a.id=$1 AND a.status IN ('pending','authorized') AND a.expires_at<=now()
         ON CONFLICT (authorization_id) WHERE event_type = 'authorization.expired' DO NOTHING`,
        [id],
      );
    }
    return row ? mapAuthorization(row) : undefined;
  }

  async recordExpiredAuthorizations(): Promise<number> {
    const result = await this.authorizer.query(
      `INSERT INTO omnis.authorization_audit (
         authorization_id, task_id, event_type, actor_id, effective_identity,
         capability, correlation_id, outcome, reason_code
       ) SELECT a.id, a.task_id, 'authorization.expired', 'service:omnis-authorizer',
         'service:omnis-authorizer', 'mock.execute', a.correlation_id, 'recorded', 'time_elapsed'
         FROM omnis.runtime_authorizations AS a
        WHERE a.status IN ('pending', 'authorized') AND a.expires_at <= now()
       ON CONFLICT (authorization_id) WHERE event_type = 'authorization.expired' DO NOTHING`,
    );
    return result.rowCount ?? 0;
  }

  async recordEnforcementDenied(
    authorizationId: string,
    taskId: string,
    reasonCode: string,
  ): Promise<void> {
    const result = await this.authorizer.query<{ recorded: boolean }>(
      'SELECT omnis.append_runtime_admission_denial($1, $2, $3) AS recorded',
      [authorizationId, taskId, reasonCode],
    );
    if (!result.rows[0]?.recorded) throw new Error('Runtime denial audit was not recorded.');
  }

  async getForRun(runId: string): Promise<RuntimeAuthorizationRecord | undefined> {
    const result = await this.authorizer.query<AuthorizationRow>(
      `${selectAuthorization} WHERE consumed_run_id=$1`,
      [runId],
    );
    return result.rows[0] ? mapAuthorization(result.rows[0]) : undefined;
  }

  async getAudit(id: string) {
    const result = await this.authorizer.query(
      `SELECT id, authorization_id AS "authorizationId", task_id AS "taskId",
         run_id AS "runId", event_type AS "eventType", actor_id AS "actorId",
         effective_identity AS "effectiveIdentity", capability, correlation_id AS "correlationId",
         outcome, reason_code AS "reasonCode", occurred_at AS "occurredAt"
       FROM omnis.authorization_audit WHERE authorization_id=$1 ORDER BY occurred_at, id`,
      [id],
    );
    return result.rows;
  }

  async isActive(id: string, taskId: string, runId: string): Promise<boolean> {
    const result = await this.runtime.query(
      `SELECT 1 FROM omnis.runtime_authorizations
        WHERE id=$1 AND task_id=$2 AND consumed_run_id=$3 AND status='authorized'
          AND expires_at > now() AND revoked_at IS NULL`,
      [id, taskId, runId],
    );
    return Boolean(result.rowCount);
  }
}

/** Runtime-only authorization reads and denial provenance; no approval/revoke methods. */
export class PostgresRuntimeAuthorizationReader implements RuntimeAuthorizationReader {
  private readonly runtime: Pool;

  constructor(runtime: Pool) {
    this.runtime = runtime;
  }

  async get(id: string): Promise<RuntimeAuthorizationRecord | undefined> {
    const result = await this.runtime.query<AuthorizationRow>(
      `${selectAuthorization} WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? mapAuthorization(result.rows[0]) : undefined;
  }

  async getForRun(runId: string): Promise<RuntimeAuthorizationRecord | undefined> {
    const result = await this.runtime.query<AuthorizationRow>(
      `${selectAuthorization} WHERE consumed_run_id=$1`,
      [runId],
    );
    return result.rows[0] ? mapAuthorization(result.rows[0]) : undefined;
  }

  async recordEnforcementDenied(
    authorizationId: string,
    taskId: string,
    reasonCode: string,
  ): Promise<void> {
    const result = await this.runtime.query<{ recorded: boolean }>(
      'SELECT omnis.append_runtime_admission_denial($1, $2, $3) AS recorded',
      [authorizationId, taskId, reasonCode],
    );
    if (!result.rows[0]?.recorded) throw new Error('Runtime denial audit was not recorded.');
  }
}

async function appendAudit(
  client: Pick<PoolClient, 'query'>,
  input: {
    authorizationId: string;
    taskId: string;
    runId?: string | null;
    eventType: string;
    actorId: string;
    effectiveIdentity: string;
    correlationId: string;
    outcome: 'allowed' | 'denied' | 'recorded';
    reasonCode?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO omnis.authorization_audit (
       authorization_id, task_id, run_id, event_type, actor_id,
       effective_identity, capability, correlation_id, outcome, reason_code
     ) VALUES ($1,$2,$3,$4,$5,$6,'mock.execute',$7,$8,$9)`,
    [
      input.authorizationId,
      input.taskId,
      input.runId ?? null,
      input.eventType,
      input.actorId,
      input.effectiveIdentity,
      input.correlationId,
      input.outcome,
      input.reasonCode ?? null,
    ],
  );
}

function mapAuthorization(row: AuthorizationRow): RuntimeAuthorizationRecord {
  const expiresAt = new Date(row.expires_at).toISOString();
  return {
    id: row.id,
    requestingActor: row.requesting_actor,
    runtimeId: row.runtime_id,
    operation: row.operation,
    taskId: row.task_id,
    capabilities: row.capabilities,
    scope: row.scope,
    status: row.status,
    policyVersion: row.policy_version,
    correlationId: row.correlation_id,
    expiresAt,
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    decidedBy: row.decided_by,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revokedBy: row.revoked_by,
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    consumedRunId: row.consumed_run_id,
  };
}

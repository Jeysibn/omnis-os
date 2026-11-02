import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { inTransaction } from './database.ts';

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

  constructor(runtime: Pool, authorizer: Pool) {
    this.runtime = runtime;
    this.authorizer = authorizer;
  }

  async request(
    taskId: string,
    actor: 'owner',
    correlationId = randomUUID(),
  ): Promise<RuntimeAuthorizationRecord> {
    const id = randomUUID();
    return inTransaction(this.authorizer, async (client) => {
      const task = await client.query('SELECT 1 FROM omnis.tasks WHERE id = $1', [taskId]);
      if (!task.rowCount) throw new Error('Authorization task was not found.');
      const result = await client.query<AuthorizationRow>(
        `INSERT INTO omnis.runtime_authorizations (
           id, requesting_actor, runtime_id, operation, task_id, capabilities, scope,
           policy_version, correlation_id, expires_at
         ) VALUES ($1, $2, 'mock', 'execute_task', $3, '["mock.execute"]',
           jsonb_build_object('kind','task','taskId',$3::text), 'r1g4-mock-v1', $4,
           now() + interval '20 minutes')
         RETURNING *`,
        [id, actor, taskId, correlationId],
      );
      await appendAudit(client, {
        authorizationId: id,
        taskId,
        eventType: 'authorization.requested',
        actorId: actor,
        effectiveIdentity: 'human:owner',
        correlationId,
        outcome: 'recorded',
      });
      return mapAuthorization(result.rows[0]!);
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
      if (
        !current ||
        current.status !== 'pending' ||
        new Date(current.expires_at).getTime() <= Date.now()
      ) {
        throw new Error('Authorization is missing, expired, or already decided.');
      }
      const status = decision === 'approve' ? 'authorized' : 'denied';
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
    const result = await this.authorizer.query<{ allowed: boolean }>(
      'SELECT omnis.revoke_run_authorization($1, $2) AS allowed',
      [id, actor],
    );
    if (!result.rows[0]?.allowed) throw new Error('Only an active authorization can be revoked.');
    const updated = await this.get(id);
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
           id, authorization_id, task_id, event_type, actor_id, effective_identity,
           capability, correlation_id, outcome, reason_code
         ) SELECT $1, a.id, a.task_id, 'authorization.expired', 'service:omnis-authorizer',
           'service:omnis-worker', 'mock.execute', a.correlation_id, 'recorded', 'time_elapsed'
           FROM omnis.runtime_authorizations a
          WHERE a.id=$2 AND a.status IN ('pending','authorized') AND a.expires_at<=now()
         ON CONFLICT (id) DO NOTHING`,
        [`audit-expired-${id}`, id],
      );
    }
    return row ? mapAuthorization(row) : undefined;
  }

  async recordEnforcementDenied(
    authorizationId: string,
    taskId: string,
    actor: 'owner',
    reasonCode: string,
  ): Promise<void> {
    await this.authorizer.query(
      `INSERT INTO omnis.authorization_audit (
         id, authorization_id, task_id, event_type, actor_id, effective_identity,
         capability, correlation_id, outcome, reason_code
       ) SELECT $1,
           CASE WHEN EXISTS (SELECT 1 FROM omnis.runtime_authorizations a WHERE a.id=$2 AND a.task_id=$3)
             THEN $2 ELSE NULL END,
           CASE WHEN EXISTS (SELECT 1 FROM omnis.tasks t WHERE t.id=$3) THEN $3 ELSE NULL END,
           'authorization.enforcement_denied',$4,'service:omnis-worker','mock.execute',
           COALESCE((SELECT a.correlation_id FROM omnis.runtime_authorizations a WHERE a.id=$2 AND a.task_id=$3),$5),
           'denied',$6`,
      [randomUUID(), authorizationId, taskId, actor, randomUUID(), reasonCode],
    );
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

export async function appendAuthorizationAudit(
  client: Pick<PoolClient, 'query'>,
  input: {
    authorizationId: string;
    taskId: string;
    runId: string | null;
    eventType: string;
    actorId: string;
    effectiveIdentity: string;
    correlationId: string;
    outcome: 'allowed' | 'denied' | 'recorded';
    reasonCode?: string | null;
  },
): Promise<void> {
  await appendAudit(client, input);
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
       id, authorization_id, task_id, run_id, event_type, actor_id,
       effective_identity, capability, correlation_id, outcome, reason_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'mock.execute',$8,$9,$10)`,
    [
      randomUUID(),
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

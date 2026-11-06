import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  ConnectorAuthorizationDecisionSchema,
  ConnectorAuthorizationRequestSchema,
  ConnectorAuthorizationSchema,
  ConnectorExecutionAttemptSchema,
  type ConnectorAuthorization,
  type ConnectorAuthorizationRequest,
  type ConnectorExecutionAttempt,
} from '@omnis/contracts/connector-authorization';
import { inTransaction } from './database.ts';

export type ConnectorAuthorizationStoreErrorCode =
  'invalid_input' | 'not_found' | 'conflict' | 'invalid_transition';

export class ConnectorAuthorizationStoreError extends Error {
  readonly code: ConnectorAuthorizationStoreErrorCode;
  readonly statusCode: 400 | 404 | 409 | 422;

  constructor(
    code: ConnectorAuthorizationStoreErrorCode,
    message: string,
    statusCode: 400 | 404 | 409 | 422,
  ) {
    super(message);
    this.name = 'ConnectorAuthorizationStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

type AuthorizationRow = QueryResultRow & {
  id: string;
  request_id: string;
  request_fingerprint: Buffer;
  correlation_id: string;
  requesting_actor: 'owner';
  project_id: string;
  project_revision: number;
  task_id: string;
  task_revision: number;
  agent_id: string;
  profile_version: number;
  connector_id: 'synthetic.codex.fixture';
  connector_version: '0.0.0-synthetic.1';
  provider_id: 'synthetic';
  model_id: 'synthetic-text-only-v1';
  operation: 'connector.respond';
  capabilities: [];
  limits: ConnectorAuthorizationRequest['limits'];
  prompt_digest: string;
  status: 'pending' | 'authorized' | 'denied' | 'revoked' | 'expired';
  policy_version: 'r1p1-synthetic-connector-v1';
  created_at: Date | string;
  consented_at: Date | string | null;
  decided_at: Date | string | null;
  decided_by: 'owner' | null;
  revoked_at: Date | string | null;
  revoked_by: 'owner' | null;
  revocation_generation: number;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  consumed_request_id: string | null;
};

type AttemptRow = QueryResultRow & {
  id: string;
  authorization_id: string;
  request_id: string;
  status: 'admitted';
  synthetic: true;
  created_at: Date | string;
};

const selectAuthorization = `
  SELECT id, request_id, request_fingerprint, correlation_id, requesting_actor,
    project_id, project_revision, task_id, task_revision, agent_id, profile_version,
    connector_id, connector_version, provider_id, model_id, operation, capabilities,
    limits, prompt_digest,
    CASE WHEN status IN ('pending', 'authorized') AND expires_at <= now()
      THEN 'expired' ELSE status END AS status,
    policy_version, created_at, consented_at, decided_at, decided_by, revoked_at,
    revoked_by, revocation_generation, expires_at, consumed_at, consumed_request_id
  FROM omnis.connector_authorizations`;

/** Uses only the dedicated authorizer pool. No runtime or launcher pool is accepted. */
export class PostgresConnectorAuthorizationStore {
  private readonly authorizer: Pool;
  private readonly grantTtlSeconds: number;

  constructor(authorizer: Pool, options: { grantTtlSeconds?: number } = {}) {
    this.authorizer = authorizer;
    this.grantTtlSeconds = options.grantTtlSeconds ?? 600;
    if (
      !Number.isSafeInteger(this.grantTtlSeconds) ||
      this.grantTtlSeconds < 1 ||
      this.grantTtlSeconds > 600
    ) {
      throw new Error('Connector authorization grant TTL must be between 1 and 600 seconds.');
    }
  }

  async request(input: unknown, requestId: string): Promise<ConnectorAuthorization> {
    const parsed = ConnectorAuthorizationRequestSchema.safeParse(input);
    if (!parsed.success || !isUuid(requestId)) {
      throw new ConnectorAuthorizationStoreError(
        'invalid_input',
        'Connector authorization request is invalid.',
        400,
      );
    }
    const request = parsed.data;
    const fingerprint = fingerprintRequest(request);

    return inTransaction(this.authorizer, async (client) => {
      await lockIdempotencyKey(client, 'grant', requestId);
      const prior = await client.query<AuthorizationRow>(
        `${selectAuthorization} WHERE request_id = $1 FOR UPDATE`,
        [requestId],
      );
      if (prior.rows[0]) {
        if (!sameFingerprint(prior.rows[0].request_fingerprint, fingerprint)) {
          throw conflict('Connector authorization idempotency key has different content.');
        }
        return mapAuthorization(prior.rows[0]);
      }

      if (!(await contextMatches(client, request))) {
        throw conflict('The project, task, or immutable profile context has changed.');
      }

      const result = await client.query<AuthorizationRow>(
        `INSERT INTO omnis.connector_authorizations (
           id, request_id, request_fingerprint, correlation_id, requesting_actor,
           project_id, project_revision, task_id, task_revision, agent_id, profile_version,
           connector_id, connector_version, provider_id, model_id, operation, capabilities,
           limits, prompt_digest, policy_version, expires_at
         ) VALUES (
           $1, $2, $3, $4, 'owner', $5, $6, $7, $8, $9, $10,
           'synthetic.codex.fixture', '0.0.0-synthetic.1', 'synthetic',
           'synthetic-text-only-v1', 'connector.respond', '[]'::jsonb,
           $11::jsonb, $12, 'r1p1-synthetic-connector-v1',
           now() + ($13::integer * interval '1 second')
         ) RETURNING *`,
        [
          randomUUID(),
          requestId,
          fingerprint,
          randomUUID(),
          request.projectId,
          request.projectRevision,
          request.taskId,
          request.taskRevision,
          request.agentId,
          request.profileVersion,
          JSON.stringify(request.limits),
          request.promptDigest,
          this.grantTtlSeconds,
        ],
      );
      const row = requiredRow(result.rows[0]);
      await appendAudit(client, row, {
        requestId,
        eventType: 'connector.authorization_requested',
        actorId: 'owner',
        effectiveIdentity: 'human:owner',
        outcome: 'recorded',
      });
      return mapAuthorization(row);
    });
  }

  async get(id: string): Promise<ConnectorAuthorization | undefined> {
    if (!isUuid(id)) {
      throw new ConnectorAuthorizationStoreError(
        'invalid_input',
        'Connector authorization ID is invalid.',
        400,
      );
    }
    const result = await this.authorizer.query<AuthorizationRow>(
      `${selectAuthorization} WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapAuthorization(result.rows[0]) : undefined;
  }

  async decide(id: string, actor: 'owner', input: unknown): Promise<ConnectorAuthorization> {
    const parsed = ConnectorAuthorizationDecisionSchema.safeParse(input);
    if (!isUuid(id) || !parsed.success) {
      throw new ConnectorAuthorizationStoreError(
        'invalid_input',
        'Connector authorization decision is invalid.',
        400,
      );
    }

    return inTransaction(this.authorizer, async (client) => {
      const result = await client.query<AuthorizationRow>(
        `${selectAuthorization} WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = result.rows[0];
      if (!current) throw notFound();
      if (parsed.data.decision === 'approve') {
        if (parsed.data.promptDigestConfirmation !== current.prompt_digest) {
          throw conflict('Owner confirmation does not match the rendered request digest.');
        }
        if (current.status === 'authorized') return mapAuthorization(current);
      } else if (current.status === 'denied') {
        return mapAuthorization(current);
      }

      if (current.status !== 'pending' || toEpoch(current.expires_at) <= Date.now()) {
        throw invalidTransition(
          'Only a pending, unexpired connector authorization can be decided.',
        );
      }
      if (!(await contextMatches(client, mapRequest(current)))) {
        throw conflict('The project, task, or immutable profile context has changed.');
      }

      const decision = parsed.data.decision;
      const updated = await client.query<AuthorizationRow>(
        `UPDATE omnis.connector_authorizations
            SET status = $2,
                consented_at = CASE WHEN $2 = 'authorized' THEN now() ELSE NULL END,
                decided_at = now(), decided_by = $3
          WHERE id = $1
          RETURNING *`,
        [id, decision === 'approve' ? 'authorized' : 'denied', actor],
      );
      const row = requiredRow(updated.rows[0]);
      await appendAudit(client, row, {
        requestId: row.request_id,
        eventType:
          decision === 'approve'
            ? 'connector.authorization_approved'
            : 'connector.authorization_denied',
        actorId: actor,
        effectiveIdentity: 'human:owner',
        outcome: decision === 'approve' ? 'allowed' : 'denied',
      });
      return mapAuthorization(row);
    });
  }

  async revoke(id: string, actor: 'owner'): Promise<ConnectorAuthorization> {
    if (!isUuid(id)) {
      throw new ConnectorAuthorizationStoreError(
        'invalid_input',
        'Connector authorization ID is invalid.',
        400,
      );
    }
    return inTransaction(this.authorizer, async (client) => {
      const result = await client.query<AuthorizationRow>(
        `${selectAuthorization} WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = result.rows[0];
      if (!current) throw notFound();
      if (current.status === 'revoked') return mapAuthorization(current);
      if (current.status !== 'authorized' || toEpoch(current.expires_at) <= Date.now()) {
        throw invalidTransition('Only an active connector authorization can be revoked.');
      }
      const updated = await client.query<AuthorizationRow>(
        `UPDATE omnis.connector_authorizations
            SET status = 'revoked', revoked_at = now(), revoked_by = $2,
                revocation_generation = 1
          WHERE id = $1
          RETURNING *`,
        [id, actor],
      );
      const row = requiredRow(updated.rows[0]);
      await appendAudit(client, row, {
        requestId: row.request_id,
        eventType: 'connector.authorization_revoked',
        actorId: actor,
        effectiveIdentity: 'human:owner',
        outcome: 'recorded',
      });
      return mapAuthorization(row);
    });
  }

  /** Synthetic test/admission record only; no worker or provider runtime consumes it. */
  async consume(
    authorizationId: string,
    input: unknown,
    requestId: string,
  ): Promise<ConnectorExecutionAttempt> {
    const parsed = ConnectorAuthorizationRequestSchema.safeParse(input);
    if (!isUuid(authorizationId) || !parsed.success || !isUuid(requestId)) {
      throw new ConnectorAuthorizationStoreError(
        'invalid_input',
        'Connector consumption request is invalid.',
        400,
      );
    }

    return inTransaction(this.authorizer, async (client) => {
      await lockIdempotencyKey(client, 'attempt', requestId);
      const existing = await client.query<AttemptRow>(
        `SELECT id, authorization_id, request_id, status, synthetic, created_at
           FROM omnis.connector_execution_attempts WHERE request_id = $1`,
        [requestId],
      );
      if (existing.rows[0]) {
        const attempt = mapAttempt(existing.rows[0]);
        if (attempt.authorizationId !== authorizationId) {
          throw conflict('Connector attempt idempotency key belongs to another grant.');
        }
        const grant = await client.query<AuthorizationRow>(`${selectAuthorization} WHERE id = $1`, [
          authorizationId,
        ]);
        if (
          !grant.rows[0] ||
          !sameFingerprint(grant.rows[0].request_fingerprint, fingerprintRequest(parsed.data))
        ) {
          throw conflict('Connector attempt content does not match its original grant.');
        }
        return attempt;
      }

      const result = await client.query<AuthorizationRow>(
        `${selectAuthorization} WHERE id = $1 FOR UPDATE`,
        [authorizationId],
      );
      const current = result.rows[0];
      if (!current) throw notFound();
      if (!sameFingerprint(current.request_fingerprint, fingerprintRequest(parsed.data))) {
        throw conflict('Connector request does not match the owner-approved grant.');
      }
      if (
        current.status !== 'authorized' ||
        current.consented_at === null ||
        current.revocation_generation !== 0 ||
        current.consumed_at !== null ||
        current.expires_at === null ||
        toEpoch(current.expires_at) <= Date.now()
      ) {
        throw invalidTransition(
          'Only an active, unexpired, unconsumed connector grant can be used.',
        );
      }
      if (!(await contextMatches(client, parsed.data))) {
        throw conflict('The project, task, or immutable profile context has changed.');
      }

      const attemptId = randomUUID();
      const inserted = await client.query<AttemptRow>(
        `INSERT INTO omnis.connector_execution_attempts
           (id, authorization_id, request_id, status, synthetic)
         VALUES ($1, $2, $3, 'admitted', TRUE)
         RETURNING id, authorization_id, request_id, status, synthetic, created_at`,
        [attemptId, authorizationId, requestId],
      );
      const attempt = mapAttempt(requiredRow(inserted.rows[0]));
      const updated = await client.query<AuthorizationRow>(
        `UPDATE omnis.connector_authorizations
            SET consumed_at = now(), consumed_request_id = $2
          WHERE id = $1 AND status = 'authorized' AND consumed_at IS NULL
          RETURNING *`,
        [authorizationId, requestId],
      );
      const row = requiredRow(updated.rows[0]);
      await appendAudit(client, row, {
        requestId,
        attemptId,
        eventType: 'connector.authorization_consumed',
        actorId: 'service:omnis-authorizer',
        effectiveIdentity: 'service:omnis-authorizer',
        outcome: 'allowed',
      });
      return attempt;
    });
  }
}

function fingerprintRequest(request: ConnectorAuthorizationRequest): Buffer {
  return createHash('sha256').update(JSON.stringify(request), 'utf8').digest();
}

async function lockIdempotencyKey(
  client: PoolClient,
  operation: 'grant' | 'attempt',
  requestId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2718324901))', [
    `connector-${operation}:${requestId}`,
  ]);
}

async function contextMatches(
  client: PoolClient,
  request: ConnectorAuthorizationRequest,
): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `SELECT omnis.validate_connector_authorization_context($1, $2, $3, $4, $5, $6) AS allowed`,
    [
      request.projectId,
      request.projectRevision,
      request.taskId,
      request.taskRevision,
      request.agentId,
      request.profileVersion,
    ],
  );
  return result.rows[0]?.allowed === true;
}

async function appendAudit(
  client: PoolClient,
  authorization: AuthorizationRow,
  input: {
    requestId: string;
    attemptId?: string;
    eventType: string;
    actorId: 'owner' | 'service:omnis-authorizer';
    effectiveIdentity: 'human:owner' | 'service:omnis-authorizer';
    outcome: 'allowed' | 'denied' | 'recorded';
  },
): Promise<void> {
  const sequence = await client.query<{ next_sequence: number }>(
    `SELECT COALESCE(max(sequence), 0) + 1 AS next_sequence
       FROM omnis.connector_authorization_audit WHERE authorization_id = $1`,
    [authorization.id],
  );
  await client.query(
    `INSERT INTO omnis.connector_authorization_audit (
       authorization_id, attempt_id, request_id, sequence, event_type, actor_id,
       effective_identity, correlation_id, outcome, revocation_generation
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      authorization.id,
      input.attemptId ?? null,
      input.requestId,
      sequence.rows[0]!.next_sequence,
      input.eventType,
      input.actorId,
      input.effectiveIdentity,
      authorization.correlation_id,
      input.outcome,
      authorization.revocation_generation,
    ],
  );
}

function mapAuthorization(row: AuthorizationRow): ConnectorAuthorization {
  return ConnectorAuthorizationSchema.parse({
    id: row.id,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    requestingActor: row.requesting_actor,
    projectId: row.project_id,
    projectRevision: row.project_revision,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    agentId: row.agent_id,
    profileVersion: row.profile_version,
    connectorId: row.connector_id,
    connectorVersion: row.connector_version,
    providerId: row.provider_id,
    modelId: row.model_id,
    operation: row.operation,
    capabilities: row.capabilities,
    limits: row.limits,
    promptDigest: row.prompt_digest,
    status: row.status,
    policyVersion: row.policy_version,
    createdAt: toIso(row.created_at),
    consentedAt: row.consented_at === null ? null : toIso(row.consented_at),
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    decidedBy: row.decided_by,
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    revokedBy: row.revoked_by,
    revocationGeneration: row.revocation_generation,
    expiresAt: toIso(row.expires_at),
    consumedAt: row.consumed_at === null ? null : toIso(row.consumed_at),
    consumedRequestId: row.consumed_request_id,
    synthetic: true,
  });
}

function mapRequest(row: AuthorizationRow): ConnectorAuthorizationRequest {
  return ConnectorAuthorizationRequestSchema.parse({
    projectId: row.project_id,
    projectRevision: row.project_revision,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    agentId: row.agent_id,
    profileVersion: row.profile_version,
    connectorId: row.connector_id,
    connectorVersion: row.connector_version,
    providerId: row.provider_id,
    modelId: row.model_id,
    operation: row.operation,
    capabilities: row.capabilities,
    limits: row.limits,
    promptDigest: row.prompt_digest,
  });
}

function mapAttempt(row: AttemptRow): ConnectorExecutionAttempt {
  return ConnectorExecutionAttemptSchema.parse({
    id: row.id,
    authorizationId: row.authorization_id,
    requestId: row.request_id,
    status: row.status,
    synthetic: row.synthetic,
    createdAt: toIso(row.created_at),
  });
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toEpoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function sameFingerprint(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error('The connector authorization store returned no row.');
  return row;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function notFound(): ConnectorAuthorizationStoreError {
  return new ConnectorAuthorizationStoreError(
    'not_found',
    'Connector authorization was not found.',
    404,
  );
}

function conflict(message: string): ConnectorAuthorizationStoreError {
  return new ConnectorAuthorizationStoreError('conflict', message, 409);
}

function invalidTransition(message: string): ConnectorAuthorizationStoreError {
  return new ConnectorAuthorizationStoreError('invalid_transition', message, 409);
}

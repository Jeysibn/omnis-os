import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  AgentMutationReceiptSchema,
  AgentProfileDraftResponseSchema,
  CreateAgentInputSchema,
  PublishAgentProfileInputSchema,
  SaveAgentProfileDraftInputSchema,
} from '@omnis/contracts';
import type {
  AgentMutationReceipt,
  AgentProfileDraftResponse,
  CreateAgentInput,
  PublishAgentProfileInput,
  SaveAgentProfileDraftInput,
} from '@omnis/contracts';
import {
  AgentProfileStoreError,
  assertNoCredentialMaterial,
  validateAgentProfileWriteInput,
} from './agent-profile-store.ts';

export type AgentLifecycleStoreErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_transition'
  | 'invalid_input'
  | 'disallowed_credential_material';

export class AgentLifecycleStoreError extends Error {
  readonly code: AgentLifecycleStoreErrorCode;
  readonly statusCode: 404 | 409 | 422;

  constructor(code: AgentLifecycleStoreErrorCode, statusCode: 404 | 409 | 422) {
    const messages: Record<AgentLifecycleStoreErrorCode, string> = {
      not_found: 'Agent was not found.',
      conflict: 'Agent management state changed; reload and retry.',
      invalid_transition: 'Agent lifecycle does not allow this operation.',
      invalid_input: 'Agent management input is invalid.',
      disallowed_credential_material: 'Agent profile contains disallowed credential material.',
    };
    super(messages[code]);
    this.name = 'AgentLifecycleStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

type DbError = { code?: string };
type JsonRow = { result: AgentMutationReceipt | AgentProfileDraftResponse };

function safeParse<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AgentLifecycleStoreError('invalid_input', 422);
  return result.data as T;
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof AgentProfileStoreError) {
    throw new AgentLifecycleStoreError(
      error.code === 'disallowed_credential_material'
        ? 'disallowed_credential_material'
        : 'invalid_input',
      422,
    );
  }
  const code = (error as DbError)?.code;
  if (code === 'P0002') throw new AgentLifecycleStoreError('not_found', 404);
  if (code === '23505' || code === '40001' || code === '23503')
    throw new AgentLifecycleStoreError('conflict', 409);
  if (code === '23514' || code === '55000')
    throw new AgentLifecycleStoreError('invalid_transition', 409);
  if (code === '22023' || code === '22003' || code === '23502' || code === '22P02')
    throw new AgentLifecycleStoreError('invalid_input', 422);
  throw error;
}

export class PostgresAgentLifecycleStore {
  private readonly pool: Pool;
  private readonly signingKey: Buffer;
  private readonly keyVersion: number;

  constructor(pool: Pool, key: Buffer, keyVersion = 1) {
    if (key.length !== 32 || !Number.isSafeInteger(keyVersion) || keyVersion < 1)
      throw new Error('Agent idempotency key configuration is invalid.');
    this.pool = pool;
    this.signingKey = Buffer.from(key);
    this.keyVersion = keyVersion;
  }

  async getDraft(agentId: string): Promise<AgentProfileDraftResponse> {
    try {
      const result = await this.pool.query<{ result: unknown }>(
        'SELECT omnis.get_agent_profile_draft($1) AS result',
        [agentId],
      );
      const parsed = safeParse(AgentProfileDraftResponseSchema, result.rows[0]?.result);
      if (parsed.profile) assertNoCredentialMaterial(parsed.profile);
      return parsed;
    } catch (error) {
      if (error instanceof AgentLifecycleStoreError) throw error;
      return mapDatabaseError(error);
    }
  }

  async createAgent(
    inputValue: CreateAgentInput,
    requestId: string,
  ): Promise<AgentMutationReceipt> {
    const input = safeParse(CreateAgentInputSchema, inputValue);
    assertNoCredentialMaterial(input);
    const fingerprint = this.fingerprint('agent.created', null, input);
    const proposedId = `agt_${randomUUID().replaceAll('-', '')}`;
    return this.mutate(`SELECT omnis.create_agent($1,$2,$3,$4,$5,$6,$7) AS result`, [
      proposedId,
      input.name,
      input.slug,
      input.departmentId,
      requestId,
      this.keyVersion,
      fingerprint,
    ]);
  }

  async saveDraft(
    agentId: string,
    inputValue: SaveAgentProfileDraftInput,
    requestId: string,
  ): Promise<AgentMutationReceipt> {
    const input = safeParse(SaveAgentProfileDraftInputSchema, inputValue);
    const profile = validateAgentProfileWriteInput(input.profile);
    const normalized = { ...input, profile };
    const fingerprint = this.fingerprint('profile.draft_saved', agentId, normalized);
    return this.mutate(
      `SELECT omnis.save_agent_profile_draft($1,$2,$3,$4::jsonb,$5,$6,$7) AS result`,
      [
        agentId,
        input.expectedDraftRevision,
        input.baseVersionNo,
        JSON.stringify(profile),
        requestId,
        this.keyVersion,
        fingerprint,
      ],
    );
  }

  async publish(
    agentId: string,
    inputValue: PublishAgentProfileInput,
    requestId: string,
  ): Promise<AgentMutationReceipt> {
    const input = safeParse(PublishAgentProfileInputSchema, inputValue);
    const fingerprint = this.fingerprint('profile.published', agentId, input);
    return this.mutate('SELECT omnis.publish_agent_profile($1,$2,$3,$4,$5,$6) AS result', [
      agentId,
      input.expectedVersionNo,
      input.expectedDraftRevision,
      requestId,
      this.keyVersion,
      fingerprint,
    ]);
  }

  async archive(agentId: string, requestId: string): Promise<AgentMutationReceipt> {
    const fingerprint = this.fingerprint('agent.archived', agentId, {});
    return this.mutate('SELECT omnis.archive_agent($1,$2,$3,$4) AS result', [
      agentId,
      requestId,
      this.keyVersion,
      fingerprint,
    ]);
  }

  private fingerprint(operation: string, target: string | null, input: unknown): Buffer {
    return createHmac('sha256', this.signingKey)
      .update('omnis-agent-management-idempotency:v1\0')
      .update(JSON.stringify({ operation, target, input }))
      .digest();
  }

  private async mutate(query: string, values: unknown[]): Promise<AgentMutationReceipt> {
    try {
      const result = await this.pool.query<JsonRow>(query, values);
      return safeParse(AgentMutationReceiptSchema, result.rows[0]?.result);
    } catch (error) {
      if (error instanceof AgentLifecycleStoreError) throw error;
      return mapDatabaseError(error);
    }
  }
}

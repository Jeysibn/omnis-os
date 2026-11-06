import { createHash } from 'node:crypto';
import { z } from 'zod';

const ProjectIdSchema = z.string().regex(/^prj_[0-9a-f]{32}$/);
const TaskIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('\0'));
const AgentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/);
const UuidSchema = z.string().uuid();
const PromptDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const ConnectorLimitsSchema = z
  .object({
    maxInputTokens: z.number().int().min(1).max(4_000),
    maxOutputTokens: z.number().int().min(1).max(1_024),
    maxDurationSeconds: z.number().int().min(1).max(900),
    maxConcurrentRuns: z.literal(1),
    maxUsageUnits: z.number().int().min(1).max(10_000),
    maxCostMicrousd: z.number().int().min(1).max(10_000_000),
  })
  .strict();
export type ConnectorLimits = z.infer<typeof ConnectorLimitsSchema>;

const ConnectorBindingShape = {
  projectId: ProjectIdSchema,
  projectRevision: z.number().int().positive().safe(),
  taskId: TaskIdSchema,
  taskRevision: z.number().int().positive().safe(),
  agentId: AgentIdSchema,
  profileVersion: z.number().int().positive().safe(),
  connectorId: z.literal('synthetic.codex.fixture'),
  connectorVersion: z.literal('0.0.0-synthetic.1'),
  providerId: z.literal('synthetic'),
  modelId: z.literal('synthetic-text-only-v1'),
  operation: z.literal('connector.respond'),
  capabilities: z.tuple([]),
  limits: ConnectorLimitsSchema,
};

/** Owner API input. The API hashes renderedRequest and never forwards or persists its text. */
export const CreateConnectorAuthorizationSchema = z
  .object({
    ...ConnectorBindingShape,
    renderedRequest: z
      .string()
      .min(1)
      .max(32_000)
      .refine((value) => !value.includes('\0') && value.trim().length > 0),
  })
  .strict();
export type CreateConnectorAuthorizationInput = z.infer<typeof CreateConnectorAuthorizationSchema>;

/** Internal API-to-authorizer request. It contains only the digest, never prompt text. */
export const ConnectorAuthorizationRequestSchema = z
  .object({ ...ConnectorBindingShape, promptDigest: PromptDigestSchema })
  .strict();
export type ConnectorAuthorizationRequest = z.infer<typeof ConnectorAuthorizationRequestSchema>;

export const ConnectorAuthorizationDecisionSchema = z.discriminatedUnion('decision', [
  z
    .object({ decision: z.literal('approve'), promptDigestConfirmation: PromptDigestSchema })
    .strict(),
  z.object({ decision: z.literal('deny') }).strict(),
]);
export type ConnectorAuthorizationDecision = z.infer<typeof ConnectorAuthorizationDecisionSchema>;

export const ConnectorAuthorizationSchema = z
  .object({
    id: UuidSchema,
    requestId: UuidSchema,
    correlationId: UuidSchema,
    requestingActor: z.literal('owner'),
    ...ConnectorBindingShape,
    promptDigest: PromptDigestSchema,
    status: z.enum(['pending', 'authorized', 'denied', 'revoked', 'expired']),
    policyVersion: z.literal('r1p1-synthetic-connector-v1'),
    createdAt: z.string().datetime(),
    consentedAt: z.string().datetime().nullable(),
    decidedAt: z.string().datetime().nullable(),
    decidedBy: z.literal('owner').nullable(),
    revokedAt: z.string().datetime().nullable(),
    revokedBy: z.literal('owner').nullable(),
    revocationGeneration: z.number().int().nonnegative().safe(),
    expiresAt: z.string().datetime(),
    consumedAt: z.string().datetime().nullable(),
    consumedRequestId: UuidSchema.nullable(),
    synthetic: z.literal(true),
  })
  .strict();
export type ConnectorAuthorization = z.infer<typeof ConnectorAuthorizationSchema>;

export const ConnectorExecutionAttemptSchema = z
  .object({
    id: UuidSchema,
    authorizationId: UuidSchema,
    requestId: UuidSchema,
    status: z.literal('admitted'),
    synthetic: z.literal(true),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ConnectorExecutionAttempt = z.infer<typeof ConnectorExecutionAttemptSchema>;

export function createRenderedRequestDigest(renderedRequest: string): string {
  return `sha256:${createHash('sha256')
    .update('omnis-os/rendered-connector-request/v1\0', 'utf8')
    .update(renderedRequest, 'utf8')
    .digest('hex')}`;
}

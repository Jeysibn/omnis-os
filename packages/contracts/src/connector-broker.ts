import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { ConnectorLimitsSchema } from './connector-authorization.ts';

const Uuid = z.string().uuid();
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const ConnectorExecutionStatusSchema = z.enum([
  'admitted',
  'submitting',
  'accepted',
  'running',
  'completed',
  'failed',
  'interrupted',
  'unknown',
]);
export type ConnectorExecutionStatus = z.infer<typeof ConnectorExecutionStatusSchema>;

export const UsageProvenanceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('measured'),
      source: z.literal('synthetic-provider'),
      inputUnits: z.number().int().nonnegative().safe(),
      outputUnits: z.number().int().nonnegative().safe(),
      billingExposure: z.literal('synthetic-only'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('estimated'),
      method: z.string().min(1).max(100),
      inputUnits: z.number().int().positive().safe().optional(),
      outputUnits: z.number().int().positive().safe().optional(),
      billingExposure: z.literal('unknown'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unknown'),
      reason: z.enum(['submission_uncertain', 'provider_unavailable', 'not_reported']),
      billingExposure: z.literal('unknown'),
    })
    .strict(),
]);
export type UsageProvenance = z.infer<typeof UsageProvenanceSchema>;

export const SyntheticProviderEventSchema = z
  .object({
    eventId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    status: z.enum(['accepted', 'running', 'completed', 'failed', 'interrupted', 'unknown']),
    providerSubmissionId: z.string().min(1).max(256).optional(),
    usage: UsageProvenanceSchema.optional(),
    responseText: z
      .string()
      .max(32_000)
      .refine((value) => !value.includes('\0') && value.trim().length > 0)
      .optional(),
  })
  .strict()
  .refine((event) => (event.status === 'completed') === (event.responseText !== undefined), {
    message: 'Completed synthetic events require exactly one bounded response.',
  });
export type SyntheticProviderEvent = z.infer<typeof SyntheticProviderEventSchema>;

export const ConnectorDecisionEnvelopeClaimsSchema = z
  .object({
    authorizationId: Uuid,
    decisionId: Uuid,
    decision: z
      .object({
        status: z.literal('authorized'),
        decidedBy: z.literal('owner'),
        decidedAt: z.string().datetime(),
        consentedAt: z.string().datetime(),
      })
      .strict(),
    principal: z.object({ kind: z.literal('owner'), id: z.literal('owner') }).strict(),
    runId: Uuid,
    attemptId: Uuid,
    requestId: Uuid,
    correlationId: Uuid,
    projectId: z.string().regex(/^prj_[0-9a-f]{32}$/),
    projectRevision: z.number().int().positive().safe(),
    taskId: z
      .string()
      .min(1)
      .max(128)
      .refine((v) => !v.includes('\0')),
    taskRevision: z.number().int().positive().safe(),
    agentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/),
    profileVersion: z.number().int().positive().safe(),
    promptDigest: Digest,
    connectorId: z.literal('synthetic.codex.fixture'),
    connectorVersion: z.literal('0.0.0-synthetic.1'),
    providerId: z.literal('synthetic'),
    modelId: z.literal('synthetic-text-only-v1'),
    operation: z.literal('connector.respond'),
    capabilities: z.tuple([]),
    limits: ConnectorLimitsSchema,
    revocationGeneration: z.literal(0),
    grantExpiresAt: z.string().datetime(),
    nonce: Uuid,
  })
  .strict()
  .refine((v) => v.runId === v.attemptId, 'runId must equal the one-use attemptId');
export type ConnectorDecisionEnvelopeClaims = z.infer<typeof ConnectorDecisionEnvelopeClaimsSchema>;

export const ConnectorDecisionEnvelopeSchema = z
  .object({
    version: z.literal('omnis.connector-decision.v1'),
    issuer: z.literal('omnis-authorizer'),
    audience: z.literal('omnis-synthetic-broker'),
    algorithm: z.literal('Ed25519'),
    keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    claims: ConnectorDecisionEnvelopeClaimsSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type ConnectorDecisionEnvelope = z.infer<typeof ConnectorDecisionEnvelopeSchema>;

export type SigningKey = {
  keyId: string;
  privateKey: KeyObject;
  notBefore: string;
  notAfter: string;
};
export type VerificationKey = {
  keyId: string;
  publicKey: KeyObject;
  notBefore: string;
  notAfter: string;
};

export function canonicalizeConnectorDecisionClaims(value: unknown): string {
  const parsed = ConnectorDecisionEnvelopeClaimsSchema.parse(value);
  return canonicalJson(parsed);
}

export function signConnectorDecisionEnvelope(
  claimsInput: unknown,
  key: SigningKey,
  now = new Date(),
  ttlSeconds = 30,
): ConnectorDecisionEnvelope {
  const claims = ConnectorDecisionEnvelopeClaimsSchema.parse(claimsInput);
  const issuedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + Math.min(Math.max(ttlSeconds, 1), 60) * 1000,
  ).toISOString();
  if (
    !isCanonicalTimestamp(key.notBefore) ||
    !isCanonicalTimestamp(key.notAfter) ||
    Date.parse(key.notAfter) <= Date.parse(key.notBefore) ||
    Date.parse(key.notBefore) > now.getTime() ||
    Date.parse(key.notAfter) < now.getTime() + 1000
  ) {
    throw new Error('Signing key is outside its active validity window.');
  }
  const unsigned = {
    version: 'omnis.connector-decision.v1' as const,
    issuer: 'omnis-authorizer' as const,
    audience: 'omnis-synthetic-broker' as const,
    algorithm: 'Ed25519' as const,
    keyId: key.keyId,
    issuedAt,
    expiresAt,
    claims,
  };
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), key.privateKey).toString(
    'base64url',
  );
  return ConnectorDecisionEnvelopeSchema.parse({ ...unsigned, signature });
}

/** Verifies an explicit trust anchor and strict audience, lifetime, and grant expiry. */
export function verifyConnectorDecisionEnvelope(
  envelopeInput: unknown,
  anchors: readonly VerificationKey[],
  now = new Date(),
): ConnectorDecisionEnvelope {
  const envelope = ConnectorDecisionEnvelopeSchema.parse(envelopeInput);
  assertTrustAnchorRotationWindow(anchors);
  const at = now.getTime();
  const issued = Date.parse(envelope.issuedAt);
  const expires = Date.parse(envelope.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > at + 5_000 ||
    expires <= at ||
    expires - issued > 60_000 ||
    Date.parse(envelope.claims.grantExpiresAt) <= at
  )
    throw new Error('Decision envelope is expired or invalid.');
  const key = anchors.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key || Date.parse(key.notBefore) > issued || Date.parse(key.notAfter) < expires)
    throw new Error('Decision envelope signing key is unknown or retired.');
  const { signature, ...unsigned } = envelope;
  const bytes = Buffer.from(signature, 'base64url');
  if (
    bytes.length !== 64 ||
    !verify(null, Buffer.from(canonicalJson(unsigned)), key.publicKey, bytes)
  ) {
    throw new Error('Decision envelope signature is invalid.');
  }
  return envelope;
}

/** Public key overlap is limited to one maximum envelope lifetime. */
export function assertTrustAnchorRotationWindow(anchors: readonly VerificationKey[]): void {
  const ids = new Set<string>();
  for (const anchor of anchors) {
    if (ids.has(anchor.keyId)) throw new Error('Duplicate decision envelope key ID.');
    ids.add(anchor.keyId);
    const notBefore = Date.parse(anchor.notBefore);
    const notAfter = Date.parse(anchor.notAfter);
    if (
      !isCanonicalTimestamp(anchor.notBefore) ||
      !isCanonicalTimestamp(anchor.notAfter) ||
      !Number.isFinite(notBefore) ||
      !Number.isFinite(notAfter) ||
      notAfter <= notBefore
    ) {
      throw new Error('Decision envelope trust anchor validity window is malformed.');
    }
  }
  for (let left = 0; left < anchors.length; left += 1) {
    for (let right = left + 1; right < anchors.length; right += 1) {
      const overlap =
        Math.min(Date.parse(anchors[left]!.notAfter), Date.parse(anchors[right]!.notAfter)) -
        Math.max(Date.parse(anchors[left]!.notBefore), Date.parse(anchors[right]!.notBefore));
      if (!Number.isFinite(overlap) || overlap > 60_000) {
        throw new Error('Decision envelope trust anchor rotation overlap exceeds 60 seconds.');
      }
    }
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

export function digestConnectorDecisionEnvelope(envelope: ConnectorDecisionEnvelope): string {
  return `sha256:${createHash('sha256').update(canonicalJson(envelope)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

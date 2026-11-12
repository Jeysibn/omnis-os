import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuidSchema = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const b64url = /^[A-Za-z0-9_-]+$/;
const isAsciiIdentifier = (value: string, max: number): boolean =>
  value.length >= 1 &&
  value.length <= max &&
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 0x20 && code <= 0x7e;
  });
const operations = ['launch', 'inspect', 'read_output', 'cancel', 'reconcile'] as const;
const digestSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((v) => {
    try {
      return decodeBase64Url(v, 32).length === 32;
    } catch {
      return false;
    }
  });
const generation = z.number().int().min(1).max(2_147_483_647).refine(Number.isSafeInteger);
const runArgs = z.object({ run_id: uuidSchema, generation }).strict();
const argumentsSchemas = {
  launch: runArgs,
  inspect: runArgs,
  reconcile: runArgs,
  cancel: runArgs.extend({
    reason_code: z.enum(['owner_requested', 'run_deadline', 'authorization_revoked']),
  }),
  read_output: runArgs.extend({
    cursor: z
      .string()
      .min(1)
      .max(128)
      .refine((v) => {
        try {
          decodeBase64Url(v);
          return true;
        } catch {
          return false;
        }
      }),
    max_bytes: z.number().int().min(1).max(8192).refine(Number.isSafeInteger),
  }),
};
const restrictions = z
  .object({
    image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    command_profile: z.literal('mock-v1'),
    network_profile: z.literal('isolated-no-egress-v1'),
    environment_profile: z.literal('synthetic-nonsecrets-v1'),
    scratch_profile: z.literal('bounded-run-scratch-v1'),
    resource_profile: z.string().refine((value) => isAsciiIdentifier(value, 64)),
    max_runtime_ms: z.number().int().min(1).max(300000).refine(Number.isSafeInteger),
    max_output_bytes: z.number().int().min(1).max(1048576).refine(Number.isSafeInteger),
  })
  .strict();
const claims = z
  .object({
    iss: z.string().refine((value) => isAsciiIdentifier(value, 128)),
    aud: z.string().refine((value) => isAsciiIdentifier(value, 128)),
    sub: z.string().refine((value) => isAsciiIdentifier(value, 128)),
    scope: z.literal('synthetic_runtime'),
    authorization_id: uuidSchema,
    lease_id: z.string().refine((value) => isAsciiIdentifier(value, 128)),
    run_id: uuidSchema,
    task_id: z.string().refine((value) => isAsciiIdentifier(value, 128)),
    project_id: z.string().regex(/^prj_[0-9a-f]{32}$/),
    operation_id: uuidSchema,
    operation: z.enum(operations),
    generation,
    request_hash: digestSchema,
    policy_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    restrictions,
    jti: uuidSchema,
    not_before: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).refine(Number.isSafeInteger),
    expires_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).refine(Number.isSafeInteger),
  })
  .strict()
  .refine((v) => v.expires_at > v.not_before);
const envelope = z
  .object({
    protected: z
      .object({
        typ: z.literal('omnis-runtime-cap+jcs'),
        version: z.literal(1),
        alg: z.literal('Ed25519'),
        kid: z.string().refine((value) => isAsciiIdentifier(value, 64)),
      })
      .strict(),
    claims,
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{86}$/)
      .refine((v) => {
        try {
          return decodeBase64Url(v, 64).length === 64;
        } catch {
          return false;
        }
      }),
  })
  .strict();
const requestBase = z
  .object({
    protocol_version: z.literal(1),
    request_id: uuidSchema,
    operation_id: uuidSchema,
    operation: z.enum(operations),
    arguments: z.unknown(),
    request_hash: digestSchema,
    capability: envelope,
  })
  .strict();

export type ProtocolRequest = z.infer<typeof requestBase>;
export type SyntheticEnvelope = z.infer<typeof envelope>;
export type ReplayRecord = {
  operationId: string;
  jti: string;
  requestHash: string;
  status: 'pending' | 'unknown' | 'resolved';
  result?: unknown;
};

/** Parse strict UTF-8 JSON while retaining raw number tokens until their lexical and precision checks pass. */
export function parseProtocolJson(input: string | Uint8Array): unknown {
  const text =
    typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
  let i = 0;
  const ws = () => {
    while (/[\x20\t\r\n]/.test(text[i] ?? '')) i++;
  };
  const string = (): string => {
    const start = i;
    if (text[i++] !== '"') throw new Error('invalid string');
    while (i < text.length) {
      const c = text[i++]!;
      if (c === '"') {
        const decoded = JSON.parse(text.slice(start, i)) as string;
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(decoded))
          throw new Error('unpaired surrogate');
        return decoded;
      }
      if (c === '\\') {
        if (i >= text.length) throw new Error('invalid escape');
        i++;
      } else if (c.charCodeAt(0) < 0x20) throw new Error('control in string');
    }
    throw new Error('unterminated string');
  };
  const value = (depth: number): unknown => {
    if (depth > 8) throw new Error('nesting too deep');
    ws();
    const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++;
      ws();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (text[i] === '}') {
        i++;
        return result;
      }
      while (true) {
        ws();
        const key = string();
        if (keys.has(key)) throw new Error('duplicate key');
        keys.add(key);
        ws();
        if (text[i++] !== ':') throw new Error('expected colon');
        result[key] = value(depth + 1);
        ws();
        const next = text[i++];
        if (next === '}') return result;
        if (next !== ',') throw new Error('expected comma');
      }
    }
    if (c === '[') {
      i++;
      ws();
      const out: unknown[] = [];
      if (text[i] === ']') {
        i++;
        return out;
      }
      while (true) {
        out.push(value(depth + 1));
        ws();
        const next = text[i++];
        if (next === ']') return out;
        if (next !== ',') throw new Error('expected comma');
      }
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    const start = i;
    while (i < text.length && /[0-9eE+.-]/.test(text[i]!)) i++;
    if (start === i) throw new Error('invalid value');
    const token = text.slice(start, i);
    if (!/^(?:0|[1-9][0-9]*)$/.test(token)) throw new Error('invalid numeric token');
    const n = Number(token);
    if (!Number.isSafeInteger(n) || String(n) !== token) throw new Error('unsafe integer');
    return n;
  };
  const parsed = value(0);
  ws();
  if (i !== text.length) throw new Error('trailing data');
  return parsed;
}

export function decodeBase64Url(value: string, exactBytes?: number): Uint8Array {
  if (!b64url.test(value) || value.includes('='))
    throw new Error('invalid base64url alphabet or padding');
  const bytes = Buffer.from(value, 'base64url');
  if (exactBytes !== undefined && bytes.length !== exactBytes)
    throw new Error('invalid base64url length');
  if (bytes.toString('base64url') !== value) throw new Error('noncanonical base64url');
  return bytes;
}

export function decodeFrame(frame: Uint8Array): Uint8Array {
  if (frame.length < 4) throw new Error('truncated frame prefix');
  const view = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.readUInt32BE(0);
  if (length < 1 || length > 65536 || frame.length !== length + 4)
    throw new Error('invalid frame length');
  return frame.slice(4);
}

export function encodeResponseFrame(payload: Uint8Array): Uint8Array {
  if (payload.length < 1 || payload.length > 16384)
    throw new Error('invalid response payload length');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  frame.set(payload, 4);
  return frame;
}

export function decodeResponseFrame(frame: Uint8Array): Uint8Array {
  if (frame.length < 4) throw new Error('truncated response prefix');
  const view = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.readUInt32BE(0);
  if (length < 1 || length > 16384 || frame.length !== length + 4)
    throw new Error('invalid response frame length');
  return frame.slice(4);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function requestHash(input: Record<string, unknown>): string {
  const semantic = {
    protocol_version: input.protocol_version,
    operation_id: input.operation_id,
    operation: input.operation,
    arguments: input.arguments,
  };
  const version = input.protocol_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 65535)
    throw new Error('invalid protocol version');
  const prefix = Buffer.from([version >> 8, version & 0xff]);
  return createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from('OMNIS-OS-RUNTIME-REQUEST\0'),
        prefix,
        Buffer.from(canonicalJson(semantic)),
      ]),
    )
    .digest('base64url');
}

export function evaluateRequest(
  frame: Uint8Array,
): { ok: true; request: ProtocolRequest } | { ok: false; code: string } {
  let input: unknown;
  try {
    input = parseProtocolJson(decodeFrame(frame));
  } catch {
    return { ok: false, code: 'MALFORMED_REQUEST' };
  }
  const base = requestBase.safeParse(input);
  if (!base.success) return { ok: false, code: 'MALFORMED_REQUEST' };
  const args = argumentsSchemas[base.data.operation].safeParse(base.data.arguments);
  if (!args.success) return { ok: false, code: 'MALFORMED_REQUEST' };
  if (requestHash(base.data as unknown as Record<string, unknown>) !== base.data.request_hash)
    return { ok: false, code: 'AUTHORIZATION_FAILURE' };
  if (
    base.data.capability.claims.operation_id !== base.data.operation_id ||
    base.data.capability.claims.operation !== base.data.operation ||
    base.data.capability.claims.request_hash !== base.data.request_hash ||
    base.data.capability.claims.run_id !== args.data.run_id ||
    base.data.capability.claims.generation !== args.data.generation
  )
    return { ok: false, code: 'AUTHORIZATION_FAILURE' };
  return { ok: true, request: base.data as ProtocolRequest };
}

export function verifySyntheticCapability(
  value: unknown,
  verifier: (keyId: string, message: Uint8Array, signature: Uint8Array) => boolean,
): { ok: boolean } {
  const parsed = envelope.safeParse(value);
  if (!parsed.success) return { ok: false };
  const signature = decodeBase64Url(parsed.data.signature, 64);
  const message = Buffer.concat([
    Buffer.from('OMNIS-OS-RUNTIME-CAPABILITY\0'),
    Buffer.from(canonicalJson(parsed.data.protected)),
    Buffer.from([0]),
    Buffer.from(canonicalJson(parsed.data.claims)),
  ]);
  try {
    return { ok: verifier(parsed.data.protected.kid, message, signature) === true };
  } catch {
    return { ok: false };
  }
}

/**
 * Replay-reducer outcomes are deliberately distinct from policy/audit classifications below.
 * The reducer has no issuer, clock, persistence, peer-authentication, or dispatch authority.
 */
export const ReplayClassificationSchema = z.enum([
  'PERMITTED',
  'AUTHORIZATION_FAILURE',
  'REPLAY_CONFLICT',
  'OUTCOME_UNKNOWN',
  'SAVED_RESULT',
]);

export function reduceReplay(
  state: readonly ReplayRecord[],
  input: Omit<ReplayRecord, 'status'>,
): {
  permit: boolean;
  classification: z.infer<typeof ReplayClassificationSchema>;
  state: ReplayRecord[];
} {
  const validRecord = (record: Omit<ReplayRecord, 'status'> | ReplayRecord): boolean =>
    uuidSchema.safeParse(record.operationId).success &&
    uuidSchema.safeParse(record.jti).success &&
    record.requestHash.length === 43 &&
    (() => {
      try {
        decodeBase64Url(record.requestHash, 32);
        return true;
      } catch {
        return false;
      }
    })();
  if (!validRecord(input) || state.some((record) => !validRecord(record)))
    return { permit: false, classification: 'AUTHORIZATION_FAILURE', state: [...state] };
  const operation = state.find((r) => r.operationId === input.operationId);
  const jti = state.find((r) => r.jti === input.jti);
  if (operation && operation.jti !== input.jti)
    return { permit: false, classification: 'AUTHORIZATION_FAILURE', state: [...state] };
  if (operation)
    return {
      permit: false,
      classification:
        operation.requestHash === input.requestHash
          ? operation.status === 'resolved'
            ? 'SAVED_RESULT'
            : 'OUTCOME_UNKNOWN'
          : 'REPLAY_CONFLICT',
      state: [...state],
    };
  if (jti) return { permit: false, classification: 'AUTHORIZATION_FAILURE', state: [...state] };
  return {
    permit: true,
    classification: 'PERMITTED',
    state: [...state, { ...input, status: 'pending' }],
  };
}

export type PolicyContext = {
  peerSubject: string;
  expectedIssuer: string;
  expectedAudience: string;
  policyDigest: string;
  authorizationId: string;
  leaseId: string;
  taskId: string;
  projectId: string;
  fixedRestrictions: z.infer<typeof restrictions>;
  now: number;
  allowed: boolean;
  verify: (keyId: string, message: Uint8Array, signature: Uint8Array) => boolean;
};

/** Deterministic synthetic policy gate. It has no clock, I/O, key loading, or persistence of its own. */
export function evaluatePolicy(
  input: Uint8Array,
  context: PolicyContext,
): { decision: 'allow' | 'deny'; reason: string; effectState: 'not_attempted' } {
  const evaluated = evaluateRequest(input);
  if (!evaluated.ok)
    return { decision: 'deny', reason: evaluated.code, effectState: 'not_attempted' };
  if (!Number.isSafeInteger(context.now) || context.now < 0)
    return { decision: 'deny', reason: 'capability_invalid', effectState: 'not_attempted' };
  const request = evaluated.request;
  const claims = request.capability.claims;
  if (
    claims.iss !== context.expectedIssuer ||
    claims.aud !== context.expectedAudience ||
    claims.sub !== context.peerSubject
  )
    return { decision: 'deny', reason: 'peer_mismatch', effectState: 'not_attempted' };
  if (
    claims.authorization_id !== context.authorizationId ||
    claims.lease_id !== context.leaseId ||
    claims.task_id !== context.taskId ||
    claims.project_id !== context.projectId ||
    canonicalJson(claims.restrictions) !== canonicalJson(context.fixedRestrictions) ||
    claims.policy_digest !== context.policyDigest ||
    claims.not_before > context.now ||
    claims.expires_at <= context.now
  )
    return { decision: 'deny', reason: 'capability_invalid', effectState: 'not_attempted' };
  if (!verifySyntheticCapability(request.capability, context.verify).ok)
    return { decision: 'deny', reason: 'capability_invalid', effectState: 'not_attempted' };
  if (context.allowed !== true)
    return { decision: 'deny', reason: 'policy_denied', effectState: 'not_attempted' };
  return { decision: 'allow', reason: 'permitted', effectState: 'not_attempted' };
}

export const ExitClassSchema = z.enum(['succeeded', 'failed', 'interrupted', 'unknown']);
export const ClassificationSchema = z.enum([
  'PERMITTED',
  'POLICY_DENIAL',
  'MALFORMED_REQUEST',
  'UNSUPPORTED',
  'REPLAY_CONFLICT',
  'AUTHORIZATION_FAILURE',
  'OUTCOME_UNKNOWN',
  'INTERNAL_FAILURE',
]);

const reasonCodesByClassification: Record<
  z.infer<typeof ClassificationSchema>,
  readonly string[]
> = {
  PERMITTED: ['permitted', 'engine_rejected'],
  POLICY_DENIAL: ['policy_denied'],
  MALFORMED_REQUEST: ['frame_invalid', 'encoding_invalid', 'schema_invalid'],
  UNSUPPORTED: ['unsupported_version', 'unsupported_operation'],
  REPLAY_CONFLICT: ['replay_conflict'],
  AUTHORIZATION_FAILURE: [
    'peer_mismatch',
    'capability_invalid',
    'capability_expired',
    'capability_revoked',
    'scope_mismatch',
    'generation_mismatch',
    'request_hash_mismatch',
  ],
  OUTCOME_UNKNOWN: ['outcome_unknown'],
  INTERNAL_FAILURE: ['dependency_unavailable', 'internal_failure'],
};

export type AuditInput = {
  requestId: string | null;
  operationId: string | null;
  operation: string;
  peerRole: string;
  jtiHash: string | null;
  requestHash: string | null;
  policyDigest: string | null;
  classification: z.infer<typeof ClassificationSchema>;
  reasonCode: string;
  effectState: 'not_attempted' | 'pending' | 'committed' | 'rejected' | 'unknown';
  durationBucket: 'lt_10ms' | 'lt_100ms' | 'lt_1s' | 'gte_1s';
  sequence: number;
};

const AuditSchema = z
  .object({
    requestId: uuidSchema.nullable(),
    operationId: uuidSchema.nullable(),
    operation: z.enum(operations),
    peerRole: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._~-]+$/),
    jtiHash: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .nullable(),
    requestHash: digestSchema.nullable(),
    policyDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable(),
    classification: ClassificationSchema,
    reasonCode: z.enum([
      'permitted',
      'policy_denied',
      'frame_invalid',
      'encoding_invalid',
      'schema_invalid',
      'unsupported_version',
      'unsupported_operation',
      'peer_mismatch',
      'capability_invalid',
      'capability_expired',
      'capability_revoked',
      'scope_mismatch',
      'generation_mismatch',
      'request_hash_mismatch',
      'replay_conflict',
      'dependency_unavailable',
      'engine_rejected',
      'outcome_unknown',
      'internal_failure',
    ]),
    effectState: z.enum(['not_attempted', 'pending', 'committed', 'rejected', 'unknown']),
    durationBucket: z.enum(['lt_10ms', 'lt_100ms', 'lt_1s', 'gte_1s']),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).refine(Number.isSafeInteger),
  })
  .strict();

export function createAuditRecord(input: AuditInput): AuditInput {
  const record = AuditSchema.parse(input);
  if (record.jtiHash !== null) decodeBase64Url(record.jtiHash, 32);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 4096)
    throw new Error('audit record exceeds 4 KiB');
  return record;
}

export const ProtocolResponseSchema = z
  .object({
    protocol_version: z.literal(1),
    request_id: uuidSchema.nullable(),
    operation_id: uuidSchema.nullable(),
    classification: ClassificationSchema,
    policy_decision: z.enum(['allow', 'deny', 'not_evaluated']),
    reason_code: z.enum([
      'permitted',
      'policy_denied',
      'frame_invalid',
      'encoding_invalid',
      'schema_invalid',
      'unsupported_version',
      'unsupported_operation',
      'peer_mismatch',
      'capability_invalid',
      'capability_expired',
      'capability_revoked',
      'scope_mismatch',
      'generation_mismatch',
      'request_hash_mismatch',
      'replay_conflict',
      'dependency_unavailable',
      'engine_rejected',
      'outcome_unknown',
      'internal_failure',
    ]),
    policy_digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable(),
    effect_state: z.enum(['not_attempted', 'pending', 'committed', 'rejected', 'unknown']),
    result: z
      .unknown()
      .nullable()
      .refine(
        (value) =>
          value === null ||
          (typeof value === 'object' &&
            !Array.isArray(value) &&
            Buffer.byteLength(JSON.stringify(value), 'utf8') <= 12000),
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const addIssue = (message: string) => context.addIssue({ code: 'custom', message });
    if (!reasonCodesByClassification[value.classification].includes(value.reason_code))
      addIssue('reason code does not match response classification');

    if (value.classification === 'PERMITTED') {
      if (value.policy_decision !== 'allow')
        addIssue('permitted responses require an allow decision');
      if (value.effect_state === 'unknown')
        addIssue('unknown effects require OUTCOME_UNKNOWN classification');
      if ((value.reason_code === 'engine_rejected') !== (value.effect_state === 'rejected'))
        addIssue('engine rejection reason and rejected effect state must appear together');
      if (value.effect_state === 'not_attempted' && value.result !== null)
        addIssue('unattempted operations cannot include a runtime result');
      if (
        value.result !== null &&
        typeof value.result === 'object' &&
        !Array.isArray(value.result) &&
        'state' in value.result &&
        value.result.state === 'unknown'
      )
        addIssue('unknown result states require OUTCOME_UNKNOWN classification');
      return;
    }

    if (value.classification === 'OUTCOME_UNKNOWN') {
      if (value.policy_decision !== 'allow')
        addIssue('unknown post-dispatch outcomes require an allow decision');
      if (value.reason_code !== 'outcome_unknown')
        addIssue('unknown outcomes require the outcome_unknown reason');
      if (value.effect_state !== 'unknown')
        addIssue('unknown outcomes require unknown effect state');
      if (
        value.result !== null &&
        (typeof value.result !== 'object' ||
          Array.isArray(value.result) ||
          !('state' in value.result) ||
          value.result.state !== 'unknown')
      )
        addIssue('unknown outcomes may include only an unknown-state summary');
      return;
    }

    if (value.effect_state !== 'not_attempted')
      addIssue('non-permitted failures must be confirmed before dispatch');
    if (value.result !== null) addIssue('failure responses cannot include a runtime result');

    if (
      value.classification === 'POLICY_DENIAL' ||
      value.classification === 'AUTHORIZATION_FAILURE' ||
      value.classification === 'REPLAY_CONFLICT'
    ) {
      if (value.policy_decision !== 'deny') addIssue('denials require a deny policy decision');
    } else if (value.policy_decision !== 'not_evaluated') {
      addIssue('pre-policy failures require not_evaluated policy decision');
    }
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16384);

const outputCursor = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      decodeBase64Url(value);
      return true;
    } catch {
      return false;
    }
  });
const resultState = z.enum(['pending', 'running', 'completed', 'interrupted', 'unknown']);
const runResult = z
  .object({
    run_id: uuidSchema,
    generation,
    state: resultState,
    output_cursor: outputCursor.nullable().optional(),
  })
  .strict();
const inspectResult = runResult.extend({ exit_class: ExitClassSchema.nullable() }).strict();
const outputResult = z
  .object({
    run_id: uuidSchema,
    generation,
    data: z
      .string()
      .max(10924)
      .refine((value) => {
        try {
          decodeBase64Url(value);
          return true;
        } catch {
          return false;
        }
      }),
    next_cursor: outputCursor,
    truncated: z.boolean(),
  })
  .strict();
const cancelResult = z
  .object({ run_id: uuidSchema, generation, state: z.enum(['cancelling', 'cancelled', 'unknown']) })
  .strict();
const reconcileResult = z
  .object({
    run_id: uuidSchema,
    generation,
    state: resultState,
    reconciliation_class: z.enum(['matched', 'missing', 'unexpected', 'unknown']),
  })
  .strict();
const resultSchemas = {
  launch: runResult,
  inspect: inspectResult,
  read_output: outputResult,
  cancel: cancelResult,
  reconcile: reconcileResult,
};

/** Adds operation-specific result validation to the bounded response envelope. */
export function validateResponseForOperation(
  input: unknown,
  operation: (typeof operations)[number],
) {
  const response = ProtocolResponseSchema.safeParse(input);
  if (!response.success) return { success: false as const };
  if (response.data.result === null) return { success: true as const, data: response.data };
  const result = resultSchemas[operation].safeParse(response.data.result);
  if (
    response.data.classification === 'OUTCOME_UNKNOWN' &&
    (typeof response.data.result !== 'object' ||
      Array.isArray(response.data.result) ||
      !('state' in response.data.result) ||
      response.data.result.state !== 'unknown')
  )
    return { success: false as const };
  return result.success
    ? { success: true as const, data: response.data }
    : { success: false as const };
}

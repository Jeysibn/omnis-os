import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  canonicalJson,
  decodeBase64Url,
  decodeFrame,
  decodeResponseFrame,
  encodeResponseFrame,
  ExitClassSchema,
  validateResponseForOperation,
  evaluateRequest,
  parseProtocolJson,
  type PolicyContext,
  requestHash,
  reduceReplay,
  verifySyntheticCapability,
} from './index.ts';

const uuid = '11111111-1111-4111-8111-111111111111';
const hash = Buffer.alloc(32).toString('base64url');
const frame = (s: string) => {
  const body = Buffer.from(s);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length);
  body.copy(out, 4);
  return out;
};
const request: {
  [key: string]: unknown;
  protocol_version: number;
  request_id: string;
  operation_id: string;
  operation: string;
  arguments: { run_id: string; generation: number };
  request_hash: string;
  capability: {
    protected: Record<string, unknown>;
    claims: Record<string, unknown>;
    signature: string;
  };
} = {
  protocol_version: 1,
  request_id: uuid,
  operation_id: uuid,
  operation: 'launch',
  arguments: { run_id: uuid, generation: 1 },
  request_hash: hash,
  capability: {
    protected: { typ: 'omnis-runtime-cap+jcs', version: 1, alg: 'Ed25519', kid: 'synthetic' },
    claims: {},
    signature: Buffer.alloc(64).toString('base64url'),
  },
};
request.request_hash = requestHash(request);
request.capability.claims = {
  iss: 'synthetic-issuer',
  aud: 'runtime-gateway',
  sub: 'synthetic-peer',
  scope: 'synthetic_runtime',
  authorization_id: uuid,
  lease_id: 'lease-1',
  run_id: uuid,
  task_id: 'task-1',
  project_id: `prj_${'a'.repeat(32)}`,
  operation_id: uuid,
  operation: 'launch',
  generation: 1,
  request_hash: request.request_hash,
  policy_digest: `sha256:${'b'.repeat(64)}`,
  jti: uuid,
  not_before: 1,
  expires_at: 2,
  restrictions: {
    image_digest: `sha256:${'c'.repeat(64)}`,
    command_profile: 'mock-v1',
    network_profile: 'isolated-no-egress-v1',
    environment_profile: 'synthetic-nonsecrets-v1',
    scratch_profile: 'bounded-run-scratch-v1',
    resource_profile: 'test',
    max_runtime_ms: 1000,
    max_output_bytes: 1024,
  },
};

test('JSON parser rejects duplicate keys and unsafe numeric spellings before conversion', () => {
  for (const input of [
    '{"a":1,"\\u0061":1}',
    '{"a":1,"a":1}',
    '{"a":-0}',
    '{"a":+1}',
    '{"a":01}',
    '{"a":1.0}',
    '{"a":1e3}',
    '{"a":9007199254740993}',
  ]) {
    assert.throws(() => parseProtocolJson(input));
  }
  assert.equal(
    JSON.stringify(parseProtocolJson('{"a":0,"b":9007199254740991}')),
    '{"a":0,"b":9007199254740991}',
  );
  assert.throws(() => parseProtocolJson(new Uint8Array([0xff])));
  assert.throws(() => parseProtocolJson('{"a":"\\ud800"}'));
  assert.equal(evaluateRequest(frame('{"protocol_version":1,"protocol_version":1}')).ok, false);
});

test('base64url decoder requires canonical spelling and exact length', () => {
  assert.equal(decodeBase64Url(hash, 32).length, 32);
  for (const alias of [hash + '=', hash.slice(0, -1) + 'B', '***'])
    assert.throws(() => decodeBase64Url(alias, 32));
});

test('framing validates exact single bounded frame', () => {
  assert.equal(decodeFrame(frame('{"a":1}')).length, 7);
  assert.throws(() => decodeFrame(Buffer.from([0, 0, 0, 4, 123])));
  assert.throws(() => decodeFrame(Buffer.from([0, 0, 0, 0])));
  assert.throws(() => decodeFrame(Buffer.from([0, 0, 0])));
  const maxRequest = Buffer.alloc(65540);
  maxRequest.writeUInt32BE(65536);
  assert.equal(decodeFrame(maxRequest).length, 65536);
  assert.throws(() => decodeFrame(Buffer.concat([frame('{}'), Buffer.from([0])])));
});

test('canonical JSON sorts keys and ignores input whitespace while retaining string semantics', () => {
  assert.equal(canonicalJson(parseProtocolJson('{ "z": 1, "a": 2 }')), '{"a":2,"z":1}');
});

test('request hash uses the approved domain and semantic fields', () => {
  const expected = createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from('OMNIS-OS-RUNTIME-REQUEST\0'),
        Buffer.from([0, 1]),
        Buffer.from(
          '{"arguments":{"generation":1,"run_id":"' +
            uuid +
            '"},"operation":"launch","operation_id":"' +
            uuid +
            '","protocol_version":1}',
        ),
      ]),
    )
    .digest('base64url');
  assert.equal(requestHash(request), expected);
  assert.equal(
    requestHash({ ...request, request_id: '22222222-2222-4222-8222-222222222222' }),
    expected,
  );
  assert.notEqual(requestHash({ ...request, protocol_version: 2 }), expected);
  assert.notEqual(
    requestHash({ ...request, arguments: { run_id: uuid, generation: 2 } }),
    expected,
  );
});

test('schema and synthetic verifier reject substitution and invalid signatures', () => {
  const parsed = evaluateRequest(frame(JSON.stringify(request)));
  assert.equal(parsed.ok, true);
  const mutated = {
    ...request,
    arguments: { run_id: '33333333-3333-4333-8333-333333333333', generation: 1 },
  };
  assert.equal(evaluateRequest(frame(JSON.stringify(mutated))).ok, false);
  let observed: Uint8Array | undefined;
  assert.equal(
    verifySyntheticCapability(request.capability, (message, signature) => {
      observed = message;
      assert.equal(signature.length, 64);
      return true;
    }).ok,
    true,
  );
  assert.equal(
    Buffer.from(observed!).toString(),
    `OMNIS-OS-RUNTIME-CAPABILITY\0${canonicalJson(request.capability.protected)}\0${canonicalJson(request.capability.claims)}`,
  );
  assert.equal(
    verifySyntheticCapability(request.capability, () => {
      throw new Error('synthetic failure');
    }).ok,
    false,
  );
  assert.equal(verifySyntheticCapability(request.capability, () => false).ok, false);
  assert.equal(
    verifySyntheticCapability({ ...request.capability, signature: '***' }, () => true).ok,
    false,
  );
});

test('policy denies unsafe profiles and replay never grants a second permit', () => {
  assert.equal(evaluateRequest(frame(JSON.stringify({ ...request, operation: 'exec' }))).ok, false);
  for (const invalidUuid of [
    '11111111-1111-4111-7111-111111111111',
    '11111111-1111-0111-8111-111111111111',
  ]) {
    assert.equal(
      evaluateRequest(frame(JSON.stringify({ ...request, operation_id: invalidUuid }))).ok,
      false,
    );
  }
  const first = reduceReplay([], { operationId: uuid, jti: uuid, requestHash: hash });
  assert.equal(first.permit, true);
  assert.equal(
    reduceReplay([], { operationId: 'bad', jti: uuid, requestHash: hash }).classification,
    'AUTHORIZATION_FAILURE',
  );
  assert.equal(
    reduceReplay([], { operationId: uuid, jti: uuid, requestHash: `${hash}=` }).classification,
    'AUTHORIZATION_FAILURE',
  );
  const repeat = reduceReplay(first.state, { operationId: uuid, jti: uuid, requestHash: hash });
  assert.equal(repeat.permit, false);
  assert.equal(repeat.classification, 'OUTCOME_UNKNOWN');
  assert.equal(
    reduceReplay(first.state, {
      operationId: uuid,
      jti: '22222222-2222-4222-8222-222222222222',
      requestHash: hash,
    }).classification,
    'AUTHORIZATION_FAILURE',
  );
  const conflict = reduceReplay(first.state, {
    operationId: uuid,
    jti: uuid,
    requestHash: Buffer.alloc(32, 1).toString('base64url'),
  });
  assert.equal(conflict.classification, 'REPLAY_CONFLICT');
});

test('policy binds peer and authoritative identities before allow', async () => {
  const { evaluatePolicy } = await import('./index.ts');
  const args = {
    peerSubject: 'synthetic-peer',
    expectedIssuer: 'synthetic-issuer',
    expectedAudience: 'runtime-gateway',
    policyDigest: `sha256:${'b'.repeat(64)}`,
    authorizationId: uuid,
    leaseId: 'lease-1',
    taskId: 'task-1',
    projectId: `prj_${'a'.repeat(32)}`,
    fixedRestrictions: request.capability.claims.restrictions as PolicyContext['fixedRestrictions'],
    now: 1,
    allowed: true,
    verify: () => true,
  };
  assert.deepEqual(evaluatePolicy(frame(JSON.stringify(request)), args), {
    decision: 'allow',
    reason: 'permitted',
    effectState: 'not_attempted',
  });
  assert.equal(
    evaluatePolicy(frame(JSON.stringify(request)), { ...args, allowed: false }).reason,
    'policy_denied',
  );
  assert.equal(
    evaluatePolicy(frame(JSON.stringify(request)), { ...args, now: 2 }).reason,
    'capability_invalid',
  );
  assert.equal(
    evaluatePolicy(frame(JSON.stringify(request)), { ...args, peerSubject: 'substituted' })
      .decision,
    'deny',
  );
  assert.equal(
    evaluatePolicy(frame(JSON.stringify(request)), { ...args, expectedIssuer: 'wrong' }).decision,
    'deny',
  );
  assert.equal(
    evaluatePolicy(frame(JSON.stringify(request)), { ...args, expectedAudience: 'wrong' }).decision,
    'deny',
  );
  assert.equal(
    evaluatePolicy(frame(JSON.stringify(request)), { ...args, taskId: 'other-task' }).decision,
    'deny',
  );
  assert.equal(
    evaluatePolicy(frame(JSON.stringify(request)), {
      ...args,
      fixedRestrictions: { ...args.fixedRestrictions, max_runtime_ms: 999 },
    }).decision,
    'deny',
  );
});

test('audit records are bounded and reject invalid identities or sequence values', async () => {
  const { createAuditRecord } = await import('./index.ts');
  const record = {
    requestId: uuid,
    operationId: uuid,
    operation: 'launch',
    peerRole: 'synthetic-worker',
    jtiHash: hash,
    requestHash: hash,
    policyDigest: `sha256:${'b'.repeat(64)}`,
    classification: 'PERMITTED' as const,
    reasonCode: 'permitted',
    effectState: 'not_attempted' as const,
    durationBucket: 'lt_10ms' as const,
    sequence: 0,
  };
  assert.equal(createAuditRecord(record).sequence, 0);
  assert.throws(() => createAuditRecord({ ...record, sequence: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => createAuditRecord({ ...record, peerRole: 'x'.repeat(100) }));
  assert.throws(() => createAuditRecord({ ...record, reasonCode: 'unregistered_reason' }));
  assert.ok(Buffer.byteLength(JSON.stringify(createAuditRecord(record))) < 4096);
});

test('request entry point enforces framed payload cap and response result matches operation', async () => {
  const oversized = Buffer.alloc(65541);
  oversized.writeUInt32BE(65537);
  assert.equal(evaluateRequest(oversized).ok, false);
  const base = {
    protocol_version: 1,
    request_id: uuid,
    operation_id: uuid,
    classification: 'PERMITTED' as const,
    policy_decision: 'allow' as const,
    reason_code: 'permitted' as const,
    policy_digest: `sha256:${'a'.repeat(64)}`,
    effect_state: 'committed' as const,
  };
  assert.equal(
    validateResponseForOperation(
      { ...base, result: { run_id: uuid, generation: 1, state: 'running', output_cursor: null } },
      'launch',
    ).success,
    true,
  );
  assert.equal(
    validateResponseForOperation({ ...base, result: { arbitrary: 'value' } }, 'launch').success,
    false,
  );
});

test('response validation rejects contradictory classifications and execution states', () => {
  const result = { run_id: uuid, generation: 1, state: 'running', output_cursor: null };
  const permitted = {
    protocol_version: 1,
    request_id: uuid,
    operation_id: uuid,
    classification: 'PERMITTED',
    policy_decision: 'allow',
    reason_code: 'permitted',
    policy_digest: `sha256:${'a'.repeat(64)}`,
    effect_state: 'committed',
    result,
  };
  assert.equal(validateResponseForOperation(permitted, 'launch').success, true);
  assert.equal(
    validateResponseForOperation({ ...permitted, classification: 'POLICY_DENIAL' }, 'launch')
      .success,
    false,
  );
  assert.equal(
    validateResponseForOperation(
      { ...permitted, classification: 'AUTHORIZATION_FAILURE' },
      'launch',
    ).success,
    false,
  );
  assert.equal(
    validateResponseForOperation(
      {
        ...permitted,
        classification: 'OUTCOME_UNKNOWN',
        reason_code: 'outcome_unknown',
        effect_state: 'not_attempted',
        result: null,
      },
      'launch',
    ).success,
    false,
  );
  assert.equal(
    validateResponseForOperation(
      {
        ...permitted,
        classification: 'INTERNAL_FAILURE',
        reason_code: 'internal_failure',
        effect_state: 'committed',
        result: null,
      },
      'launch',
    ).success,
    false,
  );
  assert.equal(
    validateResponseForOperation(
      {
        ...permitted,
        classification: 'POLICY_DENIAL',
        reason_code: 'policy_denied',
        policy_decision: 'deny',
        effect_state: 'not_attempted',
        result: null,
      },
      'launch',
    ).success,
    true,
  );
  assert.equal(
    validateResponseForOperation(
      {
        ...permitted,
        classification: 'OUTCOME_UNKNOWN',
        reason_code: 'outcome_unknown',
        effect_state: 'unknown',
        result: null,
      },
      'launch',
    ).success,
    true,
  );
  assert.equal(
    validateResponseForOperation(
      {
        ...permitted,
        classification: 'OUTCOME_UNKNOWN',
        reason_code: 'outcome_unknown',
        effect_state: 'unknown',
        result: { run_id: uuid, generation: 1, state: 'unknown', output_cursor: null },
      },
      'launch',
    ).success,
    true,
  );
  assert.equal(
    validateResponseForOperation(
      {
        ...permitted,
        classification: 'OUTCOME_UNKNOWN',
        reason_code: 'outcome_unknown',
        effect_state: 'unknown',
        result,
      },
      'launch',
    ).success,
    false,
  );
});

test('response frames enforce exact payload boundaries and exit classes are closed', () => {
  const response = Buffer.alloc(16384, 0x61);
  assert.equal(decodeResponseFrame(encodeResponseFrame(response)).length, 16384);
  assert.throws(() => encodeResponseFrame(Buffer.alloc(16385)));
  const oversizeResponse = Buffer.alloc(16388);
  oversizeResponse.writeUInt32BE(16385);
  assert.throws(() => decodeResponseFrame(oversizeResponse));
  for (const allowed of ['succeeded', 'failed', 'interrupted', 'unknown'])
    assert.equal(ExitClassSchema.safeParse(allowed).success, true);
  assert.equal(ExitClassSchema.safeParse('denied').success, false);
});

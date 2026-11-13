import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  decodeResponseFrame,
  evaluatePolicy,
  parseProtocolJson,
  requestHash,
  validateResponseForOperation,
} from '../../packages/runtime-protocol/src/index.ts';
export { requestHash };

const cloneFixture = (value) => JSON.parse(JSON.stringify(value));
export { cloneFixture };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fixedImage = `sha256:${'c'.repeat(64)}`;
const fixedPolicyDigest = `sha256:${'b'.repeat(64)}`;
const syntheticSignature = Buffer.alloc(64).toString('base64url');
const maxInputBytes = 65_536;
const maxOutputBytes = 8_192;

export function makeFrame(value) {
  const body = Buffer.from(typeof value === 'string' ? value : value);
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function makeSyntheticCapability(claims) {
  return {
    protected: { typ: 'omnis-runtime-cap+jcs', version: 1, alg: 'Ed25519', kid: 'stage-a-fixture' },
    claims,
    signature: syntheticSignature,
  };
}

export function buildProtocolRequest({
  runId = '11111111-1111-4111-8111-111111111111',
  generation = 1,
  operation = 'launch',
} = {}) {
  const request = {
    protocol_version: 1,
    request_id: '22222222-2222-4222-8222-222222222222',
    operation_id: '33333333-3333-4333-8333-333333333333',
    operation,
    arguments: { run_id: runId, generation },
    request_hash: Buffer.alloc(32).toString('base64url'),
    capability: makeSyntheticCapability({}),
  };
  request.request_hash = requestHash(request);
  request.capability.claims = {
    iss: 'stage-a-issuer',
    aud: 'stage-a-gateway',
    sub: 'stage-a-launcher',
    scope: 'synthetic_runtime',
    authorization_id: '44444444-4444-4444-8444-444444444444',
    lease_id: 'lease-fixture-1',
    run_id: runId,
    task_id: 'task-fixture-1',
    project_id: `prj_${'a'.repeat(32)}`,
    operation_id: request.operation_id,
    operation,
    generation,
    request_hash: request.request_hash,
    policy_digest: fixedPolicyDigest,
    restrictions: {
      image_digest: fixedImage,
      command_profile: 'mock-v1',
      network_profile: 'isolated-no-egress-v1',
      environment_profile: 'synthetic-nonsecrets-v1',
      scratch_profile: 'bounded-run-scratch-v1',
      resource_profile: 'stage-a-v1',
      max_runtime_ms: 1000,
      max_output_bytes: 1024,
    },
    jti: '55555555-5555-4555-8555-555555555555',
    not_before: 100,
    expires_at: 200,
  };
  return request;
}

export function makeSyntheticPolicyContext() {
  const request = buildProtocolRequest();
  return {
    peerSubject: 'stage-a-launcher',
    expectedIssuer: 'stage-a-issuer',
    expectedAudience: 'stage-a-gateway',
    policyDigest: fixedPolicyDigest,
    authorizationId: '44444444-4444-4444-8444-444444444444',
    leaseId: 'lease-fixture-1',
    taskId: 'task-fixture-1',
    projectId: `prj_${'a'.repeat(32)}`,
    fixedRestrictions: request.capability.claims.restrictions,
    now: 100,
    allowed: true,
    verify: (keyId, _message, signature) =>
      keyId === 'stage-a-fixture' && Buffer.from(signature).equals(Buffer.alloc(64)),
  };
}

export function evaluateOfflineRequest(frame, context = makeSyntheticPolicyContext()) {
  return evaluatePolicy(frame, context);
}

const stepTypes = new Set(['create', 'start', 'inspect', 'read_output', 'reconcile']);

export class FakeAuthorizationAuthority {
  constructor({
    now = 1000,
    available = true,
    revoked = false,
    authorizationRevision = 4,
    taskRevision = 2,
    profileRevision = 3,
    leaseRevision = 7,
    authorizationId = 'auth-fixture-1',
    taskId = 'task-fixture-1',
    profileId = 'profile-fixture-1',
    leaseId = 'lease-fixture-1',
    environmentEpoch = 'environment-fixture-1',
    inputProfileVersion = 'synthetic-input-v1',
    leaseOwner = 'worker-1',
    workerIdentity = 'uid:61001',
    ttlMs = 30_000,
  } = {}) {
    this.now = now;
    this.available = available;
    this.revoked = revoked;
    this.authorizationRevision = authorizationRevision;
    this.taskRevision = taskRevision;
    this.profileRevision = profileRevision;
    this.leaseRevision = leaseRevision;
    this.authorizationId = authorizationId;
    this.taskId = taskId;
    this.profileId = profileId;
    this.leaseId = leaseId;
    this.environmentEpoch = environmentEpoch;
    this.inputProfileVersion = inputProfileVersion;
    this.leaseOwner = leaseOwner;
    this.workerIdentity = workerIdentity;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 30_000)
      throw new Error('fixture ticket TTL must be within the proposed 30-second ceiling');
    this.ttlMs = ttlMs;
    this.nextJti = 1;
    this.nextReservation = 1;
    this.operations = new Map();
    this.tickets = new Map();
    this.dispatchClaims = new Set();
    this.registrations = new Map();
    this.armedStopLeases = new Map();
    this.fencedGenerations = new Set();
  }

  digestPayload(payload, binding = {}) {
    const context = JSON.stringify({
      inputProfileVersion: binding.inputProfileVersion ?? this.inputProfileVersion,
      authorizationRevision: binding.authorizationRevision ?? this.authorizationRevision,
      taskRevision: binding.taskRevision ?? this.taskRevision,
      profileRevision: binding.profileRevision ?? this.profileRevision,
      runId: binding.runId ?? '',
      generation: binding.generation ?? 0,
    });
    return createHash('sha256')
      .update('OMNIS-OS-STAGE-A-PAYLOAD\0')
      .update(context)
      .update('\0')
      .update(Buffer.from(payload))
      .digest('base64url');
  }

  reserve(intent) {
    if (!this.available) return rejected('authority_unavailable');
    if (!Number.isSafeInteger(this.now) || this.now < 0) return rejected('clock_invalid');
    if (intent.peerIdentity !== this.workerIdentity) return rejected('worker_identity');
    if (this.revoked) return rejected('authorization_revoked');
    if (
      intent.authorizationRevision !== this.authorizationRevision ||
      intent.taskRevision !== this.taskRevision ||
      intent.profileRevision !== this.profileRevision
    )
      return rejected('stale_revision');
    if (intent.leaseRevision !== this.leaseRevision) return rejected('lease_lost');
    if (!uuidPattern.test(intent.operationId) || !uuidPattern.test(intent.runId))
      return rejected('invalid_identity');
    if (!Number.isSafeInteger(intent.generation) || intent.generation < 1)
      return rejected('invalid_identity');
    if (!Buffer.isBuffer(intent.payload) && !(intent.payload instanceof Uint8Array))
      return rejected('payload_missing');
    const payload = Buffer.from(intent.payload);
    if (payload.length === 0) return rejected('payload_missing');
    if (payload.length > maxInputBytes) return rejected('payload_too_large');
    if (!stepTypes.has(intent.stepType)) return rejected('unsupported_step');

    let startBinding = null;
    if (intent.stepType === 'start') {
      const scope = `${intent.runId}:${intent.generation}`;
      if (this.fencedGenerations.has(scope)) return rejected('generation_fenced');
      const registration = this.registrations.get(scope);
      const stopLease = this.armedStopLeases.get(scope);
      if (!registration || !stopLease) return rejected('stop_registration_missing');
      if (
        registration.environmentEpoch !== this.environmentEpoch ||
        registration.registrationId !== intent.registrationId ||
        registration.revision !== intent.registrationRevision ||
        registration.digest !== intent.registrationDigest ||
        registration.revoked
      )
        return rejected('stale_stop_registration');
      if (
        stopLease.stopLeaseId !== intent.stopLeaseId ||
        stopLease.registrationId !== registration.registrationId ||
        stopLease.registrationRevision !== registration.revision ||
        stopLease.registrationDigest !== registration.digest ||
        stopLease.environmentEpoch !== this.environmentEpoch ||
        !stopLease.armed
      )
        return rejected('stop_lease_unarmed');
      if (this.now >= stopLease.absoluteDeadline || this.now >= stopLease.expiresAt)
        return rejected('stop_lease_expired');
      startBinding = { registration, stopLease };
    }

    const payloadContext = {
      inputProfileVersion: this.inputProfileVersion,
      authorizationRevision: this.authorizationRevision,
      taskRevision: this.taskRevision,
      profileRevision: this.profileRevision,
      runId: intent.runId,
      generation: intent.generation,
    };
    const payloadDigest = this.digestPayload(payload, payloadContext);
    const operationBinding = JSON.stringify({
      runId: intent.runId,
      generation: intent.generation,
      payloadDigest,
      payloadLength: payload.length,
      authorizationId: this.authorizationId,
      authorizationRevision: this.authorizationRevision,
      taskId: this.taskId,
      taskRevision: this.taskRevision,
      profileId: this.profileId,
      profileRevision: this.profileRevision,
      inputProfileVersion: this.inputProfileVersion,
      leaseId: this.leaseId,
      leaseOwner: this.leaseOwner,
      leaseRevision: this.leaseRevision,
    });
    let operation = this.operations.get(intent.operationId);
    if (operation && operation.binding !== operationBinding) return rejected('operation_conflict');
    if (!operation) {
      if (intent.stepIndex !== 0 || intent.stepType !== 'create') return rejected('step_order');
      operation = { binding: operationBinding, nextStep: 0, activeJti: null, status: 'active' };
      this.operations.set(intent.operationId, operation);
    }
    if (
      operation.status !== 'active' ||
      operation.activeJti !== null ||
      intent.stepIndex !== operation.nextStep ||
      (intent.stepIndex === 0 ? intent.stepType !== 'create' : intent.stepType === 'create')
    )
      return rejected('step_order');

    const jti = fixtureUuid(this.nextJti++);
    const reservationRevision = this.nextReservation++;
    const reservationId = fixtureUuid(reservationRevision);
    const ticket = Object.freeze({
      version: 1,
      operationId: intent.operationId,
      stepIndex: intent.stepIndex,
      stepType: intent.stepType,
      reservationId,
      reservationRevision,
      authorizationId: this.authorizationId,
      authorizationRevision: this.authorizationRevision,
      taskId: this.taskId,
      taskRevision: this.taskRevision,
      profileId: this.profileId,
      profileRevision: this.profileRevision,
      runId: intent.runId,
      generation: intent.generation,
      leaseOwner: this.leaseOwner,
      leaseId: this.leaseId,
      leaseRevision: this.leaseRevision,
      inputProfileVersion: this.inputProfileVersion,
      payloadDigest,
      payloadLength: payload.length,
      policyRestrictions: Object.freeze({
        policyDigest: fixedPolicyDigest,
        imageDigest: fixedImage,
        network: 'none',
        tools: 'none',
        outputLimit: maxOutputBytes,
      }),
      registration: startBinding
        ? Object.freeze({
            registrationId: startBinding.registration.registrationId,
            revision: startBinding.registration.revision,
            digest: startBinding.registration.digest,
            handle: startBinding.registration.handle,
          })
        : null,
      stopLease: startBinding
        ? Object.freeze({
            stopLeaseId: startBinding.stopLease.stopLeaseId,
            absoluteDeadline: startBinding.stopLease.absoluteDeadline,
            expiresAt: startBinding.stopLease.expiresAt,
          })
        : null,
      issuer: 'stage-a-authorizer',
      audience: 'stage-a-gateway',
      peerIdentity: 'uid:61002',
      jti,
      issuedAt: this.now,
      expiresAt: this.now + this.ttlMs,
      signature: 'synthetic-fixture-only',
    });
    operation.activeJti = jti;
    this.tickets.set(jti, { ticket, operation, state: 'reserved', dispatchClaimed: false });
    return { ok: true, ticket };
  }

  consume(ticket, { now = this.now, payload } = {}) {
    const record = ticket && this.tickets.get(ticket.jti);
    if (!this.available) return rejected('authority_unavailable');
    if (!record || JSON.stringify(record.ticket) !== JSON.stringify(ticket))
      return rejected('authorization_failure');
    if (record.state !== 'reserved') return rejected('replay_conflict');
    if (this.revoked) return rejected('authorization_revoked');
    if (ticket.authorizationRevision !== this.authorizationRevision)
      return rejected('stale_revision');
    if (ticket.leaseRevision !== this.leaseRevision) return rejected('lease_lost');
    if (!Number.isSafeInteger(now) || now < 0 || now >= ticket.expiresAt)
      return rejected('ticket_expired');
    if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array))
      return rejected('payload_missing');
    const submitted = Buffer.from(payload);
    if (
      submitted.length !== ticket.payloadLength ||
      this.digestPayload(submitted, ticket) !== ticket.payloadDigest
    )
      return rejected('payload_mismatch');
    record.state = 'consumed';
    return { ok: true, status: 'consumed' };
  }

  claimDispatch(jti, { now = this.now } = {}) {
    const record = this.tickets.get(jti);
    if (!this.available) return rejected('authority_unavailable');
    if (!record || record.state !== 'consumed' || record.dispatchClaimed)
      return rejected('dispatch_not_permitted');
    if (!Number.isSafeInteger(now) || now < 0 || now >= record.ticket.expiresAt)
      return rejected('ticket_expired');
    // Consumption is the modeled linearization point for this exact step.
    // A later revocation does not roll back a consumed step; a pre-consumption
    // revocation is rejected by consume(). This is fixture contract behavior,
    // not a claim of cross-service atomicity.
    record.dispatchClaimed = true;
    record.state = 'dispatched';
    this.dispatchClaims.add(jti);
    return { ok: true, fixtureOnly: true };
  }

  completeStep(jti, outcome) {
    const record = this.tickets.get(jti);
    if (!record) return rejected('invalid_transition');
    if (outcome === 'unknown') {
      if (!['consumed', 'dispatched'].includes(record.state)) return rejected('invalid_transition');
      record.state = 'unknown';
      record.operation.status = 'unknown';
      return { ok: true, state: 'unknown' };
    }
    if (record.state !== 'dispatched' || !record.dispatchClaimed)
      return rejected('invalid_transition');
    if (outcome !== 'completed' && outcome !== 'failed') return rejected('invalid_transition');
    record.state = outcome;
    if (outcome === 'failed') {
      record.operation.status = 'failed';
      return { ok: true, state: 'failed' };
    }
    record.operation.nextStep = record.ticket.stepIndex + 1;
    record.operation.activeJti = null;
    return { ok: true, state: outcome };
  }

  revoke() {
    this.revoked = true;
    this.authorizationRevision++;
  }

  registerRuntime({
    runId,
    generation,
    registrationId,
    revision,
    digest,
    handle,
    environmentEpoch = this.environmentEpoch,
    registrarSignatureValid = true,
    terminatorArmingValid = true,
  }) {
    const scope = `${runId}:${generation}`;
    if (this.fencedGenerations.has(scope)) return rejected('generation_fenced');
    if (
      environmentEpoch !== this.environmentEpoch ||
      !uuidPattern.test(runId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      typeof registrationId !== 'string' ||
      registrationId.length < 1 ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      typeof digest !== 'string' ||
      digest.length < 1 ||
      typeof handle !== 'string' ||
      handle.length < 1 ||
      !registrarSignatureValid ||
      !terminatorArmingValid
    )
      return rejected('registration_invalid');
    const registration = Object.freeze({
      runId,
      generation,
      registrationId,
      revision,
      digest,
      handle,
      environmentEpoch,
      revoked: false,
      fixtureOnly: true,
    });
    const current = this.registrations.get(scope);
    if (current) {
      const currentBody = JSON.stringify({
        runId: current.runId,
        generation: current.generation,
        registrationId: current.registrationId,
        revision: current.revision,
        digest: current.digest,
        handle: current.handle,
        environmentEpoch: current.environmentEpoch,
        revoked: current.revoked,
      });
      const nextBody = JSON.stringify({
        runId: registration.runId,
        generation: registration.generation,
        registrationId: registration.registrationId,
        revision: registration.revision,
        digest: registration.digest,
        handle: registration.handle,
        environmentEpoch: registration.environmentEpoch,
        revoked: registration.revoked,
      });
      if (registration.revision < current.revision) return rejected('stale_registration');
      if (registration.revision === current.revision)
        return currentBody === nextBody
          ? { ok: true, registration: current, replayed: true }
          : rejected('registration_conflict');
      this.armedStopLeases.delete(scope);
    }
    this.registrations.set(scope, registration);
    return { ok: true, registration };
  }

  armStopLease({
    runId,
    generation,
    stopLeaseId,
    registrationId,
    registrationRevision,
    registrationDigest,
    absoluteDeadline,
    notBefore = this.now,
    expiresAt,
    maximumTerminationGraceMs,
    evidenceWindowMs,
    environmentEpoch = this.environmentEpoch,
    issuerValid = true,
  }) {
    const scope = `${runId}:${generation}`;
    const registration = this.registrations.get(scope);
    if (
      !registration ||
      registration.registrationId !== registrationId ||
      registration.revision !== registrationRevision ||
      registration.digest !== registrationDigest
    )
      return rejected('stop_registration_mismatch');
    if (
      environmentEpoch !== this.environmentEpoch ||
      !issuerValid ||
      typeof stopLeaseId !== 'string' ||
      stopLeaseId.length < 1 ||
      !Number.isSafeInteger(absoluteDeadline) ||
      !Number.isSafeInteger(notBefore) ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(maximumTerminationGraceMs) ||
      maximumTerminationGraceMs < 0 ||
      !Number.isSafeInteger(evidenceWindowMs) ||
      evidenceWindowMs < 0 ||
      notBefore > this.now ||
      expiresAt < absoluteDeadline + maximumTerminationGraceMs + evidenceWindowMs
    )
      return rejected('stop_lease_invalid');
    const lease = Object.freeze({
      runId,
      generation,
      stopLeaseId,
      registrationId,
      registrationRevision,
      registrationDigest,
      absoluteDeadline,
      notBefore,
      expiresAt,
      maximumTerminationGraceMs,
      evidenceWindowMs,
      environmentEpoch,
      armed: true,
      fixtureOnly: true,
    });
    this.armedStopLeases.set(scope, lease);
    return { ok: true, lease };
  }

  recordStopIntent({ runId, generation, stopOperationId }) {
    if (!uuidPattern.test(runId) || !Number.isSafeInteger(generation) || generation < 1)
      return rejected('stop_scope_invalid');
    if (typeof stopOperationId !== 'string' || stopOperationId.length < 1)
      return rejected('stop_operation_invalid');
    this.fencedGenerations.add(`${runId}:${generation}`);
    return { ok: true, fenced: true, fixtureOnly: true };
  }

  revokeRegistration({ runId, generation, revision }) {
    const scope = `${runId}:${generation}`;
    const registration = this.registrations.get(scope);
    if (!registration || registration.revision !== revision) return rejected('stale_registration');
    this.registrations.set(scope, Object.freeze({ ...registration, revoked: true }));
    this.fencedGenerations.add(scope);
    return { ok: true, fenced: true };
  }

  supersedeLease() {
    this.leaseRevision++;
    this.leaseOwner = 'worker-2';
  }
}

function rejected(reason) {
  return { ok: false, status: 'rejected', reason };
}

function fixtureUuid(counter) {
  const suffix = String(counter).padStart(12, '0');
  return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
}

const engineLimits = Object.freeze({
  AutoRemove: false,
  Privileged: false,
  NetworkMode: 'none',
  PidMode: '',
  IpcMode: '',
  ReadonlyRootfs: true,
  CapDrop: Object.freeze(['ALL']),
  SecurityOpt: Object.freeze(['no-new-privileges:true']),
  Binds: Object.freeze([]),
  Mounts: Object.freeze([]),
  Tmpfs: Object.freeze({ '/workspace': 'rw,noexec,nosuid,nodev,size=65536k' }),
  Memory: 67_108_864,
  MemorySwap: 67_108_864,
  NanoCpus: 500_000_000,
  PidsLimit: 32,
  PortBindings: Object.freeze({}),
  PublishAllPorts: false,
  Devices: Object.freeze([]),
  DeviceRequests: Object.freeze([]),
  LogConfig: Object.freeze({
    Type: 'local',
    Config: Object.freeze({ 'max-size': '1m', 'max-file': '1' }),
  }),
});

export function makeSafeEngineCreateRequest({ runId, generation }) {
  const name = deriveContainerName(runId, generation);
  return {
    Image: fixedImage,
    Entrypoint: ['/usr/local/bin/omnis-synthetic-v1'],
    Cmd: ['execute', '--profile', 'mock-v1'],
    User: '10001:10001',
    WorkingDir: '/workspace',
    Env: ['OMNIS_MODE=synthetic'],
    Labels: {
      'omnis.run-id': runId,
      'omnis.generation': String(generation),
      'omnis.owner': 'stage-a-fixture',
    },
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    HostConfig: cloneFixture(engineLimits),
    name,
  };
}

export class FakeDockerEngineRecorder {
  constructor() {
    this.calls = [];
    this.maxOutputBytes = maxOutputBytes;
  }

  createContainer(request) {
    const { name, ...body } = request ?? {};
    const labels = body?.Labels ?? {};
    const expected = makeSafeEngineCreateRequest({
      runId: labels['omnis.run-id'],
      generation: Number(labels['omnis.generation']),
    });
    assert.equal(name, expected.name);
    delete expected.name;
    assert.deepStrictEqual(body, expected);
    const saved = cloneFixture(request);
    this.calls.push({ operation: 'create', request: saved });
    return saved;
  }

  startContainer(binding) {
    if (!binding || binding.authorized !== true || !binding.registrationId || !binding.stopLeaseId)
      throw new Error('start authorization, registration, and armed stop lease are required');
    const saved = cloneFixture(binding);
    this.calls.push({ operation: 'start', request: saved });
    return saved;
  }

  readOutput(bytes) {
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array))
      throw new Error('output must be a byte buffer');
    if (bytes.byteLength > this.maxOutputBytes) throw new Error('output limit exceeded');
    const output = Buffer.from(bytes);
    this.calls.push({ operation: 'read_output', bytes: output.length });
    return output;
  }
}

export function deriveContainerName(runId, generation) {
  if (!uuidPattern.test(runId)) throw new Error('invalid run identifier');
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647)
    throw new Error('invalid execution generation');
  return `omnis-${runId.replaceAll('-', '')}-g${generation}`;
}

export function makeProtocolResponse({ runId, generation, state = 'completed' }) {
  return {
    protocol_version: 1,
    request_id: '22222222-2222-4222-8222-222222222222',
    operation_id: '33333333-3333-4333-8333-333333333333',
    classification: 'PERMITTED',
    policy_decision: 'allow',
    reason_code: 'permitted',
    policy_digest: fixedPolicyDigest,
    effect_state: 'committed',
    result: { run_id: runId, generation, state, output_cursor: null },
  };
}

export function parseEngineResponse(
  { contentType, body, expectedRequestId, expectedOperationId, expectedRunId, expectedGeneration },
  operation,
) {
  if (contentType !== 'application/json')
    return { ok: false, classification: 'MALFORMED_RESPONSE' };
  if (
    !(body instanceof Uint8Array) ||
    body.byteLength > 16_388 ||
    !uuidPattern.test(expectedRequestId ?? '') ||
    !uuidPattern.test(expectedOperationId ?? '') ||
    !uuidPattern.test(expectedRunId ?? '') ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 1
  )
    return { ok: false, classification: 'MALFORMED_RESPONSE' };
  try {
    const value = parseProtocolJson(decodeResponseFrame(body));
    const parsed = validateResponseForOperation(value, operation);
    if (!parsed.success) return { ok: false, classification: 'MALFORMED_RESPONSE' };
    if (
      parsed.data.request_id !== expectedRequestId ||
      parsed.data.operation_id !== expectedOperationId ||
      (parsed.data.result !== null &&
        (parsed.data.result.run_id !== expectedRunId ||
          parsed.data.result.generation !== expectedGeneration))
    )
      return { ok: false, classification: 'MALFORMED_RESPONSE' };
    return { ok: true, classification: parsed.data.classification };
  } catch {
    return { ok: false, classification: 'MALFORMED_RESPONSE' };
  }
}

export function parseEngineLogs(bytes, maxBytes = maxOutputBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maxOutputBytes)
    throw new Error('invalid log output limit');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
    throw new Error('log output limit exceeded');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) throw new Error('truncated log header');
    const streamId = buffer[offset];
    if (
      (streamId !== 1 && streamId !== 2) ||
      buffer[offset + 1] !== 0 ||
      buffer[offset + 2] !== 0 ||
      buffer[offset + 3] !== 0
    )
      throw new Error('invalid log stream header');
    const length = buffer.readUInt32BE(offset + 4);
    if (length > maxBytes || offset + 8 + length > buffer.length)
      throw new Error('truncated or oversized log frame');
    frames.push({
      stream: streamId === 1 ? 'stdout' : 'stderr',
      bytes: Buffer.from(buffer.subarray(offset + 8, offset + 8 + length)),
    });
    offset += 8 + length;
  }
  return frames;
}

const transitions = Object.freeze({
  ticket_reserved: new Set(['ticket_consumed']),
  ticket_consumed: new Set(['dispatch_attempted']),
  dispatch_attempted: new Set(['engine_ack_lost', 'reconciliation_pending']),
  engine_ack_lost: new Set(['reconciliation_pending']),
  // Terminal classification is reachable only through reconcile(), where the
  // operation/run/generation evidence is checked. Generic transitions cannot
  // assert that an ambiguous Engine mutation completed or had no effect.
  reconciliation_pending: new Set(['outcome_unknown']),
  outcome_unknown: new Set(),
  definitively_completed: new Set(),
  definitively_failed: new Set(),
});

export class OfflineOutcomeLedger {
  constructor() {
    this.records = new Map();
    this.nextId = 1;
  }

  reserve(binding) {
    if (!uuidPattern.test(binding.operationId) || !uuidPattern.test(binding.runId))
      throw new Error('invalid operation binding');
    if (
      [...this.records.values()].some(
        (record) => record.binding.operationId === binding.operationId,
      )
    )
      throw new Error('operation already reserved');
    const id = `mutation-${this.nextId++}`;
    this.records.set(id, {
      binding: cloneFixture(binding),
      state: 'ticket_reserved',
      dispatchCount: 0,
    });
    return id;
  }

  transition(id, next) {
    const record = this.records.get(id);
    if (!record || !transitions[record.state]?.has(next))
      return { ok: false, state: record?.state ?? 'missing' };
    if (next === 'dispatch_attempted') record.dispatchCount++;
    record.state = next;
    return { ok: true, state: record.state };
  }

  reconcile(id, evidence) {
    const record = this.records.get(id);
    if (!record || record.state !== 'reconciliation_pending')
      return { ok: false, state: record?.state ?? 'missing' };
    const identityMatches =
      evidence?.operationId === record.binding.operationId &&
      evidence?.runId === record.binding.runId &&
      evidence?.generation === record.binding.generation &&
      evidence?.source === 'synthetic-exact-inspect';
    if (!identityMatches) record.state = 'outcome_unknown';
    else if (evidence.observation === 'owned_completed') record.state = 'definitively_completed';
    else if (evidence.observation === 'confirmed_no_effect') record.state = 'definitively_failed';
    else record.state = 'outcome_unknown';
    return { ok: true, state: record.state };
  }

  canDispatchAgain(id) {
    const record = this.records.get(id);
    return Boolean(record && record.dispatchCount === 0 && record.state === 'ticket_consumed');
  }
}

export class MockMonotonicAnchor {
  constructor({
    epoch = 'fixture-epoch-1',
    sequence = 0,
    digest = 'genesis',
    available = true,
  } = {}) {
    this.epoch = epoch;
    this.sequence = sequence;
    this.digest = digest;
    this.available = available;
  }

  advance(local, next) {
    if (!this.available) return { ok: false, reason: 'anchor_unavailable' };
    if (
      local.epoch !== this.epoch ||
      local.sequence !== this.sequence ||
      local.digest !== this.digest ||
      next.sequence !== this.sequence + 1 ||
      typeof next.digest !== 'string' ||
      next.digest.length === 0
    )
      return { ok: false, reason: 'anchor_conflict' };
    this.sequence = next.sequence;
    this.digest = next.digest;
    return {
      ok: true,
      receipt: {
        epoch: this.epoch,
        sequence: this.sequence,
        digest: this.digest,
        fixtureOnly: true,
      },
    };
  }

  admit(local) {
    if (!this.available) return { ok: false, reason: 'anchor_unavailable' };
    const ok =
      local.epoch === this.epoch &&
      local.sequence === this.sequence &&
      local.digest === this.digest;
    return { ok, reason: ok ? 'matched' : 'anchor_mismatch' };
  }
}

export class MockTerminationAuthority {
  constructor() {
    this.registrations = new Map();
    this.requests = new Map();
    this.realProcessesTerminated = false;
  }

  register({ runId, generation, cgroupId }) {
    if (
      !uuidPattern.test(runId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !/^cg-fixture-[a-z0-9]+$/.test(cgroupId)
    )
      throw new Error('invalid fixture registration');
    this.registrations.set(`${runId}:${generation}`, cgroupId);
  }

  requestStop(request) {
    const registration = this.registrations.get(`${request.runId}:${request.generation}`);
    if (
      request.authority !== 'synthetic-stop-only' ||
      !registration ||
      registration !== request.cgroupId ||
      typeof request.stopId !== 'string' ||
      request.stopId.length < 1 ||
      this.requests.has(request.stopId)
    )
      return { status: 'denied' };
    this.requests.set(request.stopId, {
      status: 'attempted',
      runId: request.runId,
      generation: request.generation,
      cgroupId: request.cgroupId,
    });
    return { status: 'attempted' };
  }

  confirm(stopId, evidence) {
    const request = this.requests.get(stopId);
    if (!request) return { status: 'unknown' };
    if (
      !evidence ||
      evidence.emptyCgroup !== true ||
      !Array.isArray(evidence.processInventory) ||
      evidence.processInventory.length !== 0
    ) {
      request.status = 'unknown';
      return { status: 'unknown' };
    }
    request.status = 'confirmed';
    return { status: 'confirmed' };
  }
}

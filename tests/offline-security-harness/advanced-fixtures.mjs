import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Fixed in-process fixture material only. This is not key custody or a production signer.
const fixtureKey = Buffer.from('offline-stage-a-fixture-key');
const clone = (value) => structuredClone(value);
const reject = (reason) => ({ ok: false, status: 'rejected', reason });
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const signFixture = (body) =>
  createHmac('sha256', fixtureKey).update(stable(body)).digest('base64url');
const verifyFixture = (envelope) => {
  if (typeof envelope?.signature !== 'string' || !envelope.body) return false;
  const expected = Buffer.from(signFixture(envelope.body));
  const actual = Buffer.from(envelope.signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const scope = ({ runId, generation }) => `${runId}:${generation}`;

export function makeOutcomeBody(ticket, overrides = {}) {
  return {
    reportId: 'report-fixture-1',
    ledgerRevision: 1,
    issuer: 'stage-a-gateway',
    audience: 'stage-a-authorizer',
    gatewayId: 'gateway-fixture',
    gatewayInstance: 'gateway-boot-fixture',
    operationId: ticket.operationId,
    stepIndex: ticket.stepIndex,
    stepType: ticket.stepType,
    reservationId: ticket.reservationId,
    reservationRevision: ticket.reservationRevision,
    authorizationRevision: ticket.authorizationRevision,
    leaseRevision: ticket.leaseRevision,
    ticketJti: ticket.jti,
    runId: ticket.runId,
    generation: ticket.generation,
    requestDigest: ticket.payloadDigest,
    payloadLength: ticket.payloadLength,
    state: 'CONSUMED',
    evidenceDigest: 'sha256:synthetic-evidence',
    ...overrides,
  };
}

export function makeOutcomeEnvelope(body, overrides = {}) {
  return {
    keyId: 'gateway-fixture-key',
    body: clone(body),
    signature: signFixture(body),
    ...overrides,
  };
}

export class FakeOutcomeLedger {
  constructor({ available = true, peer = 'uid:61003' } = {}) {
    this.available = available;
    this.peer = peer;
    this.revision = 1;
    this.tickets = new Map();
    this.reports = new Map();
    this.dispatches = new Set();
    this.operations = new Map();
  }

  register(ticket) {
    if (!ticket?.jti || this.tickets.has(ticket.jti)) return reject('ticket_conflict');
    let operation = this.operations.get(ticket.operationId);
    if (!operation) {
      if (ticket.stepIndex !== 0 || ticket.stepType !== 'create') return reject('step_order');
      operation = { nextStep: 0, state: 'active', activeJti: null };
      this.operations.set(ticket.operationId, operation);
    }
    if (
      operation.state !== 'active' ||
      operation.activeJti ||
      ticket.stepIndex !== operation.nextStep
    )
      return reject('step_order');
    operation.activeJti = ticket.jti;
    this.tickets.set(ticket.jti, { ticket: clone(ticket), state: 'RESERVED' });
    return { ok: true, fixtureOnly: true };
  }

  submit(envelope, { peerIdentity } = {}) {
    if (!this.available) return reject('authorizer_unavailable');
    const body = envelope?.body;
    if (peerIdentity !== this.peer) return reject('gateway_peer');
    if (
      envelope?.keyId !== 'gateway-fixture-key' ||
      body?.issuer !== 'stage-a-gateway' ||
      body?.audience !== 'stage-a-authorizer' ||
      body?.gatewayId !== 'gateway-fixture' ||
      body?.gatewayInstance !== 'gateway-boot-fixture' ||
      !verifyFixture(envelope)
    )
      return reject('gateway_authentication');
    const fingerprint = stable(body);
    const prior = this.reports.get(body.reportId);
    if (prior)
      return prior.fingerprint === fingerprint
        ? { ok: true, replayed: true, receipt: clone(prior.receipt) }
        : reject('report_id_conflict');
    if (!body.reportId || body.ledgerRevision !== this.revision)
      return reject('stale_ledger_revision');
    const record = this.tickets.get(body.ticketJti);
    if (!record) return reject('ticket_unknown');
    if (!this.#matches(body, record.ticket)) return reject('ticket_binding');
    const operation = this.operations.get(record.ticket.operationId);
    if (
      !operation ||
      operation.state !== 'active' ||
      operation.activeJti !== record.ticket.jti ||
      record.ticket.stepIndex !== operation.nextStep
    )
      return reject('step_order');
    if (!this.#transitionAllowed(record.state, body.state)) return reject('outcome_order');
    record.state = body.state;
    if (body.state === 'UNKNOWN') operation.state = 'unknown';
    if (body.state === 'ACKNOWLEDGED') {
      operation.nextStep++;
      operation.activeJti = null;
    }
    this.revision++;
    const receipt = Object.freeze({
      reportId: body.reportId,
      revision: this.revision,
      state: body.state,
      ticketJti: body.ticketJti,
      fixtureOnly: true,
    });
    this.reports.set(body.reportId, { fingerprint, receipt });
    return { ok: true, replayed: false, receipt };
  }

  #matches(body, ticket) {
    return (
      body.operationId === ticket.operationId &&
      body.stepIndex === ticket.stepIndex &&
      body.stepType === ticket.stepType &&
      body.reservationId === ticket.reservationId &&
      body.reservationRevision === ticket.reservationRevision &&
      body.authorizationRevision === ticket.authorizationRevision &&
      body.leaseRevision === ticket.leaseRevision &&
      body.ticketJti === ticket.jti &&
      body.runId === ticket.runId &&
      body.generation === ticket.generation &&
      body.requestDigest === ticket.payloadDigest &&
      body.payloadLength === ticket.payloadLength
    );
  }

  #transitionAllowed(current, next) {
    return (
      (current === 'RESERVED' && next === 'CONSUMED') ||
      (current === 'CONSUMED' && ['DISPATCHED', 'UNKNOWN'].includes(next)) ||
      (current === 'DISPATCHED' && ['ACKNOWLEDGED', 'UNKNOWN'].includes(next))
    );
  }

  recoverAfterGatewayCrash(jti) {
    const record = this.tickets.get(jti);
    if (!this.available) return reject('authorizer_unavailable');
    if (!record) return reject('ticket_unknown');
    if (['CONSUMED', 'DISPATCHED'].includes(record.state)) {
      record.state = 'UNKNOWN';
      const operation = this.operations.get(record.ticket.operationId);
      if (operation) {
        operation.state = 'unknown';
        operation.activeJti = null;
      }
      this.revision++;
    }
    return { ok: true, state: record.state, revision: this.revision, fixtureOnly: true };
  }

  claimDispatch(jti) {
    const record = this.tickets.get(jti);
    if (!record || record.state !== 'DISPATCHED' || this.dispatches.has(jti))
      return reject('dispatch_not_permitted');
    this.dispatches.add(jti);
    return { ok: true, fixtureOnly: true };
  }

  state(jti) {
    return this.tickets.get(jti)?.state ?? 'UNKNOWN';
  }
}

export class FakeStopAuthority {
  constructor({ now = 1000, terminatorPeer = 'uid:61005', actuatorPeer = 'uid:61006' } = {}) {
    this.now = now;
    this.terminatorPeer = terminatorPeer;
    this.actuatorPeer = actuatorPeer;
    this.registrations = new Map();
    this.leases = new Map();
    this.fenced = new Set();
    this.used = new Map();
    this.records = new Map();
  }

  register(value) {
    const id = scope(value);
    if (this.fenced.has(id)) return reject('generation_fenced');
    if (
      !value?.runId ||
      !Number.isSafeInteger(value.generation) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !value.registrationId ||
      !value.digest ||
      !value.handle ||
      value.signatureValid !== true
    )
      return reject('registration_invalid');
    const registration = Object.freeze({ ...value, fixtureOnly: true });
    const current = this.registrations.get(id);
    if (current) {
      const binding = (entry) =>
        stable({
          runId: entry.runId,
          generation: entry.generation,
          registrationId: entry.registrationId,
          revision: entry.revision,
          digest: entry.digest,
          handle: entry.handle,
          bootId: entry.bootId,
        });
      if (registration.revision < current.revision) return reject('stale_registration');
      if (registration.revision === current.revision)
        return binding(registration) === binding(current)
          ? { ok: true, registration: current, replayed: true }
          : reject('registration_conflict');
      this.leases.delete(id);
    }
    this.registrations.set(id, registration);
    return { ok: true, registration };
  }

  arm(value) {
    const registration = this.registrations.get(scope(value));
    if (!registration || this.fenced.has(scope(value))) return reject('registration_missing');
    if (
      value.registrationId !== registration.registrationId ||
      value.registrationRevision !== registration.revision ||
      value.registrationDigest !== registration.digest ||
      value.signatureValid !== true ||
      typeof value.stopId !== 'string' ||
      value.stopId.length === 0 ||
      typeof value.stopCapability !== 'string' ||
      value.stopCapability.length === 0 ||
      !Number.isSafeInteger(value.deadline) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt < value.deadline
    )
      return reject('stop_lease_invalid');
    const id = scope(value);
    const lease = Object.freeze({ ...value, fixtureOnly: true });
    const current = this.leases.get(id);
    if (current) {
      const binding = (entry) =>
        stable(
          Object.fromEntries(
            [
              'runId',
              'generation',
              'registrationId',
              'registrationRevision',
              'registrationDigest',
              'stopId',
              'stopCapability',
              'deadline',
              'expiresAt',
            ].map((key) => [key, entry[key]]),
          ),
        );
      return binding(lease) === binding(current)
        ? { ok: true, replayed: true, fixtureOnly: true }
        : reject('stop_lease_conflict');
    }
    this.leases.set(id, lease);
    return { ok: true, fixtureOnly: true };
  }

  fenceBeforeRegistration({ runId, generation, stopId }) {
    this.fenced.add(scope({ runId, generation }));
    this.records.set(stopId, {
      status: 'UNKNOWN',
      runId,
      generation,
      registrationId: null,
      attempted: false,
      evidence: null,
    });
    return { ok: true, status: 'UNKNOWN', fixtureOnly: true };
  }

  requestStop(request) {
    const id = scope(request ?? {});
    const registration = this.registrations.get(id);
    const lease = this.leases.get(id);
    if (
      !request ||
      request.peerIdentity !== this.terminatorPeer ||
      request.operation !== 'terminate_registered_scope' ||
      !registration ||
      !lease ||
      this.fenced.has(id) ||
      request.handle !== registration.handle ||
      request.registrationId !== registration.registrationId ||
      request.registrationRevision !== registration.revision ||
      request.registrationDigest !== registration.digest ||
      request.bootId !== registration.bootId ||
      request.generation !== registration.generation ||
      request.runId !== registration.runId ||
      request.stopCapability !== lease.stopCapability ||
      request.stopId !== lease.stopId ||
      this.now >= lease.expiresAt ||
      typeof request.stopId !== 'string' ||
      request.stopId.length === 0 ||
      ['pid', 'path', 'unit'].some((key) => Object.hasOwn(request, key))
    )
      return reject('stop_authorization');
    const prior = this.used.get(request.stopCapability);
    if (prior)
      return prior.stopId === request.stopId
        ? { ok: true, replayed: true, status: prior.status }
        : reject('stop_capability_reused');
    const record = {
      status: 'ATTEMPTED',
      runId: request.runId,
      generation: request.generation,
      registrationId: registration.registrationId,
      stopId: request.stopId,
      attempted: true,
      evidence: null,
    };
    this.records.set(request.stopId, record);
    this.used.set(request.stopCapability, record);
    return { ok: true, status: record.status, fixtureOnly: true };
  }

  deadline({ now, authorizerAvailable = true, gatewayAvailable = true, actuatorAvailable = true }) {
    this.now = now;
    for (const [id, lease] of this.leases) {
      if (now < lease.deadline) continue;
      const registration = this.registrations.get(id);
      if (!registration || !actuatorAvailable) {
        this.records.set(lease.stopId, {
          status: 'UNKNOWN',
          runId: lease.runId,
          generation: lease.generation,
          registrationId: registration?.registrationId ?? null,
          attempted: false,
          evidence: null,
        });
        return { status: 'UNKNOWN', reason: 'actuator_unavailable' };
      }
      let record = this.records.get(lease.stopId);
      if (!record) {
        record = {
          status: 'ATTEMPTED',
          runId: lease.runId,
          generation: lease.generation,
          registrationId: registration.registrationId,
          stopId: lease.stopId,
          attempted: true,
          evidence: null,
        };
        this.records.set(lease.stopId, record);
        this.used.set(lease.stopCapability, record);
      }
      return { status: record.status, duringOutage: !authorizerAvailable || !gatewayAvailable };
    }
    return { status: 'ARMED' };
  }

  gatewayObservation(stopId) {
    return {
      advisory: true,
      evidence: false,
      status: this.records.get(stopId)?.status ?? 'UNKNOWN',
    };
  }

  confirm(stopId, evidence, { peerIdentity = this.actuatorPeer, storageAvailable = true } = {}) {
    const record = this.records.get(stopId);
    if (
      !record ||
      record.attempted !== true ||
      !record.registrationId ||
      peerIdentity !== this.actuatorPeer ||
      !storageAvailable ||
      evidence?.source !== 'synthetic-actuator' ||
      evidence.runId !== record.runId ||
      evidence.generation !== record.generation ||
      evidence.registrationId !== record.registrationId ||
      evidence.inventoryComplete !== true ||
      evidence.remainingProcesses !== 0
    ) {
      if (record) record.status = 'UNKNOWN';
      return { status: 'UNKNOWN', reason: 'termination_unconfirmed' };
    }
    record.status = 'CONFIRMED';
    record.evidence = clone(evidence);
    return { status: 'CONFIRMED', fixtureOnly: true };
  }
}

export class FakeIndependentAnchor {
  constructor({ available = true, epoch = 'anchor-fixture-epoch' } = {}) {
    this.available = available;
    this.epoch = epoch;
    this.sequence = 0;
    this.entries = new Map();
    this.protectedIdentities = new Set();
    this.transitions = new Map();
    this.nonces = new Set();
  }

  seed(kind, subjectId, revision) {
    const key = `${kind}:${subjectId}`;
    this.entries.set(key, { revision, fenced: false });
    this.protectedIdentities.add(key);
  }

  preFence(intent) {
    if (!this.available) return reject('anchor_unavailable');
    const fingerprint = stable(intent);
    const old = this.transitions.get(intent.transitionId);
    if (old)
      return old.fingerprint === fingerprint
        ? { ok: true, replayed: true, receipt: clone(old.receipt) }
        : reject('anchor_conflict');
    const key = `${intent.kind}:${intent.subjectId}`;
    const state = this.entries.get(key);
    if (
      !state ||
      state.revision !== intent.expectedRevision ||
      intent.newRevision !== intent.expectedRevision + 1
    )
      return reject('anchor_revision');
    this.sequence++;
    const receipt = Object.freeze({
      epoch: this.epoch,
      sequence: this.sequence,
      transitionId: intent.transitionId,
      fingerprint,
      fixtureOnly: true,
    });
    this.entries.set(key, { revision: intent.expectedRevision, fenced: true });
    this.transitions.set(intent.transitionId, {
      intent: clone(intent),
      fingerprint,
      receipt,
      databaseReceipt: null,
      finalized: false,
    });
    return { ok: true, receipt };
  }

  finalize({ transitionId, receipt, databaseReceipt }) {
    if (!this.available) return reject('anchor_unavailable');
    const transition = this.transitions.get(transitionId);
    if (
      !transition ||
      transition.receipt.sequence !== receipt?.sequence ||
      receipt.epoch !== this.epoch ||
      databaseReceipt?.transitionId !== transitionId ||
      databaseReceipt?.newRevision !== transition.intent.newRevision
    )
      return reject('anchor_receipt_conflict');
    if (transition.finalized)
      return { ok: true, replayed: true, receipt: clone(transition.finalReceipt) };
    this.sequence++;
    const key = `${transition.intent.kind}:${transition.intent.subjectId}`;
    this.entries.set(key, { revision: transition.intent.newRevision, fenced: true });
    transition.databaseReceipt = clone(databaseReceipt);
    transition.finalized = true;
    transition.finalReceipt = Object.freeze({
      epoch: this.epoch,
      sequence: this.sequence,
      transitionId,
      revision: transition.intent.newRevision,
      fixtureOnly: true,
    });
    return { ok: true, receipt: clone(transition.finalReceipt) };
  }

  admission({ kind, subjectId, revision, epoch, nonce }) {
    if (!this.available) return reject('anchor_unavailable');
    const key = `${kind}:${subjectId}`;
    const state = this.entries.get(key);
    if (!nonce || this.nonces.has(nonce)) return reject('anchor_replay');
    if (epoch !== this.epoch || !state || state.fenced || state.revision !== revision)
      return reject('anchor_fenced');
    this.nonces.add(nonce);
    return { ok: true, epoch: this.epoch, revision, nonce, fixtureOnly: true };
  }
}

export class FakeAuthorityLedger {
  constructor({ anchor = new FakeIndependentAnchor(), available = true } = {}) {
    this.anchor = anchor;
    this.available = available;
    this.epoch = anchor.epoch;
    this.authorizations = new Map([['auth-1', { revision: 1, revoked: false }]]);
    this.leases = new Map([['lease-1', { revision: 1, superseded: false }]]);
    this.transitions = new Map();
    anchor.seed('authorization_revocation', 'auth-1', 1);
    anchor.seed('lease_supersession', 'lease-1', 1);
  }

  reserve({ authorizationRevision = 1, leaseRevision = 1, nonce = 'admission-1' } = {}) {
    if (!this.available) return reject('authorizer_unavailable');
    const auth = this.authorizations.get('auth-1');
    const lease = this.leases.get('lease-1');
    if (
      auth.revoked ||
      auth.revision !== authorizationRevision ||
      lease.superseded ||
      lease.revision !== leaseRevision
    )
      return reject('authority_state');
    const a = this.anchor.admission({
      kind: 'authorization_revocation',
      subjectId: 'auth-1',
      revision: auth.revision,
      epoch: this.epoch,
      nonce: `${nonce}:a`,
    });
    if (!a.ok) return a;
    const l = this.anchor.admission({
      kind: 'lease_supersession',
      subjectId: 'lease-1',
      revision: lease.revision,
      epoch: this.epoch,
      nonce: `${nonce}:l`,
    });
    if (!l.ok) return l;
    return { ok: true, fixtureOnly: true };
  }

  change({
    transitionId,
    kind = 'authorization_revocation',
    subjectId = 'auth-1',
    expectedRevision = 1,
    databaseAvailable = true,
    anchorAvailable = this.anchor.available,
    finalizeAvailable = anchorAvailable,
  }) {
    if (!this.available) return reject('authorizer_unavailable');
    const map = kind === 'authorization_revocation' ? this.authorizations : this.leases;
    const record = map.get(subjectId);
    if (!record || record.revision !== expectedRevision) return reject('stale_revision');
    this.anchor.available = anchorAvailable;
    const intent = {
      transitionId,
      kind,
      subjectId,
      expectedRevision,
      newRevision: expectedRevision + 1,
      epoch: this.epoch,
    };
    let transition = this.transitions.get(transitionId);
    if (transition && stable(transition.intent) !== stable(intent))
      return reject('transition_conflict');
    if (!transition) {
      const preFence = this.anchor.preFence(intent);
      if (!preFence.ok) return { ...preFence, databaseCommitted: false };
      transition = { intent, receipt: preFence.receipt, databaseReceipt: null, finalized: false };
      this.transitions.set(transitionId, transition);
      if (!databaseAvailable)
        return {
          ok: true,
          effective: false,
          protection: 'pending',
          databaseCommitted: false,
          preFenced: true,
        };
      record.revision++;
      if ('revoked' in record) record.revoked = true;
      if ('superseded' in record) record.superseded = true;
      transition.databaseReceipt = { transitionId, newRevision: expectedRevision + 1 };
    }
    if (!databaseAvailable)
      return {
        ok: true,
        effective: false,
        protection: 'pending',
        databaseCommitted: false,
        preFenced: true,
      };
    this.anchor.available = finalizeAvailable;
    if (!transition.databaseReceipt) {
      if (record.revision !== expectedRevision) return reject('stale_revision');
      record.revision++;
      if ('revoked' in record) record.revoked = true;
      if ('superseded' in record) record.superseded = true;
      transition.databaseReceipt = { transitionId, newRevision: expectedRevision + 1 };
    }
    const finalized = this.anchor.finalize({
      transitionId,
      receipt: transition.receipt,
      databaseReceipt: transition.databaseReceipt,
    });
    if (!finalized.ok)
      return {
        ok: true,
        effective: true,
        protection: 'pending',
        databaseCommitted: true,
        reason: finalized.reason,
      };
    transition.finalized = true;
    transition.finalReceipt = finalized.receipt;
    return {
      ok: true,
      effective: true,
      protection: 'anchored',
      databaseCommitted: true,
      receipt: finalized.receipt,
    };
  }

  retry(transitionId) {
    const transition = this.transitions.get(transitionId);
    if (!transition) return reject('transition_missing');
    const record = (
      transition.intent.kind === 'authorization_revocation' ? this.authorizations : this.leases
    ).get(transition.intent.subjectId);
    if (record.revision === transition.intent.expectedRevision && !transition.databaseReceipt) {
      record.revision = transition.intent.newRevision;
      if ('revoked' in record) record.revoked = true;
      if ('superseded' in record) record.superseded = true;
      transition.databaseReceipt = { transitionId, newRevision: transition.intent.newRevision };
    }
    if (record.revision !== transition.intent.newRevision) return reject('database_state_mismatch');
    if (!this.anchor.available)
      return {
        ok: true,
        effective: true,
        protection: 'pending',
        databaseCommitted: true,
        reason: 'anchor_unavailable',
      };
    const finalized = this.anchor.finalize({
      transitionId,
      receipt: transition.receipt,
      databaseReceipt: transition.databaseReceipt,
    });
    if (!finalized.ok)
      return {
        ok: true,
        effective: true,
        protection: 'pending',
        databaseCommitted: true,
        reason: finalized.reason,
      };
    transition.finalized = true;
    transition.finalReceipt = finalized.receipt;
    return {
      ok: true,
      effective: true,
      protection: 'anchored',
      databaseCommitted: true,
      receipt: finalized.receipt,
    };
  }

  restore(snapshot, { freshEpoch = false } = {}) {
    if (!freshEpoch || !snapshot || snapshot.epoch !== this.epoch)
      return reject('fresh_epoch_required');
    if ([...this.transitions.values()].some((entry) => !entry.finalized))
      return reject('transition_pending');
    if (
      !Array.isArray(snapshot.authorizations) ||
      !Array.isArray(snapshot.leases) ||
      !this.#hasExactRecordSet(
        snapshot.authorizations,
        this.#protectedSubjectIds('authorization_revocation'),
      ) ||
      !this.#hasExactRecordSet(snapshot.leases, this.#protectedSubjectIds('lease_supersession'))
    )
      return reject('snapshot_identity_set');
    for (const [id, record] of snapshot.authorizations) {
      const anchored = this.anchor.entries.get(`authorization_revocation:${id}`);
      if (!anchored || anchored.revision !== record.revision || anchored.fenced !== record.revoked)
        return reject('rollback_detected');
    }
    for (const [id, record] of snapshot.leases) {
      const anchored = this.anchor.entries.get(`lease_supersession:${id}`);
      if (
        !anchored ||
        anchored.revision !== record.revision ||
        anchored.fenced !== record.superseded
      )
        return reject('rollback_detected');
    }
    return { ok: true, fixtureOnly: true };
  }

  #protectedSubjectIds(kind) {
    const prefix = `${kind}:`;
    return new Set(
      [...this.anchor.protectedIdentities]
        .filter((identity) => identity.startsWith(prefix))
        .map((identity) => identity.slice(prefix.length)),
    );
  }

  #hasExactRecordSet(entries, expectedIds) {
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          !entry[1] ||
          typeof entry[1] !== 'object' ||
          !Number.isSafeInteger(entry[1].revision) ||
          typeof (entry[1].revoked ?? entry[1].superseded) !== 'boolean',
      )
    )
      return false;
    const ids = entries.map(([id]) => id);
    return (
      ids.length === expectedIds.size &&
      new Set(ids).size === expectedIds.size &&
      ids.every((id) => expectedIds.has(id))
    );
  }

  snapshot() {
    return clone({
      epoch: this.epoch,
      authorizations: [...this.authorizations],
      leases: [...this.leases],
    });
  }
}

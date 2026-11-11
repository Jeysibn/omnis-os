import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sealLedger,
  validateAuthorization,
  validateLedger,
  validateRequest,
} from './schema.test-only.ts';
import { validAuthorization, validRequest } from './fixtures.test-only.ts';

test('validates explicitly synthetic authorization and complete Stage 1 request binding', () => {
  const authorization = validAuthorization();
  assert.deepEqual(validateAuthorization(authorization), authorization);
  const request = validRequest(authorization);
  assert.deepEqual(validateRequest(request), request);
});

test('rejects production-shaped, extra, malformed and stale authorization data', () => {
  const invalid = [
    { ...validAuthorization(), mode: 'production' },
    { ...validAuthorization(), authorizationId: '11111111-1111-4111-8111-111111111111' },
    { ...validAuthorization(), expiresAtNs: '100' },
    { ...validAuthorization(), expiresAtNs: '720000000101' },
    { ...validAuthorization(), singleUse: false },
    { ...validAuthorization(), unexpected: true },
    { ...validAuthorization(), runId: 'sim-run:one' },
  ];
  for (const value of invalid) assert.throws(() => validateAuthorization(value));
});

test('rejects malformed Stage 1 tuple values and stale reservation times', () => {
  const auth = validAuthorization();
  assert.throws(() => validateRequest(validRequest(auth, { sessionId: 'sim-session:bad' })));
  assert.throws(() => validateRequest(validRequest(auth, { ordinal: 4 })));
  assert.throws(() =>
    validateRequest(validRequest(auth, { journalSequenceDigest: 'not-a-digest' })),
  );
  assert.throws(() => validateRequest(validRequest(auth, { requestDigest: 'not-a-digest' })));
  assert.throws(
    () => validateRequest(validRequest(auth, { nowNs: auth.deadlineBootTimeNs })),
    /stale_stage1_reservation/,
  );
  assert.throws(
    () => validateRequest(validRequest(auth, { nowNs: '99' })),
    /stale_stage1_reservation/,
  );
});

test('validates ledger schema and rejects unknown or inconsistent states', () => {
  const ledger = sealLedger({
    schemaVersion: 1,
    mode: 'synthetic-ledger-only',
    sequence: 0,
    entries: [],
  });
  assert.deepEqual(validateLedger(ledger), ledger);
  assert.throws(() => validateLedger({ ...ledger, mode: 'production' }));
  assert.throws(() => validateLedger({ ...ledger, unknown: true }));
  assert.throws(() => validateLedger({ ...ledger, sequence: -1 }));
  assert.throws(() => validateLedger({ ...ledger, sequence: 1 }));
});

test('rejects accessors, non-plain records and out-of-range timestamps', () => {
  const accessor = validAuthorization();
  Object.defineProperty(accessor, 'issuedAtNs', { enumerable: true, get: () => '110' });
  assert.throws(() => validateAuthorization(accessor));
  assert.throws(() =>
    validateAuthorization(Object.assign(Object.create({ inherited: true }), validAuthorization())),
  );
  assert.throws(() =>
    validateAuthorization({ ...validAuthorization(), expiresAtNs: '9223372036854775808' }),
  );
});

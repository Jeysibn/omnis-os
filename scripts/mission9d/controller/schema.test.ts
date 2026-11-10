import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateJournal } from './schema.ts';

const validJournal = () => ({
  schemaVersion: 1,
  runId: '9d4fcd3f-74e7-474b-b7b7-22038d38f7fd',
  generation: 1,
  manifestSha256: 'a'.repeat(64),
  bootId: 'c1111111-1111-4111-8111-111111111111',
  startedAtBootTimeNs: '1000',
  deadlineBootTimeNs: '720000001000',
  lastObservedBootTimeNs: '1000',
  session: {
    id: 'd1111111-1111-4111-8111-111111111111',
    ownerPid: 123,
    ownerStartTimeTicks: '987654',
  },
  attemptCounts: { windows: 0, wsl: 0, direct: 0, published: 0 },
  reservations: [],
  events: [],
});

test('accepts the complete initial journal schema', () => {
  assert.deepEqual(validateJournal(validJournal()), validJournal());
});

test('rejects unknown, missing, accessor and symbol properties', () => {
  const extra = { ...validJournal(), unexpected: true };
  assert.throws(() => validateJournal(extra));

  const missing = validJournal() as Record<string, unknown>;
  delete missing['events'];
  assert.throws(() => validateJournal(missing));

  const accessor = validJournal();
  Object.defineProperty(accessor, 'runId', { enumerable: true, get: () => accessor.runId });
  assert.throws(() => validateJournal(accessor));

  const symbol = validJournal();
  Object.defineProperty(symbol, Symbol('hidden'), { value: true });
  assert.throws(() => validateJournal(symbol));
});

test('rejects malformed attempt counts and inconsistent reservations', () => {
  for (const count of [-1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    const value = validJournal();
    value.attemptCounts.windows = count as number;
    assert.throws(() => validateJournal(value));
  }

  const inconsistent = validJournal();
  inconsistent.attemptCounts.direct = 1;
  assert.throws(() => validateJournal(inconsistent));
});

test('rejects malformed boot clocks, generations and identifiers', () => {
  const invalid = [
    { bootId: '' },
    { generation: 0 },
    { generation: 1.5 },
    { startedAtBootTimeNs: '-1' },
    { deadlineBootTimeNs: '1000' },
    { lastObservedBootTimeNs: '999' },
    { manifestSha256: 'not-a-digest' },
    { session: { ...validJournal().session, ownerPid: 0 } },
  ];

  for (const change of invalid) {
    assert.throws(() => validateJournal({ ...validJournal(), ...change }));
  }
});

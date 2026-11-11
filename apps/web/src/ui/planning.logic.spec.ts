import { expect, test } from '@playwright/test';
import { isValidStatusStep, nextStatuses } from './projects/planning/lifecycle.js';
import { judgeAssociation, judgeEdit } from './projects/planning/recovery.js';
import { CLOCK_SKEW_MS, MAX_SCAN_PAGES, scanForCreated } from './projects/planning/unresolved.js';
import { associationConfirmed } from './projects/planning/verify.js';
import {
  ENVELOPE_VERSION,
  FUTURE_SKEW_MS,
  MAX_ENVELOPE_CHARS,
  MAX_KNOWN_IDS,
  REPLAY_WINDOW_MS,
  newEnvelope,
  parseEnvelope,
  readPending,
  removePending,
  replayPolicy,
  storageKey,
  storageWritable,
  transitionAfterSend,
  viewAfterScan,
  writePending,
  type PendingEnvelope,
  type Scope,
  type SendOutcome,
  type StorageLike,
} from './projects/planning/pendingCreate.js';
import { describeRecovery } from './projects/planning/recoveryCopy.js';
import { summariseTasks } from './projects/planning/summary.js';

/** Pure decisions behind the planning screens: no browser, no network. */

const tasks = (...statuses: Array<'open' | 'in_progress' | 'completed'>) =>
  statuses.map((status) => ({ status }));

test.describe('summariseTasks', () => {
  test('counts by status and calls a fully loaded, matching set complete', () => {
    const summary = summariseTasks(tasks('open', 'open', 'completed'), {
      observedTotal: 3,
      complete: true,
    });
    expect(summary.counts).toEqual({ open: 2, in_progress: 0, completed: 1 });
    expect(summary.partial).toBe(false);
    expect(summary.text).toBe('All 3 tasks loaded.');
  });

  test('an unfinished read is partial and says how many were observed', () => {
    const summary = summariseTasks(tasks('open', 'in_progress'), {
      observedTotal: 40,
      complete: false,
    });
    expect(summary.partial).toBe(true);
    expect(summary.text).toBe(
      'Counts cover the 2 tasks loaded so far; 40 were observed. Load more to count the rest.',
    );
  });

  test('a finished read that disagrees with the observed total may be out of date', () => {
    const summary = summariseTasks(tasks('open'), { observedTotal: 3, complete: true });
    expect(summary.partial).toBe(true);
    expect(summary.text).toContain('may be out of date');
  });

  test('no page yet is never presented as complete; none is singular', () => {
    expect(summariseTasks([], null).partial).toBe(true);
    expect(summariseTasks(tasks('open'), { observedTotal: 1, complete: true }).text).toBe(
      'All 1 task loaded.',
    );
    expect(summariseTasks([], { observedTotal: 0, complete: true }).text).toBe('No tasks.');
  });
});

test.describe('judgeEdit', () => {
  const at = (revision: number, status = 'planned') => ({
    kind: 'record' as const,
    value: { revision, status },
  });
  const yes = () => true;
  const no = () => false;

  test('the next revision with the requested values is applied, with other values only changed', () => {
    expect(judgeEdit(1, at(2), yes)).toBe('applied');
    expect(judgeEdit(1, at(2), no)).toBe('changed');
  });
  test('the same revision means nothing was applied', () => {
    expect(judgeEdit(1, at(1), yes)).toBe('not-applied');
  });
  test('any other revision, or an archived record, means it changed elsewhere', () => {
    expect(judgeEdit(1, at(5), yes)).toBe('changed');
    expect(judgeEdit(1, at(5, 'archived'), no)).toBe('archived');
  });
  test('a failed or absent read is never an observation', () => {
    expect(judgeEdit(1, { kind: 'failed' }, yes)).toBe('unreadable');
    expect(judgeEdit(1, { kind: 'absent' }, yes)).toBe('absent');
  });
});

test.describe('judgeAssociation', () => {
  const at = (associationRevision: number, epicId: string | null) => ({
    kind: 'record' as const,
    value: { associationRevision, epic: epicId ? { id: epicId } : null },
  });
  test('the next revision in the requested epic (or none) is applied', () => {
    expect(judgeAssociation(1, 'epc_a', at(2, 'epc_a'))).toBe('applied');
    expect(judgeAssociation(3, null, at(4, null))).toBe('applied');
  });
  test('the same revision is not applied; another epic or revision changed elsewhere', () => {
    expect(judgeAssociation(1, 'epc_a', at(1, null))).toBe('not-applied');
    expect(judgeAssociation(1, 'epc_a', at(2, 'epc_b'))).toBe('changed');
    expect(judgeAssociation(1, 'epc_a', at(4, 'epc_a'))).toBe('changed');
  });
  test('a failed or absent read is never an observation', () => {
    expect(judgeAssociation(1, null, { kind: 'failed' })).toBe('unreadable');
    expect(judgeAssociation(1, null, { kind: 'absent' })).toBe('absent');
  });
});

test.describe('status lifecycle', () => {
  test('only forward steps are offered, the current status first', () => {
    expect(nextStatuses('planned')).toEqual(['planned', 'in_progress', 'completed']);
    expect(nextStatuses('in_progress')).toEqual(['in_progress', 'completed']);
    expect(nextStatuses('completed')).toEqual(['completed']);
    expect(nextStatuses('archived')).toEqual([]);
  });
  test('every permitted step is valid and every backward step is not', () => {
    for (const [from, to] of [
      ['planned', 'in_progress'],
      ['planned', 'completed'],
      ['in_progress', 'completed'],
      ['planned', 'planned'],
    ] as const)
      expect(isValidStatusStep(from, to), `${from} -> ${to}`).toBe(true);
    for (const [from, to] of [
      ['completed', 'in_progress'],
      ['completed', 'planned'],
      ['in_progress', 'planned'],
      ['archived', 'planned'],
      ['planned', 'archived'],
    ] as const)
      expect(isValidStatusStep(from, to), `${from} -> ${to}`).toBe(false);
  });
});

test.describe('associationConfirmed', () => {
  const sent = {
    taskId: 'task-1',
    epicId: 'epc_a' as string | null,
    expectedAssociationRevision: 3,
    currentEpicId: null as string | null,
  };
  const reply = (
    over: Partial<{ taskId: string; epicId: string | null; associationRevision: number }> = {},
  ) => ({
    taskId: 'task-1',
    epicId: 'epc_a' as string | null,
    associationRevision: 4,
    ...over,
  });
  test('a real change must advance the revision by exactly one', () => {
    expect(associationConfirmed(reply(), sent)).toBe(true);
    expect(associationConfirmed(reply({ associationRevision: 3 }), sent)).toBe(false); // unchanged
    expect(associationConfirmed(reply({ associationRevision: 5 }), sent)).toBe(false); // jumped
    expect(associationConfirmed(reply({ associationRevision: 2 }), sent)).toBe(false); // went back
  });
  test('the task and the epic in the response must be the ones sent', () => {
    expect(associationConfirmed(reply({ taskId: 'task-2' }), sent)).toBe(false);
    expect(associationConfirmed(reply({ epicId: 'epc_b' }), sent)).toBe(false);
    expect(associationConfirmed(reply({ epicId: null }), sent)).toBe(false);
  });
  test('moving and clearing are real changes too', () => {
    const move = { ...sent, currentEpicId: 'epc_old' };
    expect(associationConfirmed(reply(), move)).toBe(true);
    expect(associationConfirmed(reply({ associationRevision: 3 }), move)).toBe(false);
    const clear = { ...sent, epicId: null, currentEpicId: 'epc_old' };
    expect(associationConfirmed(reply({ epicId: null }), clear)).toBe(true);
    expect(associationConfirmed(reply({ epicId: null, associationRevision: 3 }), clear)).toBe(
      false,
    );
  });
  test('the documented no-op (the same epic again) leaves the revision unchanged, and only then', () => {
    const noOp = { ...sent, currentEpicId: 'epc_a' };
    expect(associationConfirmed(reply({ associationRevision: 3 }), noOp)).toBe(true);
    expect(associationConfirmed(reply({ associationRevision: 4 }), noOp)).toBe(false);
  });
});

test.describe('scanForCreated', () => {
  const now = Date.now();
  type R = { id: string; title: string; revision: number; status: string; createdAt: string };
  const rec = (id: string, over: Partial<R> = {}): R => ({
    id,
    title: 'Reporting',
    revision: 1,
    status: 'planned',
    createdAt: new Date(now).toISOString(),
    ...over,
  });
  const pending = {
    changes: { title: 'Reporting' },
    startedAt: now,
    knownIds: ['old'] as readonly string[],
  };
  const fits = (r: R) => r.title === 'Reporting';
  const pages = (list: R[][]) => async (cursor: string | null) => {
    const index = cursor === null ? 0 : Number(cursor);
    const items = list[index] ?? [];
    const more = index + 1 < list.length;
    return { items, page: { complete: !more, nextCursor: more ? String(index + 1) : null } };
  };

  test('one new matching record is found, even on a later page', async () => {
    const result = await scanForCreated(
      pages([[rec('a', { title: 'Other' })], [rec('b')]]),
      pending,
      fits,
    );
    expect(result).toEqual({ kind: 'found', record: rec('b') });
  });
  test('absence is only reported after every page was read', async () => {
    let reads = 0;
    const read = async (cursor: string | null) => {
      reads += 1;
      return pages([
        [rec('a', { title: 'x' })],
        [rec('b', { title: 'y' })],
        [rec('c', { title: 'z' })],
      ])(cursor);
    };
    expect(await scanForCreated(read, pending, fits)).toEqual({ kind: 'absent' });
    expect(reads).toBe(3);
  });
  test('records already known, revised, older than the attempt, or not planned do not count', async () => {
    const result = await scanForCreated(
      pages([
        [
          rec('old'),
          rec('r2', { revision: 2 }),
          rec('s', { status: 'completed' }),
          rec('past', { createdAt: new Date(now - CLOCK_SKEW_MS - 60_000).toISOString() }),
        ],
      ]),
      pending,
      fits,
    );
    expect(result).toEqual({ kind: 'absent' });
  });
  test('two fitting records are ambiguous and none is picked', async () => {
    expect(await scanForCreated(pages([[rec('a'), rec('b')]]), pending, fits)).toEqual({
      kind: 'ambiguous',
      count: 2,
    });
  });
  test('a page that cannot be read, or too many pages, conclude nothing', async () => {
    const failing = async (cursor: string | null) => {
      if (cursor !== null) throw new Error('down');
      return { items: [rec('a')], page: { complete: false, nextCursor: '1' } };
    };
    expect(await scanForCreated(failing, pending, fits)).toEqual({ kind: 'unknown' });
    const endless = async () => ({ items: [], page: { complete: false, nextCursor: 'more' } });
    expect(await scanForCreated(endless, pending, fits)).toEqual({ kind: 'unknown' });
    expect(MAX_SCAN_PAGES).toBeGreaterThan(1);
  });
});

/* ------------------------------ durable unknown-create recovery ------------------------------ */

const scope: Scope = { ownerId: 'owner', projectId: `prj_${'1'.repeat(32)}`, kind: 'epic' };
const memory = (
  initial: Record<string, string> = {},
): StorageLike & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const good = (over: Record<string, unknown> = {}) => ({
  version: 1,
  ...scope,
  request: { title: 'Reporting' },
  idempotencyKey: '11111111-2222-4333-8444-555555555555',
  attemptedAt: NOW - 1000,
  ...over,
});
const parse = (value: unknown, s: Scope = scope) => parseEnvelope(JSON.stringify(value), s, NOW);

test.describe('pending create envelope', () => {
  test('a valid envelope for exactly this owner, project and type is accepted and normalised', () => {
    const result = parse(
      good({
        request: { title: 'Reporting', description: 'Weekly.' },
        knownIds: [`epc_${'a'.repeat(32)}`],
      }),
    );
    expect(result).toMatchObject({
      status: 'found',
      envelope: { request: { title: 'Reporting', description: 'Weekly.' } },
    });
  });
  test('a milestone envelope keeps its target date; an epic cannot carry one', () => {
    const ms: Scope = { ...scope, kind: 'milestone' };
    expect(
      parse(good({ kind: 'milestone', request: { title: 'T', targetDate: '2026-12-31' } }), ms),
    ).toMatchObject({
      status: 'found',
      envelope: { request: { title: 'T', targetDate: '2026-12-31' } },
    });
    expect(parse(good({ request: { title: 'T', targetDate: '2026-12-31' } }))).toEqual({
      status: 'blocked',
      reason: 'corrupt',
    });
  });
  test('corrupt, malformed, incomplete or oversized input fails closed as corrupt', () => {
    expect(parseEnvelope('{not json', scope, NOW)).toEqual({
      status: 'blocked',
      reason: 'corrupt',
    });
    expect(parseEnvelope('[]', scope, NOW)).toEqual({ status: 'blocked', reason: 'corrupt' });
    expect(parseEnvelope('null', scope, NOW)).toEqual({ status: 'blocked', reason: 'corrupt' });
    expect(parse({ version: 1 })).toEqual({ status: 'blocked', reason: 'corrupt' });
    expect(parse(good({ extra: 1 }))).toEqual({ status: 'blocked', reason: 'corrupt' });
    expect(parse(good({ kind: 'story' }))).toEqual({ status: 'blocked', reason: 'corrupt' });
    expect(parse(good({ idempotencyKey: 'x' }))).toEqual({ status: 'blocked', reason: 'corrupt' });
    expect(parse(good({ request: { title: '' } }))).toEqual({
      status: 'blocked',
      reason: 'corrupt',
    });
    expect(
      parse(
        good({
          knownIds: Array.from({ length: MAX_KNOWN_IDS + 1 }, () => `epc_${'a'.repeat(32)}`),
        }),
      ),
    ).toEqual({ status: 'blocked', reason: 'corrupt' });
    expect(parseEnvelope('x'.repeat(MAX_ENVELOPE_CHARS + 1), scope, NOW)).toEqual({
      status: 'blocked',
      reason: 'corrupt',
    });
  });
  test('another version is incompatible, never guessed at', () => {
    expect(parse(good({ version: 2 }))).toEqual({ status: 'blocked', reason: 'incompatible' });
    expect(parse(good({ version: '1' }))).toEqual({ status: 'blocked', reason: 'incompatible' });
  });
  test('an envelope for another owner, project or record type is foreign', () => {
    expect(parse(good({ ownerId: 'someone' }))).toEqual({ status: 'blocked', reason: 'foreign' });
    expect(parse(good({ projectId: `prj_${'2'.repeat(32)}` }))).toEqual({
      status: 'blocked',
      reason: 'foreign',
    });
    expect(parse(good({ kind: 'milestone', request: { title: 'T' } }))).toEqual({
      status: 'blocked',
      reason: 'foreign',
    });
  });
  test('an impossible timestamp is a clock problem; an old one is still valid (age is policy, not validity)', () => {
    expect(parse(good({ attemptedAt: NOW + FUTURE_SKEW_MS + 1 }))).toEqual({
      status: 'blocked',
      reason: 'clock',
    });
    expect(parse(good({ attemptedAt: 5 }))).toEqual({ status: 'blocked', reason: 'clock' });
    expect(parse(good({ attemptedAt: NOW - 30 * 24 * 3_600_000 })).status).toBe('found');
  });
  test('the stored key names the owner, project and type, so scopes cannot read each other', () => {
    const a = storageKey(scope);
    expect(storageKey({ ...scope, ownerId: 'other' })).not.toBe(a);
    expect(storageKey({ ...scope, kind: 'milestone' })).not.toBe(a);
    expect(storageKey({ ...scope, projectId: `prj_${'3'.repeat(32)}` })).not.toBe(a);
    const store = memory({
      [storageKey({ ...scope, ownerId: 'other' })]: JSON.stringify(good({ ownerId: 'other' })),
    });
    expect(readPending(store, scope, NOW)).toEqual({ status: 'none' });
  });
});

test.describe('pending create storage', () => {
  test('write, read back and remove; an unwritable or unreadable store is reported, not hidden', () => {
    const store = memory();
    const envelope = newEnvelope(
      scope,
      { title: 'Reporting' },
      [`epc_${'a'.repeat(32)}`, 'not-an-id'],
      NOW,
    );
    expect(envelope.knownIds).toEqual([`epc_${'a'.repeat(32)}`]);
    expect(envelope.version).toBe(ENVELOPE_VERSION);
    expect(writePending(store, envelope)).toBe(true);
    expect(readPending(store, scope, Date.now())).toMatchObject({
      status: 'found',
      envelope: { idempotencyKey: envelope.idempotencyKey },
    });
    expect(removePending(store, scope)).toBe(true);
    expect(readPending(store, scope, NOW)).toEqual({ status: 'none' });

    const denied: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(writePending(denied, envelope)).toBe(false);
    expect(writePending(null, envelope)).toBe(false);
    expect(readPending(denied, scope, NOW)).toEqual({
      status: 'blocked',
      reason: 'storage-unavailable',
    });
    expect(readPending(null, scope, NOW)).toEqual({
      status: 'blocked',
      reason: 'storage-unavailable',
    });
    expect(removePending(denied, scope)).toBe(false);
    expect(storageWritable(denied)).toBe(false);
    expect(storageWritable(memory())).toBe(true);
  });
  test('a write that does not read back is a failure, and an oversized request is refused', () => {
    const lying: StorageLike = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(writePending(lying, newEnvelope(scope, { title: 'x' }, [], NOW))).toBe(false);
    const huge = {
      ...newEnvelope(scope, { title: 'x' }, [], NOW),
      request: { title: 'y'.repeat(MAX_ENVELOPE_CHARS) },
    };
    expect(writePending(memory(), huge as PendingEnvelope)).toBe(false);
  });
  test('the stored envelope holds only what recovery needs, and no secret', () => {
    const store = memory();
    writePending(store, newEnvelope(scope, { title: 'Reporting' }, [], NOW));
    const raw = [...store.data.values()][0] ?? '';
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'attemptedAt',
      'idempotencyKey',
      'kind',
      'knownIds',
      'ownerId',
      'projectId',
      'request',
      'version',
    ]);
    for (const secret of ['csrf', 'token', 'cookie', 'password', 'session'])
      expect(raw.toLowerCase()).not.toContain(secret);
  });
});

test.describe('replay policy', () => {
  test('a recent key may be repeated; one older than the window is not, and is never discarded for it', () => {
    expect(replayPolicy({ attemptedAt: NOW - 1000 }, NOW)).toEqual({ safe: true });
    expect(replayPolicy({ attemptedAt: NOW - REPLAY_WINDOW_MS }, NOW)).toEqual({ safe: true });
    expect(replayPolicy({ attemptedAt: NOW - REPLAY_WINDOW_MS - 1 }, NOW)).toEqual({
      safe: false,
      reason: 'replay-unverified',
    });
    // Old but valid stays readable: policy never changes what is stored.
    expect(parse(good({ attemptedAt: NOW - 10 * REPLAY_WINDOW_MS })).status).toBe('found');
  });
});

test.describe('create recovery state machine', () => {
  const outcomes: SendOutcome[] = [
    { kind: 'saved' },
    { kind: 'unknown' },
    { kind: 'unauthorized' },
    ...[403, 404, 409, 422, 503].map((status) => ({ kind: 'rejected', status }) as SendOutcome),
  ];
  test('the pending request is cleared ONLY by a confirmed answer or a refusal of the first attempt', () => {
    for (const retry of [false, true])
      for (const outcome of outcomes) {
        const t = transitionAfterSend(retry, outcome);
        const allowed =
          outcome.kind === 'saved' ||
          (!retry && (outcome.kind === 'rejected' || outcome.kind === 'unauthorized'));
        expect(t.clear, `retry=${retry} ${JSON.stringify(outcome)}`).toBe(allowed);
        expect(t.basis.length).toBeGreaterThan(10);
      }
  });
  test('a refusal of a retry says nothing about the original; only the secure-session check is merely unknown', () => {
    expect(transitionAfterSend(true, { kind: 'rejected', status: 422 })).toMatchObject({
      to: 'unsafe',
      unsafe: 'refused',
      clear: false,
    });
    expect(transitionAfterSend(true, { kind: 'rejected', status: 409 })).toMatchObject({
      to: 'unsafe',
      clear: false,
    });
    expect(transitionAfterSend(true, { kind: 'rejected', status: 403 })).toMatchObject({
      to: 'unknown',
      clear: false,
    });
    expect(transitionAfterSend(false, { kind: 'rejected', status: 422 })).toMatchObject({
      to: 'rejected',
      clear: true,
    });
    expect(transitionAfterSend(false, { kind: 'saved' })).toMatchObject({
      to: 'confirmed',
      clear: true,
    });
  });
  test('a list read is only ever an observation', () => {
    expect(viewAfterScan({ kind: 'found' })).toEqual({ view: 'candidate' });
    expect(viewAfterScan({ kind: 'ambiguous', count: 3 })).toEqual({ view: 'ambiguous', count: 3 });
    expect(viewAfterScan({ kind: 'absent' })).toEqual({ view: 'absent' });
    expect(viewAfterScan({ kind: 'unknown' })).toEqual({ view: 'unreadable' });
  });
});

test.describe('recovery copy', () => {
  test('every view states what happened, what is known, what is not verified, and why creation is unavailable', () => {
    const views = [
      { view: 'unknown' },
      { view: 'candidate', title: 'T', revision: 1 },
      { view: 'ambiguous', count: 2 },
      { view: 'absent' },
      { view: 'unreadable' },
      { view: 'refused', status: 409 },
      { view: 'replay-unverified' },
      { view: 'blocked', reason: 'corrupt' },
      { view: 'storage-unavailable' },
    ] as const;
    for (const view of views) {
      const copy = describeRecovery(view, 'epic', true);
      expect(copy.headline.length, view.view).toBeGreaterThan(5);
      expect(copy.what.length, view.view).toBeGreaterThan(20);
      expect(copy.why.length, view.view).toBeGreaterThan(20);
      expect(copy.actions.length, view.view).toBeGreaterThan(0);
    }
  });
  test('the candidate wording is exact, and no view offers a plain new create', () => {
    expect(
      describeRecovery({ view: 'candidate', title: 'T', revision: 1 }, 'epic', true).what,
    ).toBe(
      'One matching record was found, but we cannot confirm whether it was created by your original request.',
    );
    // The only actions are to repeat THE request, look, discard on purpose, or close: never a new one.
    const allowed = ['retry', 'checkCreate', 'discard', 'close'];
    for (const view of [
      { view: 'unknown' },
      { view: 'refused', status: 422 },
      { view: 'replay-unverified' },
    ] as const)
      for (const action of describeRecovery(view, 'epic', true).actions)
        expect(allowed, `${view.view}: ${action}`).toContain(action);
  });
  test('a key that cannot be trusted never offers a retry', () => {
    for (const view of [
      { view: 'unknown' },
      { view: 'candidate', title: 'T', revision: 1 },
      { view: 'absent' },
    ] as const)
      expect(describeRecovery(view, 'epic', false).actions).not.toContain('retry');
    expect(describeRecovery({ view: 'unknown' }, 'epic', true).actions).toContain('retry');
  });
});

import { expect, test } from '@playwright/test';
import { isValidStatusStep, nextStatuses } from './projects/planning/lifecycle.js';
import { judgeAssociation, judgeEdit } from './projects/planning/recovery.js';
import { CLOCK_SKEW_MS, MAX_SCAN_PAGES, scanForCreated } from './projects/planning/unresolved.js';
import { associationConfirmed } from './projects/planning/verify.js';
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

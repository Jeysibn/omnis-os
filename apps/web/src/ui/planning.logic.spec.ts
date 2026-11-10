import { expect, test } from '@playwright/test';
import { judgeAssociation, judgeEdit } from './projects/planning/recovery.js';
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

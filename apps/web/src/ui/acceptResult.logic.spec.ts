import { expect, test } from '@playwright/test';
import { ApiRequestError } from './api.js';
import { TaskStatusSchema, type Run, type Task } from '@omnis/contracts';
import {
  acceptanceAttempts,
  acceptanceViewFor,
  classifyAcceptanceFailure,
  latestRunForTask,
} from './acceptResult.js';
import { summariseTasks, taskStatuses } from './projects/planning/summary.js';

const at = '2026-11-03T10:00:00.000Z';
const task = (status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'T',
  detail: 'detail detail',
  status,
  createdAt: at,
  agentId: null,
  profileVersion: null,
  runtimeId: null,
  assignmentRevision: 1,
  ...extra,
});
const run = (id: string, createdAt = at, status: Run['status'] = 'completed'): Run => ({
  id,
  taskId: 't1',
  taskTitle: 'T',
  status,
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt,
  updatedAt: createdAt,
});
const receipt = (runId: string) => ({
  runId,
  acceptedBy: 'owner' as const,
  acceptedAt: at,
  requestId: '00000000-0000-4000-8000-000000000000',
});
const failure = (status: number | null, outcome: ApiRequestError['outcome']) =>
  new ApiRequestError({ message: 'm', status, code: 'c', outcome });

test('every contract task status is counted, including in_review', () => {
  expect([...taskStatuses].sort()).toEqual([...TaskStatusSchema.options].sort());
  const summary = summariseTasks(
    TaskStatusSchema.options.map((status) => ({ status })),
    { observedTotal: 4, complete: true },
  );
  expect(summary.counts).toEqual({ open: 1, in_progress: 1, in_review: 1, completed: 1 });
});

test('the latest run is the newest by createdAt with a deterministic tie-break', () => {
  const runs = [run('run-0001', '2026-11-03T09:00:00.000Z'), run('run-0002'), run('run-0003')];
  expect(latestRunForTask(runs, 't1')?.id).toBe('run-0003');
  expect(latestRunForTask(runs, 'other')).toBeNull();
});

test('acceptance view: eligible only for the latest completed run of a task in review', () => {
  const runs = [run('run-0001', '2026-11-03T09:00:00.000Z'), run('run-0002')];
  expect(acceptanceViewFor(task('in_review'), runs[1]!, runs).kind).toBe('eligible');
  expect(acceptanceViewFor(task('in_review'), runs[0]!, runs).kind).toBe('superseded');
  expect(acceptanceViewFor(task('in_progress'), runs[1]!, runs).kind).toBe('none');
  expect(acceptanceViewFor(task('open'), runs[1]!, runs).kind).toBe('none');
  const failed = [run('run-0003', at, 'failed')];
  expect(acceptanceViewFor(task('in_review'), failed[0]!, failed).kind).toBe('none');
  expect(acceptanceViewFor(null, runs[1]!, runs).kind).toBe('none');
});

test('completion is never inferred from run completion; receipts bind to their run', () => {
  const runs = [run('run-0001', '2026-11-03T09:00:00.000Z'), run('run-0002')];
  expect(acceptanceViewFor(task('in_review'), runs[1]!, runs).kind).not.toBe('accepted');
  const accepted = task('completed', { resultAcceptance: receipt('run-0002') });
  expect(acceptanceViewFor(accepted, runs[1]!, runs).kind).toBe('accepted');
  expect(acceptanceViewFor(accepted, runs[0]!, runs).kind).toBe('superseded');
  // A receipt for another run does not vouch for this one.
  const other = task('completed', { resultAcceptance: receipt('run-0001') });
  expect(acceptanceViewFor(other, runs[1]!, runs).kind).toBe('historical');
  // Historical completed task without any receipt.
  expect(acceptanceViewFor(task('completed'), runs[1]!, runs).kind).toBe('historical');
});

test('one idempotency key per attempt, kept until the outcome is settled', () => {
  acceptanceAttempts.clear();
  const first = acceptanceAttempts.keyFor('owner', 't1', 'run-0001');
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(acceptanceAttempts.keyFor('owner', 't1', 'run-0001')).toBe(first);
  expect(acceptanceAttempts.keyFor('owner', 't1', 'run-0002')).not.toBe(first);
  expect(acceptanceAttempts.keyFor('someone', 't1', 'run-0001')).not.toBe(first);
  acceptanceAttempts.settle('owner', 't1', 'run-0001');
  expect(acceptanceAttempts.has('owner', 't1', 'run-0001')).toBe(false);
  expect(acceptanceAttempts.keyFor('owner', 't1', 'run-0001')).not.toBe(first);
});

test('failures map to the documented handling', () => {
  expect(classifyAcceptanceFailure(failure(401, 'rejected')).kind).toBe('unauthorized');
  expect(classifyAcceptanceFailure(failure(409, 'rejected')).kind).toBe('conflict');
  expect(classifyAcceptanceFailure(failure(403, 'rejected')).kind).toBe('rejected');
  expect(classifyAcceptanceFailure(failure(400, 'rejected')).kind).toBe('rejected');
  expect(classifyAcceptanceFailure(failure(404, 'rejected')).kind).toBe('rejected');
  expect(classifyAcceptanceFailure(failure(503, 'uncertain')).kind).toBe('uncertain');
  expect(classifyAcceptanceFailure(failure(null, 'uncertain')).kind).toBe('uncertain');
  expect(classifyAcceptanceFailure(failure(200, 'invalid-response')).kind).toBe('uncertain');
  expect(classifyAcceptanceFailure(new Error('x')).kind).toBe('uncertain');
});

import { expect, type Page, type Route } from '@playwright/test';
import { RunSchema, TaskSchema, type Run, type Task } from '@omnis/contracts';

/**
 * OMNIS NEXUS V2 Stage 1: Command Center. A small self-contained API fixture (owner, CSRF, tasks,
 * runs) drives the real application in the browser. Everything is synthetic; no provider is
 * contacted, and any request the fixture does not model fails the test.
 */

export const at = (hours: number) =>
  new Date(Date.parse('2026-11-03T00:00:00.000Z') + hours * 3_600_000).toISOString();

export const makeTask = (
  id: string,
  title: string,
  status: Task['status'] = 'open',
  hour = 0,
): Task =>
  TaskSchema.parse({
    id,
    title,
    detail: `Detail for ${title}.`,
    status,
    createdAt: at(hour),
    agentId: null,
    profileVersion: null,
    runtimeId: null,
    assignmentRevision: 1,
  });

export const makeRun = (
  id: string,
  taskId: string,
  taskTitle: string,
  status: Run['status'],
  hour = 0,
): Run =>
  RunSchema.parse({
    id,
    taskId,
    taskTitle,
    status,
    runtimeKind: 'mock',
    synthetic: true,
    usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
    createdAt: at(hour),
    updatedAt: at(hour + 0.5),
  });

export type Options = {
  tasks?: Task[];
  runs?: Run[];
  runsStatus?: number;
  tasksStatus?: number;
  delayMs?: number;
};

export function mockApi(page: Page, options: Options = {}) {
  const state = {
    ...options,
    tasksStatus: options.tasksStatus ?? 200,
    runsStatus: options.runsStatus ?? 200,
  };
  const requests: string[] = [];
  const unexpected: string[] = [];
  const fail = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, json: { error: { code, message, requestId: 'fixture-request' } } });
  void page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push(`${method} ${path}`);
    if (path === '/api/v1/auth/csrf') return route.fulfill({ json: { csrfToken: 'csrf-fixture' } });
    if (path === '/api/v1/me')
      return route.fulfill({ json: { id: 'owner', displayName: 'Director' } });
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (path === '/api/v1/tasks' && method === 'GET')
      return state.tasksStatus === 200
        ? route.fulfill({ json: state.tasks ?? [] })
        : fail(route, state.tasksStatus, 'tasks_unavailable', 'Tasks are temporarily unavailable.');
    if (path === '/api/v1/runs' && method === 'GET')
      return state.runsStatus === 200
        ? route.fulfill({ json: state.runs ?? [] })
        : fail(route, state.runsStatus, 'runs_unavailable', 'Runs are temporarily unavailable.');
    if (/^\/api\/v1\/runs\/[^/]+\/events$/.test(path))
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    unexpected.push(`${method} ${path}`);
    return fail(route, 500, 'fixture_contract_violation', `Unexpected request: ${method} ${path}`);
  });
  return {
    state,
    requests,
    unexpected,
    mutations: () => requests.filter((r) => !r.startsWith('GET ')),
  };
}

export async function open(page: Page, hash = '#command-center') {
  await page.goto(`/${hash}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
}

/** Opt-in visual evidence: set NEXUS_SHOT_DIR to save full-page screenshots; no effect otherwise. */
export async function shoot(page: Page, name: string) {
  const dir = process.env.NEXUS_SHOT_DIR;
  if (dir)
    await page.screenshot({
      path: `${dir}/${name}.jpg`,
      type: 'jpeg',
      quality: 80,
      fullPage: true,
    });
}

export const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
export const vital = (page: Page, label: string) =>
  page.getByRole('button', { name: new RegExp(`^${label}: `) });

export const mixedRuns = [
  makeRun('run-completed', 't-1', 'Finished report', 'completed', 8),
  makeRun('run-cancelled', 't-2', 'Cancelled sweep', 'cancelled', 7),
  makeRun('run-running', 't-3', 'Live analysis', 'running', 6),
  makeRun('run-stopping', 't-4', 'Winding down', 'stopping', 5),
  makeRun('run-queued', 't-5', 'Waiting job', 'queued', 4),
  makeRun('run-failed', 't-6', 'Broken import', 'failed', 3),
  makeRun('run-interrupted', 't-7', 'Cut-off sync', 'interrupted', 2),
  makeRun('run-unknown', 't-8', 'Lost acknowledgement', 'unknown', 1),
];

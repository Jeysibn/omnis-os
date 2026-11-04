import type { Page, Route } from '@playwright/test';
import { RunSchema, TaskSchema, type Run, type Task } from '@omnis/contracts';

export const T0 = '2026-11-03T02:00:00.000Z'; // 10:00 Asia/Manila
export const csrf = 'csrf-nexus-fixture-token';

export const task = (id: string, title: string, status: Task['status'] = 'open'): Task => ({
  id,
  title,
  detail: `Read the notes for ${title.toLowerCase()} and report the next action.`,
  status,
  createdAt: T0,
});

export const run = (
  id: string,
  taskId: string,
  taskTitle: string,
  status: Run['status'],
  updatedAt = T0,
  createdAt = T0,
): Run => ({
  id,
  taskId,
  taskTitle,
  status,
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt,
  updatedAt,
});

export type NexusApiOptions = {
  tasks?: Task[];
  runs?: Run[];
  runFailures?: number;
  taskFailures?: number;
  taskDelayMs?: number;
  stopStatus?: number;
};

export type Recorded = { method: string; path: string; csrf: string | undefined };

/** Strict mock of the owner API. Unknown routes fail the test instead of silently passing. */
export async function mockApi(page: Page, options: NexusApiOptions = {}) {
  const requests: Recorded[] = [];
  let runFailures = options.runFailures ?? 0;
  let taskFailures = options.taskFailures ?? 0;
  const tasks = options.tasks ?? [
    task('task-open', 'Review launch checklist'),
    task('task-open-2', 'Draft rollout notes'),
    task('task-done', 'Audit access notes', 'completed'),
  ];
  let runs = options.runs ?? [
    run(
      'run-active',
      'task-busy',
      'Index the knowledge base',
      'running',
      '2026-11-03T02:05:00.000Z',
      '2026-11-03T02:01:00.000Z',
    ),
    run(
      'run-old',
      'task-done',
      'Audit access notes',
      'completed',
      '2026-11-03T01:30:00.000Z',
      '2026-11-03T01:00:00.000Z',
    ),
    run(
      'run-bad',
      'task-x',
      'Sync archive',
      'failed',
      '2026-11-03T01:50:00.000Z',
      '2026-11-03T01:40:00.000Z',
    ),
  ];
  const fail = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, json: { error: { code, message, requestId: 'nexus-fixture' } } });

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    requests.push({ method: req.method(), path, csrf: req.headers()['x-omnis-csrf'] });
    if (path === '/api/v1/auth/csrf') return route.fulfill({ json: { csrfToken: csrf } });
    if (path === '/api/v1/me')
      return route.fulfill({ json: { id: 'owner', displayName: 'Director' } });
    if (path === '/api/v1/tasks' && req.method() === 'GET') {
      if (options.taskDelayMs) await new Promise((r) => setTimeout(r, options.taskDelayMs));
      if (taskFailures-- > 0)
        return fail(route, 503, 'tasks_unavailable', 'Tasks are temporarily unavailable.');
      return route.fulfill({ json: tasks.map((t) => TaskSchema.parse(t)) });
    }
    if (path === '/api/v1/runs' && req.method() === 'GET') {
      if (runFailures-- > 0)
        return fail(route, 503, 'runs_unavailable', 'Runs are temporarily unavailable.');
      return route.fulfill({ json: runs.map((r) => RunSchema.parse(r)) });
    }
    const stop = /^\/api\/v1\/runs\/([^/]+)\/stop$/.exec(path);
    if (stop && req.method() === 'POST') {
      if (options.stopStatus && options.stopStatus !== 200)
        return fail(
          route,
          options.stopStatus,
          'stop_failed',
          'Stop request could not be completed.',
        );
      runs = runs.map((r) => (r.id === stop[1] ? { ...r, status: 'stopping' as const } : r));
      return route.fulfill({ json: RunSchema.parse(runs.find((r) => r.id === stop[1])) });
    }
    return fail(route, 404, 'unexpected_route', `Unexpected ${req.method()} ${path}`);
  });
  // Runs page streams are out of scope for these tests; hold the connection idle.
  await page.route('**/api/v1/runs/*/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'retry: 60000\n\n',
    }),
  );
  return { requests };
}

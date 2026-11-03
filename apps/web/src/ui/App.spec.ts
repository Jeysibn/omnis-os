import { expect, test, type Page } from '@playwright/test';

const now = '2026-11-03T10:00:00.000Z';
const tasks = [
  {
    id: 'task-2',
    title: 'Review launch checklist',
    detail: 'Read the release checklist and summarize open items.',
    status: 'open',
    createdAt: now,
  },
  {
    id: 'task-1',
    title: 'Audit access notes',
    detail: 'Read the access notes and list any missing owners.',
    status: 'completed',
    createdAt: '2026-11-02T10:00:00.000Z',
  },
];

function makeRun(id: string, taskId: string, taskTitle: string, status = 'completed') {
  return {
    id,
    taskId,
    taskTitle,
    status,
    runtimeKind: 'mock',
    synthetic: true,
    usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
    createdAt: now,
    updatedAt: now,
  };
}

const runs = [
  makeRun('run-2', 'task-2', 'Review launch checklist', 'running'),
  makeRun('run-1', 'task-1', 'Audit access notes'),
];

async function mockWorkspace(
  page: Page,
  options: { tasksError?: boolean; tasksDelayMs?: number; eventsDisconnected?: boolean } = {},
) {
  let currentTasks = [...tasks];
  let currentRuns = [...runs];
  let authenticated = true;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'POST' && request.headers()['x-omnis-csrf'] !== 'csrf-test-token') {
      return route.fulfill({
        status: 403,
        json: { error: { code: 'csrf_rejected', message: 'Missing CSRF protection.' } },
      });
    }
    if (url.pathname === '/api/v1/auth/csrf' && method === 'GET') {
      return route.fulfill({ json: { csrfToken: 'csrf-test-token' } });
    }
    if (url.pathname === '/api/v1/me' && method === 'GET') {
      return authenticated
        ? route.fulfill({ json: { id: 'owner', displayName: 'Director' } })
        : route.fulfill({
            status: 401,
            json: { error: { code: 'unauthorized', message: 'Sign in to continue.' } },
          });
    }
    if (url.pathname === '/api/v1/auth/login' && method === 'POST') {
      authenticated = true;
      return route.fulfill({ json: { authenticated: true } });
    }
    if (url.pathname === '/api/v1/tasks' && method === 'GET') {
      if (options.tasksDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.tasksDelayMs));
      }
      return options.tasksError
        ? route.fulfill({
            status: 503,
            json: { error: { code: 'unavailable', message: 'Tasks are temporarily unavailable.' } },
          })
        : route.fulfill({ json: currentTasks });
    }
    if (url.pathname === '/api/v1/tasks' && method === 'POST') {
      const body = request.postDataJSON() as { title: string; detail: string };
      const created = { id: 'task-new', ...body, status: 'open', createdAt: now };
      currentTasks = [created, ...currentTasks];
      return route.fulfill({ status: 201, json: created });
    }
    if (url.pathname === '/api/v1/runs' && method === 'GET')
      return route.fulfill({ json: currentRuns });
    if (url.pathname === '/api/v1/authorizations' && method === 'POST') {
      return route.fulfill({
        status: 201,
        json: {
          id: 'b7cece2c-2e6f-4b3b-92da-f0352c24debb',
          requestingActor: 'owner',
          runtimeId: 'mock',
          operation: 'execute_task',
          taskId: 'task-new',
          capabilities: ['mock.execute'],
          scope: { kind: 'task', taskId: 'task-new' },
          status: 'pending',
          policyVersion: 'mock-policy-v1',
          correlationId: 'corr-test',
          expiresAt: '2026-11-03T10:20:00.000Z',
          createdAt: now,
          decidedAt: null,
          decidedBy: null,
          revokedAt: null,
          revokedBy: null,
          consumedAt: null,
          consumedRunId: null,
        },
      });
    }
    if (url.pathname.endsWith('/decision') && method === 'POST') {
      const body = request.postDataJSON() as { decision: string };
      return route.fulfill({
        json: {
          id: 'b7cece2c-2e6f-4b3b-92da-f0352c24debb',
          requestingActor: 'owner',
          runtimeId: 'mock',
          operation: 'execute_task',
          taskId: 'task-new',
          capabilities: ['mock.execute'],
          scope: { kind: 'task', taskId: 'task-new' },
          status: body.decision === 'approve' ? 'authorized' : 'denied',
          policyVersion: 'mock-policy-v1',
          correlationId: 'corr-test',
          expiresAt: '2026-11-03T10:20:00.000Z',
          createdAt: now,
          decidedAt: now,
          decidedBy: 'owner',
          revokedAt: null,
          revokedBy: null,
          consumedAt: null,
          consumedRunId: null,
        },
      });
    }
    if (url.pathname === '/api/v1/runs' && method === 'POST') {
      const created = makeRun('run-new', 'task-new', 'Prepare rollout notes', 'queued');
      currentRuns = [created, ...currentRuns];
      return route.fulfill({ status: 201, json: created });
    }
    if (url.pathname.endsWith('/events') && method === 'GET') {
      if (options.eventsDisconnected) return route.abort();
      const selectedRun = currentRuns.find((run) =>
        url.pathname.includes(encodeURIComponent(run.id)),
      );
      const selected = selectedRun ?? currentRuns[0];
      const taskId = selected?.taskId ?? 'task-2';
      const event = {
        id: `event-${selected?.id ?? 'run-2'}`,
        runId: selected?.id ?? 'run-2',
        sequence: 1,
        at: now,
        type: selected?.status === 'completed' ? 'run.completed' : 'run.started',
        source: 'mock',
        synthetic: true,
        message: `Synthetic ${selected?.status === 'completed' ? 'run completed' : 'run started'} for ${taskId}.`,
      };
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      });
    }
    if (/\/api\/v1\/runs\/[^/]+$/.test(url.pathname) && method === 'GET') {
      const run = currentRuns.find((entry) => url.pathname.endsWith(encodeURIComponent(entry.id)));
      return run
        ? route.fulfill({ json: run })
        : route.fulfill({
            status: 404,
            json: { error: { code: 'not_found', message: 'Run not found.' } },
          });
    }
    if (url.pathname.endsWith('/stop') && method === 'POST') {
      const currentRun = currentRuns[0];
      if (!currentRun) {
        return route.fulfill({
          status: 404,
          json: { error: { code: 'not_found', message: 'Run not found.' } },
        });
      }
      const updated = { ...currentRun, status: 'stopping' };
      currentRuns = [updated, ...currentRuns.slice(1)];
      return route.fulfill({ json: updated });
    }
    if (url.pathname === '/api/v1/auth/logout' && method === 'POST') {
      authenticated = false;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: 'Not mocked.' } },
    });
  });
  await page.goto('/');
  if (options.tasksDelayMs) await expect(page.getByText('Opening Omnis OS…')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
}

test('navigation changes destination and shows the active page', async ({ page }) => {
  await mockWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page).toHaveURL(/#tasks$/);
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByRole('heading', { name: 'Run history' })).toBeVisible();
});

test('supports keyboard navigation between destinations', async ({ page }) => {
  await mockWorkspace(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Omnis OS' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Tasks' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
});

test('creates a task and starts a run only after owner approval', async ({ page }) => {
  await mockWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByLabel('Task title').fill('Prepare rollout notes');
  await page.getByLabel('Task detail').fill('Read the change log and draft a rollout checklist.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('heading', { name: 'Prepare rollout notes' })).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Prepare rollout notes' })
    .getByRole('button', { name: 'Approve & run' })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('limited to the task below');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Prepare rollout notes' })
    .getByRole('button', { name: 'Approve & run' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page).toHaveURL(/#runs$/);
  await expect(page.getByRole('heading', { name: 'Run inspector' })).toBeVisible();
  await expect(page.getByText('Synthetic run started for task-new.')).toBeVisible();
});

test('selects historical runs and inspects their event stream', async ({ page }) => {
  await mockWorkspace(page);
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByText('Synthetic run started for task-2.')).toBeVisible();
  await page.getByRole('button', { name: /Audit access notes/ }).click();
  await expect(page.getByText('Synthetic run completed for task-1.')).toBeVisible();
  await expect(page.getByText('Stream ended', { exact: true })).toBeVisible();
  await expect(page.getByText('run-1')).toBeVisible();
});

test('announces task API errors to the owner', async ({ page }) => {
  await mockWorkspace(page, { tasksError: true });
  await expect(page.getByRole('alert')).toContainText('Tasks are temporarily unavailable.');
});

test('shows the workspace loading state while task data is pending', async ({ page }) => {
  await mockWorkspace(page, { tasksDelayMs: 350 });
});

test('shows a stop request and the resulting run state', async ({ page }) => {
  await mockWorkspace(page);
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByRole('button', { name: 'Request stop' })).toBeVisible();
  await page.getByRole('button', { name: 'Request stop' }).click();
  await expect(page.getByRole('button', { name: 'Stop requested' })).toBeVisible();
});

test('shows a reconnecting state when the event stream disconnects', async ({ page }) => {
  await mockWorkspace(page, { eventsDisconnected: true });
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
});

test('captures desktop command center and mobile task screenshots', async ({ page }) => {
  await mockWorkspace(page);
  await page.screenshot({ path: '/tmp/omnis-os-command-center-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.screenshot({ path: '/tmp/omnis-os-command-center-mobile.png', fullPage: true });
});

test('keeps task controls and navigation usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByLabel('Task title')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  await expect(page.getByRole('link', { name: 'Runs' })).toBeVisible();
});

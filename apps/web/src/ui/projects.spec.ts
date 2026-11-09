import AxeBuilder from '@axe-core/playwright';
import { chromium, expect, test as base, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi, later, pid, proj, task } from './projects.fixture.js';

/**
 * Browser tests for Project Workspace V1. Every response is a strictly contract-parsed synthetic
 * fixture, so none of this is live backend integration evidence. All user-facing wording below is
 * typed here on purpose and never derived from the production catalog: a copy change in
 * `projects/messages.ts` must fail these tests until the expectation is reviewed by hand.
 */

const test = base.extend<{ api: ReturnType<typeof createApi> }>({
  api: async ({ page }, use) => {
    const api = createApi(page);
    await use(api);
    expect(api.unexpected, 'all frontend requests must match the fixture contract').toEqual([]);
  },
});

const alpha = proj(1, { name: 'Alpha rollout', priority: 'high', objective: 'Ship alpha safely.' });
const beta = proj(2, { name: 'Beta migration', status: 'paused', priority: 'low' });
const gamma = proj(3, { name: 'Gamma archive', status: 'archived', revision: 4 });

const projectTaskReads = (api: ReturnType<typeof createApi>) =>
  api.of('GET', /^\/api\/v1\/projects\/prj_[0-9a-f]{32}\/tasks$/);

/**
 * Opens a route and waits for the state the test explicitly expects. `workspace` means the signed-in
 * shell; `sign-in` means the owner sign-in screen (for example after a 401), which never shows the
 * workspace shell. Waiting for `#main-content` in that case would depend on a transient render.
 */
async function open(
  page: Page,
  hash = '#projects',
  expected: 'workspace' | 'sign-in' = 'workspace',
) {
  await page.goto(`/${hash}`);
  if (expected === 'workspace') {
    await expect(page.locator('#main-content')).toBeVisible();
    return;
  }
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('#main-content')).toHaveCount(0);
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary navigation' });
const table = (page: Page, name: string) => page.getByRole('table', { name });
const status = (page: Page) => page.locator('[data-message-key]');
const detailHash = (id: string) => `#projects/${id}`;

const copy = {
  csrf: 'Your secure session needs refreshing. The change was not applied. Try again.',
  invalid:
    'The server rejected these values. Check them, and remove anything that looks like a credential or secret.',
  created: (key: string, name: string) =>
    `The server confirmed the project was created: ${key}, ${name}.`,
  edited: (revision: number) =>
    `The server confirmed your changes. The project is now at revision ${revision}.`,
  archived:
    'The server confirmed this project is archived. It is now read-only, and there is no restore action.',
  stale:
    'This project changed since you opened it, so your edits were not applied. Your unsaved edits are still in the form.',
};

async function fillCreate(page: Page, key: string, name: string, objective: string) {
  await page.getByLabel('Key', { exact: true }).fill(key);
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Objective').fill(objective);
}

test.describe('navigation', () => {
  test('Projects is in the primary navigation and opens the directory', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, '#command-center');
    await nav(page).getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page).toHaveURL(/#projects$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(table(page, 'Projects')).toBeVisible();
  });

  test('a project link can be entered directly and survives a reload', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, detailHash(alpha.id));
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  });

  test('browser back and forward move between directory, detail and edit', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page);
    await page.getByRole('link', { name: 'Alpha rollout' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit project' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Edit project' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    await page.goBack();
    await expect(table(page, 'Projects')).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
  });

  test('a malformed project link makes no request and explains itself', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, '#projects/not-a-project');
    await expect(page.getByRole('alert')).toContainText('This project link is not valid.');
    expect(api.requests.filter((r) => r.path.startsWith('/api/v1/projects'))).toEqual([]);
  });

  test('the skip link and sign-out still work on the Projects screen', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
    await expect(page).toHaveURL(/#projects$/);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('directory', () => {
  test('lists projects with their real fields', async ({ page, api }) => {
    api.configure({ projects: [alpha, beta] });
    await open(page);
    const rows = table(page, 'Projects').getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('AO-1');
    await expect(rows.nth(1)).toContainText('Alpha rollout');
    await expect(rows.nth(1)).toContainText('Active');
    await expect(rows.nth(1)).toContainText('High');
    await expect(rows.nth(2)).toContainText('Paused');
    await expect(rows.nth(2)).toContainText('Low');
    await expect(page.getByTestId('directory-summary')).toHaveText('Showing 2 of 2 projects.');
    expect(api.requests.some((r) => r.path.startsWith('/api/v1/tasks/'))).toBe(false);
  });

  test('timestamps are shown in Asia/Manila time', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page);
    // 2026-11-03T10:00:00Z is 18:00 in Manila (UTC+8, no daylight saving).
    await expect(table(page, 'Projects')).toContainText('6:00');
    await expect(table(page, 'Projects')).toContainText('PM');
  });

  test('shows an empty state with a way to create the first project', async ({ page, api }) => {
    api.configure({ projects: [] });
    await open(page);
    await expect(page.getByText('No projects yet')).toBeVisible();
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page).toHaveURL(/#projects\/new$/);
  });

  test('a failed load shows an error and retry sends exactly one more request', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    api.persist('list', { status: 500, code: 'internal_error', message: 'The request failed.' });
    await open(page);
    await expect(page.getByRole('alert')).toContainText('The project list could not be loaded.');
    await expect(page.getByRole('alert')).toContainText('The request failed.');
    const before = api.of('GET', /^\/api\/v1\/projects$/).length;
    await page.waitForTimeout(300);
    expect(api.of('GET', /^\/api\/v1\/projects$/), 'no automatic retry').toHaveLength(before);
    api.persist('list', null);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(table(page, 'Projects')).toBeVisible();
    expect(api.of('GET', /^\/api\/v1\/projects$/)).toHaveLength(before + 1);
  });

  test('archived projects are hidden by default, counted, and shown on request', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha, gamma] });
    await open(page);
    await expect(table(page, 'Projects').getByRole('row')).toHaveCount(2);
    await expect(page.getByTestId('directory-summary')).toHaveText(
      'Showing 1 of 2 projects. 1 archived project is hidden.',
    );
    await page.getByLabel('Show archived projects').click();
    await expect(page).toHaveURL(/#projects\?archived=1$/);
    const rows = table(page, 'Projects').getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText('Gamma archive');
    await expect(rows.nth(2)).toContainText('Archived');
    await expect(page.getByTestId('directory-summary')).toHaveText('Showing 2 of 2 projects.');
    await page.reload();
    await expect(page.getByLabel('Show archived projects')).toBeChecked();
  });

  test('search filters by name or key without another request', async ({ page, api }) => {
    api.configure({ projects: [alpha, beta] });
    await open(page);
    await expect(table(page, 'Projects')).toBeVisible();
    const before = api.of('GET', /^\/api\/v1\/projects$/).length;
    await page.getByLabel('Search projects').fill('ao-2');
    await expect(table(page, 'Projects').getByRole('row')).toHaveCount(2);
    await expect(table(page, 'Projects')).toContainText('Beta migration');
    await page.getByLabel('Search projects').fill('zzz');
    await expect(page.getByText('No projects match')).toBeVisible();
    expect(api.of('GET', /^\/api\/v1\/projects$/)).toHaveLength(before);
  });

  test('an expired session returns to sign-in', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    api.persist('list', { status: 401, code: 'unauthorized', message: 'Sign in to continue.' });
    await open(page, '#projects', 'sign-in');
    await expect(
      page.getByText('Your owner session expired. Sign in again to continue.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('project detail and tasks', () => {
  test('shows the project and task summaries with their latest run', async ({ page, api }) => {
    const tasks = [
      task(1, alpha.id, {
        title: 'Review the deliverable',
        status: 'in_progress',
        latestRun: { id: 'run-0001', status: 'running', createdAt: stampA, updatedAt: later },
      }),
      task(2, alpha.id, { title: 'Write the brief', status: 'completed' }),
    ];
    api.configure({ projects: [alpha], tasks: { [alpha.id]: tasks } });
    await open(page, detailHash(alpha.id));
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    await expect(page.getByText('Ship alpha safely.')).toBeVisible();
    const info = page.locator('dl.nx-info');
    await expect(info).toContainText('Active');
    await expect(info).toContainText('High');
    await expect(info).toContainText('1');
    await expect(info).toContainText(alpha.id);
    const rows = table(page, 'Tasks in Alpha rollout').getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('Review the deliverable');
    await expect(rows.nth(1)).toContainText('In progress');
    await expect(rows.nth(1)).toContainText('Running');
    await expect(rows.nth(2)).toContainText('No runs yet');
    await expect(rows.nth(1).getByRole('link', { name: 'run-0001' })).toHaveAttribute(
      'href',
      '#runs/run-0001',
    );
    await expect(page.getByTestId('task-summary')).toHaveText('Showing all 2 tasks.');
    expect(api.requests.some((r) => /^\/api\/v1\/tasks\/[^/]+$/.test(r.path))).toBe(false);
  });

  test('an empty project says so', async ({ page, api }) => {
    api.configure({ projects: [alpha], tasks: { [alpha.id]: [] } });
    await open(page, detailHash(alpha.id));
    await expect(page.getByText('No tasks in this project')).toBeVisible();
  });

  test('paged tasks never present a partial page as the project total', async ({ page, api }) => {
    const many = Array.from({ length: 60 }, (_, index) => task(index + 1, alpha.id));
    api.configure({ projects: [alpha], tasks: { [alpha.id]: many } });
    await open(page, detailHash(alpha.id));
    const summary = page.getByTestId('task-summary');
    await expect(summary).toHaveText(
      'Showing 25 tasks so far. 60 tasks were associated with this project when the latest page was read.',
    );
    await expect(summary).not.toContainText('Total');
    await expect(table(page, 'Tasks in Alpha rollout').getByRole('row')).toHaveCount(26);
    expect(projectTaskReads(api).map((r) => r.search)).toEqual(
      expect.arrayContaining(['?limit=25']),
    );
    await page.getByRole('button', { name: 'Load more tasks' }).click();
    await expect(table(page, 'Tasks in Alpha rollout').getByRole('row')).toHaveCount(51);
    expect(projectTaskReads(api).at(-1)?.search).toBe('?limit=25&cursor=cur%3A25');
    await page.getByRole('button', { name: 'Load more tasks' }).click();
    await expect(summary).toHaveText('Showing all 60 tasks.');
    await expect(page.getByRole('button', { name: 'Load more tasks' })).toHaveCount(0);
  });

  test('a failed next page keeps the tasks already shown and can be retried', async ({
    page,
    api,
  }) => {
    const many = Array.from({ length: 30 }, (_, index) => task(index + 1, alpha.id));
    api.configure({ projects: [alpha], tasks: { [alpha.id]: many } });
    await open(page, detailHash(alpha.id));
    await expect(table(page, 'Tasks in Alpha rollout').getByRole('row')).toHaveCount(26);
    api.next('tasks', { status: 500, code: 'internal_error', message: 'Task read failed.' });
    await page.getByRole('button', { name: 'Load more tasks' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Task read failed.' })).toBeVisible();
    await expect(table(page, 'Tasks in Alpha rollout').getByRole('row')).toHaveCount(26);
    await page.getByRole('button', { name: 'Retry loading more tasks' }).click();
    await expect(table(page, 'Tasks in Alpha rollout').getByRole('row')).toHaveCount(31);
  });

  test('an invalid continuation offers a restart from the first page', async ({ page, api }) => {
    const many = Array.from({ length: 30 }, (_, index) => task(index + 1, alpha.id));
    api.configure({ projects: [alpha], tasks: { [alpha.id]: many } });
    await open(page, detailHash(alpha.id));
    api.invalidateCursors();
    await page.getByRole('button', { name: 'Load more tasks' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'The task list changed while it was being read, so the next page can no longer be continued.',
    );
    await expect(table(page, 'Tasks in Alpha rollout').getByRole('row')).toHaveCount(26);
    const reads = projectTaskReads(api).length;
    await page.getByRole('button', { name: 'Restart from the first page' }).click();
    await expect(table(page, 'Tasks in Alpha rollout').getByRole('row')).toHaveCount(26);
    expect(projectTaskReads(api)).toHaveLength(reads + 1);
    expect(projectTaskReads(api).at(-1)?.search).toBe('?limit=25');
  });

  test('a missing project shows not found, with no retry and a way back', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, detailHash(pid(99)));
    await expect(page.getByRole('alert')).toContainText('This project was not found.');
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await page.getByRole('link', { name: '← All projects' }).click();
    await expect(table(page, 'Projects')).toBeVisible();
  });

  test('an archived project is read-only and still shows its tasks', async ({ page, api }) => {
    api.configure({
      projects: [gamma],
      tasks: { [gamma.id]: [task(1, gamma.id, { title: 'Historic task' })] },
    });
    await open(page, detailHash(gamma.id));
    await expect(
      page.getByText('This project is archived and read-only. There is no restore action.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit project' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive project' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /restore/i })).toHaveCount(0);
    await expect(table(page, 'Tasks in Gamma archive')).toContainText('Historic task');
  });

  test('a slow response for a previous project never replaces the current one', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha, beta] });
    api.delayDetail(alpha.id, 900);
    await open(page, detailHash(alpha.id));
    await page.evaluate((hash) => (window.location.hash = hash), detailHash(beta.id));
    await expect(page.getByRole('heading', { level: 2, name: 'Beta migration' })).toBeVisible();
    await page.waitForTimeout(1300);
    await expect(page.getByRole('heading', { level: 2, name: 'Beta migration' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Alpha rollout' })).toHaveCount(0);
  });

  test('leaving while loading cancels quietly', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    api.delayDetail(alpha.id, 800);
    await open(page, detailHash(alpha.id));
    await page.evaluate(() => (window.location.hash = '#tasks'));
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  });
});

const stampA = '2026-11-04T02:00:00.000Z';

test.describe('create project', () => {
  test('creates a project with a protected, idempotent request and lands on it', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-200', '  Delta  ', 'Deliver delta.');
    await page.getByLabel('Priority').selectOption('urgent');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Delta' })).toBeVisible();
    await expect(status(page)).toHaveText(copy.created('AO-200', 'Delta'));
    const post = api.posts()[0];
    expect(api.posts()).toHaveLength(1);
    expect(post?.body).toEqual({
      key: 'AO-200',
      name: 'Delta',
      objective: 'Deliver delta.',
      priority: 'urgent',
    });
    expect(post?.csrf).toBe('csrf-fixture');
    expect(post?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page).toHaveURL(new RegExp(`#projects/prj_[0-9a-f]{32}$`));
    // The follow-up read is authoritative: the project is read back from the server.
    expect(api.of('GET', /^\/api\/v1\/projects\/prj_/).length).toBeGreaterThan(0);
    await expect(page.locator('dl.nx-info')).toContainText('Proposed');
  });

  test('validates before sending and keeps focus on the first problem', async ({ page, api }) => {
    api.configure({ projects: [] });
    await open(page, '#projects/new');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByLabel('Key', { exact: true })).toBeFocused();
    await expect(page.getByText('Enter a key.')).toBeVisible();
    await expect(page.getByText('Enter a name.')).toBeVisible();
    await expect(page.getByText('Enter an objective.')).toBeVisible();
    await page.getByLabel('Key', { exact: true }).fill('ao-1');
    await page.getByLabel('Name', { exact: true }).fill('x'.repeat(121));
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(
      page.getByText(
        'Start with a capital letter. Use capital letters and numbers, with single hyphens between parts, for example AO-105.',
      ),
    ).toBeVisible();
    await expect(page.getByText('Use 120 characters or fewer.')).toBeVisible();
    expect(api.posts()).toHaveLength(0);
  });

  test('prevents a duplicate submission', async ({ page, api }) => {
    api.configure({ projects: [] });
    api.next('create', { delayMs: 600 });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-7', 'Seven', 'Seven things.');
    const submit = page.getByRole('button', { name: 'Create project' });
    await submit.dblclick();
    // Implicit submission from a text field while the request is still in flight.
    await page.getByLabel('Name', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Seven' })).toBeVisible();
    expect(api.posts()).toHaveLength(1);
    expect(api.storedCount()).toBe(1);
  });

  test('a taken key is reported on the field and the values are kept', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-1', 'Another', 'Reuses the key.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText('This key is already used by another project.')).toBeVisible();
    await expect(page.getByLabel('Key', { exact: true })).toBeFocused();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Another');
    await expect(page.getByLabel('Objective')).toHaveValue('Reuses the key.');
    await page.getByLabel('Key', { exact: true }).fill('AO-3');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Another' })).toBeVisible();
    const keys = api.posts().map((r) => r.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]); // a definite rejection ends the intent
  });

  test('a server validation rejection keeps what was typed', async ({ page, api }) => {
    api.configure({ projects: [] });
    api.next('create', {
      status: 422,
      code: 'invalid_input',
      message: 'Project input is invalid.',
    });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-5', 'Five', 'Five things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(status(page)).toHaveText(copy.invalid);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Five');
  });

  test('a rejected CSRF token refreshes the token and the retry succeeds', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [] });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-6', 'Six', 'Six things.');
    const before = api.csrfReads().length;
    api.rotateCsrf();
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(status(page)).toHaveText(copy.csrf);
    expect(api.csrfReads().length).toBe(before + 1);
    expect(api.storedCount()).toBe(0);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Six' })).toBeVisible();
    expect(api.posts()[1]?.csrf).toBe('csrf-rotated');
  });

  test('a full directory is reported as a definite refusal', async ({ page, api }) => {
    api.configure({ projects: [] });
    api.next('create', {
      status: 503,
      code: 'limit',
      message: 'The project directory capacity was reached.',
    });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-8', 'Eight', 'Eight things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(status(page)).toHaveText(
      "The project limit (500) has been reached. Archiving is permanent, so existing projects can't be removed in this release.",
    );
  });

  test('a lost response after the commit is recovered from the project list', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [] });
    api.next('create', { abort: true, commit: true });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-9', 'Nine', 'Nine things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('alert')).toContainText(
      "The result was unknown. The project list shows a project with this key, the name Nine and this priority. We couldn't confirm whether this request created it. Open it to check.",
    );
    expect(api.posts()).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Create project' })).toBeDisabled();
    await page.getByRole('button', { name: 'Open project' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Nine' })).toBeVisible();
    expect(api.storedCount()).toBe(1);
  });

  test('a lost request that never committed is retried with the same key and body', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [] });
    api.next('create', { abort: true });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-10', 'Ten', 'Ten things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('alert')).toContainText(
      "The result was unknown. The project list doesn't show this project, so it was probably not created. Trying again reuses the same request, which cannot create a duplicate.",
    );
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Ten' })).toBeVisible();
    const [first, second] = api.posts();
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.body).toEqual(first?.body);
    expect(api.storedCount()).toBe(1);
  });

  test('an ambiguous 503 is treated as unknown, not as failure', async ({ page, api }) => {
    api.configure({ projects: [] });
    api.next('create', {
      status: 503,
      code: 'project_outcome_unknown',
      message: 'The authorizer response was lost; the project change may have committed.',
      commit: true,
    });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-11', 'Eleven', 'Eleven things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('alert')).toContainText(
      "We couldn't confirm whether this request created it.",
    );
    await expect(page.getByRole('alert')).not.toContainText('not applied');
  });

  test('if the recheck also fails, saving stays paused until it succeeds', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [] });
    api.next('create', { abort: true });
    api.next('list', { status: 500, code: 'internal_error', message: 'Down.' });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-12', 'Twelve', 'Twelve things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('alert')).toContainText(
      "The result of creating this project is unknown, and Omnis OS couldn't check the project list. Check again before trying again.",
    );
    await expect(page.getByRole('button', { name: 'Create project' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(api.posts()).toHaveLength(1);
  });

  test('an expired session during create returns to sign-in', async ({ page, api }) => {
    api.configure({ projects: [] });
    api.next('create', { status: 401, code: 'unauthorized', message: 'Sign in to continue.' });
    await open(page, '#projects/new');
    await fillCreate(page, 'AO-13', 'Thirteen', 'Thirteen things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('edit project', () => {
  test('sends only the changed fields with the expected revision', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, detailHash(alpha.id));
    await page.getByRole('button', { name: 'Edit project' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Alpha rollout');
    await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
    await page.getByLabel('Name', { exact: true }).fill('Alpha rollout v2');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout v2' })).toBeVisible();
    await expect(status(page)).toHaveText(copy.edited(2));
    expect(api.patches()).toHaveLength(1);
    expect(api.patches()[0]?.body).toEqual({ expectedRevision: 1, name: 'Alpha rollout v2' });
    expect(api.patches()[0]?.csrf).toBe('csrf-fixture');
    await expect(page.locator('dl.nx-info')).toContainText('2');
  });

  test('saving with no change sends nothing', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(status(page)).toHaveText('Change at least one field before saving.');
    expect(api.patches()).toHaveLength(0);
  });

  test('the key cannot be edited', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await expect(page.getByLabel('Key', { exact: true })).toHaveCount(0);
    await expect(page.getByText('The key cannot be changed.')).toBeVisible();
  });

  test('a stale revision is explained, nothing is resent, and edits are kept', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Alpha rollout');
    api.editOutside(alpha.id, { name: 'Renamed elsewhere' });
    await page.getByLabel('Objective').fill('My new objective.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('[data-message-key="rejected.edit.stale"]')).toHaveText(copy.stale);
    await expect(page.getByLabel('Objective')).toHaveValue('My new objective.');
    await page.waitForTimeout(400);
    expect(api.patches()).toHaveLength(1); // never auto-resubmitted
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  test('Load latest values discards the edits and shows the current project', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Alpha rollout');
    api.editOutside(alpha.id, { name: 'Renamed elsewhere' });
    await page.getByLabel('Objective').fill('My new objective.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('button', { name: 'Load latest values (discard my edits)' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Renamed elsewhere');
    await expect(page.getByLabel('Objective')).toHaveValue('Ship alpha safely.');
    await expect(status(page)).toHaveText('Loaded the latest values, revision 2.');
  });

  test('Keep my edits applies them to the latest version with a new revision and key', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Alpha rollout');
    api.editOutside(alpha.id, { name: 'Renamed elsewhere' });
    await page.getByLabel('Objective').fill('My new objective.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('button', { name: 'Keep my edits on the latest version' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Renamed elsewhere');
    await expect(page.getByLabel('Objective')).toHaveValue('My new objective.');
    await expect(status(page)).toHaveText(
      'Your edits are kept on top of the latest version, revision 2. Review them, then save.',
    );
    expect(api.patches()).toHaveLength(1);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Renamed elsewhere' })).toBeVisible();
    expect(api.patches()[1]?.body).toEqual({ expectedRevision: 2, objective: 'My new objective.' });
    expect(api.patches()[1]?.idempotencyKey).not.toBe(api.patches()[0]?.idempotencyKey);
  });

  test('a project archived meanwhile cannot be edited', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Alpha rollout');
    api.editOutside(alpha.id, { status: 'archived' });
    await page.getByLabel('Name', { exact: true }).fill('Too late');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      "The project is currently archived, so it can't be changed. The server reported a conflict, and it can't be determined whether this request or something else archived it.",
    );
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Too late');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  test('editing an archived project directly is refused without a form', async ({ page, api }) => {
    api.configure({ projects: [gamma] });
    await open(page, `${detailHash(gamma.id)}/edit`);
    await expect(page.getByRole('alert')).toContainText('This project is archived.');
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  });

  test('a lost response whose values now match is reported as observed, not as saved by this request', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    api.next('update', { abort: true, commit: true });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await page.getByLabel('Name', { exact: true }).fill('Alpha two');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha two' })).toBeVisible();
    await expect(status(page)).toHaveText(
      "The project currently has the requested values. We couldn't confirm whether this request saved them.",
    );
    expect(api.patches()).toHaveLength(1);
    expect(api.stored(alpha.id)?.revision).toBe(2);
  });

  test('a lost request that was not saved is retried with the same key', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    api.next('update', { abort: true });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await page.getByLabel('Name', { exact: true }).fill('Alpha two');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'The result was unknown. The project still shows its previous values, so your changes were probably not saved. Trying again reuses the same request, which cannot apply twice.',
    );
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha two' })).toBeVisible();
    const [first, second] = api.patches();
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.body).toEqual(first?.body);
    expect(api.stored(alpha.id)?.revision).toBe(2);
  });

  test('changing the values after an unknown outcome uses a new key', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    api.next('update', { abort: true });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await page.getByLabel('Name', { exact: true }).fill('Alpha two');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('button', { name: 'Edit values' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Alpha three');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha three' })).toBeVisible();
    expect(api.patches()[1]?.idempotencyKey).not.toBe(api.patches()[0]?.idempotencyKey);
  });

  test('an edit that cannot be told apart from another change is not retried blindly', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    api.next('update', {
      abort: true,
      before: () => api.editOutside(alpha.id, { priority: 'urgent' }),
    });
    await open(page, `${detailHash(alpha.id)}/edit`);
    await page.getByLabel('Name', { exact: true }).fill('Alpha two');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toContainText(
      "The result was unknown, and the project has changed since you opened it. It can't be told whether your edit was applied. Review the latest values before saving again.",
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

test.describe('archive project', () => {
  const trigger = (page: Page) => page.getByRole('button', { name: 'Archive project' });
  const dialog = (page: Page) => page.getByRole('dialog', { name: 'Archive this project?' });

  test('the dialog states the consequence, defaults to Cancel and restores focus', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page, detailHash(alpha.id));
    await trigger(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText(
      'Archiving "Alpha rollout" cannot be undone. There is no restore action. The project stays readable, but it can no longer be edited and new runs can no longer be started for its tasks. Runs already started are not cancelled.',
    );
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(trigger(page)).toBeFocused();
    expect(api.archives()).toHaveLength(0);
  });

  test('confirming archives with the revision, protection and an idempotency key', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha], tasks: { [alpha.id]: [task(1, alpha.id)] } });
    await open(page, detailHash(alpha.id));
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(status(page)).toHaveText(copy.archived);
    expect(api.archives()).toHaveLength(1);
    expect(api.archives()[0]?.body).toEqual({ expectedRevision: 1 });
    expect(api.archives()[0]?.csrf).toBe('csrf-fixture');
    expect(api.archives()[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      page.getByText('This project is archived and read-only. There is no restore action.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit project' })).toHaveCount(0);
    await expect(trigger(page)).toHaveCount(0);
    await expect(page.locator('.pw-live[tabindex="-1"]')).toBeFocused();
    await expect(page.locator('dl.nx-info')).toContainText('Archived');
    await expect(table(page, 'Tasks in Alpha rollout')).toBeVisible();
  });

  test('activating the confirmation repeatedly sends one request', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    api.next('archive', { delayMs: 600 });
    await open(page, detailHash(alpha.id));
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).dblclick();
    await expect(status(page)).toHaveText(copy.archived);
    expect(api.archives()).toHaveLength(1);
  });

  test('a stale revision does not archive and shows the latest version', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, detailHash(alpha.id));
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    api.editOutside(alpha.id, { name: 'Renamed elsewhere' });
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'This project changed since you opened it, so it was not archived. Review the latest version, then archive again if you still want to.',
    );
    await expect(page.getByRole('heading', { level: 2, name: 'Renamed elsewhere' })).toBeVisible();
    expect(api.stored(alpha.id)?.status).toBe('active');
    expect(api.archives()).toHaveLength(1);
  });

  test('a project already archived elsewhere is reported', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, detailHash(alpha.id));
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    api.editOutside(alpha.id, { status: 'archived' });
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      "The project is currently archived, so it can't be changed. The server reported a conflict, and it can't be determined whether this request or something else archived it.",
    );
    await expect(
      page.getByText('This project is archived and read-only. There is no restore action.'),
    ).toBeVisible();
  });

  test('a rejected CSRF token refreshes it and the archive can be confirmed again', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page, detailHash(alpha.id));
    api.rotateCsrf();
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByRole('alert')).toHaveText(copy.csrf);
    expect(api.stored(alpha.id)?.status).toBe('active');
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(status(page)).toHaveText(copy.archived);
    expect(api.archives()[1]?.csrf).toBe('csrf-rotated');
  });

  test('a lost response after the commit is recognised as archived', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    api.next('archive', { abort: true, commit: true });
    await open(page, detailHash(alpha.id));
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(status(page)).toHaveText(
      "The result was unknown. The project is now archived, and it is read-only with no restore action. We couldn't confirm whether this request archived it.",
    );
    expect(api.archives()).toHaveLength(1);
  });

  test('a lost request that did not archive is retried with the same key', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    api.next('archive', { status: 503, code: 'project_outcome_unknown', message: 'Lost.' });
    await open(page, detailHash(alpha.id));
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'The result was unknown. The project is still not archived. Trying again reuses the same request, which cannot archive twice.',
    );
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(status(page)).toHaveText(copy.archived);
    expect(api.archives()[1]?.idempotencyKey).toBe(api.archives()[0]?.idempotencyKey);
    expect(api.archives()[1]?.body).toEqual(api.archives()[0]?.body);
  });

  test('an expired session during archive returns to sign-in', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    api.next('archive', { status: 401, code: 'unauthorized', message: 'Sign in to continue.' });
    await open(page, detailHash(alpha.id));
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

async function expectContained(page: Page, label: string) {
  const metrics = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(metrics.doc, `${label}: page must not scroll horizontally`).toBeLessThanOrEqual(
    metrics.client,
  );
}

const busyTasks = () => [
  task(1, alpha.id, {
    title:
      'A deliberately long task title that has to wrap inside the table without widening the page',
    latestRun: {
      id: 'run-with-a-long-identifier-0001',
      status: 'failed',
      createdAt: stampA,
      updatedAt: later,
    },
  }),
  ...Array.from({ length: 30 }, (_, index) => task(index + 2, alpha.id)),
];

const screens: Array<{ name: string; hash: string }> = [
  { name: 'directory', hash: '#projects' },
  { name: 'detail', hash: detailHash(alpha.id) },
  { name: 'create form', hash: '#projects/new' },
  { name: 'edit form', hash: `${detailHash(alpha.id)}/edit` },
];

test.describe('responsive containment and accessibility', () => {
  for (const width of [320, 390, 720, 1024, 1440]) {
    test(`no horizontal overflow on every Projects screen at ${width}px`, async ({ page, api }) => {
      api.configure({ projects: [alpha, beta, gamma], tasks: { [alpha.id]: busyTasks() } });
      await page.setViewportSize({ width, height: 900 });
      for (const screen of screens) {
        await open(page, screen.hash);
        await expect(page.locator('.pw-surface h2').first()).toBeVisible();
        await expectContained(page, `${screen.name} @${width}`);
        if (screen.name === 'detail')
          await test.info().attach(`projects-${screen.name}-${width}.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
      }
    });
  }

  for (const width of [390, 1440]) {
    test(`axe finds no violations on every Projects screen at ${width}px`, async ({
      page,
      api,
    }) => {
      api.configure({ projects: [alpha, beta, gamma], tasks: { [alpha.id]: busyTasks() } });
      await page.setViewportSize({ width, height: 900 });
      for (const screen of screens) {
        await open(page, screen.hash);
        await expect(page.locator('.pw-surface h2').first()).toBeVisible();
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations, screen.name).toEqual([]);
      }
    });
  }

  test('axe finds no violations on validation errors, notices and the archive dialog', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page, '#projects/new');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText('Enter a key.')).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    api.next('create', { abort: true });
    await fillCreate(page, 'AO-30', 'Thirty', 'Thirty things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('alert')).toContainText('The result was unknown.');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await open(page, detailHash(alpha.id));
    await page.getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByRole('dialog', { name: 'Archive this project?' })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test('the whole create flow works by keyboard alone', async ({ page, api }) => {
    api.configure({ projects: [] });
    await open(page, '#projects/new');
    await page.getByLabel('Key', { exact: true }).focus();
    await page.keyboard.type('AO-40');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Forty');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Forty things.');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Priority')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Create project' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Forty' })).toBeVisible();
  });

  test('every control on the detail screen shows a visible focus ring', async ({ page, api }) => {
    api.configure({ projects: [alpha], tasks: { [alpha.id]: busyTasks() } });
    await open(page, detailHash(alpha.id));
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    await page.getByRole('link', { name: '← All projects' }).focus();
    const names: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const cs = getComputedStyle(el);
        return {
          name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName,
          width: Number.parseFloat(cs.outlineWidth),
          style: cs.outlineStyle,
        };
      });
      expect(info.style, `${info.name} focus outline`).not.toBe('none');
      expect(info.width, `${info.name} focus width`).toBeGreaterThanOrEqual(2);
      names.push(info.name);
      await page.keyboard.press('Tab');
    }
    expect(names).toContain('Edit project');
    expect(names).toContain('Archive project');
  });

  test('a 16px minimum font setting still contains every Projects screen at 320px', async () => {
    const baseURL = test.info().project.use.baseURL;
    if (!baseURL) throw new Error('The Playwright project has no baseURL.');
    const browser = await chromium.launch({ args: ['--blink-settings=minimumFontSize=16'] });
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 900 }, baseURL });
      createApi(page).configure({
        projects: [alpha, beta],
        tasks: { [alpha.id]: busyTasks() },
      });
      for (const screen of screens) {
        await page.goto(`/${screen.hash}`);
        await expect(page.locator('.pw-surface h2').first()).toBeVisible();
        await expectContained(page, `${screen.name} 16px minimum @320`);
      }
    } finally {
      await browser.close();
    }
  });

  test('genuine 200% browser zoom reflows the detail screen without overflow', async () => {
    const baseURL = test.info().project.use.baseURL;
    if (!baseURL) throw new Error('The Playwright project has no baseURL.');
    const level = Math.log(2) / Math.log(1.2); // Chromium's zoom level for 200%
    const profile = mkdtempSync(join(tmpdir(), 'omnis-projects-zoom-'));
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({
        partition: {
          default_zoom_level: { x: level },
          per_host_zoom_levels: {
            x: { '127.0.0.1': { zoom_level: level, last_modified: '13400000000000000' } },
          },
        },
      }),
    );
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      baseURL,
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      createApi(page).configure({ projects: [alpha], tasks: { [alpha.id]: busyTasks() } });
      for (const screen of screens) {
        await page.goto(`/${screen.hash}`);
        await expect(page.locator('.pw-surface h2').first()).toBeVisible();
        const m = await page.evaluate(() => ({
          ratio: window.devicePixelRatio,
          inner: window.innerWidth,
        }));
        expect(m.ratio, 'devicePixelRatio proves real browser zoom').toBeCloseTo(2, 1);
        expect(m.inner).toBe(640);
        await expectContained(page, `${screen.name} @200% zoom`);
      }
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('reduced motion removes animation from the Projects workspace', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    api.next('detail', { delayMs: 400 });
    await open(page, detailHash(alpha.id));
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll('.pw-surface *')].map(
        (el) => getComputedStyle(el).animationName,
      ),
    );
    expect(durations.every((name) => name === 'none')).toBe(true);
  });

  test('workspace link styling is scoped to the workspace', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await open(page, '#tasks'); // the Projects stylesheet is in the bundle but must not reach here
    const outside = await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<table class="nx-table" id="probe"><tbody><tr><td><a href="#x">link</a></td></tr></tbody></table>',
      );
      return getComputedStyle(document.querySelector('#probe a')!).textUnderlineOffset;
    });
    expect(outside, 'a .nx-table link outside the workspace keeps the browser default').toBe(
      'auto',
    );
    await open(page);
    await expect(table(page, 'Projects')).toBeVisible();
    const inside = await page
      .getByRole('link', { name: 'Alpha rollout' })
      .evaluate((el) => getComputedStyle(el).textUnderlineOffset);
    expect(inside).toBe('2px');
  });

  test('colours come from the NEXUS tokens and the page is unchanged elsewhere', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await open(page, '#tasks');
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--nx-jade').trim(),
      ),
      'tokens must not leak onto the document root',
    ).toBe('');
    await open(page);
    const jade = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.nx-theme')!).getPropertyValue('--nx-jade').trim(),
    );
    expect(jade).toBe('#91f2cd');
    const bg = await page
      .locator('.nx-button[data-variant="primary"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  });
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page } from '@playwright/test';
import {
  createPlanningApi,
  epic,
  eid,
  milestone,
  planningTask as task,
  proj,
} from './planning.fixture.js';

/**
 * Browser tests for Project Planning V1 (epics, milestones, task-to-epic assignment). Every
 * response is a strictly contract-parsed synthetic fixture, so none of this is live backend
 * evidence. User-facing wording is typed here on purpose, so a copy change fails a test until the
 * expectation is reviewed by hand.
 */
const test = base.extend<{ api: ReturnType<typeof createPlanningApi> }>({
  api: async ({ page }, use) => {
    const api = createPlanningApi(page);
    await use(api);
    expect(api.unexpected, 'all frontend requests must match the fixture contract').toEqual([]);
  },
});

const project = proj(1, { name: 'Alpha rollout', objective: 'Ship alpha safely.' });
const archivedProject = proj(2, { name: 'Gamma archive', status: 'archived', revision: 3 });

type Config = Parameters<ReturnType<typeof createPlanningApi>['configure']>[0];

async function open(
  page: Page,
  api: ReturnType<typeof createPlanningApi>,
  config: Config = {},
  size = { width: 1440, height: 900 },
) {
  const target = config.project ?? project;
  api.configure({ project: target, ...config });
  await page.setViewportSize(size);
  await page.goto(`/#projects/${target.id}`);
  await expect(page.getByRole('heading', { level: 2, name: target.name })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Epics', exact: true })).toBeVisible();
}

const epicsPanel = (page: Page) => page.getByRole('region', { name: 'Epics', exact: true });
const milestonesPanel = (page: Page) =>
  page.getByRole('region', { name: 'Milestones', exact: true });
const tasksPanel = (page: Page) => page.getByRole('region', { name: 'Tasks', exact: true });
const dialog = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name });
const live = (page: Page) => page.locator('[data-planning-status]');
const row = (panel: ReturnType<typeof epicsPanel>, title: string) =>
  panel
    .getByRole('listitem')
    .filter({ has: panel.page().getByRole('heading', { name: title, level: 4, exact: true }) });
const e1 = epic(1, project.id, { title: 'Onboarding flow', description: 'Sign-up and first run.' });
const e2 = epic(2, project.id, { title: 'Billing', status: 'in_progress' });
const e3 = epic(3, project.id, {
  title: 'Legacy import',
  status: 'archived',
  archivedAt: '2026-11-04T08:30:00.000Z',
  revision: 2,
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.describe('epics: list and read states', () => {
  test('lists active epics, folds archived ones away, and says nothing it does not know', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1, e2, e3] });
    const panel = epicsPanel(page);
    await expect(row(panel, 'Onboarding flow')).toContainText('Planned');
    await expect(row(panel, 'Onboarding flow')).toContainText('Sign-up and first run.');
    await expect(row(panel, 'Billing')).toContainText('In progress');
    await expect(panel.getByRole('heading', { name: 'Legacy import' })).toHaveCount(0);
    await expect(panel.getByText('All 3 epics loaded; 2 shown.')).toBeVisible();
    await panel.getByRole('button', { name: 'Show archived (1)' }).click();
    const archived = row(panel, 'Legacy import');
    await expect(archived).toContainText('Archived');
    await expect(archived.getByRole('button', { name: /Edit epic|Archive epic/ })).toHaveCount(0);
  });

  test('empty, loading failure and retry', async ({ page, api }) => {
    api.persist('epics:list', { status: 500, code: 'internal_error', message: 'Down.' });
    await open(page, api, {}).catch(() => undefined);
    await expect(epicsPanel(page).getByText('The epic list could not be loaded.')).toBeVisible();
    api.persist('epics:list', null);
    await epicsPanel(page).getByRole('button', { name: 'Retry' }).click();
    await expect(epicsPanel(page).getByText('No epics yet')).toBeVisible();
    await expect(
      epicsPanel(page).getByText('Create the first epic to start planning this project.'),
    ).toBeVisible();
  });

  test('a forbidden project shows an access message and no retry', async ({ page, api }) => {
    api.persist('epics:list', { status: 403, code: 'forbidden', message: 'No.' });
    await open(page, api, {});
    await expect(
      epicsPanel(page).getByText("You don't have access to this epic list."),
    ).toBeVisible();
    await expect(epicsPanel(page).getByRole('button', { name: 'Retry' })).toHaveCount(0);
  });
});

test.describe('epics: create', () => {
  test('validates, sends exactly the typed values with a CSRF header and a fresh key, and returns focus', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1] });
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const form = dialog(page, 'New epic');
    await expect(form.getByLabel('Title')).toBeFocused();

    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form.getByText('Enter a title of 1 to 120 characters.')).toBeVisible();
    expect(api.writes()).toHaveLength(0);

    await form.getByLabel('Title').fill('  Reporting  ');
    await form.getByLabel('Description (optional)').fill('Weekly summaries.');
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toBeHidden();

    const [write] = api.writes();
    expect(write).toMatchObject({
      method: 'POST',
      body: { title: 'Reporting', description: 'Weekly summaries.' },
      csrf: 'csrf-fixture',
    });
    expect(write?.idempotencyKey).toMatch(uuid);
    await expect(row(epicsPanel(page), 'Reporting')).toContainText('Planned');
    // Newest first, and announced.
    await expect(epicsPanel(page).getByRole('heading', { level: 4 }).first()).toHaveText(
      'Reporting',
    );
    await expect(live(page)).toContainText('Epic “Reporting” created at revision 1.');
    await expect(epicsPanel(page).getByRole('button', { name: 'New epic' })).toBeFocused();
  });

  test('an omitted description is not sent', async ({ page, api }) => {
    await open(page, api, {});
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    await dialog(page, 'New epic').getByLabel('Title').fill('Solo');
    await dialog(page, 'New epic').getByRole('button', { name: 'Create epic' }).click();
    await expect(row(epicsPanel(page), 'Solo')).toBeVisible();
    expect(api.writes()[0]?.body).toEqual({ title: 'Solo' });
  });
});

test.describe('epics: edit, status and archive', () => {
  test('sends only what changed with the revision being edited, and restores focus to Edit', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1, e2] });
    const trigger = epicsPanel(page).getByRole('button', { name: 'Edit epic Onboarding flow' });
    await trigger.click();
    const form = dialog(page, 'Edit epic');
    await expect(form.getByText('Editing revision 1.')).toBeVisible();
    await form.getByLabel('Title').fill('Onboarding v2');
    await form.getByLabel('Status').selectOption('in_progress');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()[0]).toMatchObject({
      method: 'PATCH',
      body: { expectedRevision: 1, title: 'Onboarding v2', status: 'in_progress' },
    });
    expect(Object.keys(api.writes()[0]?.body as object).sort()).toEqual([
      'expectedRevision',
      'status',
      'title',
    ]);
    await expect(row(epicsPanel(page), 'Onboarding v2')).toContainText('In progress');
    await expect(row(epicsPanel(page), 'Onboarding v2')).toContainText('Revision 2');
    await expect(
      epicsPanel(page).getByRole('button', { name: 'Edit epic Onboarding v2' }),
    ).toBeFocused();
  });

  test('clearing the description sends null; submitting nothing sends nothing', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1] });
    await epicsPanel(page).getByRole('button', { name: 'Edit epic Onboarding flow' }).click();
    const form = dialog(page, 'Edit epic');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form.getByText('There is nothing to save. Change a field first.')).toBeVisible();
    expect(api.writes()).toHaveLength(0);
    await form.getByLabel('Description (optional)').fill('');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()[0]?.body).toEqual({ expectedRevision: 1, description: null });
    expect(api.epicStored(e1.id)?.description).toBeNull();
  });

  test('archive asks first, is permanent, and moves the epic under Show archived', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1, e2] });
    await epicsPanel(page).getByRole('button', { name: 'Archive epic Billing' }).click();
    const confirm = dialog(page, 'Archive this epic?');
    await expect(confirm).toContainText('cannot be undone');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(api.writes()).toHaveLength(0);
    await expect(
      epicsPanel(page).getByRole('button', { name: 'Archive epic Billing' }),
    ).toBeFocused();

    await epicsPanel(page).getByRole('button', { name: 'Archive epic Billing' }).click();
    await dialog(page, 'Archive this epic?').getByRole('button', { name: 'Archive epic' }).click();
    await expect(dialog(page, 'Archive this epic?')).toBeHidden();
    expect(api.writes()[0]).toMatchObject({
      method: 'POST',
      path: expect.stringMatching(/\/archive$/),
      body: { expectedRevision: 1 },
    });
    await expect(live(page)).toContainText('Epic “Billing” is archived.');
    // The Archive button left the page, so focus lands on the status region, not the document.
    await expect(live(page)).toBeFocused();
    await expect(epicsPanel(page).getByRole('heading', { name: 'Billing' })).toHaveCount(0);
    await epicsPanel(page).getByRole('button', { name: 'Show archived (1)' }).click();
    await expect(row(epicsPanel(page), 'Billing')).toContainText('Archived');
  });
});

test.describe('epics: revision conflicts and unknown outcomes', () => {
  async function startEdit(page: Page) {
    await epicsPanel(page).getByRole('button', { name: 'Edit epic Onboarding flow' }).click();
    return dialog(page, 'Edit epic');
  }

  test('a stale revision reads the latest, keeps the dialog open, and offers Load latest or Keep my edits', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1] });
    const form = await startEdit(page);
    await form.getByLabel('Title').fill('My title');
    api.next('epic:update', { before: () => api.editEpicOutside(e1.id, { title: 'Their title' }) });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText('was changed elsewhere (it is now at revision 2)');
    await expect(form.getByLabel('Title')).toHaveValue('My title');
    await expect(epicsPanel(page).getByRole('heading', { name: 'My title' })).toHaveCount(0);

    // Load latest replaces the form with the server's values at the new revision.
    await form.getByRole('button', { name: 'Load latest version' }).click();
    await expect(form.getByLabel('Title')).toHaveValue('Their title');
    await expect(form.getByText('Editing revision 2.')).toBeVisible();
  });

  test('Keep my edits re-bases them on the latest revision and saves with the new revision', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1] });
    const form = await startEdit(page);
    await form.getByLabel('Title').fill('My title');
    api.next('epic:update', {
      before: () => api.editEpicOutside(e1.id, { description: 'Edited elsewhere' }),
    });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await form.getByRole('button', { name: 'Keep my edits' }).click();
    await expect(form.getByText('Editing revision 2.')).toBeVisible();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    const patches = api.writes().filter((entry) => entry.method === 'PATCH');
    expect(patches.at(-1)?.body).toMatchObject({ expectedRevision: 2, title: 'My title' });
    expect(api.epicStored(e1.id)).toMatchObject({
      title: 'My title',
      description: 'Edited elsewhere',
      revision: 3,
    });
    // A new request after a definite rejection gets a new key.
    expect(patches[0]?.idempotencyKey).not.toBe(patches.at(-1)?.idempotencyKey);
  });

  test('editing an epic archived elsewhere says so and cannot be saved', async ({ page, api }) => {
    await open(page, api, { epics: [e1] });
    const form = await startEdit(page);
    await form.getByLabel('Title').fill('Late edit');
    api.next('epic:update', {
      before: () =>
        api.editEpicOutside(e1.id, { status: 'archived', archivedAt: '2026-11-04T08:30:00.000Z' }),
    });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText('was archived elsewhere and can no longer be edited');
    await expect(form.getByRole('button', { name: 'Keep my edits' })).toHaveCount(0);
  });

  test('a lost response that was not applied: nothing is shown as saved, and retry reuses the key', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1] });
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const form = dialog(page, 'New epic');
    await form.getByLabel('Title').fill('Reporting');
    api.next('epics:create', { abort: true });
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toContainText('did not get a confirmed result');
    await expect(form).toContainText('this form is locked to this exact request');
    await expect(epicsPanel(page).getByRole('heading', { name: 'Reporting' })).toHaveCount(0);
    expect(api.epicCount()).toBe(1);

    await form.getByRole('button', { name: 'Send the same request again' }).click();
    await expect(form).toBeHidden();
    const posts = api.writes();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.idempotencyKey).toBe(posts[0]?.idempotencyKey);
    expect(api.epicCount()).toBe(2);
    await expect(row(epicsPanel(page), 'Reporting')).toBeVisible();
  });

  test('a lost response after the commit: retrying replays it and creates exactly one epic', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [] });
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const form = dialog(page, 'New epic');
    await form.getByLabel('Title').fill('Reporting');
    api.next('epics:create', { abort: true, commit: true });
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toContainText('did not get a confirmed result');
    expect(api.epicCount()).toBe(1); // it was applied, and the page does not claim otherwise
    await expect(epicsPanel(page).getByRole('heading', { name: 'Reporting' })).toHaveCount(0);
    await form.getByRole('button', { name: 'Send the same request again' }).click();
    await expect(form).toBeHidden();
    expect(api.epicCount()).toBe(1);
    expect(api.writes().map((entry) => entry.idempotencyKey)).toEqual([
      api.writes()[0]?.idempotencyKey,
      api.writes()[0]?.idempotencyKey,
    ]);
    await expect(row(epicsPanel(page), 'Reporting')).toBeVisible();
  });

  test('Check current state after an applied edit shows what the server has, without claiming more', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1] });
    const form = await startEdit(page);
    await form.getByLabel('Title').fill('Renamed');
    api.next('epic:update', { abort: true, commit: true });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText('did not get a confirmed result');
    await form.getByRole('button', { name: 'Check current state' }).click();
    await expect(form).toBeHidden();
    await expect(row(epicsPanel(page), 'Renamed')).toContainText('Revision 2');
    expect(api.writes()).toHaveLength(1); // checking is a read, never a second write
  });

  test('Check current state when the edit was not applied offers to save again', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1] });
    const form = await startEdit(page);
    await form.getByLabel('Title').fill('Renamed');
    api.next('epic:update', { abort: true });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await form.getByRole('button', { name: 'Check current state' }).click();
    await expect(form).toContainText(
      'still at the revision you opened, so the change was not applied',
    );
    await form.getByRole('button', { name: 'Send the same request again' }).click();
    await expect(form).toBeHidden();
    expect(api.epicStored(e1.id)?.title).toBe('Renamed');
  });

  test('an unreadable recheck keeps the warning and does not guess', async ({ page, api }) => {
    await open(page, api, { epics: [e1] });
    const form = await startEdit(page);
    await form.getByLabel('Title').fill('Renamed');
    api.next('epic:update', { abort: true, commit: true });
    await form.getByRole('button', { name: 'Save changes' }).click();
    api.persist('epic:get', { status: 500, code: 'internal_error', message: 'Down.' });
    await form.getByRole('button', { name: 'Check current state' }).click();
    await expect(form).toContainText('cannot tell whether the change was applied');
    api.persist('epic:get', null);
  });

  test('a rotated CSRF token is refreshed and the same values can be sent again', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [] });
    api.rotateCsrf();
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const form = dialog(page, 'New epic');
    await form.getByLabel('Title').fill('After rotation');
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toContainText(
      'Your secure session needed refreshing. Nothing was changed. Try again.',
    );
    expect(api.epicCount()).toBe(0);
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toBeHidden();
    expect(api.epicCount()).toBe(1);
  });

  test('a rejected create (422, limit, not found) keeps the dialog open and says what the server said', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [] });
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const form = dialog(page, 'New epic');
    await form.getByLabel('Title').fill('Rejected');
    api.next('epics:create', { status: 422, code: 'invalid_input', message: 'Bad.' });
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toContainText('The server rejected these values.');
    api.next('epics:create', { status: 503, code: 'limit', message: 'Full.' });
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toContainText(
      "The limit for this project's epics was reached, so nothing was created or changed.",
    );
    api.next('epics:create', { status: 404, code: 'not_found', message: 'Gone.' });
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toContainText('was not found. Close this form; the list will be refreshed.');
    await form.getByRole('button', { name: 'Close and refresh the list' }).click();
    await expect(form).toBeHidden();
    expect(api.of('epics:list').length).toBeGreaterThanOrEqual(2); // the list was read again
  });

  test('a 5xx is an unknown outcome, never a rejection', async ({ page, api }) => {
    await open(page, api, { epics: [] });
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const form = dialog(page, 'New epic');
    await form.getByLabel('Title').fill('Maybe');
    api.next('epics:create', { status: 502, code: 'bad_gateway', message: 'Upstream.' });
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toContainText('did not get a confirmed result');
  });

  test('archive: a stale revision explains the change and a lost response is recoverable', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1] });
    await epicsPanel(page).getByRole('button', { name: 'Archive epic Onboarding flow' }).click();
    const confirm = dialog(page, 'Archive this epic?');
    api.next('epic:archive', { before: () => api.editEpicOutside(e1.id, { title: 'Elsewhere' }) });
    await confirm.getByRole('button', { name: 'Archive epic' }).click();
    await expect(confirm).toContainText(
      'was changed elsewhere (it is now at revision 2) and is not archived',
    );
    await confirm.getByRole('button', { name: 'Show latest version' }).click();
    await expect(confirm).toBeHidden();
    await expect(row(epicsPanel(page), 'Elsewhere')).toContainText('Revision 2');

    await epicsPanel(page).getByRole('button', { name: 'Archive epic Elsewhere' }).click();
    api.next('epic:archive', { abort: true, commit: true });
    await dialog(page, 'Archive this epic?').getByRole('button', { name: 'Archive epic' }).click();
    await expect(dialog(page, 'Archive this epic?')).toContainText(
      'did not get a confirmed result',
    );
    await dialog(page, 'Archive this epic?')
      .getByRole('button', { name: 'Check current state' })
      .click();
    await expect(dialog(page, 'Archive this epic?')).toBeHidden();
    await expect(live(page)).toContainText('Epic “Elsewhere” is archived.');
  });
});

const t = (i: number, overrides: Parameters<typeof task>[2] = {}) => task(i, project.id, overrides);
const run = (status: 'completed' | 'running') => ({
  id: 'run-9',
  status,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:30:00.000Z',
});
const manyTasks = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    t(i + 1, { status: (['open', 'in_progress', 'completed'] as const)[i % 3] ?? 'open' }),
  );
const group = (page: Page, name: string) => page.getByRole('group', { name });
const countsText = async (page: Page, name: string) =>
  (await group(page, name).locator('.pw-counts').innerText()).replace(/\s+/g, ' ').trim();

test.describe('pagination and completeness', () => {
  test('epics: the first page, an honest partial summary, then everything', async ({
    page,
    api,
  }) => {
    const sixty = Array.from({ length: 60 }, (_, i) =>
      epic(i + 10, project.id, { title: `Epic ${String(i + 1).padStart(2, '0')}` }),
    );
    await open(page, api, { epics: sixty });
    const panel = epicsPanel(page);
    await expect(panel.getByRole('heading', { level: 4 })).toHaveCount(50);
    await expect(
      panel.getByText('50 epics loaded so far; 60 were observed. More are available.'),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Load more epics' }).click();
    await expect(panel.getByRole('heading', { level: 4 })).toHaveCount(60);
    await expect(panel.getByText('All 60 epics loaded.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Load more epics' })).toHaveCount(0);
  });

  test('a continuation that can no longer be read keeps the first page and offers a restart', async ({
    page,
    api,
  }) => {
    const sixty = Array.from({ length: 60 }, (_, i) =>
      epic(i + 10, project.id, { title: `Epic ${i + 1}` }),
    );
    await open(page, api, { epics: sixty });
    api.invalidateCursors();
    await epicsPanel(page).getByRole('button', { name: 'Load more epics' }).click();
    await expect(epicsPanel(page)).toContainText('the next page can no longer be continued');
    await expect(epicsPanel(page).getByRole('heading', { level: 4 })).toHaveCount(50);
  });

  test('milestones page the same way', async ({ page, api }) => {
    const sixty = Array.from({ length: 60 }, (_, i) =>
      milestone(i + 10, project.id, { title: `Milestone ${i + 1}` }),
    );
    await open(page, api, { milestones: sixty });
    await expect(milestonesPanel(page).getByRole('heading', { level: 4 })).toHaveCount(50);
    await milestonesPanel(page).getByRole('button', { name: 'Load more milestones' }).click();
    await expect(milestonesPanel(page).getByText('All 60 milestones loaded.')).toBeVisible();
  });
});

test.describe('tasks in an epic', () => {
  test('counts by status come from the loaded tasks and say when all of them are loaded', async ({
    page,
    api,
  }) => {
    await open(page, api, {
      epics: [e1, e2],
      tasks: [
        t(1, { status: 'open' }),
        t(2, { status: 'in_progress', latestRun: run('running') }),
        t(3, { status: 'completed' }),
        t(4),
      ],
      assignments: { 'task-0001': e1.id, 'task-0002': e1.id, 'task-0003': e1.id },
    });
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    const tasks = group(page, 'Tasks in Onboarding flow');
    await expect(tasks.getByText('All 3 tasks loaded.')).toBeVisible();
    expect(await countsText(page, 'Tasks in Onboarding flow')).toBe(
      'Open 1 In progress 1 Awaiting review 0 Completed 1',
    );
    // Navigation to the existing task detail and run.
    await expect(tasks.getByRole('link', { name: 'Task number 1' })).toHaveAttribute(
      'href',
      '#tasks/task-0001',
    );
    await expect(tasks.getByRole('link', { name: /Running/ })).toHaveAttribute(
      'href',
      '#runs/run-9',
    );
    await expect(tasks.getByText('Task number 4')).toHaveCount(0); // not in this epic
    await expect(
      epicsPanel(page).getByRole('button', { name: 'Hide tasks for Onboarding flow' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  test('an epic with no tasks says so, and counts are zero', async ({ page, api }) => {
    await open(page, api, { epics: [e1], tasks: [t(1)] });
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    await expect(
      group(page, 'Tasks in Onboarding flow').getByText('No tasks in this epic'),
    ).toBeVisible();
    expect(await countsText(page, 'Tasks in Onboarding flow')).toBe(
      'Open 0 In progress 0 Awaiting review 0 Completed 0',
    );
  });

  test('more tasks than one page: the counts are marked partial until every page is loaded', async ({
    page,
    api,
  }) => {
    const sixty = manyTasks(60);
    await open(page, api, {
      epics: [e1],
      tasks: sixty,
      assignments: Object.fromEntries(sixty.map((item) => [item.id, e1.id])),
    });
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    const tasks = group(page, 'Tasks in Onboarding flow');
    await expect(
      tasks.getByText(
        'Counts cover the 50 tasks loaded so far; 60 were observed. Load more to count the rest.',
      ),
    ).toBeVisible();
    await expect(tasks.locator('.pw-counts')).toHaveAttribute('data-partial', 'true');
    expect(await countsText(page, 'Tasks in Onboarding flow')).toBe(
      'Open 17 In progress 17 Awaiting review 0 Completed 16',
    );
    await tasks.getByRole('button', { name: 'Load more tasks' }).click();
    await expect(tasks.getByText('All 60 tasks loaded.')).toBeVisible();
    await expect(tasks.locator('.pw-counts')).toHaveAttribute('data-partial', 'false');
    expect(await countsText(page, 'Tasks in Onboarding flow')).toBe(
      'Open 20 In progress 20 Awaiting review 0 Completed 20',
    );
  });

  test('a failed epic task read is recoverable and does not affect the epic list', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1], tasks: [t(1)], assignments: { 'task-0001': e1.id } });
    api.persist('epic:tasks', { status: 500, code: 'internal_error', message: 'Down.' });
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    await expect(
      epicsPanel(page).getByText('The epic task list could not be loaded.'),
    ).toBeVisible();
    await expect(row(epicsPanel(page), 'Onboarding flow')).toBeVisible();
    api.persist('epic:tasks', null);
    await epicsPanel(page).getByRole('button', { name: 'Retry' }).click();
    await expect(
      group(page, 'Tasks in Onboarding flow').getByText('All 1 task loaded.'),
    ).toBeVisible();
  });
});

test.describe('task to epic', () => {
  const base = { epics: [e1, e2, e3], tasks: [t(1), t(2)] };
  const setEpic = (page: Page, title: string) =>
    tasksPanel(page).getByRole('button', { name: `Set epic for ${title}` });

  test('sets an epic with the revision just read, announces it, and returns focus to the row button', async ({
    page,
    api,
  }) => {
    await open(page, api, base);
    await setEpic(page, 'Task number 1').click();
    const form = dialog(page, 'Set the epic for a task');
    await expect(form).toContainText('Not in any epic.');
    await expect(form.getByLabel('Epic'))
      .toBeFocused()
      .catch(() => undefined);
    // Archived epics are not offered as a destination.
    await expect(form.getByRole('option', { name: 'Legacy import' })).toHaveCount(0);
    await form.getByLabel('Epic').selectOption({ label: 'Onboarding flow' });
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toBeHidden();
    const [write] = api.writes();
    expect(write).toMatchObject({
      method: 'PUT',
      body: { expectedAssociationRevision: 1, epicId: e1.id },
      csrf: 'csrf-fixture',
    });
    expect(write?.idempotencyKey).toMatch(uuid);
    await expect(live(page)).toContainText('“Task number 1” is now in the epic “Onboarding flow”.');
    await expect(setEpic(page, 'Task number 1')).toBeFocused();
    // The epic's task list now includes it.
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    await expect(
      group(page, 'Tasks in Onboarding flow').getByRole('link', { name: 'Task number 1' }),
    ).toBeVisible();
  });

  test('clears an epic by sending null, and moves between epics in one request', async ({
    page,
    api,
  }) => {
    await open(page, api, { ...base, assignments: { 'task-0001': e1.id } });
    await setEpic(page, 'Task number 1').click();
    let form = dialog(page, 'Set the epic for a task');
    await expect(form).toContainText('Currently in “Onboarding flow”.');
    await form.getByLabel('Epic').selectOption({ label: 'Billing' });
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]?.body).toEqual({ expectedAssociationRevision: 1, epicId: e2.id });

    await setEpic(page, 'Task number 1').click();
    form = dialog(page, 'Set the epic for a task');
    await expect(form).toContainText('revision 2');
    await form.getByLabel('Epic').selectOption({ label: 'No epic' });
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()[1]?.body).toEqual({ expectedAssociationRevision: 2, epicId: null });
    await expect(live(page)).toContainText('“Task number 1” is no longer in an epic.');
    expect(api.assignment('task-0001')).toEqual({ epicId: null, revision: 3 });
  });

  test('choosing what is already assigned sends nothing', async ({ page, api }) => {
    await open(page, api, { ...base, assignments: { 'task-0001': e1.id } });
    await setEpic(page, 'Task number 1').click();
    const form = dialog(page, 'Set the epic for a task');
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toContainText('The task is already in that epic.');
    expect(api.writes()).toHaveLength(0);
  });

  test('a stale association is read again, explained, and can be redone from the latest', async ({
    page,
    api,
  }) => {
    await open(page, api, base);
    await setEpic(page, 'Task number 1').click();
    const form = dialog(page, 'Set the epic for a task');
    await form.getByLabel('Epic').selectOption({ label: 'Onboarding flow' });
    api.next('task-epic:set', { before: () => api.assignOutside('task-0001', e2.id) });
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toContainText(
      'This task’s epic was changed elsewhere. It is now in “Billing” (revision 2).',
    );
    expect(api.assignment('task-0001')).toEqual({ epicId: e2.id, revision: 2 });
    await form.getByRole('button', { name: 'Use latest assignment' }).click();
    await expect(form).toContainText('Currently in “Billing”.');
    await expect(form.getByLabel('Epic')).toHaveValue(e2.id);
    await form.getByLabel('Epic').selectOption({ label: 'Onboarding flow' });
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toBeHidden();
    expect(api.writes().at(-1)?.body).toEqual({ expectedAssociationRevision: 2, epicId: e1.id });
  });

  test('a lost response after the commit: the same request replays and the revision moves once', async ({
    page,
    api,
  }) => {
    await open(page, api, base);
    await setEpic(page, 'Task number 1').click();
    const form = dialog(page, 'Set the epic for a task');
    await form.getByLabel('Epic').selectOption({ label: 'Onboarding flow' });
    api.next('task-epic:set', { abort: true, commit: true });
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toContainText('did not get a confirmed result');
    await expect(live(page)).toHaveText('');
    await form.getByRole('button', { name: 'Send the same request again' }).click();
    await expect(form).toBeHidden();
    const [first, second] = api.writes();
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(api.assignment('task-0001')).toEqual({ epicId: e1.id, revision: 2 });
  });

  test('Check current state after a committed write reports what the server shows', async ({
    page,
    api,
  }) => {
    await open(page, api, base);
    await setEpic(page, 'Task number 2').click();
    const form = dialog(page, 'Set the epic for a task');
    await form.getByLabel('Epic').selectOption({ label: 'Billing' });
    api.next('task-epic:set', { abort: true, commit: true });
    await form.getByRole('button', { name: 'Save epic' }).click();
    await form.getByRole('button', { name: 'Check current state' }).click();
    await expect(form).toBeHidden();
    await expect(live(page)).toContainText('“Task number 2” is now in the epic “Billing”.');
    expect(api.writes()).toHaveLength(1);
  });

  test('an unreadable assignment, a missing task and a rejected change are each stated plainly', async ({
    page,
    api,
  }) => {
    await open(page, api, base);
    api.persist('task-epic:get', { status: 500, code: 'internal_error', message: 'Down.' });
    await setEpic(page, 'Task number 1').click();
    const form = dialog(page, 'Set the epic for a task');
    await expect(form).toContainText('The task’s current epic could not be loaded.');
    await expect(form.getByRole('button', { name: 'Save epic' })).toBeDisabled();
    api.persist('task-epic:get', null);
    await form.getByRole('button', { name: 'Try again' }).click();
    await expect(form).toContainText('Not in any epic.');
    await form.getByLabel('Epic').selectOption({ label: 'Billing' });
    api.next('task-epic:set', { status: 409, code: 'invalid_transition', message: 'Archived.' });
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toContainText(
      'The server does not allow this change: an archived epic or project cannot receive task assignments. Nothing was changed.',
    );
    // A definitive refusal offers no retry of the same request.
    await expect(form.getByRole('button', { name: 'Send the same request again' })).toHaveCount(0);
  });

  test('a rotated CSRF token is refreshed and the change can be sent again', async ({
    page,
    api,
  }) => {
    await open(page, api, base);
    await setEpic(page, 'Task number 1').click();
    const form = dialog(page, 'Set the epic for a task');
    await form.getByLabel('Epic').selectOption({ label: 'Billing' });
    api.rotateCsrf();
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toContainText(
      'Your secure session needed refreshing. Nothing was changed. Try again.',
    );
    await form.getByRole('button', { name: 'Save epic' }).click();
    await expect(form).toBeHidden();
  });
});

const m1 = milestone(1, project.id, {
  title: 'Beta launch',
  targetDate: '2026-12-31',
  description: 'Public beta.',
});
const m2 = milestone(2, project.id, {
  title: 'Old goal',
  status: 'archived',
  archivedAt: '2026-11-04T08:30:00.000Z',
  revision: 2,
});

test.describe('milestones', () => {
  test('lists milestones with their target dates and folds archived ones', async ({
    page,
    api,
  }) => {
    await open(page, api, { milestones: [m1, m2, milestone(3, project.id, { title: 'Undated' })] });
    const panel = milestonesPanel(page);
    // A target date is a calendar date: it never shifts with the browser's time zone.
    await expect(row(panel, 'Beta launch')).toContainText('Target Dec 31, 2026');
    await expect(row(panel, 'Undated')).toContainText('No target date');
    await expect(panel.getByRole('heading', { name: 'Old goal' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Show archived (1)' }).click();
    await expect(row(panel, 'Old goal')).toContainText('Archived');
    await expect(row(panel, 'Old goal').getByRole('button', { name: /Edit|Archive/ })).toHaveCount(
      0,
    );
  });

  test('creates one with a target date, and with none', async ({ page, api }) => {
    await open(page, api, {});
    await milestonesPanel(page).getByRole('button', { name: 'New milestone' }).click();
    let form = dialog(page, 'New milestone');
    await form.getByLabel('Title').fill('Beta launch');
    await form.getByLabel('Target date (optional)').fill('2026-12-31');
    await form.getByRole('button', { name: 'Create milestone' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()[0]?.body).toEqual({ title: 'Beta launch', targetDate: '2026-12-31' });
    await expect(row(milestonesPanel(page), 'Beta launch')).toContainText('Target Dec 31, 2026');
    await expect(
      milestonesPanel(page).getByRole('button', { name: 'New milestone' }),
    ).toBeFocused();

    await milestonesPanel(page).getByRole('button', { name: 'New milestone' }).click();
    form = dialog(page, 'New milestone');
    await form.getByLabel('Title').fill('Open-ended');
    await form.getByRole('button', { name: 'Create milestone' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()[1]?.body).toEqual({ title: 'Open-ended' });
  });

  test('edits the date and status together, and clears the date with null', async ({
    page,
    api,
  }) => {
    await open(page, api, { milestones: [m1] });
    await milestonesPanel(page).getByRole('button', { name: 'Edit milestone Beta launch' }).click();
    let form = dialog(page, 'Edit milestone');
    await expect(form.getByLabel('Target date (optional)')).toHaveValue('2026-12-31');
    await form.getByLabel('Target date (optional)').fill('2027-01-15');
    await form.getByLabel('Status').selectOption('in_progress');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()[0]?.body).toEqual({
      expectedRevision: 1,
      targetDate: '2027-01-15',
      status: 'in_progress',
    });
    await expect(row(milestonesPanel(page), 'Beta launch')).toContainText('Target Jan 15, 2027');
    await expect(row(milestonesPanel(page), 'Beta launch')).toContainText('In progress');

    await milestonesPanel(page).getByRole('button', { name: 'Edit milestone Beta launch' }).click();
    form = dialog(page, 'Edit milestone');
    await form.getByLabel('Target date (optional)').fill('');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()[1]?.body).toEqual({ expectedRevision: 2, targetDate: null });
    await expect(row(milestonesPanel(page), 'Beta launch')).toContainText('No target date');
  });

  test('completed is a status the owner can set; archiving is separate and permanent', async ({
    page,
    api,
  }) => {
    await open(page, api, { milestones: [m1] });
    await milestonesPanel(page).getByRole('button', { name: 'Edit milestone Beta launch' }).click();
    const form = dialog(page, 'Edit milestone');
    await expect(form.getByRole('option', { name: 'Archived' })).toHaveCount(0);
    await form.getByLabel('Status').selectOption('completed');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(row(milestonesPanel(page), 'Beta launch')).toContainText('Completed');
    await milestonesPanel(page)
      .getByRole('button', { name: 'Archive milestone Beta launch' })
      .click();
    await expect(dialog(page, 'Archive this milestone?')).toContainText('cannot be undone');
    await dialog(page, 'Archive this milestone?')
      .getByRole('button', { name: 'Archive milestone' })
      .click();
    await expect(live(page)).toContainText('Milestone “Beta launch” is archived.');
    expect(api.milestoneStored(m1.id)?.status).toBe('archived');
  });

  test('a stale revision and a lost response behave like epics', async ({ page, api }) => {
    await open(page, api, { milestones: [m1] });
    await milestonesPanel(page).getByRole('button', { name: 'Edit milestone Beta launch' }).click();
    const form = dialog(page, 'Edit milestone');
    await form.getByLabel('Title').fill('Mine');
    api.next('milestone:update', {
      before: () => api.editMilestoneOutside(m1.id, { targetDate: '2027-02-01' }),
    });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText(
      'This milestone was changed elsewhere (it is now at revision 2)',
    );
    await form.getByRole('button', { name: 'Keep my edits' }).click();
    // Only the field the owner changed is kept; the date set elsewhere is not overwritten.
    await expect(form.getByLabel('Target date (optional)')).toHaveValue('2027-02-01');
    api.next('milestone:update', { abort: true, commit: true });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText('did not get a confirmed result');
    await form.getByRole('button', { name: 'Send the same request again' }).click();
    await expect(form).toBeHidden();
    const [first, second] = api.writes().slice(-2);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(api.milestoneStored(m1.id)).toMatchObject({
      title: 'Mine',
      targetDate: '2027-02-01',
      revision: 3,
    });
  });
});

test.describe('an archived project is read-only', () => {
  test('planning stays readable and offers no changes', async ({ page, api }) => {
    const home = archivedProject.id;
    await open(page, api, {
      project: archivedProject,
      epics: [epic(1, home, { title: 'Onboarding flow' })],
      milestones: [milestone(1, home, { title: 'Beta launch', targetDate: '2026-12-31' })],
      tasks: [task(1, home)],
      assignments: { 'task-0001': eid(1) },
    });
    await expect(row(epicsPanel(page), 'Onboarding flow')).toBeVisible();
    await expect(row(milestonesPanel(page), 'Beta launch')).toBeVisible();
    for (const name of [
      /^New epic$/,
      /^New milestone$/,
      /^Edit epic/,
      /^Archive epic/,
      /^Edit milestone/,
      /^Archive milestone/,
    ])
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Set epic for/ })).toHaveCount(0);
    // Reading an epic's tasks still works.
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    await expect(group(page, 'Tasks in Onboarding flow')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Change epic for/ })).toHaveCount(0);
  });

  test('creating in an archived project is refused by the server with a clear message', async ({
    page,
    api,
  }) => {
    // The UI hides the controls, so this exercises the server-side guard through a project that was
    // archived after the page loaded.
    await open(page, api, { epics: [] });
    api.configure({ project: { ...project, status: 'archived', revision: 2 }, epics: [] });
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const form = dialog(page, 'New epic');
    await form.getByLabel('Title').fill('Too late');
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(form).toContainText(
      "The server does not allow creating a epic in this project's current state (for example, it is archived), so nothing was created.",
    );
    expect(api.epicCount()).toBe(0);
  });
});

test.describe('keyboard and focus', () => {
  test('the epic flow works by keyboard alone, and Escape cancels without a request', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [] });
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).focus();
    await page.keyboard.press('Enter');
    const form = dialog(page, 'New epic');
    await expect(form.getByLabel('Title')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    await expect(epicsPanel(page).getByRole('button', { name: 'New epic' })).toBeFocused();
    expect(api.writes()).toHaveLength(0);

    await page.keyboard.press('Enter');
    await page.keyboard.type('Keyboard epic');
    await page.keyboard.press('Enter'); // submits the form
    await expect(form).toBeHidden();
    await expect(row(epicsPanel(page), 'Keyboard epic')).toBeVisible();
    await expect(epicsPanel(page).getByRole('button', { name: 'New epic' })).toBeFocused();
  });

  test('Tab never reaches the page behind an open dialog', async ({ page, api }) => {
    await open(page, api, { epics: [e1] });
    await epicsPanel(page).getByRole('button', { name: 'Edit epic Onboarding flow' }).click();
    const form = dialog(page, 'Edit epic');
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press(i % 2 ? 'Tab' : 'Shift+Tab');
      // Focus is in the dialog, or has left the page for the browser's own controls (the body);
      // it is never on content behind the dialog.
      const place = await form.evaluate((node) =>
        node.contains(document.activeElement)
          ? 'dialog'
          : document.activeElement === document.body
            ? 'browser'
            : 'page',
      );
      expect(place, `press ${i + 1}`).not.toBe('page');
    }
  });

  test('a disclosure and the archived group are buttons with expanded state', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [e1, e3], tasks: [t(1)] });
    const toggle = epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(
      epicsPanel(page).getByRole('button', { name: 'Hide tasks for Onboarding flow' }),
    ).toHaveAttribute('aria-expanded', 'true');
    const archived = epicsPanel(page).getByRole('button', { name: 'Show archived (1)' });
    await archived.focus();
    await page.keyboard.press('Space');
    await expect(
      epicsPanel(page).getByRole('button', { name: 'Hide archived (1)' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  test('DOM order, tab order and visual order agree: epics, milestones, then tasks', async ({
    page,
    api,
  }) => {
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
    ]) {
      await open(page, api, { epics: [e1], milestones: [m1], tasks: [t(1)] }, size);
      const order = await page.evaluate(() => {
        const names = ['Epics', 'Milestones', 'Tasks'];
        const els = names.map(
          (name) => document.querySelector(`section[aria-label="${name}"]`) as HTMLElement,
        );
        const dom = els.every(
          (el, i) =>
            i === 0 ||
            (els[i - 1]!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        );
        const boxes = els.map((el) => el.getBoundingClientRect());
        // Reading order: top to bottom, then left to right.
        const visual = boxes.every(
          (box, i) => i === 0 || box.y > boxes[i - 1]!.y - 1 || box.x > boxes[i - 1]!.x,
        );
        return { dom, visual };
      });
      expect(order, `${size.width}px`).toEqual({ dom: true, visual: true });
    }
  });
});

test.describe('task links', () => {
  test('a task link opens the existing task detail on the Tasks screen', async ({ page, api }) => {
    await open(page, api, {
      epics: [e1],
      tasks: [t(1), t(2), t(3)],
      assignments: { 'task-0002': e1.id },
    });
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    await group(page, 'Tasks in Onboarding flow')
      .getByRole('link', { name: 'Task number 2' })
      .click();
    await expect(page).toHaveURL(/#tasks\/task-0002$/);
    await expect(page.getByRole('heading', { level: 3, name: 'Task number 2' })).toBeVisible();
  });

  test('a direct #tasks/<id> load selects that task, and plain #tasks is unchanged', async ({
    page,
    api,
  }) => {
    api.configure({ project, tasks: [t(1), t(2), t(3)] });
    await page.goto('/#tasks/task-0003');
    await expect(page.getByRole('heading', { level: 3, name: 'Task number 3' })).toBeVisible();
    await page.goto('/#tasks');
    await page.reload(); // a fresh load: the hash alone does not reset the selection
    await expect(page.getByRole('heading', { level: 3, name: 'Task number 1' })).toBeVisible();
  });
});

test.describe('session', () => {
  test('a 401 on a write ends the session instead of showing a failure', async ({ page, api }) => {
    await open(page, api, { epics: [] });
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const form = dialog(page, 'New epic');
    await form.getByLabel('Title').fill('Expired');
    api.next('epics:create', { status: 401, code: 'unauthorized', message: 'Sign in.' });
    await form.getByRole('button', { name: 'Create epic' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(api.epicCount()).toBe(0);
  });
});

test.describe('desktop and laptop usability', () => {
  const laptops = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
  ];
  const zoomed = [
    { width: 1093, height: 614 }, // 1366x768 at 125%
    { width: 1024, height: 576 }, // 1536x864 at 150%
    { width: 1280, height: 600 }, // a short laptop window
  ];
  const full: Config = {
    epics: [e1, e2, e3],
    milestones: [m1, m2],
    tasks: manyTasks(12),
    assignments: { 'task-0001': e1.id },
  };

  for (const size of laptops)
    test(`${size.width}x${size.height}: both create actions are on the first screen, nothing overflows`, async ({
      page,
      api,
    }) => {
      await open(page, api, full, size);
      for (const name of ['New epic', 'New milestone']) {
        const box = await page.getByRole('button', { name, exact: true }).boundingBox();
        expect(box, name).not.toBeNull();
        expect(box!.y + box!.height, `${name} bottom`).toBeLessThanOrEqual(size.height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      // The task table keeps its own columns without a horizontal scrollbar.
      expect(
        await page
          .locator('.nx-table-wrap')
          .first()
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    });

  for (const size of zoomed)
    test(`${size.width}x${size.height}: no overflow, every control reachable, dialogs fit`, async ({
      page,
      api,
    }) => {
      await open(page, api, full, size);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const name of ['New epic', 'New milestone']) {
        const button = page.getByRole('button', { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
      }
      for (const [open_, title, submit] of [
        ['New epic', 'New epic', 'Create epic'],
        ['New milestone', 'New milestone', 'Create milestone'],
      ] as const) {
        await page.getByRole('button', { name: open_, exact: true }).click();
        const form = dialog(page, title);
        const box = await form.boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
        // Even when the form is taller than the window, its own scrolling reaches the submit button.
        const button = form.getByRole('button', { name: submit });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
        await page.keyboard.press('Escape');
        await expect(form).toBeHidden();
      }
    });

  test('the task-to-epic dialog fits a short window', async ({ page, api }) => {
    await open(page, api, full, { width: 1280, height: 600 });
    await page.getByRole('button', { name: 'Set epic for Task number 2' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Set epic for Task number 2' }).click();
    const form = dialog(page, 'Set the epic for a task');
    await expect(form.getByLabel('Epic')).toBeVisible();
    const box = await form.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    await expect(form.getByRole('button', { name: 'Save epic' })).toBeInViewport();
  });

  test('reduced motion: nothing animates in the planning screens', async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, api, full);
    await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
    const durations = await page.locator('dialog[open], .pw-record').evaluateAll((els) =>
      els.flatMap((el) => {
        const style = getComputedStyle(el);
        return [
          style.animationName === 'none' ? 0 : 1,
          parseFloat(style.transitionDuration) > 0 ? 1 : 0,
        ];
      }),
    );
    expect(durations.every((value) => value === 0)).toBe(true);
  });

  test('axe finds no violations with lists, a dialog and a recovery notice open', async ({
    page,
    api,
  }) => {
    await open(page, api, full);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    await expect(group(page, 'Tasks in Onboarding flow')).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await epicsPanel(page).getByRole('button', { name: 'Edit epic Onboarding flow' }).click();
    const form = dialog(page, 'Edit epic');
    await form.getByLabel('Title').fill('Changed');
    api.next('epic:update', { abort: true });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText('did not get a confirmed result');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Set epic for Task number 2' }).click();
    await expect(dialog(page, 'Set the epic for a task').getByLabel('Epic')).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test.describe('visual evidence (only when NEXUS_SHOT_DIR is set)', () => {
  test.skip(!process.env.NEXUS_SHOT_DIR, 'set NEXUS_SHOT_DIR to save screenshots');
  const dir = process.env.NEXUS_SHOT_DIR ?? '';
  const config: Config = {
    epics: [e1, e2, e3],
    milestones: [m1, m2],
    tasks: manyTasks(14),
    assignments: { 'task-0001': e1.id, 'task-0002': e1.id, 'task-0005': e2.id },
  };
  const shoot = (page: Page, name: string, fullPage = false) =>
    page.screenshot({ path: `${dir}/${name}.jpg`, type: 'jpeg', quality: 80, fullPage });

  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
    { width: 1093, height: 614 },
  ])
    test(`first screen at ${size.width}x${size.height}`, async ({ page, api }) => {
      await open(page, api, config, size);
      await shoot(page, `planning-${size.width}x${size.height}`);
    });

  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ])
    test(`unresolved create and a refused status step at ${size.width}x${size.height}`, async ({
      page,
      api,
    }) => {
      await open(page, api, config, size);
      await epicsPanel(page).getByRole('button', { name: 'New epic' }).click();
      const create = dialog(page, 'New epic');
      await create.getByLabel('Title').fill('Reporting');
      api.next('epics:create', { abort: true, commit: true });
      await create.getByRole('button', { name: 'Create epic' }).click();
      await expect(create).toContainText('this form is locked to this exact request');
      await shoot(page, `planning-unresolved-create-${size.width}x${size.height}`);
      await create.getByRole('button', { name: 'Check the current list' }).click();
      await expect(create).toContainText('One matching record was found, but we cannot confirm');
      await shoot(page, `planning-candidate-${size.width}x${size.height}`);
      await create.getByRole('button', { name: 'Close (the request stays unresolved)' }).click();
      await expect(create).toBeHidden();
      await epicsPanel(page).getByRole('button', { name: 'Edit epic Billing' }).click();
      const edit = dialog(page, 'Edit epic');
      await edit.getByLabel('Status').selectOption('completed');
      api.next('epic:update', { status: 409, code: 'invalid_transition', message: 'Not allowed.' });
      await edit.getByRole('button', { name: 'Save changes' }).click();
      await expect(edit).toContainText('The server does not allow this change.');
      await shoot(page, `planning-invalid-transition-${size.width}x${size.height}`);
    });

  test('expanded tasks, dialogs and a conflict at 1440x900', async ({ page, api }) => {
    await open(page, api, config);
    await epicsPanel(page).getByRole('button', { name: 'Show tasks for Onboarding flow' }).click();
    await expect(group(page, 'Tasks in Onboarding flow')).toBeVisible();
    await shoot(page, 'planning-epic-tasks-1440x900', true);
    await epicsPanel(page).getByRole('button', { name: 'Edit epic Billing' }).click();
    const form = dialog(page, 'Edit epic');
    await form.getByLabel('Title').fill('Billing v2');
    api.next('epic:update', {
      before: () => api.editEpicOutside(e2.id, { description: 'Edited elsewhere' }),
    });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText('was changed elsewhere');
    await shoot(page, 'planning-epic-conflict-1440x900');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Set epic for Task number 3' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Set epic for Task number 3' }).click();
    await expect(dialog(page, 'Set the epic for a task').getByLabel('Epic')).toBeVisible();
    await shoot(page, 'planning-task-epic-1440x900');
  });
});

/* ------------------------------------------------------------------------------------------ *
 * Remediation: an unknown create must never lead to a second create.
 * ------------------------------------------------------------------------------------------ */
const kinds = [
  {
    kind: 'epic' as const,
    panel: epicsPanel,
    openName: 'New epic',
    dialogName: 'New epic',
    submit: 'Create epic',
    fault: 'epics:create' as const,
    list: 'epics:list' as const,
    count: (api: ReturnType<typeof createPlanningApi>) => api.epicCount(),
    outside: (api: ReturnType<typeof createPlanningApi>, title: string) =>
      api.addEpicOutside({ title }),
    seed: (n: number) =>
      Array.from({ length: n }, (_, i) => epic(i + 10, project.id, { title: `Existing ${i + 1}` })),
    config: (n: number): Config => ({
      epics: Array.from({ length: n }, (_, i) =>
        epic(i + 10, project.id, { title: `Existing ${i + 1}` }),
      ),
    }),
  },
  {
    kind: 'milestone' as const,
    panel: milestonesPanel,
    openName: 'New milestone',
    dialogName: 'New milestone',
    submit: 'Create milestone',
    fault: 'milestones:create' as const,
    list: 'milestones:list' as const,
    count: (api: ReturnType<typeof createPlanningApi>) => api.milestoneCount(),
    outside: (api: ReturnType<typeof createPlanningApi>, title: string) =>
      api.addMilestoneOutside({ title, targetDate: '2026-12-31' }),
    seed: (n: number) =>
      Array.from({ length: n }, (_, i) =>
        milestone(i + 10, project.id, { title: `Existing ${i + 1}` }),
      ),
    config: (n: number): Config => ({
      milestones: Array.from({ length: n }, (_, i) =>
        milestone(i + 10, project.id, { title: `Existing ${i + 1}` }),
      ),
    }),
  },
];

const OWNER = 'owner';
const storageKeyFor = (kind: string, owner = OWNER, projectId = project.id) =>
  `omnis.planning-create.v1:${encodeURIComponent(owner)}:${projectId}:${kind}`;
const readStored = async (page: Page, kind: string, owner = OWNER) => {
  const raw = await page.evaluate((key) => sessionStorage.getItem(key), storageKeyFor(kind, owner));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
};
const seed = (page: Page, kind: string, value: string, owner = OWNER) =>
  page.evaluate(
    ([key, text]) => sessionStorage.setItem(key as string, text as string),
    [storageKeyFor(kind, owner), value],
  );
const envelopeFor = (kind: 'epic' | 'milestone', overrides: Record<string, unknown> = {}) => ({
  version: 1,
  ownerId: OWNER,
  projectId: project.id,
  kind,
  request:
    kind === 'epic' ? { title: 'Reporting' } : { title: 'Reporting', targetDate: '2026-12-31' },
  idempotencyKey: '11111111-2222-4333-8444-555555555555',
  attemptedAt: Date.now() - 60_000,
  knownIds: [],
  ...overrides,
});
const reloadProject = async (page: Page) => {
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: project.name })).toBeVisible();
  await expect(epicsPanel(page)).toBeVisible();
};
const recovery = (form: ReturnType<typeof dialog>) => form.locator('[data-recovery-view]');

for (const k of kinds)
  test.describe(`unresolved ${k.kind} create: durable and never falsely resolved`, () => {
    type Api = ReturnType<typeof createPlanningApi>;
    const openCreate = async (page: Page) => {
      await k.panel(page).getByRole('button', { name: k.openName, exact: true }).click();
      return dialog(page, k.dialogName);
    };
    const resolveButton = (page: Page) =>
      k.panel(page).getByRole('button', { name: `Resolve pending ${k.kind}` });
    const openResolve = async (page: Page) => {
      await resolveButton(page).click();
      return dialog(page, k.dialogName);
    };
    /** Types a title, loses the response (optionally after the commit), returns the open dialog. */
    async function loseResponse(page: Page, api: Api, commit: boolean, config: Config = {}) {
      await open(page, api, config);
      const form = await openCreate(page);
      await form.getByLabel('Title').fill('Reporting');
      if (k.kind === 'milestone')
        await form.getByLabel('Target date (optional)').fill('2026-12-31');
      api.next(k.fault, { abort: true, commit });
      await form.getByRole('button', { name: k.submit }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'unknown');
      return form;
    }
    /** The request is still pending, creation is still locked, and nothing was resolved. */
    async function expectUnresolved(
      page: Page,
      api: Api,
      form: ReturnType<typeof dialog>,
      writes: number,
    ) {
      expect(await readStored(page, k.kind)).not.toBeNull();
      await expect(form.getByLabel('Title')).toBeDisabled();
      await expect(form.getByRole('button', { name: k.submit })).toHaveCount(0);
      await expect(live(page)).toHaveText('');
      expect(api.writes()).toHaveLength(writes);
    }

    test('the request and its key are saved BEFORE it is sent, with nothing secret', async ({
      page,
      api,
    }) => {
      await open(page, api, {});
      const form = await openCreate(page);
      await form.getByLabel('Title').fill('Reporting');
      if (k.kind === 'milestone')
        await form.getByLabel('Target date (optional)').fill('2026-12-31');
      api.next(k.fault, { delayMs: 1500, abort: true, commit: true });
      await form.getByRole('button', { name: k.submit }).click();
      await expect.poll(() => api.writes().length).toBe(1);
      // The server has the request but has not answered; the envelope already exists.
      const stored = await readStored(page, k.kind);
      expect(stored).not.toBeNull();
      expect(stored?.idempotencyKey).toBe(api.writes()[0]?.idempotencyKey);
      expect(Object.keys(stored ?? {}).sort()).toEqual(
        [
          'attemptedAt',
          'idempotencyKey',
          'kind',
          'knownIds',
          'ownerId',
          'projectId',
          'request',
          'version',
        ].sort(),
      );
      expect(stored).toMatchObject({
        version: 1,
        ownerId: OWNER,
        projectId: project.id,
        kind: k.kind,
      });
      const raw = JSON.stringify(stored);
      for (const secret of ['csrf', 'token', 'cookie', 'password'])
        expect(raw.toLowerCase()).not.toContain(secret);
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'unknown');
    });

    test('A. commit, lost response, reload: the same pending request is restored and locked', async ({
      page,
      api,
    }) => {
      const form = await loseResponse(page, api, true);
      const before = await readStored(page, k.kind);
      expect(k.count(api)).toBe(1);
      await form.getByRole('button', { name: 'Close (the request stays unresolved)' }).click();

      await reloadProject(page);
      // The ordinary "New" action is gone; only resolving the pending request is offered.
      await expect(
        k.panel(page).getByRole('button', { name: k.openName, exact: true }),
      ).toHaveCount(0);
      const restored = await openResolve(page);
      await expect(recovery(restored)).toHaveAttribute('data-recovery-view', 'unknown');
      await expect(restored.getByLabel('Title')).toHaveValue('Reporting');
      if (k.kind === 'milestone')
        await expect(restored.getByLabel('Target date (optional)')).toHaveValue('2026-12-31');
      await expectUnresolved(page, api, restored, 1);
      // Original request and key preserved; nothing was sent after the reload.
      expect(await readStored(page, k.kind)).toEqual(before);
      expect(k.count(api)).toBe(1);
      await expect(restored).toContainText('this form is locked to this exact request');
      await expect(restored).toContainText('What is not verified');
    });

    test('B. same-key recovery after a reload: identical request, no duplicate, cleared only once confirmed', async ({
      page,
      api,
    }) => {
      const form = await loseResponse(page, api, true);
      await form.getByRole('button', { name: 'Close (the request stays unresolved)' }).click();
      await reloadProject(page);
      const restored = await openResolve(page);
      const first = api.writes()[0];
      await restored.getByRole('button', { name: 'Send the same request again' }).click();
      await expect(restored).toBeHidden();
      const [, second] = api.writes();
      expect(api.writes()).toHaveLength(2);
      expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
      expect(second?.body).toEqual(first?.body);
      expect(k.count(api)).toBe(1); // replayed, not duplicated
      await expect(live(page)).toContainText('created at revision 1');
      expect(await readStored(page, k.kind)).toBeNull(); // cleared only after confirmation
      await expect(
        k.panel(page).getByRole('button', { name: k.openName, exact: true }),
      ).toBeVisible();
    });

    test('a retry whose answer is lost again stays unresolved with the same key', async ({
      page,
      api,
    }) => {
      const form = await loseResponse(page, api, false);
      const key = (await readStored(page, k.kind))?.idempotencyKey;
      api.next(k.fault, { abort: true });
      await form.getByRole('button', { name: 'Send the same request again' }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'unknown');
      expect((await readStored(page, k.kind))?.idempotencyKey).toBe(key);
      await expectUnresolved(page, api, form, 2);
      expect(api.writes()[1]?.idempotencyKey).toBe(key);
    });

    test('C. one matching record is only a candidate: still unresolved, locked, and it survives a reload', async ({
      page,
      api,
    }) => {
      const form = await loseResponse(page, api, true);
      await form.getByRole('button', { name: 'Check the current list' }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'candidate');
      await expect(recovery(form)).toContainText(
        'One matching record was found, but we cannot confirm whether it was created by your original request.',
      );
      await expect(recovery(form)).toContainText('Reporting');
      await expect(recovery(form)).toContainText('only an observation');
      await expectUnresolved(page, api, form, 1);
      expect(k.count(api)).toBe(1);
      await expect(form).not.toContainText('created at revision');

      await form.getByRole('button', { name: 'Close (the request stays unresolved)' }).click();
      await expect(
        k.panel(page).getByRole('button', { name: k.openName, exact: true }),
      ).toHaveCount(0);
      await reloadProject(page);
      const restored = await openResolve(page);
      await expectUnresolved(page, api, restored, 1);
      // Only the same request, with the same key, settles it.
      await restored.getByRole('button', { name: 'Send the same request again' }).click();
      await expect(restored).toBeHidden();
      expect(k.count(api)).toBe(1);
      expect(await readStored(page, k.kind)).toBeNull();
    });

    test('D. reconciliation is never authoritative: zero, two, unreadable, failed and incomplete reads', async ({
      page,
      api,
    }) => {
      // Zero matches, over a list that spans several pages: every page is read before "none".
      const form = await loseResponse(page, api, false, k.config(60));
      await form.getByRole('button', { name: 'Check the current list' }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'absent');
      await expect(recovery(form)).toContainText('The complete list was read and no new');
      await expect(recovery(form)).toContainText('That is an observation, not proof');
      expect(
        api.of(k.list).filter((entry) => entry.search.includes('cursor=')).length,
      ).toBeGreaterThan(0);
      await expectUnresolved(page, api, form, 1);

      // A page that cannot be read (an incomplete read) concludes nothing.
      api.invalidateCursors();
      await form.getByRole('button', { name: 'Check the current list' }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'unreadable');
      await expect(recovery(form)).toContainText('The list could not be read completely');
      await expectUnresolved(page, api, form, 1);

      // The list request itself failing concludes nothing either.
      api.persist(k.list, { status: 500, code: 'internal_error', message: 'Down.' });
      await form.getByRole('button', { name: 'Check the current list' }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'unreadable');
      api.persist(k.list, null);
      await expectUnresolved(page, api, form, 1);
    });

    test('D. two fitting records are never guessed between', async ({ page, api }) => {
      const form = await loseResponse(page, api, true);
      k.outside(api, 'Reporting');
      await form.getByRole('button', { name: 'Check the current list' }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'ambiguous');
      await expect(recovery(form)).toContainText('2 records in the list fit this request');
      await expectUnresolved(page, api, form, 1);
    });

    test('a refused first attempt is authoritative: it clears the request and frees the form', async ({
      page,
      api,
    }) => {
      await open(page, api, {});
      const form = await openCreate(page);
      await form.getByLabel('Title').fill('Rejected');
      if (k.kind === 'milestone')
        await form.getByLabel('Target date (optional)').fill('2026-12-31');
      api.next(k.fault, { status: 422, code: 'invalid_input', message: 'Bad.' });
      await form.getByRole('button', { name: k.submit }).click();
      await expect(form).toContainText('The server rejected these values.');
      expect(await readStored(page, k.kind)).toBeNull();
      await expect(form.getByLabel('Title')).toBeEnabled();
      await expect(recovery(form)).toHaveCount(0);
    });

    for (const [status, code] of [
      [422, 'invalid_input'],
      [409, 'conflict'],
      [409, 'invalid_transition'],
      [404, 'not_found'],
      [503, 'limit'],
    ] as const)
      test(`a ${status} ${code} refusal of a RETRY does not show the original was not applied: it stays unresolved`, async ({
        page,
        api,
      }) => {
        const form = await loseResponse(page, api, true);
        const key = (await readStored(page, k.kind))?.idempotencyKey;
        api.next(k.fault, { status, code, message: 'Refused.' });
        await form.getByRole('button', { name: 'Send the same request again' }).click();
        await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'refused');
        await expect(recovery(form)).toContainText(
          'does not show that the original request was not applied',
        );
        expect((await readStored(page, k.kind))?.idempotencyKey).toBe(key);
        await expect(form.getByRole('button', { name: 'Send the same request again' })).toHaveCount(
          0,
        );
        await expect(form.getByRole('button', { name: 'Check the current list' })).toBeVisible();
        await expect(form.getByLabel('Title')).toBeDisabled();
        await expect(live(page)).toHaveText('');
        // It survives a reload and is never auto-discarded.
        await form.getByRole('button', { name: 'Close (the request stays unresolved)' }).click();
        await reloadProject(page);
        await expect(resolveButton(page)).toBeVisible();
        expect((await readStored(page, k.kind))?.idempotencyKey).toBe(key);
      });

    test('a retry that fails the secure-session check is only unknown, and can be sent again', async ({
      page,
      api,
    }) => {
      const form = await loseResponse(page, api, true);
      api.next(k.fault, { status: 403, code: 'csrf_rejected', message: 'Refresh.' });
      await form.getByRole('button', { name: 'Send the same request again' }).click();
      await expect(form).toContainText('this repeat was not processed');
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'unknown');
      await form.getByRole('button', { name: 'Send the same request again' }).click();
      await expect(form).toBeHidden();
      expect(k.count(api)).toBe(1);
      const keys = new Set(api.writes().map((entry) => entry.idempotencyKey));
      expect(keys.size).toBe(1);
    });

    const cases: Array<{ name: string; value: string; view: string; reveals?: string }> = [
      { name: 'corrupt JSON', value: '{not json', view: 'blocked' },
      {
        name: 'invalid schema (extra field)',
        value: JSON.stringify(envelopeFor(k.kind, { extra: true })),
        view: 'blocked',
      },
      {
        name: 'missing fields',
        value: JSON.stringify({ version: 1, kind: k.kind }),
        view: 'blocked',
      },
      {
        name: 'invalid record type',
        value: JSON.stringify(envelopeFor(k.kind, { kind: 'story' })),
        view: 'blocked',
      },
      {
        name: 'invalid key',
        value: JSON.stringify(envelopeFor(k.kind, { idempotencyKey: 'not-a-uuid' })),
        view: 'blocked',
      },
      {
        name: 'invalid request',
        value: JSON.stringify(envelopeFor(k.kind, { request: { title: '' } })),
        view: 'blocked',
      },
      {
        name: 'wrong owner',
        value: JSON.stringify(
          envelopeFor(k.kind, { ownerId: 'someone-else', request: { title: 'Secret payload' } }),
        ),
        view: 'blocked',
        reveals: 'Secret payload',
      },
      {
        name: 'wrong project',
        value: JSON.stringify(
          envelopeFor(k.kind, {
            projectId: `prj_${'9'.repeat(32)}`,
            request: { title: 'Secret payload' },
          }),
        ),
        view: 'blocked',
        reveals: 'Secret payload',
      },
      {
        name: 'wrong record type',
        value: JSON.stringify(
          envelopeFor(k.kind === 'epic' ? 'milestone' : 'epic', {
            request: { title: 'Secret payload' },
          }),
        ),
        view: 'blocked',
        reveals: 'Secret payload',
      },
      {
        name: 'unsupported version',
        value: JSON.stringify(
          envelopeFor(k.kind, { version: 2, request: { title: 'Secret payload' } }),
        ),
        view: 'blocked',
        reveals: 'Secret payload',
      },
      {
        name: 'impossible timestamp',
        value: JSON.stringify(envelopeFor(k.kind, { attemptedAt: Date.now() + 3_600_000 })),
        view: 'blocked',
      },
      {
        name: 'oversized',
        value: JSON.stringify(envelopeFor(k.kind, { request: { title: 'x'.repeat(20_000) } })),
        view: 'blocked',
      },
      {
        name: 'stale attempt',
        value: JSON.stringify(envelopeFor(k.kind, { attemptedAt: Date.now() - 20 * 60_000 })),
        view: 'replay-unverified',
      },
      { name: 'valid', value: JSON.stringify(envelopeFor(k.kind)), view: 'unknown' },
    ];
    for (const item of cases)
      test(`E. stored envelope - ${item.name}: ${item.view === 'unknown' ? 'restored and repeated with its key' : 'fails closed with an explicit recovery state'}`, async ({
        page,
        api,
      }) => {
        await open(page, api, {});
        const stored = () =>
          page.evaluate((key) => sessionStorage.getItem(key), storageKeyFor(k.kind));
        await seed(page, k.kind, item.value);
        await reloadProject(page);
        await expect(
          k.panel(page).getByRole('button', { name: k.openName, exact: true }),
        ).toHaveCount(0);
        const form = await openResolve(page);
        await expect(recovery(form)).toHaveAttribute('data-recovery-view', item.view);
        await expect(form.getByLabel('Title')).toBeDisabled();
        await expect(form.getByRole('button', { name: k.submit })).toHaveCount(0);
        if (item.reveals) await expect(page.locator('body')).not.toContainText(item.reveals);
        if (item.view !== 'unknown')
          await expect(
            form.getByRole('button', { name: 'Send the same request again' }),
          ).toHaveCount(0);
        if (item.view === 'replay-unverified')
          await expect(form).toContainText('too old to repeat safely');
        // Whatever the state, nothing was sent and nothing was thrown away.
        expect(api.writes()).toHaveLength(0);
        expect(await stored()).not.toBeNull();
        if (item.view === 'unknown') {
          // The valid one is repeated with its original key and exactly its original request.
          await form.getByRole('button', { name: 'Send the same request again' }).click();
          await expect(form).toBeHidden();
          expect(api.writes()[0]?.idempotencyKey).toBe('11111111-2222-4333-8444-555555555555');
          expect(api.writes()[0]?.body).toEqual(envelopeFor(k.kind).request);
          expect(await stored()).toBeNull();
          return;
        }
        // The only way out is explicit: Keep leaves it as it was; Discard removes it.
        await form.getByRole('button', { name: 'Discard this unresolved request…' }).click();
        await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'discard-confirm');
        await form.getByRole('button', { name: 'Keep the request' }).click();
        await expect(recovery(form)).toHaveAttribute('data-recovery-view', item.view);
        expect(await stored()).not.toBeNull();
        await form.getByRole('button', { name: 'Discard this unresolved request…' }).click();
        await form.getByRole('button', { name: 'Discard the request' }).click();
        await expect(form.getByLabel('Title')).toBeEnabled();
        expect(await stored()).toBeNull();
        expect(api.writes()).toHaveLength(0); // discarding sends nothing
      });

    test('E. storage unavailable: no create is sent whose recovery could not be kept', async ({
      page,
      api,
    }) => {
      await page.addInitScript(() => {
        const denied = () => {
          throw new DOMException('denied', 'SecurityError');
        };
        Storage.prototype.getItem = denied;
        Storage.prototype.setItem = denied;
        Storage.prototype.removeItem = denied;
      });
      await open(page, api, {});
      const form = await openCreate(page);
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'storage-unavailable');
      await expect(form).toContainText('This tab cannot save recovery information.');
      await expect(form.getByLabel('Title')).toBeDisabled();
      await expect(form.getByRole('button', { name: k.submit })).toHaveCount(0);
      await form.getByRole('button', { name: 'Check storage again' }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'storage-unavailable');
      expect(api.writes()).toHaveLength(0);
    });

    test('E. a write that fails at send time stops the create before it is sent', async ({
      page,
      api,
    }) => {
      await page.addInitScript(() => {
        const real = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (
            (window as unknown as { __failWrites?: boolean }).__failWrites &&
            !key.endsWith(':probe')
          )
            throw new DOMException('quota', 'QuotaExceededError');
          return real.call(this, key, value);
        };
      });
      await open(page, api, {});
      const form = await openCreate(page);
      await form.getByLabel('Title').fill('Reporting');
      if (k.kind === 'milestone')
        await form.getByLabel('Target date (optional)').fill('2026-12-31');
      await page.evaluate(
        () => ((window as unknown as { __failWrites?: boolean }).__failWrites = true),
      );
      await form.getByRole('button', { name: k.submit }).click();
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'storage-unavailable');
      expect(api.writes()).toHaveLength(0);
      expect(k.count(api)).toBe(0);
    });

    test('E. another owner never sees or replays this owner’s pending request', async ({
      page,
      api,
    }) => {
      const form = await loseResponse(page, api, true);
      const ownerKey = (await readStored(page, k.kind))?.idempotencyKey;
      await form.getByRole('button', { name: 'Close (the request stays unresolved)' }).click();

      // Owner A signs out and owner B signs in on the same tab.
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      api.setOwner('owner-b');
      await page.getByLabel('Owner password').fill('fixture-owner-password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(k.panel(page)).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Resolve pending');
      await expect(
        k.panel(page).getByRole('button', { name: k.openName, exact: true }),
      ).toBeVisible();
      expect(await readStored(page, k.kind, 'owner-b')).toBeNull();

      // B's own create is independent: its own key, nothing of A's.
      const mine = await openCreate(page);
      await mine.getByLabel('Title').fill('Bee work');
      if (k.kind === 'milestone')
        await mine.getByLabel('Target date (optional)').fill('2027-01-01');
      await mine.getByRole('button', { name: k.submit }).click();
      await expect(mine).toBeHidden();
      const bWrite = api.writes().at(-1);
      expect(bWrite?.idempotencyKey).not.toBe(ownerKey);
      expect(JSON.stringify(bWrite?.body)).not.toContain('Reporting');

      // A signs back in: their pending request is still theirs, untouched.
      await page.getByRole('button', { name: 'Sign out' }).click();
      api.setOwner(OWNER);
      await page.getByLabel('Owner password').fill('fixture-owner-password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(resolveButton(page)).toBeVisible();
      expect((await readStored(page, k.kind, OWNER))?.idempotencyKey).toBe(ownerKey);
    });

    test('a changed session on reload is a different owner: the stored request is not used', async ({
      page,
      api,
    }) => {
      const form = await loseResponse(page, api, true);
      await form.getByRole('button', { name: 'Close (the request stays unresolved)' }).click();
      api.setOwner('owner-b');
      await reloadProject(page);
      await expect(
        k.panel(page).getByRole('button', { name: k.openName, exact: true }),
      ).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Resolve pending');
      expect(api.writes()).toHaveLength(1);
    });

    test('F. a key too old to trust is neither repeated nor discarded', async ({ page, api }) => {
      await open(page, api, {});
      await seed(
        page,
        k.kind,
        JSON.stringify(envelopeFor(k.kind, { attemptedAt: Date.now() - 20 * 60_000 })),
      );
      await reloadProject(page);
      const form = await openResolve(page);
      await expect(recovery(form)).toHaveAttribute('data-recovery-view', 'replay-unverified');
      await expect(form).toContainText(
        'cannot verify that the server still remembers its idempotency key',
      );
      await expect(form).toContainText('it has not been discarded');
      await expect(form.getByRole('button', { name: 'Send the same request again' })).toHaveCount(
        0,
      );
      // Reading is still allowed, and still concludes nothing.
      await form.getByRole('button', { name: 'Check the current list' }).click();
      await expect(recovery(form)).not.toHaveAttribute('data-recovery-view', 'replay-unverified');
      await expect(form.getByRole('button', { name: 'Send the same request again' })).toHaveCount(
        0,
      );
      expect(api.writes()).toHaveLength(0);
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), storageKeyFor(k.kind)),
      ).not.toBeNull();
      await page.keyboard.press('Escape');
      await reloadProject(page);
      await expect(resolveButton(page)).toBeVisible(); // age alone never discards it
    });

    test('keyboard and focus: the recovery actions are reachable, announced, and focus returns to the opener', async ({
      page,
      api,
    }) => {
      const form = await loseResponse(page, api, true);
      await expect(recovery(form)).toHaveAttribute('role', 'alert');
      await form.getByRole('button', { name: 'Close (the request stays unresolved)' }).focus();
      await page.keyboard.press('Enter');
      await expect(form).toBeHidden();
      await expect(resolveButton(page)).toBeFocused();
      await page.keyboard.press('Enter');
      const reopened = dialog(page, k.dialogName);
      await page.keyboard.press('Tab');
      expect(await reopened.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(reopened).toBeHidden();
      await expect(resolveButton(page)).toBeFocused();
    });
  });

/* ------------------------------------------------------------------------------------------ *
 * Remediation: status lifecycle (planned -> in_progress -> completed, forward only).
 * ------------------------------------------------------------------------------------------ */
const planned = epic(21, project.id, { title: 'Planned epic' });
const progressing = epic(22, project.id, { title: 'Progressing epic', status: 'in_progress' });
const finished = epic(23, project.id, { title: 'Finished epic', status: 'completed' });
const optionsOf = (form: ReturnType<typeof dialog>) =>
  form.getByLabel('Status').locator('option').allInnerTexts();

test.describe('status lifecycle', () => {
  test('only valid next statuses are offered, for epics and milestones', async ({ page, api }) => {
    await open(page, api, {
      epics: [planned, progressing, finished],
      milestones: [
        milestone(31, project.id, { title: 'M planned' }),
        milestone(32, project.id, { title: 'M progressing', status: 'in_progress' }),
        milestone(33, project.id, { title: 'M finished', status: 'completed' }),
      ],
    });
    const expected: Array<[string, string[]]> = [
      ['Planned epic', ['Planned', 'In progress', 'Completed']],
      ['Progressing epic', ['In progress', 'Completed']],
      ['Finished epic', ['Completed']],
    ];
    for (const [title, options] of expected) {
      await epicsPanel(page)
        .getByRole('button', { name: `Edit epic ${title}` })
        .click();
      const form = dialog(page, 'Edit epic');
      expect(await optionsOf(form), title).toEqual(options);
      await page.keyboard.press('Escape');
      await expect(form).toBeHidden();
    }
    const milestoneExpected: Array<[string, string[]]> = [
      ['M planned', ['Planned', 'In progress', 'Completed']],
      ['M progressing', ['In progress', 'Completed']],
      ['M finished', ['Completed']],
    ];
    for (const [title, options] of milestoneExpected) {
      await milestonesPanel(page)
        .getByRole('button', { name: `Edit milestone ${title}` })
        .click();
      const form = dialog(page, 'Edit milestone');
      expect(await optionsOf(form), title).toEqual(options);
      await page.keyboard.press('Escape');
      await expect(form).toBeHidden();
    }
  });

  test('every permitted forward step saves', async ({ page, api }) => {
    await open(page, api, {
      epics: [planned, epic(24, project.id, { title: 'Second planned' }), progressing],
    });
    const steps: Array<[string, string, string]> = [
      ['Planned epic', 'in_progress', 'In progress'],
      ['Second planned', 'completed', 'Completed'],
      ['Progressing epic', 'completed', 'Completed'],
    ];
    for (const [title, value, shown] of steps) {
      await epicsPanel(page)
        .getByRole('button', { name: `Edit epic ${title}` })
        .click();
      const form = dialog(page, 'Edit epic');
      await form.getByLabel('Status').selectOption(value);
      await form.getByRole('button', { name: 'Save changes' }).click();
      await expect(form).toBeHidden();
      await expect(row(epicsPanel(page), title)).toContainText(shown);
    }
  });

  test('the fixture refuses every backward step with invalid_transition, like the backend', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [planned, progressing, finished] });
    const probe = (id: string, revision: number, status: string) =>
      page.evaluate(
        async ({ projectId, epicId, expectedRevision, next }) => {
          const response = await fetch(`/api/v1/projects/${projectId}/epics/${epicId}`, {
            method: 'PATCH',
            headers: {
              'content-type': 'application/json',
              'x-omnis-csrf': 'csrf-fixture',
              'idempotency-key': crypto.randomUUID(),
            },
            body: JSON.stringify({ expectedRevision, status: next }),
          });
          const body = (await response.json()) as { error?: { code: string } };
          return `${response.status} ${body.error?.code ?? 'ok'}`;
        },
        { projectId: project.id, epicId: id, expectedRevision: revision, next: status },
      );
    expect(await probe(finished.id, 1, 'in_progress')).toBe('409 invalid_transition');
    expect(await probe(finished.id, 1, 'planned')).toBe('409 invalid_transition');
    expect(await probe(progressing.id, 1, 'planned')).toBe('409 invalid_transition');
    expect(await probe(progressing.id, 1, 'in_progress')).toBe('200 ok'); // the same status is a no-op
    expect(await probe(planned.id, 1, 'completed')).toBe('200 ok');
  });

  test('invalid_transition is a definitive refusal: no retry, no stale-revision wording, no Keep my edits', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [planned] });
    await epicsPanel(page).getByRole('button', { name: 'Edit epic Planned epic' }).click();
    const form = dialog(page, 'Edit epic');
    await form.getByLabel('Status').selectOption('in_progress');
    api.next('epic:update', { status: 409, code: 'invalid_transition', message: 'Not allowed.' });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText('The server does not allow this change.');
    await expect(form).toContainText('only moves forward');
    await expect(form).not.toContainText('changed elsewhere');
    await expect(form).not.toContainText('revision you opened');
    for (const name of ['Send the same request again', 'Keep my edits', 'Check current state'])
      await expect(form.getByRole('button', { name })).toHaveCount(0);
    expect(api.epicStored(planned.id)?.status).toBe('planned');
    // The form is still editable: a different choice is a new request.
    await form.getByLabel('Status').selectOption('completed');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    expect(api.writes()).toHaveLength(2);
    expect(api.writes()[1]?.idempotencyKey).not.toBe(api.writes()[0]?.idempotencyKey);
  });

  test('a refusal that also finds the record changed elsewhere says so and offers only Load latest', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [planned] });
    await epicsPanel(page).getByRole('button', { name: 'Edit epic Planned epic' }).click();
    const form = dialog(page, 'Edit epic');
    await form.getByLabel('Status').selectOption('in_progress');
    api.next('epic:update', {
      status: 409,
      code: 'invalid_transition',
      message: 'Not allowed.',
      before: () => api.editEpicOutside(planned.id, { status: 'completed' }),
    });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText(
      'It was also changed elsewhere: it is now completed at revision 2.',
    );
    await expect(form.getByRole('button', { name: 'Send the same request again' })).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Keep my edits' })).toHaveCount(0);
    await form.getByRole('button', { name: 'Load latest version' }).click();
    expect(await optionsOf(form)).toEqual(['Completed']);
  });

  test('a concurrent update that makes the chosen step invalid is a revision conflict; the step is dropped, other edits kept', async ({
    page,
    api,
  }) => {
    await open(page, api, { epics: [planned] });
    await epicsPanel(page).getByRole('button', { name: 'Edit epic Planned epic' }).click();
    const form = dialog(page, 'Edit epic');
    await form.getByLabel('Title').fill('Renamed');
    await form.getByLabel('Status').selectOption('in_progress');
    api.next('epic:update', {
      before: () => api.editEpicOutside(planned.id, { status: 'completed' }),
    });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toContainText('was changed elsewhere (it is now at revision 2)');
    await form.getByRole('button', { name: 'Keep my edits' }).click();
    await expect(form).toContainText('Your status change was not kept: this epic is now completed');
    await expect(form.getByLabel('Title')).toHaveValue('Renamed');
    expect(await optionsOf(form)).toEqual(['Completed']);
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form).toBeHidden();
    const last = api.writes().at(-1)?.body as Record<string, unknown>;
    expect(last).toEqual({ expectedRevision: 2, title: 'Renamed' }); // no status in the request
    expect(api.epicStored(planned.id)).toMatchObject({
      title: 'Renamed',
      status: 'completed',
      revision: 3,
    });
  });
});

/* ------------------------------------------------------------------------------------------ *
 * Remediation: a task-to-epic response proves the change only when the revision advances by one.
 * ------------------------------------------------------------------------------------------ */
test.describe('association revision is verified exactly', () => {
  const base = { epics: [e1, e2], tasks: [t(1)] };
  const cases: Array<[string, (json: unknown) => unknown]> = [
    ['an unchanged revision', (json) => ({ ...(json as object), associationRevision: 1 })],
    [
      'a revision that jumped',
      (json) => ({ ...(json as { associationRevision: number }), associationRevision: 5 }),
    ],
    ['the wrong epic', (json) => ({ ...(json as object), epicId: e2.id })],
  ];
  for (const [name, tamper] of cases)
    test(`${name} is an unverified outcome, never a success`, async ({ page, api }) => {
      await open(page, api, base);
      await tasksPanel(page).getByRole('button', { name: 'Set epic for Task number 1' }).click();
      const form = dialog(page, 'Set the epic for a task');
      await form.getByLabel('Epic').selectOption({ label: 'Onboarding flow' });
      api.next('task-epic:set', { tamper });
      await form.getByRole('button', { name: 'Save epic' }).click();
      await expect(form).toContainText('did not get a confirmed result');
      await expect(live(page)).toHaveText(''); // no success announcement
      // The server did apply it. Retrying with the same key replays the real receipt: verified.
      expect(api.assignment('task-0001')).toEqual({ epicId: e1.id, revision: 2 });
      await form.getByRole('button', { name: 'Send the same request again' }).click();
      await expect(form).toBeHidden();
      await expect(live(page)).toContainText(
        '“Task number 1” is now in the epic “Onboarding flow”.',
      );
      const [first, second] = api.writes();
      expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
      expect(api.assignment('task-0001')).toEqual({ epicId: e1.id, revision: 2 });
    });

  test('a correct increment is confirmed for set, move and clear', async ({ page, api }) => {
    await open(page, api, base);
    const button = tasksPanel(page).getByRole('button', { name: 'Set epic for Task number 1' });
    const steps: Array<[string, string, number]> = [
      ['Onboarding flow', 'is now in the epic “Onboarding flow”', 2], // set
      ['Billing', 'is now in the epic “Billing”', 3], // move
      ['No epic', 'is no longer in an epic', 4], // clear
    ];
    for (const [choice, said, revision] of steps) {
      await button.click();
      const form = dialog(page, 'Set the epic for a task');
      await form.getByLabel('Epic').selectOption({ label: choice });
      await form.getByRole('button', { name: 'Save epic' }).click();
      await expect(form).toBeHidden();
      await expect(live(page)).toContainText(said);
      expect(api.assignment('task-0001')?.revision).toBe(revision);
    }
  });
});

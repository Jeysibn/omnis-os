import { expect, test as base, type Page } from '@playwright/test';
import { CONFLICT_MESSAGE, createApi, proj } from './projects.fixture.js';

/**
 * Recovery-state tests for Project Workspace V1: ambiguous 409 handling, the frozen retry, and
 * the difference between a confirmed response and an observed state. Fixture conflicts carry the
 * backend's real, non-specific message (see CONFLICT_MESSAGE). All wording is typed here and never
 * derived from the production catalog.
 */

const test = base.extend<{ api: ReturnType<typeof createApi> }>({
  api: async ({ page }, use) => {
    const api = createApi(page);
    await use(api);
    expect(api.unexpected, 'all frontend requests must match the fixture contract').toEqual([]);
  },
});

const alpha = proj(1, { name: 'Alpha rollout', priority: 'high', objective: 'Ship alpha safely.' });
const conflict = { status: 409, code: 'conflict', message: CONFLICT_MESSAGE } as const;

const copy = {
  keyInUse:
    "The key AO-1 is already used by a project named Alpha rollout. The server reported a conflict, but it doesn't say which condition caused it.",
  keyField: 'This key is already used by another project.',
  createNoMatch:
    "The server reported a conflict, but the project list doesn't show this key in use, and a conflict response doesn't say why. Your values are kept. You can check again, or create again, which sends a new request.",
  createReadback:
    "The server reported a conflict, and Omnis OS couldn't read the project list to check why. Your values are kept. Check again before trying again.",
  editSameRevision:
    "The server reported a conflict, but the project is unchanged at revision 1, so Omnis OS can't tell why. Your edits are kept. You can check again, or save again, which sends a new request.",
  editReadback:
    "The server reported a conflict, and Omnis OS couldn't read the project to check why. Your edits are kept. Check again before saving.",
  editStale:
    'This project changed since you opened it, so your edits were not applied. Your unsaved edits are still in the form.',
  archiveSameRevision:
    "The server reported a conflict, but the project is still active at revision 1, so Omnis OS can't tell why. It was not archived. You can confirm the archive again, which sends a new request.",
  archiveReadback:
    "The server reported a conflict, and Omnis OS couldn't read the project to check why, so its current state is unconfirmed. Reload the page before trying again.",
  observedArchived:
    "The project is currently archived, so it can't be changed. The server reported a conflict, and it can't be determined whether this request or something else archived it.",
  editMatching:
    "The project currently has the requested values. We couldn't confirm whether this request saved them.",
  frozenHint:
    'The values are locked so a retry sends exactly the request that was sent. Choose Edit values to change them.',
  resumed: 'You can edit the values again. Saving sends a new request.',
  valuesChanged:
    'The values changed, so the earlier request was not sent. Review them, then save again.',
  notApplied:
    'The result was unknown. The project still shows its previous values, so your changes were probably not saved. Trying again reuses the same request, which cannot apply twice.',
};

const message = (page: Page, key: string) => page.locator(`[data-message-key="${key}"]`);
const name = (page: Page) => page.getByLabel('Name', { exact: true });
const detailHash = `#projects/${alpha.id}`;

async function openEdit(page: Page) {
  await page.goto(`/${detailHash}/edit`);
  await expect(name(page)).toHaveValue('Alpha rollout');
}
async function fillCreate(page: Page, key: string, projectName: string, objective: string) {
  await page.getByLabel('Key', { exact: true }).fill(key);
  await name(page).fill(projectName);
  await page.getByLabel('Objective').fill(objective);
}
/** Starts an edit whose response is lost without any server-side commit, and waits for the recheck. */
async function loseEdit(page: Page, api: ReturnType<typeof createApi>, next = 'Alpha two') {
  api.next('update', { abort: true });
  await name(page).fill(next);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(message(page, 'unknown.edit.notApplied')).toHaveText(copy.notApplied);
}

test.describe('create: an ambiguous 409 is read back, never assumed to be a duplicate key', () => {
  test('a matching key in the directory is reported as occupied, not as the cause', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await page.goto('/#projects/new');
    await fillCreate(page, 'AO-1', 'Another', 'Reuses the key.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(message(page, 'conflict.create.keyInUse')).toHaveText(copy.keyInUse);
    await expect(page.getByText(copy.keyField)).toBeVisible();
    await expect(page.getByLabel('Key', { exact: true })).toBeFocused();
    await expect(name(page)).toHaveValue('Another');
    await expect(page.getByLabel('Objective')).toHaveValue('Reuses the key.');
    expect(api.posts()).toHaveLength(1);
    expect(api.of('GET', /^\/api\/v1\/projects$/).length).toBeGreaterThan(0);
  });

  test('no matching key gives a neutral explanation and no key-field error', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [] });
    api.next('create', conflict);
    await page.goto('/#projects/new');
    await fillCreate(page, 'AO-20', 'Twenty', 'Twenty things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(message(page, 'conflict.create.noMatch')).toHaveText(copy.createNoMatch);
    await expect(page.getByText(copy.keyField)).toHaveCount(0);
    await expect(page.getByLabel('Key', { exact: true })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page.getByLabel('Key', { exact: true })).toHaveValue('AO-20');
    // A deliberate second attempt is a new request with a new idempotency key.
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Twenty' })).toBeVisible();
    const [first, second] = api.posts();
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  test('a failed directory readback says the conflict could not be resolved', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [] });
    api.next('create', conflict);
    api.persist('list', { status: 500, code: 'internal_error', message: 'Down.' });
    await page.goto('/#projects/new');
    await fillCreate(page, 'AO-21', 'Twenty-one', 'Twenty-one things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(message(page, 'conflict.create.readbackFailed')).toHaveText(copy.createReadback);
    await expect(page.getByText(copy.keyField)).toHaveCount(0);
    await expect(name(page)).toHaveValue('Twenty-one');
    api.persist('list', null);
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(message(page, 'conflict.create.noMatch')).toHaveText(copy.createNoMatch);
    expect(api.posts()).toHaveLength(1); // checking again never resends
  });

  test('an existing project with the same key, name and priority is not claimed as this request', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await page.goto('/#projects/new');
    await fillCreate(page, 'AO-1', 'Alpha rollout', 'Ship alpha safely.');
    await page.getByLabel('Priority').selectOption('high');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(message(page, 'conflict.create.keyInUse')).toHaveText(copy.keyInUse);
    await expect(page).toHaveURL(/#projects\/new$/);
    await expect(page.locator('[data-message-key="confirmed.create"]')).toHaveCount(0);
    await expect(page.locator('[data-message-key="unknown.create.matchingRow"]')).toHaveCount(0);
    expect(api.posts()).toHaveLength(1);
  });
});

test.describe('edit: a retry is frozen to exactly what was sent', () => {
  test('the form locks while a retry is available, and the retry resends the identical request', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    await loseEdit(page, api);
    await expect(page.getByText(copy.frozenHint)).toBeVisible();
    await expect(name(page)).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Objective')).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Priority')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    // Typing into a locked field changes nothing.
    await name(page).focus();
    await page.keyboard.type(' typed while locked');
    await expect(name(page)).toHaveValue('Alpha two');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha two' })).toBeVisible();
    const [first, second] = api.patches();
    expect(second?.body).toEqual(first?.body);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(api.stored(alpha.id)?.name).toBe('Alpha two');
  });

  test('Edit values unlocks the form and a changed value is sent as a new request', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    await loseEdit(page, api);
    await page.getByRole('button', { name: 'Edit values' }).click();
    await expect(message(page, 'edit.resumed')).toHaveText(copy.resumed);
    await expect(name(page)).toBeFocused();
    await expect(name(page)).not.toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await name(page).fill('Alpha three');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha three' })).toBeVisible();
    const [first, second] = api.patches();
    expect(second?.body).toEqual({ expectedRevision: 1, name: 'Alpha three' });
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
    expect(api.stored(alpha.id)?.name).toBe('Alpha three');
  });

  test('Edit values ends the old intent even if the same values are saved again', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    await loseEdit(page, api);
    await page.getByRole('button', { name: 'Edit values' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha two' })).toBeVisible();
    const [first, second] = api.patches();
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  test('if the visible values ever diverge from the frozen request, the old payload is not sent', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    await loseEdit(page, api);
    // Force a divergence the UI should make impossible, to prove the invariant is also enforced.
    await name(page).evaluate((element: HTMLInputElement) => {
      element.removeAttribute('readonly');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(element, 'Diverged name');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(name(page)).toHaveValue('Diverged name');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(message(page, 'edit.valuesChanged')).toHaveText(copy.valuesChanged);
    expect(api.patches()).toHaveLength(1);
    await expect(name(page)).toHaveValue('Diverged name');
    // Saving now is a new request carrying what is visible.
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Diverged name' })).toBeVisible();
    expect(api.patches()[1]?.body).toEqual({ expectedRevision: 1, name: 'Diverged name' });
    expect(api.patches()[1]?.idempotencyKey).not.toBe(api.patches()[0]?.idempotencyKey);
  });

  test('create is frozen the same way, and its Edit values returns focus to the key', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [] });
    api.next('create', { abort: true });
    await page.goto('/#projects/new');
    await fillCreate(page, 'AO-30', 'Thirty', 'Thirty things.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(message(page, 'unknown.create.noMatch')).toBeVisible();
    await expect(page.getByLabel('Key', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Objective')).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Edit values' }).click();
    await expect(page.getByLabel('Key', { exact: true })).toBeFocused();
    await page.getByLabel('Key', { exact: true }).fill('AO-31');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Thirty' })).toBeVisible();
    expect(api.posts()[1]?.idempotencyKey).not.toBe(api.posts()[0]?.idempotencyKey);
    expect(api.posts()[1]?.body).toMatchObject({ key: 'AO-31' });
  });

  test('Edit values works from the keyboard', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    await loseEdit(page, api);
    await page.getByRole('button', { name: 'Edit values' }).focus();
    await page.keyboard.press('Enter');
    await expect(name(page)).toBeFocused();
    await page.keyboard.type(' v2');
    await expect(name(page)).toHaveValue('Alpha two v2');
  });

  test('leaving while an outcome is unresolved sends nothing, and the form reopens fresh', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await page.goto(`/${detailHash}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit project' }).click();
    await expect(name(page)).toHaveValue('Alpha rollout');
    await loseEdit(page, api);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
    expect(api.patches()).toHaveLength(1);
    await page.goForward();
    await expect(name(page)).toHaveValue('Alpha rollout'); // server values, not the lost draft
    await expect(name(page)).not.toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await name(page).fill('Alpha fresh');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha fresh' })).toBeVisible();
    expect(api.patches()[1]?.idempotencyKey).not.toBe(api.patches()[0]?.idempotencyKey);
  });

  test('activating Try again repeatedly sends one request', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    await loseEdit(page, api);
    api.next('update', { delayMs: 500 });
    await page.getByRole('button', { name: 'Try again' }).dblclick();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha two' })).toBeVisible();
    expect(api.patches()).toHaveLength(2);
  });

  test('a recheck that answers after Edit values cannot relock or re-block the form', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    await loseEdit(page, api);
    api.next('detail', { delayMs: 600 });
    const late = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && response.url().endsWith(`/projects/${alpha.id}`),
    );
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.getByRole('button', { name: 'Edit values' }).click();
    await expect(name(page)).not.toHaveAttribute('readonly', '');
    await late;
    await expect(page.getByText(copy.frozenHint)).toHaveCount(0);
    await expect(message(page, 'unknown.edit.notApplied')).toHaveCount(0);
    await expect(name(page)).not.toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(api.patches()).toHaveLength(1);
  });
});

test.describe('edit: a matching state is observed, not attributed', () => {
  test('another session making the identical change is not reported as this request saving it', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    api.next('update', {
      abort: true,
      before: () => api.editOutside(alpha.id, { name: 'Alpha two' }),
    });
    await name(page).fill('Alpha two');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(message(page, 'unknown.edit.matching')).toHaveText(copy.editMatching);
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha two' })).toBeVisible();
    await expect(page.getByText('They were saved.')).toHaveCount(0);
    await expect(page.locator('[data-message-key="confirmed.edit"]')).toHaveCount(0);
    expect(api.patches()).toHaveLength(1);
    expect(api.stored(alpha.id)?.revision).toBe(2);
  });
});

test.describe('edit: conflict wording follows the evidence', () => {
  test('a 409 with an unchanged revision is neutral and keeps the edits', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    api.next('update', conflict);
    await name(page).fill('Alpha two');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(message(page, 'conflict.edit.sameRevision')).toHaveText(copy.editSameRevision);
    await expect(page.locator('[data-message-key="rejected.edit.stale"]')).toHaveCount(0);
    await expect(name(page)).toHaveValue('Alpha two');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha two' })).toBeVisible();
    expect(api.patches()[1]?.idempotencyKey).not.toBe(api.patches()[0]?.idempotencyKey);
  });

  test('a 409 with a changed revision is called stale', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    api.editOutside(alpha.id, { name: 'Renamed elsewhere' });
    await name(page).fill('Mine');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(message(page, 'rejected.edit.stale')).toHaveText(copy.editStale);
  });

  test('a 409 whose readback fails does not guess', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    api.persist('detail', { status: 500, code: 'internal_error', message: 'Down.' });
    api.next('update', conflict);
    await name(page).fill('Alpha two');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(message(page, 'conflict.edit.readbackFailed')).toHaveText(copy.editReadback);
    await expect(page.locator('[data-message-key="rejected.edit.stale"]')).toHaveCount(0);
    await expect(name(page)).toHaveValue('Alpha two');
  });

  test('an archived project observed after a 409 is described without attribution', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openEdit(page);
    api.editOutside(alpha.id, { status: 'archived' });
    await name(page).fill('Too late');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(message(page, 'conflict.observedArchived')).toHaveText(copy.observedArchived);
    await expect(name(page)).toHaveValue('Too late');
  });
});

test.describe('archive: conflict wording follows the evidence', () => {
  const trigger = (page: Page) => page.getByRole('button', { name: 'Archive project' });
  const dialog = (page: Page) => page.getByRole('dialog', { name: 'Archive this project?' });
  async function openAndConfirm(page: Page) {
    await page.goto(`/${detailHash}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Alpha rollout' })).toBeVisible();
  }

  test('a 409 on an unchanged active project is neutral, and confirming again is a new request', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openAndConfirm(page);
    api.next('archive', conflict);
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(message(page, 'conflict.archive.sameRevision')).toHaveText(
      copy.archiveSameRevision,
    );
    await expect(page.locator('[data-message-key="rejected.archive.stale"]')).toHaveCount(0);
    expect(api.stored(alpha.id)?.status).toBe('active');
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByText('This project is archived and read-only.')).toBeVisible();
    expect(api.archives()[1]?.idempotencyKey).not.toBe(api.archives()[0]?.idempotencyKey);
  });

  test('a 409 whose readback fails does not guess', async ({ page, api }) => {
    api.configure({ projects: [alpha] });
    await openAndConfirm(page);
    api.persist('detail', { status: 500, code: 'internal_error', message: 'Down.' });
    api.next('archive', conflict);
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(message(page, 'conflict.archive.readbackFailed')).toHaveText(copy.archiveReadback);
    expect(api.stored(alpha.id)?.status).toBe('active');
  });

  test('an archived project observed after a 409 is described without attribution', async ({
    page,
    api,
  }) => {
    api.configure({ projects: [alpha] });
    await openAndConfirm(page);
    api.editOutside(alpha.id, { status: 'archived' });
    await trigger(page).click();
    await dialog(page).getByRole('button', { name: 'Archive project' }).click();
    await expect(message(page, 'conflict.observedArchived')).toHaveText(copy.observedArchived);
  });
});

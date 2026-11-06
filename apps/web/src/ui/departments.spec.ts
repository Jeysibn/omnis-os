import AxeBuilder from '@axe-core/playwright';
import {
  chromium,
  expect,
  test as base,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import {
  AgentDirectoryResponseSchema,
  CreateDepartmentSchema,
  DepartmentListResponseSchema,
  DepartmentSchema,
  type Department,
} from '@omnis/contracts';
import {
  catalog,
  messageText,
  permittedClaims,
  type MessageKey,
  type MessageParams,
} from './departments/messages.js';
import { analyse } from './departments/recovery.js';

/**
 * Browser tests for Department Management V1 milestone 2 (list, create, rename). Every response
 * is a strictly contract-parsed synthetic fixture. Nothing here exercises the real backend, so
 * none of it is live AO-104 integration evidence.
 */

const stamp = '2026-11-03T10:00:00.000Z';
const later = '2026-11-04T08:30:00.000Z';

function dept(id: string, slug: string, name: string, overrides: Partial<Department> = {}) {
  return DepartmentSchema.parse({
    id,
    slug,
    name,
    archivedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  });
}

const engineering = dept('dep_eng', 'engineering', 'Engineering');
const research = dept('dep_res', 'research', 'Research');
const retired = dept('dep_old', 'retired', 'Retired Unit', { archivedAt: later, updatedAt: later });
const defaultDepartments = [engineering, research, retired];

type Step = {
  status?: number;
  code?: string;
  message?: string;
  abort?: boolean;
  /** Apply the default effect to the fixture state, then still fail (a late or lost response). */
  commit?: boolean;
  /** Runs before the response, to simulate another session changing the list. */
  before?: () => void;
  body?: unknown;
  delayMs?: number;
};

function createApi(page: Page) {
  let departments: Department[] = [...defaultDepartments];
  let token = 'csrf-fixture';
  let counter = 100;
  let listDelay = 0;
  let signedOut = false;
  const queues: Record<'GET' | 'POST' | 'PATCH', Step[]> = { GET: [], POST: [], PATCH: [] };
  let persistentListFailure: Step | null = null;
  const requests: Array<{
    method: string;
    path: string;
    search: string;
    body: unknown;
    csrf: string | null;
  }> = [];
  const unexpected: string[] = [];

  const error = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, json: { error: { code, message, requestId: 'fixture-request' } } });

  const sorted = () =>
    [...departments].sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
    );

  type Outcome =
    { status: 200 | 201; json: unknown } | { status: number; code: string; message: string };

  const mutate = (method: string, id: string | null, raw: string | null): Outcome => {
    const parsed = CreateDepartmentSchema.safeParse(raw ? JSON.parse(raw) : undefined);
    if (!parsed.success)
      return {
        status: 422,
        code: 'invalid_input',
        message: 'Department input is invalid.',
      };
    const { slug, name } = parsed.data;
    if (method === 'POST') {
      if (departments.length >= 500)
        return { status: 422, code: 'limit', message: 'Department limit reached.' };
      if (departments.some((item) => item.slug === slug))
        return { status: 409, code: 'conflict', message: 'Slug is already used.' };
      counter += 1;
      const created = dept(`dep_${counter}`, slug, name);
      departments.push(created);
      return { status: 201, json: DepartmentSchema.parse(created) };
    }
    const current = departments.find((item) => item.id === id);
    if (!current) return { status: 404, code: 'not_found', message: 'Department not found.' };
    if (current.archivedAt)
      return { status: 409, code: 'invalid_transition', message: 'Department is archived.' };
    if (departments.some((item) => item.id !== id && item.slug === slug))
      return { status: 409, code: 'conflict', message: 'Slug is already used.' };
    const updated = dept(current.id, slug, name, {
      createdAt: current.createdAt,
      updatedAt: later,
    });
    departments = departments.map((item) => (item.id === id ? updated : item));
    return { status: 200, json: DepartmentSchema.parse(updated) };
  };

  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path, search } = url;
    const method = request.method();
    const csrf = (await request.headerValue('x-omnis-csrf')) ?? null;
    const raw = request.postData();
    requests.push({
      method,
      path,
      search,
      body: raw ? (JSON.parse(raw) as unknown) : null,
      csrf,
    });

    if (path === '/api/v1/auth/csrf') return route.fulfill({ json: { csrfToken: token } });
    if (path === '/api/v1/me')
      return signedOut
        ? error(route, 401, 'unauthorized', 'Sign in to continue.')
        : route.fulfill({ json: { id: 'owner', displayName: 'Director' } });
    if (path === '/api/v1/tasks' || path === '/api/v1/runs') return route.fulfill({ json: [] });
    if (path === '/api/v1/agents' && method === 'GET')
      return route.fulfill({
        json: AgentDirectoryResponseSchema.parse({
          agents: [],
          page: { total: 0, complete: true, nextCursor: null },
        }),
      });
    if (path.startsWith('/api/v1/agents/'))
      return error(route, 404, 'not_found', 'Agent not found.');

    const detail = /^\/api\/v1\/departments\/([^/]+)$/.exec(path);
    const isList = path === '/api/v1/departments';
    if (!(isList && (method === 'GET' || method === 'POST')) && !(detail && method === 'PATCH')) {
      unexpected.push(`${method} ${path}`);
      return error(route, 500, 'fixture_contract_violation', `Unexpected ${method} ${path}`);
    }

    if (method === 'GET') {
      const include = url.searchParams.get('includeArchived');
      if (search && !(search === '?includeArchived=true' || search === '?includeArchived=false'))
        return error(route, 422, 'invalid_input', 'Department query parameters are invalid.');
      const step = queues.GET.shift() ?? persistentListFailure ?? {};
      step.before?.();
      if (listDelay) await new Promise((resolve) => setTimeout(resolve, listDelay));
      if (step.abort) return route.abort('failed');
      if (step.status)
        return error(
          route,
          step.status,
          step.code ?? 'departments_unavailable',
          step.message ?? 'Departments are temporarily unavailable.',
        );
      if (step.body !== undefined) return route.fulfill({ json: step.body });
      const visible = sorted().filter((item) => include === 'true' || item.archivedAt === null);
      return route.fulfill({
        json: DepartmentListResponseSchema.parse({ departments: visible, total: visible.length }),
      });
    }

    // Mutation: the CSRF check runs before any write, as on the real API.
    const step = queues[method as 'POST' | 'PATCH'].shift() ?? {};
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (csrf !== token)
      return error(route, 403, 'csrf_rejected', 'Refresh the page and retry the action.');
    step.before?.();
    const id = detail ? decodeURIComponent(detail[1] ?? '') : null;
    if (step.commit) mutate(method, id, raw);
    if (step.abort) return route.abort('failed');
    if (step.status)
      return error(route, step.status, step.code ?? 'error', step.message ?? 'Fixture error.');
    if (step.body !== undefined) return route.fulfill({ status: 200, json: step.body });
    const outcome = mutate(method, id, raw);
    if ('json' in outcome) return route.fulfill({ status: outcome.status, json: outcome.json });
    return error(route, outcome.status, outcome.code, outcome.message);
  };

  void page.route('**/api/v1/**', handle);
  return {
    configure(next: { departments?: Department[]; listDelay?: number } = {}) {
      departments = [...(next.departments ?? defaultDepartments)];
      listDelay = next.listDelay ?? 0;
      requests.length = 0;
    },
    /** Queue the next response for a method. Unqueued requests behave like the contract. */
    next(method: 'GET' | 'POST' | 'PATCH', ...steps: Step[]) {
      queues[method].push(...steps);
    },
    failLists(step: Step | null) {
      persistentListFailure = step;
    },
    rotateCsrf() {
      token = 'csrf-rotated';
    },
    signOut() {
      signedOut = true;
    },
    /** Mutates the fixture list directly, as another session would. */
    insert(item: Department) {
      departments.push(item);
    },
    replace(item: Department) {
      departments = departments.map((current) => (current.id === item.id ? item : current));
    },
    requests,
    unexpected,
    lists: (include?: boolean) =>
      requests.filter(
        (entry) =>
          entry.method === 'GET' &&
          entry.path === '/api/v1/departments' &&
          (include === undefined ||
            (include ? entry.search === '?includeArchived=true' : entry.search === '')),
      ),
    posts: () => requests.filter((entry) => entry.method === 'POST'),
    patches: () => requests.filter((entry) => entry.method === 'PATCH'),
    mutations: () =>
      requests.filter(
        (entry) => entry.method !== 'GET' && entry.path.startsWith('/api/v1/departments'),
      ),
  };
}

const test = base.extend<{ api: ReturnType<typeof createApi> }>({
  api: async ({ page }, use) => {
    const api = createApi(page);
    await use(api);
    expect(api.unexpected, 'all frontend requests must match the fixture contract').toEqual([]);
  },
});

async function openDepartments(page: Page, hash = '#departments') {
  await page.goto(`/${hash}`);
  await expect(page.locator('#main-content')).toBeVisible();
}

const list = (page: Page) => page.getByRole('list', { name: 'Departments' });
const row = (page: Page, name: string) =>
  list(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) });
const statusRegion = (page: Page) => page.locator('.dept-status');
const keysOnScreen = (page: Page) =>
  page
    .locator('[data-message-key]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-key')));

/**
 * Independently anchored wording for every rejected rename message. These literals are typed
 * here on purpose and never derived from the production catalog: a copy change in
 * `messages.ts` must fail these tests until the expectation is reviewed and updated by hand.
 */
const csrfCopy = 'Your secure session needs refreshing. The change was not applied. Try again.';
const invalidInputCopy =
  'The server rejected these values. Check the name and slug, and remove anything that looks like a credential or secret.';
const renameCopy: Partial<Record<MessageKey, string>> = {
  'rejected.rename.csrf': csrfCopy,
  'rejected.rename.invalidInput': invalidInputCopy,
  'rejected.rename.notFound': "The server reports that this department doesn't exist.",
  'rejected.rename.readbackFailed':
    "The server rejected the rename. Omnis OS couldn't check why. The slug may already be in use, or the department may be archived.",
  'rejected.rename.absent':
    "The server rejected the rename, and this department doesn't appear in the latest list.",
  'rejected.rename.archived':
    "The server rejected the rename. The department currently appears as archived, so it can't be changed.",
  'rejected.rename.conflictOtherSlug':
    'Another department currently uses this slug (an archived department keeps its slug). Choose a different slug.',
  'rejected.rename.inconclusive':
    "The server rejected the rename, but the latest list doesn't show why. Something may have changed in between. Reload and try again.",
};
/** Literal wording for rejected rename keys; every other key still reads from the catalog. */
const expectedText = (key: MessageKey, params: MessageParams = {}) =>
  renameCopy[key] ?? messageText({ key, params });

/** Asserts the catalog key, then the exact catalogued text, inside one scope. */
/** A field error carries its catalog key on the error element itself. */
const expectField = (page: Page, key: MessageKey, params: MessageParams = {}) =>
  expect(page.locator(`.dept-field-error[data-message-key="${key}"]`)).toHaveText(
    expectedText(key, params),
  );

async function expectMessage(
  scope: Locator,
  key: MessageKey,
  params: MessageParams = {},
  prefix = '',
) {
  const element = scope.locator(`[data-message-key="${key}"]`);
  await expect(element).toHaveCount(1);
  await expect(element).toHaveText(`${prefix}${expectedText(key, params)}`);
}
const expectStatus = (page: Page, key: MessageKey, params?: MessageParams) =>
  expectMessage(statusRegion(page), key, params);

async function openCreate(page: Page) {
  await page.getByRole('button', { name: 'New department' }).click();
  await expect(page.getByLabel(/^Name/)).toBeFocused();
}
async function fillForm(
  page: Page,
  name: string,
  slug: string,
  scope: Locator = page.locator('form.dept-form'),
) {
  await scope.getByLabel(/^Name/).fill(name);
  await scope.getByLabel(/^Slug/).fill(slug);
}
async function startRename(page: Page, name: string) {
  await row(page, name)
    .getByRole('button', { name: new RegExp(`^Rename ${name}`) })
    .click();
  await expect(page.getByLabel(/^Name/)).toBeFocused();
}
const save = (page: Page) => page.getByRole('button', { name: 'Save changes' });

const widths = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1000 },
  { name: '390', width: 390, height: 844 },
  { name: '360', width: 360, height: 740 },
  { name: '320', width: 320, height: 640 },
];

async function expectNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 6)
      .map((el) => `${el.tagName}.${el.className}`),
  }));
  expect(result.overflow, `offenders: ${result.offenders.join(', ')}`).toBeLessThanOrEqual(0);
}

/**
 * The Departments content itself must fit the viewport. Used where the pre-existing app shell
 * (top bar) already overflows on every route (720px at density 2; 16px minimum font <= 390px),
 * so a document-level check would measure the shell rather than this feature.
 */
async function expectWorkspaceContained(page: Page) {
  const result = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.dept-workspace');
    const width = document.documentElement.clientWidth;
    const offenders = root
      ? [...root.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().right > width + 1)
          .slice(0, 6)
          .map((el) => `${el.tagName}.${el.className}`)
      : ['missing workspace'];
    return { offenders, scroll: root ? root.scrollWidth - root.clientWidth : 1 };
  });
  expect(result.offenders).toEqual([]);
  expect(result.scroll).toBeLessThanOrEqual(0);
}

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious'),
  ).toEqual([]);
}

test.describe('Message catalog', () => {
  test('rejected rename copy matches the independently anchored wording', () => {
    const keys = Object.keys(catalog).filter((key) => key.startsWith('rejected.rename.'));
    expect(keys.sort()).toEqual(Object.keys(renameCopy).sort());
    for (const key of keys)
      expect(messageText({ key: key as MessageKey }), key).toBe(renameCopy[key as MessageKey]);
  });

  test('every entry declares claims that its evidence level permits (7.8)', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      expect(entry.claims.length, key).toBeGreaterThan(0);
      expect(key.split('.')[0], key).toBe(entry.evidence);
      for (const claim of entry.claims)
        expect(permittedClaims[entry.evidence], `${key} claim ${claim}`).toContain(claim);
    }
  });

  test('unknown entries make no success, failure or cause claim; success only when confirmed', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      const claims = entry.claims as readonly string[];
      if (entry.evidence === 'unknown' || entry.evidence === 'inflight')
        for (const banned of ['success', 'failure', 'cause'])
          expect(claims, `${key} must not claim ${banned}`).not.toContain(banned);
      if (claims.includes('success')) expect(entry.evidence, key).toBe('confirmed');
      expect(claims, key).not.toContain('cause');
    }
  });

  test('RM-07: the hedged noMatch text contains "failed" yet is an uncertainty, not a failure claim', () => {
    const entry = catalog['unknown.create.noMatch'];
    expect(messageText({ key: 'unknown.create.noMatch' })).toContain(
      "doesn't prove the create failed",
    );
    expect(entry.claims).toEqual(['uncertainty']);
  });

  test('rejected entries that declare uncertainty also declare failure (cause uncertainty only); inflight is progress only', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      const claims = entry.claims as readonly string[];
      if (entry.evidence === 'rejected' && claims.includes('uncertainty'))
        expect(claims, `${key} keeps the rejection certain`).toContain('failure');
      if (entry.evidence === 'inflight') {
        expect(claims, key).toEqual(['progress']);
        expect(key.startsWith('inflight.'), key).toBe(true);
      }
      if (key.endsWith('.outcome') || key.includes('.newRequest'))
        expect(entry.evidence, key).toBe('unknown');
    }
  });

  test('recovery analysis is pure: a failed recheck is never an observation', () => {
    const create = { kind: 'create', slug: 's', name: 'N' } as const;
    expect(analyse(create, 'unknown', null).messages).toEqual([
      { key: 'unknown.create.recheckFailed' },
    ]);
    const rename = {
      kind: 'rename',
      id: 'dep_eng',
      previous: { slug: 'engineering', name: 'Engineering' },
      slug: 'eng',
      name: 'Eng',
    } as const;
    expect(analyse(rename, 'unknown', null).blocking).toBe(true);
    expect(analyse(rename, 'conflict', null).messages).toEqual([
      { key: 'rejected.rename.readbackFailed' },
    ]);
  });
});

test.describe('Department directory', () => {
  test('lists real API departments in server order with Manila times and no query', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Department directory' }),
    ).toBeVisible();
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    await expect(list(page).getByRole('heading', { level: 3 })).toHaveText([
      'Engineering',
      'Research',
    ]);
    const first = row(page, 'Engineering');
    await expect(first).toContainText('engineering');
    await expect(first).toContainText(/Created .*6:00\s?pm/i);
    await expect(first).toContainText(/Updated .*6:00\s?pm/i);
    await expect(first.getByRole('button', { name: 'Rename Engineering' })).toBeVisible();
    await expect(page.getByText('Retired Unit')).toHaveCount(0);
    // React StrictMode double-runs the mount effect in dev, so allow the aborted duplicate.
    expect(api.lists().length).toBeGreaterThanOrEqual(1);
    expect(api.lists().every((entry) => entry.search === '')).toBe(true);
    expect(api.lists(true)).toHaveLength(0);
  });

  test('Show archived refetches with includeArchived=true, replaces the URL and offers no actions on archived rows', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    const historyBefore = await page.evaluate(() => history.length);
    await page.getByLabel('Show archived').check();
    await expect(row(page, 'Retired Unit')).toBeVisible();
    expect(api.lists(true)).toHaveLength(1);
    await expect(page).toHaveURL(/#departments\?archived=1$/);
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);
    const archived = row(page, 'Retired Unit');
    await expect(archived.getByText('Archived', { exact: true })).toBeVisible();
    await expect(archived.getByText("Archived departments can't be changed.")).toBeVisible();
    await expect(archived.getByRole('button')).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('Show archived')).toBeChecked();
    await expect(row(page, 'Retired Unit')).toBeVisible();
  });

  test('Back and Forward restore the archived setting', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await page.evaluate(() => {
      window.location.hash = '#departments?archived=1';
    });
    await expect(row(page, 'Retired Unit')).toBeVisible();
    await page.goBack();
    await expect(page.getByLabel('Show archived')).not.toBeChecked();
    await expect(page.getByText('Retired Unit')).toHaveCount(0);
    await page.goForward();
    await expect(row(page, 'Retired Unit')).toBeVisible();
  });

  test('empty states are neutral about archived rows', async ({ page, api }) => {
    api.configure({ departments: [retired] });
    await openDepartments(page);
    const neutral =
      'No active departments. Turn on Show archived to check for archived departments.';
    await expect(page.getByText(neutral, { exact: true })).toBeVisible();
    await expect(page.getByText('No departments yet.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New department' })).toBeVisible();
    await page.getByLabel('Show archived').check();
    await expect(row(page, 'Retired Unit')).toBeVisible();
    await expect(page.getByText('All departments shown here are archived.')).toBeVisible();
    await expect(page.getByText('No departments yet.')).toHaveCount(0);
  });

  test('"No departments yet." appears only for a successful include-archived empty response', async ({
    page,
    api,
  }) => {
    api.configure({ departments: [] });
    await openDepartments(page);
    await expect(page.getByText('No active departments.', { exact: false })).toBeVisible();
    await expect(page.getByText('No departments yet.')).toHaveCount(0);
    await page.getByLabel('Show archived').check();
    await expect(page.getByText('No departments yet.', { exact: true })).toBeVisible();
  });

  test('a failed include-archived request shows the ordinary error and no inference', async ({
    page,
    api,
  }) => {
    api.configure({ departments: [retired] });
    await openDepartments(page);
    await expect(page.getByText('No active departments.', { exact: false })).toBeVisible();
    api.next('GET', { status: 503 });
    await page.getByLabel('Show archived').check();
    await expect(page.getByText('Departments unavailable')).toBeVisible();
    await expect(page.getByText('No active departments.', { exact: false })).toHaveCount(0);
    await expect(page.getByText('No departments yet.')).toHaveCount(0);
    await expect(page.getByText('Retired Unit')).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry departments' }).click();
    await expect(row(page, 'Retired Unit')).toBeVisible();
  });

  test('shows loading, then a failure with Retry that recovers, never an empty state', async ({
    page,
    api,
  }) => {
    api.configure({ listDelay: 300 });
    api.failLists({ status: 503 });
    await openDepartments(page);
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading departments…' }),
    ).toBeVisible();
    await expect(page.getByText('Departments unavailable')).toBeVisible();
    await expect(page.getByText(/No active departments|No departments yet/)).toHaveCount(0);
    await expect(list(page)).toHaveCount(0);
    api.failLists(null);
    await page.getByRole('button', { name: 'Retry departments' }).click();
    await expect(row(page, 'Engineering')).toBeVisible();
  });

  test('403 shows the access message and navigation still works', async ({ page, api }) => {
    api.configure();
    api.failLists({ status: 403, code: 'forbidden', message: 'No.' });
    await openDepartments(page);
    await expect(page.getByText("You don't have access to departments.")).toBeVisible();
    await page.getByRole('link', { name: 'Back to Agents' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Agents & Profiles' })).toBeVisible();
  });

  test('401 follows the session-expiry flow and leaves no department data', async ({
    page,
    api,
  }) => {
    api.configure();
    api.failLists({ status: 401, code: 'unauthorized', message: 'Sign in to continue.' });
    // Not openDepartments: the authenticated workspace correctly disappears once the 401 is
    // handled, so waiting for #main-content would race the expected outcome.
    await page.goto('/#departments');
    // The expected outcome: the sign-in screen with the session-expiry notice.
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await expect(
      page.getByText('Your owner session expired. Sign in again to continue.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // Nothing from the authenticated workspace is presented, and no department data survives.
    await expect(page.locator('#main-content')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toHaveCount(0);
    await expect(page.getByText('Engineering')).toHaveCount(0);
    await expect(page.getByText('Research')).toHaveCount(0);
    // The 401 came from the real list request, not from a missing session at load.
    expect(api.lists().length).toBeGreaterThanOrEqual(1);
    expect(api.unexpected).toEqual([]);
  });

  test('503 limit shows the too-large state with no partial list', async ({ page, api }) => {
    api.configure();
    api.failLists({ status: 503, code: 'limit', message: 'Too many.' });
    await openDepartments(page);
    await expect(
      page.getByText('The department list is too large to show reliably.'),
    ).toBeVisible();
    await expect(list(page)).toHaveCount(0);
  });

  const invalidBodies: Array<[string, () => unknown]> = [
    ['an extra field', () => ({ departments: [], total: 0, extra: true })],
    ['a total mismatch', () => ({ departments: [engineering], total: 2 })],
    [
      'a duplicate id',
      () => ({ departments: [engineering, { ...research, id: engineering.id }], total: 2 }),
    ],
    [
      'a duplicate slug',
      () => ({ departments: [engineering, { ...research, slug: engineering.slug }], total: 2 }),
    ],
    [
      'an unknown department field',
      () => ({ departments: [{ ...engineering, color: 'red' }], total: 1 }),
    ],
  ];
  for (const [label, body] of invalidBodies) {
    test(`an invalid response (${label}) shows the unexpected-response error, never a list or empty state`, async ({
      page,
      api,
    }) => {
      api.configure();
      api.failLists({ body: body() });
      await openDepartments(page);
      await expect(
        page.getByText('Omnis OS received an unexpected department response.'),
      ).toBeVisible();
      await expect(list(page)).toHaveCount(0);
      await expect(page.getByText(/No active departments|No departments yet/)).toHaveCount(0);
    });
  }

  test('same-name departments are distinguishable by slug and by accessible action name', async ({
    page,
    api,
  }) => {
    api.configure({
      departments: [dept('dep_a', 'ops-a', 'Operations'), dept('dep_b', 'ops-b', 'Operations')],
    });
    await openDepartments(page);
    await expect(page.getByRole('button', { name: 'Rename Operations, slug ops-a' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rename Operations, slug ops-b' })).toBeVisible();
    await expect(list(page)).toContainText('ops-a');
    await expect(list(page)).toContainText('ops-b');
  });

  test('Milestone 2 renders no archive, unarchive, delete or undo control', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page, '#departments?archived=1');
    await expect(row(page, 'Retired Unit')).toBeVisible();
    await expect(page.getByRole('button', { name: /archive|delete|undo|restore/i })).toHaveCount(0);
  });

  test('hostile names and slugs render inert as text', async ({ page, api }) => {
    const hostile =
      '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>**bold**';
    api.configure({
      departments: [dept('dep_h', 'hostile', hostile), dept('dep_b', 'bidi', 'A‮b‬')],
    });
    await openDepartments(page);
    await expect(list(page).getByText(hostile, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
    await expect(list(page).locator('img, script')).toHaveCount(0);
  });
});

test.describe('Routing, navigation and focus', () => {
  test('direct navigation and reload work; the primary nav keeps four links and marks none current', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(nav.getByRole('link')).toHaveCount(4);
    await expect(nav.locator('[aria-current]')).toHaveCount(0);
    await page.reload();
    await expect(row(page, 'Engineering')).toBeVisible();
    expect(api.requests.filter((entry) => entry.path.startsWith('/api/v1/agents/'))).toHaveLength(
      0,
    );
  });

  test('Manage departments on the Agents directory and Back to Agents navigate correctly', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page, '#agents');
    await page.getByRole('link', { name: 'Manage departments' }).click();
    await expect(page).toHaveURL(/#departments$/);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Department directory' }),
    ).toBeFocused();
    await page.getByRole('link', { name: 'Back to Agents' }).click();
    await expect(page).toHaveURL(/#agents$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Agents & Profiles' })).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Department directory' }),
    ).toBeVisible();
  });

  test('initial load does not move focus', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await expect(row(page, 'Engineering')).toBeVisible();
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBe('BODY');
  });

  test('#departments/x is a malformed link with no department request', async ({ page, api }) => {
    api.configure();
    await openDepartments(page, '#departments/x');
    await expect(page.getByRole('heading', { name: "This link isn't valid" })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Back to the department directory' }),
    ).toBeVisible();
    expect(api.lists()).toHaveLength(0);
  });

  test('a trailing slash is normalized without a history entry', async ({ page, api }) => {
    api.configure();
    await openDepartments(page, '#departments/');
    await expect(row(page, 'Engineering')).toBeVisible();
    await expect(page).toHaveURL(/#departments$/);
  });

  test('#agents/departments is still the agent with id "departments"', async ({ page, api }) => {
    api.configure();
    await openDepartments(page, '#agents/departments');
    await expect(page.getByRole('heading', { level: 1, name: 'Agents & Profiles' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Department directory' })).toHaveCount(0);
    expect(api.lists()).toHaveLength(0);
    expect(api.requests.some((entry) => entry.path === '/api/v1/agents/departments')).toBe(true);
  });

  test('F0b: the skip link keeps the hash, adds no history and focuses main', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await expect(row(page, 'Engineering')).toBeVisible();
    const before = await page.evaluate(() => history.length);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: /skip to main/i });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
    await expect(page).toHaveURL(/#departments$/);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });
});

test.describe('Create department', () => {
  test('sends exactly {slug, name} with the CSRF header, closes, re-reads and confirms (DM-09, DM-14)', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, '  Finance  ', '  finance  ');
    api.next('POST', { delayMs: 400, commit: false });
    const listsBefore = api.lists().length;
    await page.getByRole('button', { name: 'Create department' }).click();
    // Pending: submit is disabled, the list is unchanged and there is no optimistic row.
    await expect(page.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    await expectStatus(page, 'inflight.create');
    await expect(page.getByText('Finance', { exact: true })).toHaveCount(0);
    await expectStatus(page, 'confirmed.create', { name: 'Finance', slug: 'finance' });
    await expect(row(page, 'Finance')).toBeVisible();
    expect(api.posts()).toHaveLength(1);
    const [post] = api.posts();
    expect(post?.body).toEqual({ slug: 'finance', name: 'Finance' });
    expect(post?.csrf).toBe('csrf-fixture');
    expect(api.lists().length).toBe(listsBefore + 1);
    await expect(page.locator('form.dept-form')).toHaveCount(0);
    await expect(row(page, 'Finance').getByRole('heading', { level: 3 })).toBeFocused();
    expect(await keysOnScreen(page)).toEqual(['confirmed.create']);
  });

  test('client validation blocks bad input with a summary and field errors and sends no request (DM-08, DM-28)', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    const cases: Array<[string, string, string, string]> = [
      ['', 'ok', 'Enter a name.', ''],
      ['x'.repeat(121), 'ok', 'Use 120 characters or fewer.', ''],
      ['Ok', '', '', 'Enter a slug.'],
      ['Ok', 'a'.repeat(81), '', 'Use 80 characters or fewer.'],
      ['Ok', 'Upper', '', 'Use lowercase letters, numbers and single hyphens.'],
      ['Ok', 'has space', '', 'Use lowercase letters, numbers and single hyphens.'],
      ['Ok', 'under_score', '', 'Use lowercase letters, numbers and single hyphens.'],
      ['Ok', '-lead', '', 'Use lowercase letters, numbers and single hyphens.'],
      ['Ok', 'trail-', '', 'Use lowercase letters, numbers and single hyphens.'],
      ['Ok', 'dou--ble', '', 'Use lowercase letters, numbers and single hyphens.'],
    ];
    for (const [name, slug, nameError, slugError] of cases) {
      await fillForm(page, name, slug);
      await page.getByRole('button', { name: 'Create department' }).click();
      const summary = page.getByRole('alert').filter({ hasText: 'There is a problem' });
      await expect(summary).toBeFocused();
      if (nameError) {
        await expect(page.getByLabel(/^Name/)).toHaveAttribute('aria-invalid', 'true');
        await expect(
          page.locator('.dept-field-error').filter({ hasText: nameError }),
        ).toBeVisible();
      }
      if (slugError) {
        await expect(page.getByLabel(/^Slug/)).toHaveAttribute('aria-invalid', 'true');
        await expect(
          page.locator('.dept-field-error').filter({ hasText: slugError }),
        ).toBeVisible();
      }
    }
    expect(api.posts()).toHaveLength(0);
    // The slug is not silently lowercased.
    await expect(page.getByLabel(/^Slug/)).toHaveValue('dou--ble');
    // Summary items are buttons (never fragment links) that focus the field.
    await expect(page.locator('.dept-summary a')).toHaveCount(0);
    await page
      .locator('.dept-summary')
      .getByRole('button', { name: /^Slug:/ })
      .click();
    await expect(page.getByLabel(/^Slug/)).toBeFocused();
    // Errors clear once the field is corrected.
    await page.getByLabel(/^Slug/).fill('fixed');
    await expect(page.getByLabel(/^Slug/)).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('duplicate slug (409) shows the slug field error, keeps the name and focuses Slug (DM-10)', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Another', 'engineering');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectField(page, 'rejected.create.slugTaken');
    await expect(page.getByLabel(/^Slug/)).toBeFocused();
    await expect(page.getByLabel(/^Name/)).toHaveValue('Another');
    await expect(row(page, 'Another')).toHaveCount(0);
    expect(api.posts()).toHaveLength(1);
  });

  test('422 invalid_input and 422 limit show form-level rejections without flagging a field (DM-11)', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Name', 'name');
    api.next('POST', {
      status: 422,
      code: 'invalid_input',
      message: 'Department input is invalid.',
    });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectMessage(page.locator('.dept-summary'), 'rejected.create.invalidInput');
    await expect(page.getByLabel(/^Name/)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel(/^Slug/)).not.toHaveAttribute('aria-invalid', 'true');
    api.next('POST', { status: 422, code: 'limit', message: 'Department limit reached.' });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectMessage(page.locator('.dept-summary'), 'rejected.create.limit');
    expect(api.posts()).toHaveLength(2);
  });

  test('403 refreshes the CSRF token, keeps input and session, and a manual retry carries the new token (DM-12)', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    api.rotateCsrf();
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectMessage(page.locator('.dept-summary'), 'rejected.create.csrf');
    await expect(page.getByLabel(/^Name/)).toHaveValue('Legal');
    expect(
      api.requests.filter((entry) => entry.path === '/api/v1/auth/csrf').length,
    ).toBeGreaterThanOrEqual(2);
    expect(api.posts()).toHaveLength(1);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectStatus(page, 'confirmed.create', { name: 'Legal', slug: 'legal' });
    expect(api.posts()).toHaveLength(2);
    expect(api.posts()[0]?.csrf).toBe('csrf-fixture');
    expect(api.posts()[1]?.csrf).toBe('csrf-rotated');
    await expect(page.getByText('Your owner session expired.')).toHaveCount(0);
  });

  test('401 on a create follows the session-expiry flow', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.next('POST', { status: 401, code: 'unauthorized', message: 'Sign in to continue.' });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expect(
      page.getByText('Your owner session expired. Sign in again to continue.'),
    ).toBeVisible();
  });

  test('double submit sends a single request', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.next('POST', { delayMs: 500 });
    const button = page.getByRole('button', { name: 'Create department' });
    await button.dblclick();
    await page.getByLabel(/^Slug/).press('Enter');
    await expectStatus(page, 'confirmed.create', { name: 'Legal', slug: 'legal' });
    expect(api.posts()).toHaveLength(1);
  });

  test('confirmed 201 followed by a failed list refresh keeps the confirmation, marks the list stale and never re-posts (RM-01)', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.failLists({ status: 503 });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'confirmed.create', { name: 'Legal', slug: 'legal' });
    await expectMessage(page.getByRole('alert'), 'confirmed.listStale');
    await expect(list(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New department' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Rename/ })).toHaveCount(0);
    api.failLists(null);
    await page.getByRole('button', { name: 'Refresh list' }).click();
    await expect(row(page, 'Legal')).toBeVisible();
    // The earlier confirmation is not announced again and is not repeated by the refresh.
    expect(api.posts()).toHaveLength(1);
  });

  const unknownCases: Array<[string, Step]> = [
    [
      '503 department_outcome_unknown',
      {
        status: 503,
        code: 'department_outcome_unknown',
        message: 'Read the department state before retrying.',
      },
    ],
    ['another 5xx', { status: 500, code: 'internal_error', message: 'Boom.' }],
    ['a network drop', { abort: true }],
    ['a 2xx with an invalid body', { body: { nope: true } }],
    ['a 2xx that does not match the request', { body: dept('dep_other', 'other-slug', 'Other') }],
  ];
  for (const [label, step] of unknownCases) {
    test(`unknown create outcome: ${label} makes no claim, adds no row and sends one POST (DM-13, RM-04, RM-22)`, async ({
      page,
      api,
    }) => {
      api.configure();
      await openDepartments(page);
      await openCreate(page);
      await fillForm(page, 'Legal', 'legal');
      api.next('POST', step);
      await page.getByRole('button', { name: 'Create department' }).click();
      await expectStatus(page, 'unknown.create.outcome');
      expect(await keysOnScreen(page)).toEqual(['unknown.create.outcome']);
      await expect(row(page, 'Legal')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Create department' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'New department' })).toBeDisabled();
      await expect(page.getByLabel(/^Name/)).toHaveValue('Legal');
      await page.waitForTimeout(500);
      expect(api.posts()).toHaveLength(1);
    });
  }

  test('RM-04: failed recheck keeps the outcome unknown, submit stays disabled, Check again works', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.next('POST', { status: 503, code: 'department_outcome_unknown', message: 'Read first.' });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'unknown.create.outcome');
    api.next('GET', { status: 503 });
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.create.recheckFailed');
    await expect(page.getByRole('button', { name: 'Create department' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New department' })).toBeDisabled();
    api.next('GET', { abort: true });
    await page.getByRole('button', { name: 'Check again' }).click();
    await expectStatus(page, 'unknown.create.recheckFailed');
    api.next('GET', { body: { departments: [], total: 1 } }); // invalid recheck (RM-21)
    await page.getByRole('button', { name: 'Check again' }).click();
    await expectStatus(page, 'unknown.create.recheckFailed');
    await page.getByRole('button', { name: 'Check again' }).click();
    await expectStatus(page, 'unknown.create.noMatch');
    expect(api.posts()).toHaveLength(1);
  });

  test('RM-05/RM-08: a matching slug and name is an observation, not a success or cause claim; only Close', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.next('POST', { status: 503, code: 'department_outcome_unknown', message: 'Read first.' });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'unknown.create.outcome');
    // Another session created the same slug and name before the recheck.
    api.insert(dept('dep_other', 'legal', 'Legal'));
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.create.matchingRow');
    expect(await keysOnScreen(page)).toEqual(['unknown.create.matchingRow']);
    await expect(page.getByRole('button', { name: 'Try creating again' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(row(page, 'Legal')).toBeVisible();
    expect(api.posts()).toHaveLength(1);
  });

  test('RM-06: same slug with a different name, or archived, is a slug observation with the input kept', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'retired');
    api.next('POST', { status: 500 });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'unknown.create.outcome');
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectField(page, 'unknown.create.slugTaken', { name: 'Retired Unit', archived: true });
    await expect(page.getByLabel(/^Slug/)).toBeFocused();
    await expect(page.getByLabel(/^Name/)).toHaveValue('Legal');
    await expect(page.getByRole('button', { name: 'Create department' })).toBeEnabled();
    expect(api.posts()).toHaveLength(1);
  });

  test('RM-07: no matching slug is hedged uncertainty; Try creating again sends exactly one more POST and a 409 flags the slug', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.next('POST', { status: 503, code: 'department_outcome_unknown', message: 'Read first.' });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'unknown.create.outcome');
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.create.noMatch');
    expect(await keysOnScreen(page)).toEqual(['unknown.create.noMatch']);
    expect(api.posts()).toHaveLength(1);
    // The late commit lands, so the explicit retry is rejected as a duplicate slug.
    api.next('POST', { before: () => api.insert(dept('dep_late', 'legal', 'Legal')) });
    await page.getByRole('button', { name: 'Try creating again' }).click();
    await expectField(page, 'rejected.create.slugTaken');
    expect(api.posts()).toHaveLength(2);
  });

  test('RM-07b: a successful explicit retry confirms creation exactly once more', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.next('POST', { abort: true });
    await page.getByRole('button', { name: 'Create department' }).click();
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.create.noMatch');
    await page.getByRole('button', { name: 'Try creating again' }).click();
    await expectStatus(page, 'confirmed.create', { name: 'Legal', slug: 'legal' });
    expect(api.posts()).toHaveLength(2);
  });

  test('a late-committed create that the recheck sees as a matching row never triggers a retry', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.next('POST', { commit: true, abort: true }); // the write landed, the response was lost
    await page.getByRole('button', { name: 'Create department' }).click();
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.create.matchingRow');
    await page.waitForTimeout(400);
    expect(api.posts()).toHaveLength(1);
  });

  test('Cancel closes without a request, discards input and restores focus to New department', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Draft', 'draft');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('form.dept-form')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New department' })).toBeFocused();
    await page.getByRole('button', { name: 'New department' }).click();
    await expect(page.getByLabel(/^Name/)).toHaveValue('');
    expect(api.posts()).toHaveLength(0);
  });

  test('keyboard-only creation works end to end (DM-32)', async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    api.configure();
    await openDepartments(page);
    await page.getByRole('button', { name: 'New department' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(/^Name/)).toBeFocused();
    await page.keyboard.type('Finance');
    await page.keyboard.press('Tab');
    await page.keyboard.type('finance');
    await page.keyboard.press('Enter');
    await expectStatus(page, 'confirmed.create', { name: 'Finance', slug: 'finance' });
    expect(api.posts()).toHaveLength(1);
  });
});

test.describe('Rename department', () => {
  test('pre-fills, sends the full {slug, name} pair, preserves the id and reflects the re-read (DM-15)', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await expect(page.getByLabel(/^Name/)).toHaveValue('Engineering');
    await expect(page.getByLabel(/^Slug/)).toHaveValue('engineering');
    await expect(
      page.getByText(
        'Edits are saved as typed. If this department was changed elsewhere, your change replaces it.',
      ),
    ).toBeVisible();
    await page.getByLabel(/^Name/).fill('Platform');
    await save(page).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Platform', slug: 'engineering' });
    await expect(row(page, 'Platform')).toBeVisible();
    expect(api.patches()).toHaveLength(1);
    const [patch] = api.patches();
    expect(patch?.path).toBe('/api/v1/departments/dep_eng');
    expect(patch?.body).toEqual({ slug: 'engineering', name: 'Platform' });
    expect(patch?.csrf).toBe('csrf-fixture');
    await expect(
      row(page, 'Platform').getByRole('button', { name: 'Rename Platform' }),
    ).toBeFocused();
    expect(await keysOnScreen(page)).toEqual(['confirmed.rename']);
  });

  test('unchanged values send no request', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('  Engineering ');
    await save(page).click();
    await expect(page.getByText('No changes to save.')).toBeVisible();
    expect(api.patches()).toHaveLength(0);
  });

  test('changing only the slug still sends both fields', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Research');
    await page.getByLabel(/^Slug/).fill('r-and-d');
    await save(page).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Research', slug: 'r-and-d' });
    expect(api.patches()[0]?.body).toEqual({ slug: 'r-and-d', name: 'Research' });
  });

  test('client validation applies to rename', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Slug/).fill('Bad Slug');
    await save(page).click();
    await expect(
      page
        .locator('.dept-field-error')
        .filter({ hasText: 'Use lowercase letters, numbers and single hyphens.' }),
    ).toBeVisible();
    expect(api.patches()).toHaveLength(0);
  });

  test('Cancel closes the form without a request and restores focus to Rename', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      row(page, 'Engineering').getByRole('button', { name: 'Rename Engineering' }),
    ).toBeFocused();
    expect(api.patches()).toHaveLength(0);
  });

  test('DM-18: a concurrent change is overwritten without any conflict claim', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    api.replace(dept('dep_eng', 'engineering', 'Changed Elsewhere', { updatedAt: later }));
    await page.getByLabel(/^Name/).fill('Mine');
    await save(page).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Mine', slug: 'engineering' });
    await expect(row(page, 'Mine')).toBeVisible();
    await expect(page.getByText(/conflict|changed elsewhere/i)).toHaveCount(0);
  });

  test('RM-15a: another department holds the slug -> slug field error from the read-back', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Slug/).fill('research');
    await save(page).click();
    await expectField(page, 'rejected.rename.conflictOtherSlug');
    await expect(page.getByLabel(/^Slug/)).toBeFocused();
    await expect(page.getByLabel(/^Name/)).toHaveValue('Engineering');
    const recheck = api.lists(true);
    expect(recheck).toHaveLength(1);
    expect(api.patches()).toHaveLength(1);
  });

  test('RM-15b: the department turned out archived -> archived observation, form closes', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    // The 409 is what an archived row returns; the read-back then shows it archived.
    api.next('PATCH', {
      before: () =>
        api.replace(dept('dep_eng', 'engineering', 'Engineering', { archivedAt: later })),
    });
    await save(page).click();
    await expectStatus(page, 'rejected.rename.archived');
    await expect(page.locator('form.dept-form')).toHaveCount(0);
    expect(await keysOnScreen(page)).toEqual(['rejected.rename.archived']);
    await expect(page.locator('.dept-field-error')).toHaveCount(0);
  });

  test('RM-15c: active and no other department has the slug -> inconclusive, no field error, form kept', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    api.next('PATCH', { status: 409, code: 'conflict', message: 'Slug is already used.' });
    await save(page).click();
    await expectStatus(page, 'rejected.rename.inconclusive');
    await expect(page.locator('.dept-field-error')).toHaveCount(0);
    await expect(page.getByLabel(/^Name/)).toHaveValue('Platform');
    expect(await keysOnScreen(page)).toEqual(['rejected.rename.inconclusive']);
  });

  test('RM-15d: a failed read-back gives the neutral message with no field error and Check again works', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    api.next('PATCH', { status: 409, code: 'conflict', message: 'Slug is already used.' });
    api.next('GET', { status: 503 });
    await save(page).click();
    await expectStatus(page, 'rejected.rename.readbackFailed');
    await expect(page.locator('.dept-field-error')).toHaveCount(0);
    await page.getByRole('button', { name: 'Check again' }).click();
    await expectStatus(page, 'rejected.rename.inconclusive');
    expect(api.patches()).toHaveLength(1);
  });

  test('RM-15e: the department is absent from the read-back -> unresolved with no field error', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    api.next('PATCH', { status: 409, code: 'conflict', message: 'x', before: () => undefined });
    api.next('GET', {
      before: () => api.replace(dept('dep_zzz', 'zzz', 'Zzz')),
      body: { departments: [], total: 0 },
    });
    await save(page).click();
    await expectStatus(page, 'rejected.rename.absent');
    await expect(page.locator('.dept-field-error')).toHaveCount(0);
  });

  test('the 409 diagnosis never depends on the error code or message', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    // A misleading code and message: the read-back still decides.
    api.next('PATCH', {
      status: 409,
      code: 'invalid_transition',
      message: 'Department is archived.',
    });
    await save(page).click();
    await expectStatus(page, 'rejected.rename.inconclusive');
  });

  test('404 shows that the server reports the department does not exist and refreshes the list', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    api.next('PATCH', { status: 404, code: 'not_found', message: 'Department not found.' });
    const before = api.lists().length;
    await save(page).click();
    await expectStatus(page, 'rejected.rename.notFound');
    await expect.poll(() => api.lists().length).toBe(before + 1);
    await expect(page.locator('form.dept-form')).toHaveCount(0);
  });

  test('422 shows the form-level rejection; 403 refreshes the token and a manual retry succeeds', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    api.next('PATCH', {
      status: 422,
      code: 'invalid_input',
      message: 'Department update is invalid.',
    });
    await save(page).click();
    await expectMessage(page.locator('.dept-summary'), 'rejected.rename.invalidInput');
    api.rotateCsrf();
    await save(page).click();
    await expectMessage(page.locator('.dept-summary'), 'rejected.rename.csrf');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Platform', slug: 'engineering' });
    expect(api.patches().map((entry) => entry.csrf)).toEqual([
      'csrf-fixture',
      'csrf-fixture',
      'csrf-rotated',
    ]);
  });

  test('RM-02: confirmed 200 followed by a failed refresh keeps the confirmation and marks the list stale', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    api.failLists({ status: 503 });
    await save(page).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Platform', slug: 'engineering' });
    await expectMessage(page.getByRole('alert'), 'confirmed.listStale');
    await expect(list(page)).toHaveCount(0);
    api.failLists(null);
    await page.getByRole('button', { name: 'Refresh list' }).click();
    await expect(row(page, 'Platform')).toBeVisible();
    expect(api.patches()).toHaveLength(1);
  });

  const unknownRename: Array<[string, Step]> = [
    ['503', { status: 503, code: 'department_outcome_unknown', message: 'Read first.' }],
    ['network drop', { abort: true }],
    ['invalid 2xx', { body: { nope: 1 } }],
    ['mismatching 2xx', { body: dept('dep_eng', 'engineering', 'Not what you asked') }],
  ];
  for (const [label, step] of unknownRename) {
    test(`unknown rename outcome (${label}): no claim, no overwrite, one PATCH (RM-22)`, async ({
      page,
      api,
    }) => {
      api.configure();
      await openDepartments(page);
      await startRename(page, 'Engineering');
      await page.getByLabel(/^Name/).fill('Platform');
      api.next('PATCH', step);
      await save(page).click();
      await expectStatus(page, 'unknown.rename.outcome');
      expect(await keysOnScreen(page)).toEqual(['unknown.rename.outcome']);
      await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
      await expect(
        row(page, 'Research').getByRole('button', { name: 'Rename Research' }),
      ).toBeEnabled();
      await page.waitForTimeout(400);
      expect(api.patches()).toHaveLength(1);
    });
  }

  async function unknownRenameThenCheck(
    page: Page,
    api: ReturnType<typeof createApi>,
    patchStep: Step = { status: 503, code: 'department_outcome_unknown', message: 'Read first.' },
  ) {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    await page.getByLabel(/^Slug/).fill('platform');
    api.next('PATCH', patchStep);
    await save(page).click();
    await expectStatus(page, 'unknown.rename.outcome');
  }

  test('RM-09: a failed recheck leaves the row unresolved and other rows usable', async ({
    page,
    api,
  }) => {
    await unknownRenameThenCheck(page, api);
    api.next('GET', { status: 503 });
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.rename.recheckFailed');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      row(page, 'Engineering').getByRole('button', { name: 'Rename Engineering' }),
    ).toBeDisabled();
    await expect(
      row(page, 'Research').getByRole('button', { name: 'Rename Research' }),
    ).toBeEnabled();
    await expectStatus(page, 'unknown.rename.recheckFailed');
    await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });

  test('RM-10: the department id absent from the recheck is unresolved with no field error', async ({
    page,
    api,
  }) => {
    await unknownRenameThenCheck(page, api);
    api.next('GET', { body: { departments: [], total: 0 } });
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.rename.absent');
    await expect(page.locator('.dept-field-error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  });

  test('RM-11: requested values present are an observation only and never "Renamed"; the form closes', async ({
    page,
    api,
  }) => {
    await unknownRenameThenCheck(page, api, { commit: true, abort: true });
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.rename.requestedValues', {
      name: 'Platform',
      slug: 'platform',
    });
    expect(await keysOnScreen(page)).toEqual(['unknown.rename.requestedValues']);
    await expect(page.locator('form.dept-form')).toHaveCount(0);
    await expect(row(page, 'Platform')).toBeVisible();
    expect(api.patches()).toHaveLength(1);
  });

  test('RM-12: earlier values still present is hedged uncertainty and only an explicit Try again re-sends', async ({
    page,
    api,
  }) => {
    await unknownRenameThenCheck(page, api, { status: 500 });
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.rename.previousValues');
    await expect(page.getByLabel(/^Name/)).toHaveValue('Platform');
    expect(api.patches()).toHaveLength(1);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Platform', slug: 'platform' });
    expect(api.patches()).toHaveLength(2);
  });

  test('RM-13: a concurrent third value shows the current values and nothing is overwritten without Edit current values', async ({
    page,
    api,
  }) => {
    await unknownRenameThenCheck(page, api);
    api.replace(dept('dep_eng', 'third', 'Third Name', { updatedAt: later }));
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.rename.otherValues', { name: 'Third Name', slug: 'third' });
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(api.patches()).toHaveLength(1);
    await page.getByRole('button', { name: 'Edit current values' }).click();
    await expect(page.getByLabel(/^Name/)).toHaveValue('Third Name');
    await expect(page.getByLabel(/^Slug/)).toHaveValue('third');
    expect(api.patches()).toHaveLength(1);
  });

  test('RM-13b: a partial match (name matches, slug differs) is treated as other values', async ({
    page,
    api,
  }) => {
    await unknownRenameThenCheck(page, api);
    api.replace(dept('dep_eng', 'engineering', 'Platform', { updatedAt: later }));
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.rename.otherValues', {
      name: 'Platform',
      slug: 'engineering',
    });
  });

  test('RM-14: a department that appears archived is an observation; the form closes', async ({
    page,
    api,
  }) => {
    await unknownRenameThenCheck(page, api);
    api.replace(dept('dep_eng', 'engineering', 'Engineering', { archivedAt: later }));
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.rename.archived');
    await expect(page.locator('form.dept-form')).toHaveCount(0);
    expect(await keysOnScreen(page)).toEqual(['unknown.rename.archived']);
  });

  test('only one mutation is in flight: other rows cannot be renamed while a rename is pending', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    api.next('PATCH', { delayMs: 500 });
    await save(page).click();
    await expect(
      row(page, 'Research').getByRole('button', { name: 'Rename Research' }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New department' })).toBeDisabled();
    await expectStatus(page, 'confirmed.rename', { name: 'Platform', slug: 'engineering' });
  });

  test('keyboard-only rename works end to end', async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    api.configure();
    await openDepartments(page);
    await row(page, 'Research').getByRole('button', { name: 'Rename Research' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByLabel(/^Name/)).toBeFocused();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('R and D');
    await page.keyboard.press('Enter');
    await expectStatus(page, 'confirmed.rename', { name: 'R and D', slug: 'research' });
  });
});

test.describe('Recovery retry sends exactly what is shown (stale-payload regression)', () => {
  async function unknownCreate(page: Page, api: ReturnType<typeof createApi>) {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Alpha', 'alpha');
    api.next('POST', { status: 503, code: 'department_outcome_unknown', message: 'Read first.' });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'unknown.create.outcome');
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.create.noMatch');
  }

  async function unknownRename(page: Page, api: ReturnType<typeof createApi>) {
    api.configure();
    await openDepartments(page);
    await startRename(page, 'Engineering');
    await page.getByLabel(/^Name/).fill('Platform');
    await page.getByLabel(/^Slug/).fill('platform');
    api.next('PATCH', { status: 500 });
    await save(page).click();
    await expectStatus(page, 'unknown.rename.outcome');
    await page.getByRole('button', { name: 'Check departments' }).click();
    await expectStatus(page, 'unknown.rename.previousValues');
  }

  test('create: the saved operation is frozen, shown, and Try creating again sends Alpha', async ({
    page,
    api,
  }) => {
    await unknownCreate(page, api);
    await expect(page.getByLabel(/^Name/)).toHaveAttribute('readonly', '');
    await expect(page.getByLabel(/^Slug/)).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Create department' })).toBeDisabled();
    await expect(page.locator('.dept-recovery')).toContainText(
      'Try creating again will send: name Alpha, slug alpha.',
    );
    // Typing into the frozen fields changes nothing.
    await page.getByLabel(/^Name/).focus();
    await page.keyboard.type('Beta');
    await expect(page.getByLabel(/^Name/)).toHaveValue('Alpha');
    await page.getByRole('button', { name: 'Try creating again' }).click();
    await expectStatus(page, 'confirmed.create', { name: 'Alpha', slug: 'alpha' });
    expect(api.posts().map((entry) => entry.body)).toEqual([
      { slug: 'alpha', name: 'Alpha' },
      { slug: 'alpha', name: 'Alpha' },
    ]);
  });

  test('create: Edit values instead is an explicit new request that sends the visible Beta values', async ({
    page,
    api,
  }) => {
    await unknownCreate(page, api);
    await page.getByRole('button', { name: 'Edit values instead' }).click();
    await expectStatus(page, 'unknown.create.newRequest');
    expect(await keysOnScreen(page)).toEqual(['unknown.create.newRequest']);
    await expect(page.getByLabel(/^Name/)).not.toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Try creating again' })).toHaveCount(0);
    // The new values are validated like any new submission and no request is sent for bad input.
    await fillForm(page, 'Beta', 'BETA');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expect(page.locator('.dept-summary')).toBeFocused();
    expect(api.posts()).toHaveLength(1);
    await fillForm(page, 'Beta', 'beta');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'confirmed.create', { name: 'Beta', slug: 'beta' });
    expect(api.posts().map((entry) => entry.body)).toEqual([
      { slug: 'alpha', name: 'Alpha' },
      { slug: 'beta', name: 'Beta' },
    ]);
  });

  test('rename: the saved operation is frozen, shown, and Try again sends the full Platform pair', async ({
    page,
    api,
  }) => {
    await unknownRename(page, api);
    await expect(page.getByLabel(/^Name/)).toHaveAttribute('readonly', '');
    await expect(page.getByLabel(/^Slug/)).toHaveAttribute('readonly', '');
    await expect(save(page)).toBeDisabled();
    await expect(page.locator('.dept-recovery')).toContainText(
      'Try again will send: name Platform, slug platform.',
    );
    await page.getByLabel(/^Slug/).focus();
    await page.keyboard.type('other');
    await expect(page.getByLabel(/^Slug/)).toHaveValue('platform');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Platform', slug: 'platform' });
    expect(api.patches().map((entry) => entry.body)).toEqual([
      { slug: 'platform', name: 'Platform' },
      { slug: 'platform', name: 'Platform' },
    ]);
  });

  test('rename: Edit values instead sends the visible values as a new, validated request', async ({
    page,
    api,
  }) => {
    await unknownRename(page, api);
    await page.getByRole('button', { name: 'Edit values instead' }).click();
    await expectStatus(page, 'unknown.rename.newRequest');
    await page.getByLabel(/^Name/).fill('Core');
    await page.getByLabel(/^Slug/).fill('Bad Slug');
    await save(page).click();
    await expect(page.locator('.dept-summary')).toBeFocused();
    expect(api.patches()).toHaveLength(1);
    await page.getByLabel(/^Slug/).fill('core');
    await save(page).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Core', slug: 'core' });
    expect(api.patches().map((entry) => entry.body)).toEqual([
      { slug: 'platform', name: 'Platform' },
      { slug: 'core', name: 'Core' },
    ]);
  });

  test('no hidden replay: editing, rechecking, focus changes and waiting never send the saved operation', async ({
    page,
    api,
  }) => {
    await unknownCreate(page, api);
    await page.getByRole('button', { name: 'Check again' }).click();
    await expectStatus(page, 'unknown.create.noMatch');
    await page.getByLabel(/^Name/).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: 'Edit values instead' }).click();
    await fillForm(page, 'Gamma', 'gamma');
    await page.getByLabel(/^Slug/).blur();
    await page.waitForTimeout(700);
    expect(api.posts()).toHaveLength(1);
  });

  test('recovery exit: Edit values instead then Cancel leaves a clean new flow without resubmitting', async ({
    page,
    api,
  }) => {
    await unknownCreate(page, api);
    await page.getByRole('button', { name: 'Edit values instead' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('form.dept-form')).toHaveCount(0);
    await page.getByRole('button', { name: 'New department' }).click();
    await expect(page.getByLabel(/^Name/)).toHaveValue('');
    await expect(page.getByLabel(/^Name/)).not.toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Try creating again' })).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(api.posts()).toHaveLength(1);
  });

  test('rename: closing the frozen form keeps the banner, and Try again still sends the displayed operation', async ({
    page,
    api,
  }) => {
    await unknownRename(page, api);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.dept-recovery')).toContainText(
      'Try again will send: name Platform, slug platform.',
    );
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectStatus(page, 'confirmed.rename', { name: 'Platform', slug: 'platform' });
    expect(api.patches().map((entry) => entry.body)).toEqual([
      { slug: 'platform', name: 'Platform' },
      { slug: 'platform', name: 'Platform' },
    ]);
  });

  test('a rapid double click and Enter on Try creating again send exactly one more POST', async ({
    page,
    api,
  }) => {
    await unknownCreate(page, api);
    api.next('POST', { delayMs: 500 });
    await page.getByRole('button', { name: 'Try creating again' }).dblclick();
    await expectStatus(page, 'confirmed.create', { name: 'Alpha', slug: 'alpha' });
    expect(api.posts()).toHaveLength(2);
  });
});

test.describe('Responsive, reflow and accessibility', () => {
  const longName = 'N'.repeat(120);
  const longSlug = 'long-slug-' + 'a'.repeat(70);

  for (const size of widths) {
    test(`no horizontal overflow with 120-character names and 80-character slugs at ${size.name}`, async ({
      page,
      api,
    }) => {
      api.configure({ departments: [dept('dep_long', longSlug, longName), engineering] });
      await page.setViewportSize({ width: size.width, height: size.height });
      await openDepartments(page);
      await expect(row(page, longName)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.getByRole('button', { name: 'New department' }).click();
      await fillForm(page, longName, longSlug);
      await page.getByRole('button', { name: 'Create department' }).click();
      await expectNoHorizontalOverflow(page);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: /^Rename N/ }).click();
      await expectNoHorizontalOverflow(page);
      await page.getByLabel(/^Slug/).fill('BAD');
      await save(page).click();
      await expect(page.locator('.dept-summary')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      if (size.width <= 820) {
        for (const button of await page
          .locator('form.dept-form button, .dept-actions button')
          .all()) {
          const box = await button.boundingBox();
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
        }
      }
    });
  }

  test('primary navigation destinations stay reachable at 320px, inline or through the menu', async ({
    page,
    api,
  }) => {
    api.configure();
    await page.setViewportSize({ width: 320, height: 640 });
    await openDepartments(page);
    await expectNoHorizontalOverflow(page);
    // Two legitimate layouts: inline links when they fit, or a disclosure menu when they do not
    // (the shared shell collapses its navigation). Either way every destination must be present,
    // visible and fully inside the viewport; a missing or clipped link fails here.
    const menu = page.getByRole('button', { name: 'Navigation menu' });
    if (await menu.isVisible()) {
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await menu.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
    }
    const primary = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(primary.getByRole('link')).toHaveCount(4);
    for (const name of ['Command Center', 'Tasks', 'Runs', 'Agents']) {
      const link = primary.getByRole('link', { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toBeInViewport({ ratio: 1 });
    }
  });

  for (const size of [widths[0]!, widths[2]!, widths[4]!]) {
    test(`axe finds no serious violations on list, empty, error and forms at ${size.name}`, async ({
      page,
      api,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      api.configure();
      await openDepartments(page, '#departments?archived=1');
      await expect(row(page, 'Retired Unit')).toBeVisible();
      await expectNoSeriousAxeViolations(page);
      await openCreate(page);
      await fillForm(page, '', 'BAD');
      await page.getByRole('button', { name: 'Create department' }).click();
      await expect(page.locator('.dept-summary')).toBeFocused();
      await expectNoSeriousAxeViolations(page);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await startRename(page, 'Engineering');
      await expectNoSeriousAxeViolations(page);
      api.configure({ departments: [] });
      await page.goto('/#departments');
      await page.reload();
      await expect(page.getByText('No active departments.', { exact: false })).toBeVisible();
      await expectNoSeriousAxeViolations(page);
      api.failLists({ status: 503 });
      await page.reload();
      await expect(page.getByText('Departments unavailable')).toBeVisible();
      await expectNoSeriousAxeViolations(page);
    });
  }

  test('axe: unknown-outcome banner and stale-list notice', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    api.next('POST', { status: 500 });
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'unknown.create.outcome');
    await expectNoSeriousAxeViolations(page);
  });

  test('DM-31 (b): a 720x450 CSS viewport at device scale 2 (a density test, not browser zoom)', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 720, height: 450 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const api = createApi(page);
    api.configure({ departments: [dept('dep_long', longSlug, longName), engineering] });
    expect(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])).toEqual([
      720, 450, 2,
    ]);
    await openDepartments(page);
    await expect(row(page, longName)).toBeVisible();
    await expectWorkspaceContained(page);
    await page.getByRole('button', { name: 'New department' }).click();
    await fillForm(page, '', 'BAD');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expect(page.locator('.dept-summary')).toBeFocused();
    await expectWorkspaceContained(page);
    expect(api.unexpected).toEqual([]);
    await context.close();
  });

  test('DM-31 (c): the 320 x 256 WCAG reflow size keeps forms and errors reachable', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 256 } });
    const page = await context.newPage();
    const api = createApi(page);
    api.configure({ departments: [dept('dep_long', longSlug, longName), engineering] });
    await openDepartments(page);
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'New department' }).click();
    await fillForm(page, longName, longSlug);
    await page.getByLabel(/^Slug/).fill('BAD');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectNoHorizontalOverflow(page);
    for (const control of [
      page.getByRole('button', { name: 'Create department' }),
      page.getByRole('button', { name: 'Cancel' }),
    ]) {
      await control.focus();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 320).toBe(true);
    }
    await context.close();
  });

  test('a wide viewport lays the fields out in two columns and a narrow one stacks them', async ({
    page,
    api,
  }) => {
    api.configure();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDepartments(page);
    await openCreate(page);
    const [a, b] = await Promise.all([
      page.getByLabel(/^Name/).boundingBox(),
      page.getByLabel(/^Slug/).boundingBox(),
    ]);
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? 99))).toBeLessThan(4);
    await page.setViewportSize({ width: 390, height: 844 });
    const [c, d] = await Promise.all([
      page.getByLabel(/^Name/).boundingBox(),
      page.getByLabel(/^Slug/).boundingBox(),
    ]);
    expect((d?.y ?? 0) - (c?.y ?? 0)).toBeGreaterThan(20);
  });

  test('focus rings are visible on form controls', async ({ page, api }) => {
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    const width = await page
      .getByLabel(/^Name/)
      .evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(width).toBe('3px');
  });

  test('reduced-motion emulation leaves no animation-dependent state', async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    api.configure();
    await openDepartments(page);
    await openCreate(page);
    await fillForm(page, 'Legal', 'legal');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expectStatus(page, 'confirmed.create', { name: 'Legal', slug: 'legal' });
    const animations = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    );
    expect(animations).toBe(0);
  });

  test('there is exactly one polite status region and failures are announced once', async ({
    page,
    api,
  }) => {
    api.configure();
    await openDepartments(page);
    await expect(row(page, 'Engineering')).toBeVisible();
    await expect(page.locator('.dept-workspace [role="status"]')).toHaveCount(1);
    await openCreate(page);
    await fillForm(page, 'x', 'BAD');
    await page.getByRole('button', { name: 'Create department' }).click();
    await expect(page.locator('.dept-workspace [role="alert"]')).toHaveCount(1);
  });
});

test.describe('16px minimum font size', () => {
  test('DM-31 (d): forms, errors and rows stay readable and unclipped', async () => {
    test.setTimeout(90_000); // five widths in a dedicated browser; slower under parallel load
    // A dedicated browser: launch options cannot be changed inside a describe group.
    const browser = await chromium.launch({ args: ['--blink-settings=minimumFontSize=16'] });
    const page = await browser.newPage();
    const api = createApi(page);
    const longName = 'N'.repeat(120);
    api.configure({
      departments: [dept('dep_long', 'long-' + 'a'.repeat(70), longName), engineering],
    });
    for (const size of widths) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openDepartments(page);
      await expect(row(page, longName)).toBeVisible();
      await expectWorkspaceContained(page);
      if (size.width >= 820) await expectNoHorizontalOverflow(page);
      await page.getByRole('button', { name: 'New department' }).click();
      await fillForm(page, '', 'BAD');
      await page.getByRole('button', { name: 'Create department' }).click();
      await expect(page.locator('.dept-summary')).toBeFocused();
      await expectWorkspaceContained(page);
      const clipped = await page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '.dept-form label, .dept-field-error, .agents-help, .dept-summary',
            ),
          ].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
      );
      expect(clipped).toBe(0);
      const minimum = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.cssText = 'font-size:11px;position:absolute;visibility:hidden';
        probe.textContent = 'Probe text for width';
        document.body.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });
      // An 11px run measured 153 CSS px by default and 215 with the setting (spec 12.8).
      expect(minimum).toBeGreaterThan(70);
      await page.reload();
    }
    // Drain before closing. The loop ends with a reload, so a list request and its fixture callback
    // may still be in flight: wait for the final list to render, then for every route handler to
    // finish, so no fixture callback can run against a closed browser.
    await expect(row(page, longName)).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' });
    expect(api.unexpected).toEqual([]);
    await browser.close();
  });
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page, type Route } from '@playwright/test';
import {
  AgentDirectoryResponseSchema,
  AgentProfileDraftResponseSchema,
  AgentProfileResponseSchema,
  AgentProfileVersionResponseSchema,
  AgentProfileVersionsResponseSchema,
  AgentSummarySchema,
  type AgentProfileVersion,
  type AgentProfileWriteInput,
  type AgentSummary,
} from '@omnis/contracts';

/**
 * Browser tests for the Agents & Profiles screens. Every response is a strictly
 * contract-parsed synthetic fixture; nothing here exercises the real backend or real agents.
 */

const stamp = '2026-11-03T10:00:00.000Z';
const later = '2026-11-04T08:30:00.000Z';

type Fixture = {
  summary: AgentSummary;
  versions: AgentProfileVersion[]; // ascending by versionNo
};

const department = (id: string, name: string) => ({ id, slug: id, name });
const engineering = department('dept-eng', 'Engineering');
const research = department('dept-res', 'Research');

function version(
  agentId: string,
  versionNo: number,
  overrides: Partial<AgentProfileVersion> = {},
): AgentProfileVersion {
  return {
    versionId: `ver-${agentId}-${versionNo}`,
    agentId,
    versionNo,
    profession: 'Systems Architect',
    seniority: 'Senior',
    specialties: ['Distributed systems', 'Capacity planning'],
    personality: {
      traits: ['Methodical', 'Direct'],
      tone: 'Calm and precise',
      principles: ['Explain trade-offs before recommending'],
    },
    behavior: {
      autonomy: 'Proposes; never acts without approval',
      escalation: 'Escalate unknowns',
    },
    instructions: `Instructions for ${agentId} v${versionNo}.\nSecond line.`,
    createdBy: { id: 'owner', displayName: 'Director' },
    createdAt: new Date(Date.parse(stamp) + versionNo * 3_600_000).toISOString(),
    ...overrides,
  };
}

function agent(
  id: string,
  name: string,
  options: {
    lifecycle?: AgentSummary['lifecycle'];
    department?: AgentSummary['department'];
    versionCount?: number;
    provenance?: AgentSummary['provenance'];
    versionOverrides?: (versionNo: number) => Partial<AgentProfileVersion>;
  } = {},
): Fixture {
  const lifecycle = options.lifecycle ?? 'available';
  const count = lifecycle === 'draft' ? 0 : (options.versionCount ?? 1);
  const versions = Array.from({ length: count }, (_, index) =>
    version(id, index + 1, options.versionOverrides?.(index + 1) ?? {}),
  );
  const current = versions[versions.length - 1];
  return {
    summary: AgentSummarySchema.parse({
      id,
      name,
      slug: id.replace(/^agent-/, ''),
      department: options.department === undefined ? engineering : options.department,
      lifecycle,
      archivedAt: lifecycle === 'archived' ? later : null,
      currentVersion: current
        ? {
            versionNo: current.versionNo,
            profession: current.profession,
            seniority: current.seniority,
          }
        : null,
      provenance: options.provenance ?? 'owner_created',
      createdAt: stamp,
      updatedAt: later,
    }),
    versions,
  };
}

const atlas = agent('agent-atlas', 'Atlas', { versionCount: 3 });
const mira = agent('agent-mira', 'Mira Vale', {
  department: research,
  versionOverrides: () => ({ profession: 'Research Analyst', seniority: null }),
});
const draft = agent('agent-draft', 'Nova Draft', { lifecycle: 'draft', department: null });
const archived = agent('agent-old', 'Old Timer', { lifecycle: 'archived', versionCount: 2 });
const defaultFixtures = [atlas, mira, draft, archived];

function cloneFixture(source: Fixture): Fixture {
  return {
    summary: structuredClone(source.summary),
    versions: source.versions.map((item) => structuredClone(item)),
  };
}

type Options = {
  agents?: Fixture[];
  directoryStatus?: number;
  directoryFailures?: number;
  directoryBody?: unknown;
  pageSize?: number;
  historyFailures?: number; // first-page failures
  historyFailAfterFirst?: boolean;
  historyChangeTotal?: boolean;
  versionBody?: (agentId: string, versionNo: number) => unknown;
  profileBody?: (agentId: string) => unknown;
  signedOut?: boolean;
  createResponseLosses?: number;
  createReceiptMismatches?: number;
  createRetryUnauthorized?: number;
  mutationResponseLosses?: number;
  profileConflict?: boolean;
  archiveResponseLosses?: number;
  archiveNoApplyResponseLosses?: number;
};

function createApi(page: Page) {
  let options: Options = {};
  let fixtures = defaultFixtures;
  let historyFailures = 0;
  let createResponseLosses = 0;
  let createReceiptMismatches = 0;
  let createRetryUnauthorized = 0;
  let mutationResponseLosses = 0;
  let archiveResponseLosses = 0;
  let archiveNoApplyResponseLosses = 0;
  const drafts = new Map<
    string,
    { revision: number; baseVersionNo: number | null; profile: AgentProfileWriteInput | null }
  >();
  const requests: Array<{ method: string; path: string; search: string }> = [];
  const createRequests: Array<{ body: unknown; key: string | undefined }> = [];
  const createReceipts = new Map<string, Record<string, unknown>>();
  const mutationRequests: Array<{
    method: string;
    path: string;
    body: unknown;
    key: string | undefined;
  }> = [];
  const archiveRequests: Array<{
    path: string;
    key: string | undefined;
    csrf: string | undefined;
  }> = [];
  const unexpected: string[] = [];

  const error = (route: Route, status: number, code = 'error', message = 'Fixture error.') =>
    route.fulfill({ status, json: { error: { code, message, requestId: 'fixture-request' } } });

  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path, search } = url;
    const method = request.method();
    requests.push({ method, path, search });

    const archiveMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/archive$/);
    if (method === 'POST' && archiveMatch) {
      const agentId = decodeURIComponent(archiveMatch[1]!);
      const key = request.headers()['idempotency-key'];
      const csrf = request.headers()['x-omnis-csrf'];
      archiveRequests.push({ path, key, csrf });
      if (csrf !== 'csrf-fixture' || !key)
        return error(route, 403, 'invalid_csrf', 'Mutation protection failed.');
      const fixture = fixtures.find((item) => item.summary.id === agentId);
      if (!fixture) return error(route, 404, 'not_found', 'Agent not found.');
      if (archiveResponseLosses > 0) {
        archiveResponseLosses -= 1;
        if (archiveNoApplyResponseLosses > 0) {
          archiveNoApplyResponseLosses -= 1;
        } else {
          fixture.summary.lifecycle = 'archived';
          fixture.summary.archivedAt = later;
        }
        return route.abort();
      }
      fixture.summary.lifecycle = 'archived';
      fixture.summary.archivedAt = later;
      return route.fulfill({
        json: {
          requestId: key,
          operation: 'agent.archived',
          agentId,
          lifecycle: 'archived',
          versionId: null,
          versionNo: null,
          draftRevision: 0,
          occurredAt: later,
        },
      });
    }

    if (method === 'POST' && path === '/api/v1/agents') {
      const body = request.postDataJSON() as { name?: string; slug?: string };
      const key = request.headers()['idempotency-key'];
      createRequests.push({ body, key });
      if (request.headers()['x-omnis-csrf'] !== 'csrf-fixture' || !key)
        return error(route, 403, 'invalid_csrf', 'Mutation protection failed.');
      const priorReceipt = createReceipts.get(key);
      if (priorReceipt) return route.fulfill({ status: 201, json: priorReceipt });
      if (createResponseLosses > 0) {
        createResponseLosses -= 1;
        return route.abort();
      }
      if (createRetryUnauthorized > 0) {
        createRetryUnauthorized -= 1;
        return error(route, 401, 'unauthorized', 'Sign in to continue.');
      }
      const created = agent('agent-created', body.name ?? 'New Agent', {
        lifecycle: 'draft',
        department: null,
      });
      created.summary.slug = body.slug ?? 'new-agent';
      fixtures = [...fixtures, created];
      drafts.set(created.summary.id, { revision: 0, baseVersionNo: null, profile: null });
      const receipt = {
        requestId: key,
        operation: 'agent.created',
        agentId: created.summary.id,
        lifecycle: 'draft',
        versionId: null,
        versionNo: null,
        draftRevision: 0,
        occurredAt: later,
      };
      createReceipts.set(key, receipt);
      if (createReceiptMismatches > 0) {
        createReceiptMismatches -= 1;
        return route.fulfill({
          status: 201,
          json: { ...receipt, requestId: '123e4567-e89b-42d3-a456-426614174000' },
        });
      }
      return route.fulfill({
        status: 201,
        json: receipt,
      });
    }

    const draftMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/draft-profile$/);
    const publishMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/publish$/);
    if ((method === 'PUT' && draftMatch) || (method === 'POST' && publishMatch)) {
      const agentId = decodeURIComponent((draftMatch ?? publishMatch)![1]!);
      const key = request.headers()['idempotency-key'];
      const body = request.postDataJSON() as Record<string, unknown>;
      mutationRequests.push({ method, path, body, key });
      if (request.headers()['x-omnis-csrf'] !== 'csrf-fixture' || !key)
        return error(route, 403, 'invalid_csrf', 'Mutation protection failed.');
      if (method === 'PUT' && options.profileConflict)
        return error(route, 409, 'profile_conflict', 'The profile changed. Reload before saving.');
      if (mutationResponseLosses > 0) {
        mutationResponseLosses -= 1;
        return route.abort();
      }
      const fixture = fixtures.find((item) => item.summary.id === agentId);
      if (!fixture) return error(route, 404, 'not_found', 'Agent not found.');
      const previous = drafts.get(agentId) ?? {
        revision: 0,
        baseVersionNo: null,
        profile: null,
      };
      if (method === 'PUT') {
        const next = {
          revision: previous.revision + 1,
          baseVersionNo: body.baseVersionNo as number | null,
          profile: body.profile as AgentProfileWriteInput,
        };
        drafts.set(agentId, next);
        return route.fulfill({
          json: {
            requestId: key,
            operation: 'profile.draft_saved',
            agentId,
            lifecycle: fixture.summary.lifecycle,
            versionId: null,
            versionNo: null,
            draftRevision: next.revision,
            occurredAt: later,
          },
        });
      }
      const nextVersionNo = (fixture.versions.at(-1)?.versionNo ?? 0) + 1;
      const published = version(agentId, nextVersionNo, {
        ...previous.profile!,
        createdAt: later,
      });
      fixture.versions.push(published);
      fixture.summary.lifecycle = 'available';
      fixture.summary.currentVersion = {
        versionNo: nextVersionNo,
        profession: published.profession,
        seniority: published.seniority,
      };
      drafts.delete(agentId);
      return route.fulfill({
        json: {
          requestId: key,
          operation: 'profile.published',
          agentId,
          lifecycle: 'available',
          versionId: published.versionId,
          versionNo: nextVersionNo,
          draftRevision: previous.revision,
          occurredAt: later,
        },
      });
    }

    if (path === '/api/v1/auth/csrf') return route.fulfill({ json: { csrfToken: 'csrf-fixture' } });
    if (path === '/api/v1/me')
      return options.signedOut
        ? error(route, 401, 'unauthorized', 'Sign in to continue.')
        : route.fulfill({ json: { id: 'owner', displayName: 'Director' } });
    if (path === '/api/v1/tasks') return route.fulfill({ json: [] });
    if (path === '/api/v1/runs') return route.fulfill({ json: [] });
    if (method !== 'GET' || !path.startsWith('/api/v1/agents')) {
      unexpected.push(`${method} ${path}`);
      return error(route, 500, 'fixture_contract_violation', `Unexpected ${method} ${path}`);
    }

    const parts = path.split('/').slice(4); // after /api/v1/agents
    // The real directory, profile and version routes reject any query string with 422.
    if (parts.length !== 2 && search && !(parts[1] === 'versions' && parts.length === 2)) {
      if (parts.length === 0 || parts.length === 1 || parts.length === 3)
        return error(route, 422, 'invalid_input', 'Query parameters are invalid.');
    }

    if (parts.length === 0) {
      if (options.directoryFailures) {
        return error(route, 503, 'agents_unavailable', 'Agents are temporarily unavailable.');
      }
      if (options.directoryStatus)
        return error(route, options.directoryStatus, 'agents_error', 'Directory error.');
      if (options.directoryBody !== undefined)
        return route.fulfill({ json: options.directoryBody });
      const agents = fixtures.map((item) => item.summary);
      return route.fulfill({
        json: AgentDirectoryResponseSchema.parse({
          agents,
          page: { total: agents.length, complete: true, nextCursor: null },
        }),
      });
    }

    const fixture = fixtures.find((item) => item.summary.id === decodeURIComponent(parts[0]!));
    if (!fixture) return error(route, 404, 'not_found', 'Agent not found.');
    const current = fixture.versions[fixture.versions.length - 1] ?? null;

    if (parts[1] === 'draft-profile' && parts.length === 2) {
      const draftState = drafts.get(fixture.summary.id) ?? {
        revision: 0,
        baseVersionNo: null,
        profile: null,
      };
      return route.fulfill({
        json: AgentProfileDraftResponseSchema.parse({
          agentId: fixture.summary.id,
          draftRevision: draftState.revision,
          baseVersionNo: draftState.baseVersionNo,
          profile: draftState.profile,
          updatedAt: draftState.profile ? later : null,
        }),
      });
    }

    if (parts.length === 1 && options.profileBody)
      return route.fulfill({ json: options.profileBody(fixture.summary.id) });
    if (parts.length === 1)
      return route.fulfill({
        json: AgentProfileResponseSchema.parse({ agent: fixture.summary, currentVersion: current }),
      });

    if (parts[1] === 'versions' && parts.length === 3) {
      const versionNo = Number(parts[2]);
      if (options.versionBody)
        return route.fulfill({ json: options.versionBody(fixture.summary.id, versionNo) });
      const found = fixture.versions.find((item) => item.versionNo === versionNo);
      if (!found) return error(route, 404, 'not_found', 'Not found.');
      return route.fulfill({
        json: AgentProfileVersionResponseSchema.parse({
          agent: fixture.summary,
          version: found,
          isCurrent: found.versionNo === current?.versionNo,
        }),
      });
    }

    if (parts[1] === 'versions' && parts.length === 2) {
      const cursor = url.searchParams.get('cursor');
      if (!cursor && historyFailures > 0) {
        return error(route, 503, 'history_unavailable', 'History is temporarily unavailable.');
      }
      if (cursor && options.historyFailAfterFirst)
        return error(route, 503, 'history_unavailable', 'History is temporarily unavailable.');
      const descending = [...fixture.versions].reverse();
      const start = cursor ? Number(cursor.replace('c', '')) : 0;
      const size = Number(url.searchParams.get('limit') ?? options.pageSize ?? 50);
      const slice = descending.slice(start, start + size);
      const next = start + size < descending.length ? `c${start + size}` : null;
      const total =
        options.historyChangeTotal && cursor ? descending.length + 1 : descending.length;
      return route.fulfill({
        json: AgentProfileVersionsResponseSchema.parse({
          agent: fixture.summary,
          versions: slice.map((item) => ({
            versionId: item.versionId,
            versionNo: item.versionNo,
            profession: item.profession,
            seniority: item.seniority,
            createdAt: item.createdAt,
            createdBy: item.createdBy,
            isCurrent: item.versionNo === current?.versionNo,
          })),
          page: { total, complete: next === null, nextCursor: next },
        }),
      });
    }
    unexpected.push(`${method} ${path}`);
    return error(route, 404, 'not_found', 'Not found.');
  };

  void page.route('**/api/v1/**', handle);
  return {
    configure(next: Options = {}) {
      options = { ...next };
      fixtures = (next.agents ?? defaultFixtures).map(cloneFixture);
      historyFailures = next.historyFailures ?? 0;
      createResponseLosses = next.createResponseLosses ?? 0;
      createReceiptMismatches = next.createReceiptMismatches ?? 0;
      createRetryUnauthorized = next.createRetryUnauthorized ?? 0;
      mutationResponseLosses = next.mutationResponseLosses ?? 0;
      archiveResponseLosses = next.archiveResponseLosses ?? 0;
      archiveNoApplyResponseLosses = next.archiveNoApplyResponseLosses ?? 0;
      requests.length = 0;
      createRequests.length = 0;
      createReceipts.clear();
      mutationRequests.length = 0;
      archiveRequests.length = 0;
      drafts.clear();
    },
    requests,
    unexpected,
    createRequests,
    mutationRequests,
    archiveRequests,
    heal() {
      options.directoryFailures = 0;
      delete options.directoryStatus;
      historyFailures = 0;
    },
    count: (predicate: (path: string) => boolean) =>
      requests.filter((entry) => predicate(entry.path)).length,
  };
}

const test = base.extend<{ api: ReturnType<typeof createApi> }>({
  api: async ({ page }, use) => {
    const api = createApi(page);
    await use(api);
    expect(api.unexpected, 'all frontend requests must match the fixture contract').toEqual([]);
  },
});

async function openAgents(page: Page, hash = '#agents') {
  await page.goto(`/${hash}`);
  await expect(page.locator('#main-content')).toBeVisible();
}

const widths = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1000 },
  { name: '390', width: 390, height: 844 },
  { name: '360', width: 360, height: 740 },
  { name: '320', width: 320, height: 640 },
];

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious'),
  ).toEqual([]);
}

const card = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });

test.describe('Agent Directory', () => {
  test('creates a draft identity with an explicit idempotency key and opens its profile', async ({
    page,
    api,
  }) => {
    api.configure({ agents: [] });
    await openAgents(page);
    await page.getByRole('button', { name: 'Create agent' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Orion');
    await page.getByLabel('Slug', { exact: true }).fill('orion-ops');
    await page.getByRole('button', { name: 'Create draft agent' }).click();

    await expect(page.getByRole('heading', { name: 'Orion' })).toBeVisible();
    await expect(page.getByText('No published version yet.').first()).toBeVisible();
    expect(api.createRequests).toHaveLength(1);
    expect(api.createRequests[0]?.key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(api.createRequests[0]?.body).toEqual({
      name: 'Orion',
      slug: 'orion-ops',
      departmentId: null,
    });
  });

  test('an uncertain create can retry only the identical request and key', async ({
    page,
    api,
  }) => {
    api.configure({ agents: [], createResponseLosses: 1 });
    await openAgents(page);
    await page.getByRole('button', { name: 'Create agent' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Orion');
    await page.getByLabel('Slug', { exact: true }).fill('orion-ops');
    await page.getByRole('button', { name: 'Create draft agent' }).click();

    await expect(page.getByText(/create result is unknown/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
    expect(api.createRequests).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry same request' }).click();
    await expect(page.getByRole('heading', { name: 'Orion' })).toBeVisible();
    expect(api.createRequests).toHaveLength(2);
    expect(api.createRequests[1]).toEqual(api.createRequests[0]);
  });

  test('a receipt mismatch is treated as unknown and retries the original idempotent create', async ({
    page,
    api,
  }) => {
    api.configure({ agents: [], createReceiptMismatches: 1 });
    await openAgents(page);
    await page.getByRole('button', { name: 'Create agent' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Orion');
    await page.getByLabel('Slug', { exact: true }).fill('orion-ops');
    await page.getByRole('button', { name: 'Create draft agent' }).click();
    await expect(page.getByText(/create result is unknown/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.getByRole('button', { name: 'Retry same request' }).click();
    await expect(page.getByRole('heading', { name: 'Orion' })).toBeVisible();
    expect(api.createRequests).toHaveLength(2);
    expect(api.createRequests[1]).toEqual(api.createRequests[0]);
    await page.goto('/#agents');
    await expect(page.getByRole('heading', { level: 3, name: 'Orion' })).toHaveCount(1);
  });

  test('an unknown create survives a browser refresh and resumes its exact retry', async ({
    page,
    api,
  }) => {
    api.configure({ agents: [], createResponseLosses: 1 });
    await openAgents(page);
    await page.getByRole('button', { name: 'Create agent' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Orion');
    await page.getByLabel('Slug', { exact: true }).fill('orion-ops');
    await page.getByRole('button', { name: 'Create draft agent' }).click();
    await expect(page.getByText(/create result is unknown/i)).toBeVisible();
    await page.reload();

    await page.getByRole('button', { name: 'Create agent' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Orion');
    await expect(page.getByLabel('Slug', { exact: true })).toHaveValue('orion-ops');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.getByRole('button', { name: 'Retry same request' }).click();
    await expect(page.getByRole('heading', { name: 'Orion' })).toBeVisible();
    expect(api.createRequests).toHaveLength(2);
    expect(api.createRequests[1]).toEqual(api.createRequests[0]);
  });

  test('session expiry preserves an already-unknown create for safe recovery', async ({
    page,
    api,
  }) => {
    api.configure({ agents: [], createResponseLosses: 1, createRetryUnauthorized: 1 });
    await openAgents(page);
    await page.getByRole('button', { name: 'Create agent' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Orion');
    await page.getByLabel('Slug', { exact: true }).fill('orion-ops');
    await page.getByRole('button', { name: 'Create draft agent' }).click();
    await expect(page.getByText(/create result is unknown/i)).toBeVisible();
    await page.getByRole('button', { name: 'Retry same request' }).click();
    await expect(
      page.getByText('Your owner session expired. Sign in again to continue.'),
    ).toBeVisible();
    const pending = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('omnis.agent-create.pending.v1') ?? 'null'),
    );
    expect(pending).toMatchObject({
      input: { name: 'Orion', slug: 'orion-ops', departmentId: null },
    });
    expect(pending.key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(api.createRequests).toHaveLength(2);
    expect(api.createRequests[1]).toEqual(api.createRequests[0]);
  });

  test('lists real API agents with identity, profile status and no runtime claims', async ({
    page,
    api,
  }) => {
    api.configure();
    await openAgents(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Agents & Profiles' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Agent directory' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { level: 3 })).toHaveText([
      'Atlas',
      'Mira Vale',
      'Nova Draft',
    ]);
    const atlasCard = card(page, 'Atlas');
    await expect(atlasCard).toContainText('Systems Architect, Senior');
    await expect(atlasCard).toContainText('Engineering');
    await expect(atlasCard).toContainText('Published');
    await expect(card(page, 'Nova Draft')).toContainText('No published version');
    await expect(card(page, 'Nova Draft')).toContainText('No department');
    await expect(card(page, 'Nova Draft')).toContainText('Draft');
    await expect(page.getByText('Profile status describes the profile record.')).toBeVisible();
    await expect(page.getByText('Showing 3 of 3 agents')).toBeVisible();
    for (const word of ['Online', 'Offline', 'Idle', 'Working', 'Active', 'Available'])
      await expect(page.locator('.agents-workspace').getByText(word, { exact: true })).toHaveCount(
        0,
      );
    // The directory read has no filters in its API query; draft and history reads are separate.
    const directoryRequests = api.requests.filter((entry) => entry.path === '/api/v1/agents');
    expect(directoryRequests.length).toBeGreaterThanOrEqual(1);
    expect(directoryRequests.every((entry) => entry.search === '')).toBe(true);
    expect(
      api.requests
        .filter((entry) => entry.path === '/api/v1/agents')
        .every((entry) => entry.method === 'GET'),
    ).toBe(true);
    expect(api.count((path) => path.includes('/events'))).toBe(0);
  });

  test('a validated empty directory shows the honest empty state', async ({ page, api }) => {
    api.configure({ agents: [] });
    await openAgents(page);
    await expect(page.getByText('No agents yet.')).toBeVisible();
    await expect(
      page.getByText('Create an agent identity, then define its profile.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create agent' })).toBeVisible();
  });

  test('an unavailable API shows an error with Retry, never a fabricated empty directory', async ({
    page,
    api,
  }) => {
    api.configure({ directoryFailures: 1 });
    await openAgents(page);
    await expect(page.getByText('Agents unavailable')).toBeVisible();
    await expect(page.getByText('Agents are temporarily unavailable.')).toBeVisible();
    await expect(page.getByText('No agents yet.')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(0);
    api.heal();
    await page.getByRole('button', { name: 'Retry agents' }).click();
    await expect(page.getByRole('link', { name: 'Atlas', exact: true })).toBeVisible();
  });

  test('403 shows an access message and keeps the session and navigation working', async ({
    page,
    api,
  }) => {
    api.configure({ directoryStatus: 403 });
    await openAgents(page);
    await expect(page.getByText("You don't have access to agents.")).toBeVisible();
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  });

  test('401 uses the existing session-expiry flow and leaves no agent data', async ({
    page,
    api,
  }) => {
    api.configure({ directoryStatus: 401 });
    await openAgents(page);
    await expect(
      page.getByText('Your owner session expired. Sign in again to continue.'),
    ).toBeVisible();
    await expect(page.getByText('Atlas')).toHaveCount(0);
  });

  for (const [name, body] of [
    [
      'duplicate ids',
      (() => {
        const a = atlas.summary;
        return {
          agents: [a, { ...a, slug: 'other' }],
          page: { total: 2, complete: true, nextCursor: null },
        };
      })(),
    ],
    [
      'an incomplete page',
      {
        agents: [atlas.summary],
        page: { total: 2, complete: false, nextCursor: 'next' },
      },
    ],
    [
      'a count that disagrees with total',
      { agents: [atlas.summary], page: { total: 3, complete: true, nextCursor: null } },
    ],
    ['a body that is not the contract', { agents: 'nope' }],
  ] as const) {
    test(`an invalid directory response (${name}) is an unexpected-response error, not empty`, async ({
      page,
      api,
    }) => {
      api.configure({ directoryBody: body });
      await openAgents(page);
      await expect(page.getByText('Omnis OS received an unexpected agent response.')).toBeVisible();
      await expect(page.getByText('No agents yet.')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 3 })).toHaveCount(0);
    });
  }

  test('search, department, no-department and archived filters, with URL state', async ({
    page,
    api,
  }) => {
    api.configure();
    await openAgents(page);
    await expect(card(page, 'Old Timer')).toHaveCount(0);
    await page.getByLabel('Show archived').check();
    await expect(page.getByText('Showing 4 of 4 agents')).toBeVisible();
    await expect(card(page, 'Old Timer')).toContainText('Archived');
    await expect(page).toHaveURL(/#agents\?archived=1$/);

    await page.getByLabel('Search agents').fill('  analyst  ');
    await expect(page.getByText('Showing 1 of 4 agents')).toBeVisible();
    await expect(card(page, 'Mira Vale')).toBeVisible();
    await page.getByLabel('Search agents').fill('eng systems');
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Atlas', 'Old Timer']);

    await page.getByLabel('Search agents').fill('');
    await page.getByLabel('Department').selectOption({ label: 'Research' });
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Mira Vale']);
    await page.getByLabel('Department').selectOption({ label: 'No department' });
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Nova Draft']);
    await expect(page).toHaveURL(/nodept=1/);

    await page.reload();
    await expect(page.getByLabel('Department')).toHaveValue('__none__');
    await expect(page.getByLabel('Show archived')).toBeChecked();
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Nova Draft']);
    // Filtering is local: no request ever carries filter parameters.
    expect(
      api.requests
        .filter((entry) => entry.path === '/api/v1/agents')
        .every((entry) => entry.search === ''),
    ).toBe(true);
  });

  test('no match offers Clear filters and returns focus to search', async ({ page, api }) => {
    api.configure();
    await openAgents(page, '#agents?q=zzz');
    await expect(page.getByText('No agents match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByLabel('Search agents')).toBeFocused();
    await expect(page.getByRole('link', { name: 'Atlas', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#agents$/);
  });

  test('everything archived shows its own state; unknown department is surfaced', async ({
    page,
    api,
  }) => {
    api.configure({ agents: [archived] });
    await openAgents(page);
    await expect(page.getByText('All agents are archived.')).toBeVisible();
    await page.getByLabel('Show archived').check();
    await expect(card(page, 'Old Timer')).toBeVisible();

    api.configure();
    await openAgents(page, '#agents?dept=nope');
    await expect(page.getByLabel('Department')).toHaveValue('__unknown__');
    await expect(page.getByText('No agents match these filters.')).toBeVisible();
  });

  test('demo agents are conspicuously labeled', async ({ page, api }) => {
    api.configure({
      agents: [agent('agent-demo', 'Demo Dana', { provenance: 'demo_seed' })],
    });
    await openAgents(page);
    await expect(card(page, 'Demo Dana')).toContainText('Demo agent (synthetic)');
  });

  test('duplicate display names are distinguishable and navigate by stable id', async ({
    page,
    api,
  }) => {
    const first = agent('agent-atlas-eng', 'Atlas');
    const second = agent('agent-atlas-research', ' atlas ', { department: research });
    api.configure({ agents: [first, second, mira] });
    await openAgents(page);
    const links = page.getByRole('link', { name: /^\s*atlas\s*$/i });
    await expect(links).toHaveCount(2);
    await expect(page.getByText('Slug: atlas-eng')).toBeVisible();
    await expect(page.getByText('Slug: atlas-research')).toBeVisible();
    await expect(page.getByText('Slug: mira')).toHaveCount(0);
    const descriptions = await links.evaluateAll((nodes) =>
      nodes.map((node) => {
        const id = node.getAttribute('aria-describedby') ?? '';
        return document.getElementById(id)?.textContent ?? '';
      }),
    );
    expect(descriptions[0]).not.toBe(descriptions[1]);
    expect(new Set(descriptions).size).toBe(2);
    await page.locator('a[href="#agents/agent-atlas-research"]').click();
    await expect(page).toHaveURL(/#agents\/agent-atlas-research$/);
    await expect(page.getByText('Research', { exact: true }).first()).toBeVisible();
  });

  test('card links are keyboard operable and expose name plus description', async ({
    page,
    api,
  }) => {
    api.configure();
    await openAgents(page);
    const link = page.getByRole('link', { name: 'Atlas', exact: true });
    await expect(link).toHaveAccessibleName('Atlas');
    await expect(link).toHaveAccessibleDescription(
      /Systems Architect, Senior · Engineering · Published/,
    );
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#agents\/agent-atlas$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Atlas' })).toBeFocused();
  });
});

test.describe('Agent Profile', () => {
  test('archiving requires confirmation and reloads the authoritative archived profile', async ({
    page,
    api,
  }) => {
    api.configure();
    await openAgents(page, '#agents/agent-atlas');
    await page.getByRole('button', { name: 'Archive agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive this agent?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Profile history is preserved');
    await expect(dialog).toContainText('There is no restore action.');
    await expectNoSeriousAxeViolations(page);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(api.archiveRequests).toHaveLength(0);

    await page.getByRole('button', { name: 'Archive agent' }).click();
    await page
      .getByRole('dialog', { name: 'Archive this agent?' })
      .getByRole('button', { name: 'Archive agent' })
      .click();
    await expect(page.getByText(/This agent is archived/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive agent' })).toHaveCount(0);
    expect(api.archiveRequests).toHaveLength(1);
    expect(api.archiveRequests[0]).toMatchObject({
      path: '/api/v1/agents/agent-atlas/archive',
      csrf: 'csrf-fixture',
      key: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  test('a lost archive response is reconciled from the persisted profile state', async ({
    page,
    api,
  }) => {
    api.configure({ archiveResponseLosses: 1 });
    await openAgents(page, '#agents/agent-atlas');
    await page.getByRole('button', { name: 'Archive agent' }).click();
    await page
      .getByRole('dialog', { name: 'Archive this agent?' })
      .getByRole('button', { name: 'Archive agent' })
      .click();

    await expect(page.getByText(/This agent is archived/)).toBeVisible();
    expect(api.archiveRequests).toHaveLength(1);
    expect(api.count((path) => path === '/api/v1/agents/agent-atlas')).toBeGreaterThanOrEqual(2);
  });

  test('an unapplied uncertain archive retries with the same idempotency key', async ({
    page,
    api,
  }) => {
    api.configure({ archiveResponseLosses: 1, archiveNoApplyResponseLosses: 1 });
    await openAgents(page, '#agents/agent-atlas');
    await page.getByRole('button', { name: 'Archive agent' }).click();
    await page
      .getByRole('dialog', { name: 'Archive this agent?' })
      .getByRole('button', { name: 'Archive agent' })
      .click();
    await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
    expect(api.archiveRequests).toHaveLength(1);

    await page.getByRole('button', { name: 'Retry same request' }).click();
    await expect(page.getByText(/This agent is archived/)).toBeVisible();
    expect(api.archiveRequests).toHaveLength(2);
    expect(api.archiveRequests[1]?.key).toBe(api.archiveRequests[0]?.key);
  });

  test('a draft agent cannot be archived', async ({ page, api }) => {
    api.configure();
    await openAgents(page, '#agents/agent-draft');
    await expect(page.getByRole('button', { name: 'Archive agent' })).toHaveCount(0);
    expect(api.archiveRequests).toHaveLength(0);
  });

  test('saves a draft and publishes a new immutable profile version', async ({ page, api }) => {
    api.configure();
    await openAgents(page, '#agents/agent-atlas');
    await expect(page.getByRole('heading', { name: 'Profile management' })).toBeVisible();
    await page.getByRole('button', { name: 'Create next draft' }).click();
    const editor = page.locator('.agents-profile-editor');
    await editor.getByLabel('Profession', { exact: true }).fill('Platform Reliability Lead');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(
      page.getByText('The server confirmed that the profile draft was saved.'),
    ).toBeVisible();
    await expect(page.getByText('Draft revision 1')).toBeVisible();
    await page.getByRole('button', { name: 'Publish immutable version' }).click();
    await expect(
      page.getByText('A new immutable profile version was published.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Version 4' })).toHaveCount(2);
    await expect(page.getByText('Platform Reliability Lead', { exact: true })).toBeVisible();
    expect(api.mutationRequests.map(({ method, path, key }) => ({ method, path, key }))).toEqual([
      {
        method: 'PUT',
        path: '/api/v1/agents/agent-atlas/draft-profile',
        key: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      },
      {
        method: 'POST',
        path: '/api/v1/agents/agent-atlas/publish',
        key: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      },
    ]);
  });

  test('an uncertain draft save retries the identical payload and idempotency key', async ({
    page,
    api,
  }) => {
    api.configure({ mutationResponseLosses: 1 });
    await openAgents(page, '#agents/agent-atlas');
    await page.getByRole('button', { name: 'Create next draft' }).click();
    await page
      .locator('.agents-profile-editor')
      .getByLabel('Profession', { exact: true })
      .fill('Platform Reliability Lead');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(/save result is unknown/i)).toBeVisible();
    await page.getByRole('button', { name: 'Retry same request' }).click();
    await expect(
      page.getByText('The server confirmed that the profile draft was saved.'),
    ).toBeVisible();
    expect(api.mutationRequests).toHaveLength(2);
    expect(api.mutationRequests[1]).toEqual(api.mutationRequests[0]);
  });

  test('a stale draft conflict reloads without claiming a profile was published', async ({
    page,
    api,
  }) => {
    api.configure({ profileConflict: true });
    await openAgents(page, '#agents/agent-atlas');
    await page.getByRole('button', { name: 'Create next draft' }).click();
    await page
      .locator('.agents-profile-editor')
      .getByLabel('Profession', { exact: true })
      .fill('Platform Reliability Lead');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(
      page.getByText('The profile changed on the server. The latest profile was reloaded.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText('A new immutable profile version was published.')).toHaveCount(0);
    expect(api.mutationRequests).toHaveLength(1);
  });

  test('renders identity, snapshot sections, safe text and the permissions note', async ({
    page,
    api,
  }) => {
    const hostile = agent('agent-evil', '<img src=x onerror=alert(1)> Eve', {
      versionOverrides: () => ({
        profession: '<b>Boss</b>',
        instructions: '<script>window.__pwned = 1</script>\n[link](javascript:alert(1))\n**bold**',
        specialties: ['<i>x</i>'],
      }),
    });
    api.configure({ agents: [hostile] });
    await openAgents(page, '#agents/agent-evil');
    await expect(page.getByRole('heading', { level: 3, name: 'Identity' })).toBeVisible();
    await expect(page.getByText('<b>Boss</b>').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Instructions (plain text)' })).toContainText(
      '<script>window.__pwned = 1</script>',
    );
    await expect(page.getByRole('region', { name: 'Instructions (plain text)' })).toContainText(
      '**bold**',
    );
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
    await expect(
      page.locator('.agents-workspace img, .agents-workspace script, .agents-workspace b'),
    ).toHaveCount(0);
    await expect(
      page.getByText('A job title or personality does not grant authority.'),
    ).toBeVisible();
    await expect(
      page.getByText("Tool and skill permissions aren't shown in this release."),
    ).toBeVisible();
  });

  test('shows current profile facts, helper text and Manila timestamps', async ({ page, api }) => {
    api.configure();
    await openAgents(page, '#agents/agent-atlas');
    await expect(page.getByRole('heading', { level: 2, name: 'Atlas' })).toBeVisible();
    await expect(page.getByText('This is not a runtime status', { exact: false })).toBeVisible();
    await expect(page.getByText('Calm and precise')).toBeVisible();
    await expect(page.getByText('Distributed systems')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Version 3' }).first()).toHaveAttribute(
      'href',
      '#agents/agent-atlas/v/3',
    );
    await expect(page.getByText('Nov 4, 2026, 4:30 PM', { exact: true }).first()).toBeVisible(); // 08:30Z in Asia/Manila
    await expect(page.getByText('Online', { exact: true })).toHaveCount(0);
  });

  test('a draft shows no published version and an archived agent shows its banner', async ({
    page,
    api,
  }) => {
    api.configure();
    await openAgents(page, '#agents/agent-draft');
    await expect(page.getByText('No published version yet.').first()).toBeVisible();
    await expect(page.getByText('No versions published yet.')).toBeVisible();
    await page.goto('/#agents/agent-old');
    await expect(
      page.getByText(
        "This agent is archived. History is preserved and the agent can't be assigned new work.",
      ),
    ).toBeVisible();
  });

  test('version history pages sequentially and only claims completeness at the end', async ({
    page,
    api,
  }) => {
    const long = agent('agent-long', 'Longhand', { versionCount: 5 });
    api.configure({ agents: [long], pageSize: 2 });
    await openAgents(page, '#agents/agent-long');
    await expect(page.getByText('Showing 2 of 5 versions')).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByText('Showing 4 of 5 versions')).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByText('5 versions', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    const items = page
      .getByRole('list', { name: 'Profile versions, newest first' })
      .getByRole('link');
    await expect(items).toHaveText([
      'Version 5',
      'Version 4',
      'Version 3',
      'Version 2',
      'Version 1',
    ]);
    await expect(page.locator('.agents-badge-current')).toHaveCount(1);
  });

  test('a first-page history failure is inline and never shown as no versions', async ({
    page,
    api,
  }) => {
    api.configure({ historyFailures: 1 });
    await openAgents(page, '#agents/agent-atlas');
    await expect(page.getByText('Version history unavailable')).toBeVisible();
    await expect(page.getByText('No versions published yet.')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Atlas' })).toBeVisible();
    api.heal();
    await page.getByRole('button', { name: 'Retry version history' }).click();
    await expect(page.getByText('3 versions', { exact: true })).toBeVisible();
  });

  test('a later-page failure keeps checked pages and offers Reload', async ({ page, api }) => {
    const long = agent('agent-long', 'Longhand', { versionCount: 5 });
    api.configure({ agents: [long], pageSize: 2, historyFailAfterFirst: true });
    await openAgents(page, '#agents/agent-long');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByText('Showing 2 of 5 versions')).toBeVisible();
    await expect(page.getByText('Version history could not be completed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload history' })).toBeVisible();
    await expect(page.getByText('5 versions', { exact: true })).toHaveCount(0);
  });

  test('a total that changes mid-traversal is reported, not hidden', async ({ page, api }) => {
    const long = agent('agent-long', 'Longhand', { versionCount: 5 });
    api.configure({ agents: [long], pageSize: 2, historyChangeTotal: true });
    await openAgents(page, '#agents/agent-long');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByText('History changed while loading')).toBeVisible();
    await expect(page.getByText('Showing 2 of 5 versions')).toBeVisible();
  });

  test('a contract-valid profile that belongs to a DIFFERENT AGENT is rejected', async ({
    page,
    api,
  }) => {
    // The response for /agents/agent-atlas is agent B's complete, schema-valid profile.
    api.configure({
      profileBody: () =>
        AgentProfileResponseSchema.parse({
          agent: mira.summary,
          currentVersion: mira.versions[mira.versions.length - 1],
        }),
    });
    await openAgents(page, '#agents/agent-atlas');
    await expect(page.getByText('Omnis OS received an unexpected agent response.')).toBeVisible();
    await expect(page.getByText('Agent profile unavailable')).toBeVisible();
    await expect(page.getByText('Mira Vale')).toHaveCount(0);
    await expect(page.getByText('Research Analyst')).toHaveCount(0);
    await expect(page.getByText('Instructions for agent-mira v1.')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3, name: 'Identity' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Agent profile' })).toBeVisible();
  });

  test('an unknown agent shows Agent not found', async ({ page, api }) => {
    api.configure();
    await openAgents(page, '#agents/does-not-exist');
    await expect(page.getByText('Agent not found')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the directory' })).toBeVisible();
  });
});

test.describe('Historical version', () => {
  test('shows an immutable older snapshot, labels as-of-now facts, never substitutes current', async ({
    page,
    api,
  }) => {
    const changing = agent('agent-chg', 'Chameleon', {
      versionCount: 2,
      versionOverrides: (n) => ({
        profession: n === 1 ? 'Junior Scribe' : 'Chief Scribe',
        instructions: n === 1 ? 'Old instructions.' : 'New instructions.',
      }),
    });
    api.configure({ agents: [changing] });
    await openAgents(page, '#agents/agent-chg/v/1');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Chameleon - Version 1' }),
    ).toBeVisible();
    await expect(page.getByText('You are viewing version 1, an immutable snapshot')).toBeVisible();
    await expect(page.getByText('Junior Scribe').first()).toBeVisible();
    await expect(page.getByText('Old instructions.')).toBeVisible();
    await expect(page.getByText('Chief Scribe')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3, name: 'Agent as of now' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View current version' })).toHaveAttribute(
      'href',
      '#agents/agent-chg/v/2',
    );
    await page.getByRole('link', { name: 'View current version' }).click();
    await expect(page.getByText('This is the current version (2).')).toBeVisible();
    await expect(page.getByText('New instructions.')).toBeVisible();
    await expect(page.getByText('Old instructions.')).toHaveCount(0);
  });

  for (const width of [1440, 320]) {
    test(`the back link reads "Back to <name>" with a space at ${width}px`, async ({
      page,
      api,
    }) => {
      api.configure();
      await page.setViewportSize({ width, height: 800 });
      await openAgents(page, '#agents/agent-mira/v/1');
      const back = page.getByRole('link', { name: 'Back to Mira Vale', exact: true });
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute('href', '#agents/agent-mira');
      // textContent cannot see CSS whitespace collapsing (the link is a flex box), so measure the
      // rendered geometry: a visible gap after the arrow and between "Back to" and the name.
      const gaps = await back.evaluate((node) => {
        const label = node.querySelector('.agents-back-label')!;
        const arrow = node.firstElementChild!;
        const name = label.querySelector('.agents-text')!;
        const range = document.createRange();
        // Only the visible words "Back to" (7 characters), not the trailing space.
        range.setStart(label.firstChild!, 0);
        range.setEnd(label.firstChild!, 7);
        const words = range.getBoundingClientRect();
        return {
          afterArrow: label.getBoundingClientRect().left - arrow.getBoundingClientRect().right,
          beforeName: name.getBoundingClientRect().left - words.right,
          label: (label as HTMLElement).innerText,
        };
      });
      expect(gaps.afterArrow).toBeGreaterThanOrEqual(4);
      expect(gaps.beforeName).toBeGreaterThanOrEqual(2);
      expect(gaps.label).toBe('Back to Mira Vale');
      await expectNoHorizontalOverflow(page);
      await back.click();
      await expect(page).toHaveURL(/#agents\/agent-mira$/);
    });
  }

  test('an archived agent keeps its banner on a historical version', async ({ page, api }) => {
    api.configure();
    await openAgents(page, '#agents/agent-old/v/1');
    await expect(page.getByText(/This agent is archived/)).toBeVisible();
  });

  test('a missing version is one generic not-found that does not name the cause', async ({
    page,
    api,
  }) => {
    api.configure();
    await openAgents(page, '#agents/agent-atlas/v/99');
    await expect(page.getByText("We couldn't find this agent version.")).toBeVisible();
    await expect(page.getByText('The agent or this version may not exist.')).toBeVisible();
    await expect(page.getByRole('link', { name: "Open this agent's profile" })).toHaveAttribute(
      'href',
      '#agents/agent-atlas',
    );
    await expect(page.getByText('Atlas', { exact: true })).toHaveCount(0);
    await page.goto('/#agents/ghost/v/1');
    await expect(page.getByText("We couldn't find this agent version.")).toBeVisible();
  });

  test('a response for a different version NUMBER is an unexpected-response error', async ({
    page,
    api,
  }) => {
    api.configure({
      versionBody: () =>
        AgentProfileVersionResponseSchema.parse({
          agent: atlas.summary,
          version: atlas.versions[0],
          isCurrent: false,
        }),
    });
    await openAgents(page, '#agents/agent-atlas/v/2');
    await expect(page.getByText('Omnis OS received an unexpected agent response.')).toBeVisible();
    await expect(page.getByText('Instructions for agent-atlas v1.')).toHaveCount(0);
  });

  test('a contract-valid snapshot that belongs to a DIFFERENT AGENT is rejected', async ({
    page,
    api,
  }) => {
    // Agent B's v2 is fully schema-valid and has the requested version number (2); only the
    // agent identity differs from the route (#agents/agent-atlas/v/2).
    const other = agent('agent-mira', 'Mira Vale', {
      versionCount: 3,
      department: research,
      versionOverrides: (n) => ({ instructions: `Mira private instructions v${n}.` }),
    });
    api.configure({
      versionBody: () =>
        AgentProfileVersionResponseSchema.parse({
          agent: other.summary,
          version: other.versions[1],
          isCurrent: false,
        }),
    });
    await openAgents(page, '#agents/agent-atlas/v/2');
    await expect(page.getByText('Omnis OS received an unexpected agent response.')).toBeVisible();
    await expect(page.getByText('Profile version unavailable')).toBeVisible();
    await expect(page.getByText('Mira Vale')).toHaveCount(0);
    await expect(page.getByText('Mira private instructions v2.')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Version 2/ })).toHaveCount(0);
    // No silent fallback to the requested agent's current profile either.
    await expect(page.getByText('Instructions for agent-atlas v3.')).toHaveCount(0);
    await expect(page.getByText('This is the current version')).toHaveCount(0);
  });
});

test.describe('Routing', () => {
  for (const hash of [
    '#agents/agent-atlas/v/0',
    '#agents/agent-atlas/v/01',
    '#agents/agent-atlas/v/abc',
    '#agents/agent-atlas/v/1/extra',
    '#agents/agent-atlas/v',
    '#agents/agent-atlas/x',
    '#agents/%E0%A4%A',
  ]) {
    test(`malformed route ${hash} shows an invalid-link state and sends no agent request`, async ({
      page,
      api,
    }) => {
      api.configure();
      await openAgents(page, hash);
      await expect(
        page.getByRole('heading', { level: 2, name: "This link isn't valid" }),
      ).toBeVisible();
      expect(api.count((path) => path.startsWith('/api/v1/agents'))).toBe(0);
    });
  }

  test('deep links survive reload and Back/Forward preserves filtered views', async ({
    page,
    api,
  }) => {
    api.configure();
    await openAgents(page, '#agents?q=mira');
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Mira Vale']);
    await page.getByRole('link', { name: 'Mira Vale', exact: true }).click();
    await expect(page).toHaveURL(/#agents\/agent-mira$/);
    await page.reload();
    await expect(page.getByRole('heading', { level: 2, name: 'Mira Vale' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#agents\?q=mira$/);
    await expect(page.getByLabel('Search agents')).toHaveValue('mira');
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Mira Vale']);
    await page.goForward();
    await expect(page.getByRole('heading', { level: 2, name: 'Mira Vale' })).toBeVisible();
    await page.getByRole('link', { name: 'Version 1' }).first().click();
    await expect(page).toHaveURL(/#agents\/agent-mira\/v\/1$/);
    await page.goBack();
    await expect(page).toHaveURL(/#agents\/agent-mira$/);
  });

  test('existing Command Center navigation still works from and to Agents', async ({
    page,
    api,
  }) => {
    api.configure();
    await openAgents(page, '#command-center');
    await page.getByRole('link', { name: 'Agents' }).click();
    await expect(page).toHaveURL(/#agents$/);
    await page.getByRole('link', { name: 'Runs' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await page.getByRole('link', { name: 'Command Center' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
    expect(api.count((path) => path.includes('/events'))).toBe(0);
  });

  for (const hash of ['#agents', '#agents/agent-atlas', '#agents/agent-atlas/v/1']) {
    test(`the skip link keeps ${hash} and focuses main`, async ({ page, api }) => {
      api.configure();
      await openAgents(page, hash);
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('#main-content')).toBeFocused();
      expect(new URL(page.url()).hash).toBe(hash);
    });
  }
});

test.describe('Responsive and accessibility', () => {
  test('profile editor stays within a narrow mobile viewport', async ({ page, api }) => {
    api.configure();
    await page.setViewportSize({ width: 320, height: 740 });
    await openAgents(page, '#agents/agent-atlas');
    await page.getByRole('button', { name: 'Create next draft' }).click();
    await expect(page.locator('.agents-profile-editor-fields')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  for (const viewport of widths) {
    test(`no horizontal overflow and a reachable 4-link nav (inline or menu) at ${viewport.name}`, async ({
      page,
      api,
    }) => {
      const long = agent('agent-long', 'A'.repeat(100), {
        versionCount: 3,
        versionOverrides: () => ({ instructions: 'x'.repeat(2000), profession: 'P'.repeat(150) }),
      });
      api.configure({ agents: [long, atlas, mira] });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const hash of ['#agents', '#agents/agent-long', '#agents/agent-long/v/2']) {
        await openAgents(page, hash);
        await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
        await expect(page.getByText('Loading', { exact: false })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      }
      // Narrow widths disclose the four links behind the navigation menu button.
      const menu = page.getByRole('button', { name: 'Navigation menu' });
      if (await menu.isVisible()) await menu.click();
      const nav = page.getByRole('navigation', { name: 'Primary navigation' });
      for (const name of ['Command Center', 'Tasks', 'Runs', 'Agents']) {
        const link = nav.getByRole('link', { name });
        await expect(link).toBeVisible();
        await expect(link).toBeInViewport({ ratio: 0.99 });
      }
      await page.getByRole('link', { name: 'Agents' }).click();
      await expect(page).toHaveURL(/#agents$/);
    });
  }

  for (const viewport of [widths[0]!, widths[2]!, widths[4]!]) {
    test(`axe finds no serious or critical issues on agents screens at ${viewport.name}`, async ({
      page,
      api,
    }) => {
      api.configure();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const hash of [
        '#agents',
        '#agents?archived=1&q=a',
        '#agents/agent-atlas',
        '#agents/agent-old',
        '#agents/agent-draft',
        '#agents/agent-atlas/v/1',
        '#agents/agent-atlas/v/99',
        '#agents/agent-atlas/v/0',
      ]) {
        await openAgents(page, hash);
        await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
        await expect(page.getByText('Loading', { exact: false })).toHaveCount(0);
        await expectNoSeriousAxeViolations(page);
      }
    });
  }

  test('empty and error states pass axe', async ({ page, api }) => {
    api.configure({ agents: [] });
    await openAgents(page);
    await expect(page.getByText('No agents yet.')).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    api.configure({ directoryStatus: 503 });
    await page.reload();
    await expect(page.getByText('Agents unavailable')).toBeVisible();
    await expectNoSeriousAxeViolations(page);
  });

  test('tab order reaches filters then one stop per card, and reduced motion is respected', async ({
    page,
    api,
  }) => {
    api.configure();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAgents(page);
    await page.getByLabel('Search agents').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Department')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Show archived')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Atlas', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Mira Vale', exact: true })).toBeFocused();
  });
});

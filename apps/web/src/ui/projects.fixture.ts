import type { Page, Route } from '@playwright/test';
import {
  AgentDirectoryResponseSchema,
  ArchiveProjectSchema,
  CreateProjectSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  ProjectSummarySchema,
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceResponseSchema,
  ProjectWorkspaceTaskSummarySchema,
  UpdateProjectSchema,
  type Project,
  type ProjectWorkspaceTaskSummary,
} from '@omnis/contracts';

/**
 * Contract-backed fixture for the Project Workspace browser tests. Every response is parsed with
 * the shared strict schemas and every request body is parsed with the matching request schema, so
 * the fixture cannot drift from the API. It models the behaviour the frontend depends on:
 * `expectedRevision` checks, the idempotency receipt, CSRF-before-write and bounded cursor
 * paging. None of it is evidence about the real backend.
 */

export const stamp = '2026-11-03T10:00:00.000Z';
export const later = '2026-11-04T08:30:00.000Z';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const pid = (n: number) => `prj_${n.toString(16).padStart(32, '0')}`;

export function proj(n: number, overrides: Partial<Project> = {}): Project {
  return ProjectSchema.parse({
    id: pid(n),
    ownerId: 'owner',
    key: `AO-${n}`,
    name: `Project ${n}`,
    objective: `Objective for project ${n}.`,
    status: 'active',
    priority: 'normal',
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  });
}

export function task(
  i: number,
  projectId: string,
  overrides: Partial<ProjectWorkspaceTaskSummary> = {},
): ProjectWorkspaceTaskSummary {
  return ProjectWorkspaceTaskSummarySchema.parse({
    id: `task-${String(i).padStart(4, '0')}`,
    title: `Task number ${i}`,
    status: 'open',
    createdAt: stamp,
    projectId,
    associationRevision: 1,
    latestRun: null,
    ...overrides,
  });
}

export type Step = {
  status?: number;
  code?: string;
  message?: string;
  abort?: boolean;
  /** Apply the change, then still fail: a response lost after the commit. */
  commit?: boolean;
  before?: () => void;
  delayMs?: number;
};

type Queue = 'list' | 'detail' | 'tasks' | 'create' | 'update' | 'archive';
type Outcome =
  { status: 200 | 201; json: unknown } | { status: number; code: string; message: string };

export function createApi(page: Page) {
  let projects: Project[] = [];
  let tasks: Record<string, ProjectWorkspaceTaskSummary[]> = {};
  let token = 'csrf-fixture';
  let counter = 100;
  let signedOut = false;
  let invalidateCursors = false;
  const persistent: Partial<Record<Queue, Step | null>> = {};
  const detailDelay = new Map<string, number>();
  const receipts = new Map<string, { signature: string; outcome: Outcome }>();
  const queues: Record<Queue, Step[]> = {
    list: [],
    detail: [],
    tasks: [],
    create: [],
    update: [],
    archive: [],
  };
  const requests: Array<{
    method: string;
    path: string;
    search: string;
    body: unknown;
    csrf: string | null;
    idempotencyKey: string | null;
  }> = [];
  const unexpected: string[] = [];

  const error = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, json: { error: { code, message, requestId: 'fixture-request' } } });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const find = (id: string) => projects.find((item) => item.id === id);
  const summaryOf = (item: Project) =>
    ProjectSummarySchema.parse(
      Object.fromEntries(Object.entries(item).filter(([field]) => field !== 'objective')),
    );

  function apply(kind: 'create' | 'update' | 'archive', id: string | null, body: unknown): Outcome {
    if (kind === 'create') {
      const input = CreateProjectSchema.parse(body);
      if (projects.some((item) => item.key === input.key))
        return {
          status: 409,
          code: 'conflict',
          message: 'A project with this key already exists.',
        };
      if (projects.length >= 500)
        return {
          status: 503,
          code: 'limit',
          message: 'The project directory capacity was reached.',
        };
      counter += 1;
      const created = proj(counter, {
        key: input.key,
        name: input.name,
        objective: input.objective,
        priority: input.priority,
        status: 'proposed',
      });
      projects.push(created);
      return { status: 201, json: ProjectSchema.parse(created) };
    }
    const current = id ? find(id) : undefined;
    if (!current) return { status: 404, code: 'not_found', message: 'Project was not found.' };
    if (current.status === 'archived')
      return {
        status: 409,
        code: 'invalid_transition',
        message: 'The project lifecycle does not allow this change.',
      };
    if (kind === 'update') {
      const input = UpdateProjectSchema.parse(body);
      if (input.expectedRevision !== current.revision)
        return { status: 409, code: 'conflict', message: 'The project revision is stale.' };
      const next = ProjectSchema.parse({
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        revision: current.revision + 1,
        updatedAt: later,
      });
      projects = projects.map((item) => (item.id === next.id ? next : item));
      return { status: 200, json: next };
    }
    const input = ArchiveProjectSchema.parse(body);
    if (input.expectedRevision !== current.revision)
      return { status: 409, code: 'conflict', message: 'The project revision is stale.' };
    const next = ProjectSchema.parse({
      ...current,
      status: 'archived',
      revision: current.revision + 1,
      updatedAt: later,
    });
    projects = projects.map((item) => (item.id === next.id ? next : item));
    return { status: 200, json: next };
  }

  async function mutation(
    route: Route,
    queue: 'create' | 'update' | 'archive',
    id: string | null,
    csrf: string | null,
    idem: string | null,
    raw: string | null,
    signature: string,
  ) {
    const step = queues[queue].shift() ?? {};
    if (step.delayMs) await sleep(step.delayMs);
    if (csrf !== token)
      return error(route, 403, 'csrf_rejected', 'Refresh the page and retry the action.');
    const parsed =
      queue === 'create'
        ? CreateProjectSchema.safeParse(raw ? JSON.parse(raw) : undefined)
        : queue === 'update'
          ? UpdateProjectSchema.safeParse(raw ? JSON.parse(raw) : undefined)
          : ArchiveProjectSchema.safeParse(raw ? JSON.parse(raw) : undefined);
    if (!parsed.success || !idem || !uuid.test(idem))
      return error(
        route,
        422,
        'invalid_input',
        'Project input and a valid Idempotency-Key are required.',
      );
    step.before?.();
    const failing = Boolean(step.abort || step.status);
    const fail = () =>
      step.abort
        ? route.abort('failed')
        : error(route, step.status ?? 500, step.code ?? 'error', step.message ?? 'Fixture error.');
    // A failure that did not commit must leave no trace, so nothing is applied.
    if (failing && !step.commit) return fail();
    const body: unknown = JSON.parse(raw ?? 'null');
    const prior = receipts.get(idem);
    let outcome: Outcome;
    if (prior) {
      outcome =
        prior.signature === signature
          ? prior.outcome
          : { status: 409, code: 'conflict', message: 'The idempotency key was reused.' };
    } else {
      outcome = apply(queue, id, body);
      if (outcome.status < 300) receipts.set(idem, { signature, outcome });
    }
    if (failing) return fail();
    if ('json' in outcome) return route.fulfill({ status: outcome.status, json: outcome.json });
    return error(route, outcome.status, outcome.code, outcome.message);
  }

  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path, search } = url;
    const method = request.method();
    const csrf = (await request.headerValue('x-omnis-csrf')) ?? null;
    const idem = (await request.headerValue('idempotency-key')) ?? null;
    const raw = request.postData();
    requests.push({
      method,
      path,
      search,
      body: raw ? (JSON.parse(raw) as unknown) : null,
      csrf,
      idempotencyKey: idem,
    });

    if (path === '/api/v1/auth/csrf') return route.fulfill({ json: { csrfToken: token } });
    if (path === '/api/v1/auth/logout' && method === 'POST') {
      signedOut = true;
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/api/v1/me')
      return signedOut
        ? error(route, 401, 'unauthorized', 'Sign in to continue.')
        : route.fulfill({ json: { id: 'owner', displayName: 'Director' } });
    if ((path === '/api/v1/tasks' || path === '/api/v1/runs') && method === 'GET')
      return route.fulfill({ json: [] });
    if (path === '/api/v1/agents' && method === 'GET')
      return route.fulfill({
        json: AgentDirectoryResponseSchema.parse({
          agents: [],
          page: { total: 0, complete: true, nextCursor: null },
        }),
      });

    const detail = /^\/api\/v1\/projects\/(prj_[0-9a-f]{32})$/.exec(path);
    const archive = /^\/api\/v1\/projects\/(prj_[0-9a-f]{32})\/archive$/.exec(path);
    const taskList = /^\/api\/v1\/projects\/(prj_[0-9a-f]{32})\/tasks$/.exec(path);
    const isList = path === '/api/v1/projects';

    const readStep = async (queue: Queue) => {
      // The dev build runs every mount effect twice (StrictMode), so a one-shot step could be
      // spent on the aborted first request. Persistent steps apply to every request until cleared.
      const step = persistent[queue] ?? queues[queue].shift() ?? {};
      step.before?.();
      if (step.delayMs) await sleep(step.delayMs);
      if (step.abort) return route.abort('failed');
      if (step.status)
        return error(route, step.status, step.code ?? 'error', step.message ?? 'Fixture error.');
      return null;
    };

    if (isList && method === 'GET') {
      const failed = await readStep('list');
      if (failed !== null) return failed;
      if (signedOut) return error(route, 401, 'unauthorized', 'Sign in to continue.');
      const body = ProjectListResponseSchema.parse({
        projects: projects.map(summaryOf),
        total: projects.length,
        complete: true,
      });
      return route.fulfill({ json: body });
    }
    if (detail && method === 'GET') {
      const delay = detailDelay.get(detail[1] ?? '');
      if (delay) await sleep(delay);
      const failed = await readStep('detail');
      if (failed !== null) return failed;
      const found = find(detail[1] ?? '');
      return found
        ? route.fulfill({ json: ProjectSchema.parse(found) })
        : error(route, 404, 'not_found', 'Project was not found.');
    }
    if (taskList && method === 'GET') {
      const failed = await readStep('tasks');
      if (failed !== null) return failed;
      const id = taskList[1] ?? '';
      const found = find(id);
      if (!found) return error(route, 404, 'not_found', 'Project was not found.');
      const query = ProjectWorkspaceQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success)
        return error(route, 422, 'invalid_input', 'Project workspace query is invalid.');
      const all = tasks[id] ?? [];
      const cursor = query.data.cursor;
      let offset = 0;
      if (cursor !== undefined) {
        const match = /^cur:(\d+)$/.exec(cursor);
        if (!match || invalidateCursors)
          return error(route, 422, 'invalid_cursor', 'The cursor is invalid.');
        offset = Number(match[1]);
      }
      const limit = query.data.limit ?? 50;
      const slice = all.slice(offset, offset + limit);
      const more = offset + limit < all.length;
      return route.fulfill({
        json: ProjectWorkspaceResponseSchema.parse({
          project: found,
          tasks: slice,
          page: {
            observedTotal: all.length,
            complete: !more,
            nextCursor: more ? `cur:${offset + limit}` : null,
          },
        }),
      });
    }

    const mutate = (kind: 'create' | 'update' | 'archive', id: string | null) =>
      mutation(route, kind, id, csrf, idem, raw, `${method} ${path} ${raw ?? ''}`);
    if (isList && method === 'POST') return mutate('create', null);
    if (detail && method === 'PATCH') return mutate('update', detail[1] ?? '');
    if (archive && method === 'POST') return mutate('archive', archive[1] ?? '');

    unexpected.push(`${method} ${path}`);
    return error(route, 500, 'fixture_contract_violation', `Unexpected ${method} ${path}`);
  };

  void page.route('**/api/v1/**', handle);
  return {
    configure(
      next: {
        projects?: Project[];
        tasks?: Record<string, ProjectWorkspaceTaskSummary[]>;
      } = {},
    ) {
      projects = [...(next.projects ?? [])];
      tasks = { ...(next.tasks ?? {}) };
      requests.length = 0;
    },
    next(queue: Queue, ...steps: Step[]) {
      queues[queue].push(...steps);
    },
    /** Applies a step to every request of a read queue until cleared with null. */
    persist(queue: Queue, step: Step | null) {
      persistent[queue] = step;
    },
    delayDetail(id: string, ms: number) {
      detailDelay.set(id, ms);
    },
    rotateCsrf() {
      token = 'csrf-rotated';
    },
    signOut() {
      signedOut = true;
    },
    invalidateCursors() {
      invalidateCursors = true;
    },
    /** Another session edits the project: the stored revision advances. */
    editOutside(id: string, changes: Partial<Project>) {
      projects = projects.map((item) =>
        item.id === id
          ? ProjectSchema.parse({
              ...item,
              ...changes,
              revision: item.revision + 1,
              updatedAt: later,
            })
          : item,
      );
    },
    stored: (id: string) => find(id),
    storedCount: () => projects.length,
    requests,
    unexpected,
    of: (method: string, pattern: RegExp) =>
      requests.filter((entry) => entry.method === method && pattern.test(entry.path)),
    posts: () =>
      requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/projects'),
    patches: () => requests.filter((entry) => entry.method === 'PATCH'),
    archives: () => requests.filter((entry) => entry.path.endsWith('/archive')),
    csrfReads: () => requests.filter((entry) => entry.path === '/api/v1/auth/csrf'),
  };
}

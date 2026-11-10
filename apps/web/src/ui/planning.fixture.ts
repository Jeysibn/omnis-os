import type { Page, Route } from '@playwright/test';
import { runtimeCapabilities } from '@omnis/contracts/runtime-capabilities';
import {
  AgentDirectoryResponseSchema,
  ArchiveEpicSchema,
  ArchiveMilestoneSchema,
  CreateEpicSchema,
  CreateMilestoneSchema,
  EpicListResponseSchema,
  EpicSchema,
  MilestoneListResponseSchema,
  MilestoneSchema,
  ProjectEpicTaskPageSchema,
  ProjectSchema,
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceResponseSchema,
  SetTaskEpicSchema,
  TaskEpicAssociationSchema,
  TaskEpicResponseSchema,
  TaskSchema,
  UpdateEpicSchema,
  UpdateMilestoneSchema,
  type Epic,
  type Milestone,
  type Project,
  type ProjectWorkspaceTaskSummary,
} from '@omnis/contracts';
import { later, pid, proj, stamp, task as makeTask } from './projects.fixture.js';

/**
 * Contract-backed fixture for the Project Planning browser tests. Responses are parsed with the
 * shared strict schemas, request bodies with the matching request schemas, and a write without a
 * CSRF header or a valid Idempotency-Key is refused, so the fixture cannot drift from the API.
 * It models what the frontend depends on: revision checks, the idempotency receipt, the single
 * `conflict` code for stale revisions and key reuse, `invalid_transition` for archived records, and
 * bounded cursor paging. None of it is evidence about the real backend.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CONFLICT = 'A conflicting change exists or the idempotency key was reused.';

export const eid = (n: number) => `epc_${n.toString(16).padStart(32, '0')}`;
export const mid = (n: number) => `mil_${n.toString(16).padStart(32, '0')}`;

export function epic(n: number, projectId: string, overrides: Partial<Epic> = {}): Epic {
  return EpicSchema.parse({
    id: eid(n),
    projectId,
    title: `Epic ${n}`,
    description: null,
    status: 'planned',
    revision: 1,
    archivedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  });
}

export function milestone(
  n: number,
  projectId: string,
  overrides: Partial<Milestone> = {},
): Milestone {
  return MilestoneSchema.parse({
    id: mid(n),
    projectId,
    title: `Milestone ${n}`,
    description: null,
    status: 'planned',
    targetDate: null,
    revision: 1,
    archivedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
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
  /** Runs before the request is handled: another session changing something. */
  before?: () => void;
  delayMs?: number;
};

export type Op =
  | 'project:get'
  | 'project:tasks'
  | 'epics:list'
  | 'epics:create'
  | 'epic:get'
  | 'epic:update'
  | 'epic:archive'
  | 'epic:tasks'
  | 'milestones:list'
  | 'milestones:create'
  | 'milestone:get'
  | 'milestone:update'
  | 'milestone:archive'
  | 'task-epic:get'
  | 'task-epic:set';

type Outcome =
  { status: number; json: unknown } | { status: number; code: string; message: string };
type Assoc = { epicId: string | null; revision: number };

const P = String.raw`/api/v1/projects/(prj_[0-9a-f]{32})`;
const routes: Array<[Op, string, RegExp]> = [
  ['project:get', 'GET', new RegExp(`^${P}$`)],
  ['project:tasks', 'GET', new RegExp(`^${P}/tasks$`)],
  ['epics:list', 'GET', new RegExp(`^${P}/epics$`)],
  ['epics:create', 'POST', new RegExp(`^${P}/epics$`)],
  ['epic:get', 'GET', new RegExp(`^${P}/epics/(epc_[0-9a-f]{32})$`)],
  ['epic:update', 'PATCH', new RegExp(`^${P}/epics/(epc_[0-9a-f]{32})$`)],
  ['epic:archive', 'POST', new RegExp(`^${P}/epics/(epc_[0-9a-f]{32})/archive$`)],
  ['epic:tasks', 'GET', new RegExp(`^${P}/epics/(epc_[0-9a-f]{32})/tasks$`)],
  ['milestones:list', 'GET', new RegExp(`^${P}/milestones$`)],
  ['milestones:create', 'POST', new RegExp(`^${P}/milestones$`)],
  ['milestone:get', 'GET', new RegExp(`^${P}/milestones/(mil_[0-9a-f]{32})$`)],
  ['milestone:update', 'PATCH', new RegExp(`^${P}/milestones/(mil_[0-9a-f]{32})$`)],
  ['milestone:archive', 'POST', new RegExp(`^${P}/milestones/(mil_[0-9a-f]{32})/archive$`)],
  ['task-epic:get', 'GET', /^\/api\/v1\/tasks\/([^/]+)\/epic$/],
  ['task-epic:set', 'PUT', /^\/api\/v1\/tasks\/([^/]+)\/epic$/],
];
const writes = new Set<Op>([
  'epics:create',
  'epic:update',
  'epic:archive',
  'milestones:create',
  'milestone:update',
  'milestone:archive',
  'task-epic:set',
]);

export function createPlanningApi(page: Page) {
  let project: Project = proj(1);
  let epics: Epic[] = [];
  let milestones: Milestone[] = [];
  let tasks: ProjectWorkspaceTaskSummary[] = [];
  const assoc = new Map<string, Assoc>();
  let token = 'csrf-fixture';
  let counter = 500;
  let invalidateCursors = false;
  const queues = new Map<Op, Step[]>();
  const persistent = new Map<Op, Step | null>();
  const receipts = new Map<string, { signature: string; outcome: Outcome }>();
  const requests: Array<{
    op: Op | null;
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
  const tasksOf = (epicId: string) => tasks.filter((item) => assoc.get(item.id)?.epicId === epicId);
  const parseQuery = (url: URL) =>
    ProjectWorkspaceQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  const paged = <T>(all: T[], url: URL): { slice: T[]; page: unknown } | 'bad' => {
    const query = parseQuery(url);
    if (!query.success) return 'bad';
    let offset = 0;
    if (query.data.cursor !== undefined) {
      const match = /^cur:(\d+)$/.exec(query.data.cursor);
      if (!match || invalidateCursors) return 'bad';
      offset = Number(match[1]);
    }
    const limit = query.data.limit ?? 50;
    const more = offset + limit < all.length;
    return {
      slice: all.slice(offset, offset + limit),
      page: {
        observedTotal: all.length,
        complete: !more,
        nextCursor: more ? `cur:${offset + limit}` : null,
      },
    };
  };

  function apply(op: Op, ids: string[], body: unknown): Outcome {
    const id = op === 'task-epic:set' ? ids[1] : ids[2];
    const archivedProject = project.status === 'archived';
    if (op === 'epics:create' || op === 'milestones:create') {
      if (archivedProject)
        return { status: 409, code: 'invalid_transition', message: 'The project is archived.' };
      counter += 1;
      if (op === 'epics:create') {
        const input = CreateEpicSchema.parse(body);
        const created = epic(counter, project.id, {
          title: input.title,
          description: input.description ?? null,
        });
        epics = [created, ...epics];
        return { status: 201, json: created };
      }
      const input = CreateMilestoneSchema.parse(body);
      const created = milestone(counter, project.id, {
        title: input.title,
        description: input.description ?? null,
        targetDate: input.targetDate ?? null,
      });
      milestones = [created, ...milestones];
      return { status: 201, json: created };
    }
    if (op === 'task-epic:set') {
      const input = SetTaskEpicSchema.parse(body);
      const current = assoc.get(id ?? '');
      if (!current) return { status: 404, code: 'not_found', message: 'Task was not found.' };
      if (input.expectedAssociationRevision !== current.revision)
        return { status: 409, code: 'conflict', message: CONFLICT };
      if (input.epicId !== null) {
        const target = epics.find((item) => item.id === input.epicId);
        if (!target) return { status: 404, code: 'not_found', message: 'Epic was not found.' };
        if (target.status === 'archived')
          return { status: 409, code: 'invalid_transition', message: 'The epic is archived.' };
      }
      const next = { epicId: input.epicId, revision: current.revision + 1 };
      assoc.set(id ?? '', next);
      return {
        status: 200,
        json: TaskEpicAssociationSchema.parse({
          taskId: id,
          projectId: project.id,
          epicId: next.epicId,
          associationRevision: next.revision,
        }),
      };
    }
    if (op.startsWith('epic')) {
      const current = epics.find((item) => item.id === id);
      if (!current) return { status: 404, code: 'not_found', message: 'Epic was not found.' };
      if (current.status === 'archived')
        return { status: 409, code: 'invalid_transition', message: 'The epic is archived.' };
      let next: Epic;
      if (op === 'epic:update') {
        const input = UpdateEpicSchema.parse(body);
        if (input.expectedRevision !== current.revision)
          return { status: 409, code: 'conflict', message: CONFLICT };
        next = EpicSchema.parse({
          ...current,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status }),
          revision: current.revision + 1,
          updatedAt: later,
        });
      } else {
        const input = ArchiveEpicSchema.parse(body);
        if (input.expectedRevision !== current.revision)
          return { status: 409, code: 'conflict', message: CONFLICT };
        next = EpicSchema.parse({
          ...current,
          status: 'archived',
          archivedAt: later,
          revision: current.revision + 1,
          updatedAt: later,
        });
      }
      epics = epics.map((item) => (item.id === next.id ? next : item));
      return { status: 200, json: next };
    }
    const current = milestones.find((item) => item.id === id);
    if (!current) return { status: 404, code: 'not_found', message: 'Milestone was not found.' };
    if (current.status === 'archived')
      return { status: 409, code: 'invalid_transition', message: 'The milestone is archived.' };
    let next: Milestone;
    if (op === 'milestone:update') {
      const input = UpdateMilestoneSchema.parse(body);
      if (input.expectedRevision !== current.revision)
        return { status: 409, code: 'conflict', message: CONFLICT };
      next = MilestoneSchema.parse({
        ...current,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
        ...(input.status === undefined ? {} : { status: input.status }),
        revision: current.revision + 1,
        updatedAt: later,
      });
    } else {
      const input = ArchiveMilestoneSchema.parse(body);
      if (input.expectedRevision !== current.revision)
        return { status: 409, code: 'conflict', message: CONFLICT };
      next = MilestoneSchema.parse({
        ...current,
        status: 'archived',
        archivedAt: later,
        revision: current.revision + 1,
        updatedAt: later,
      });
    }
    milestones = milestones.map((item) => (item.id === next.id ? next : item));
    return { status: 200, json: next };
  }

  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const csrf = (await request.headerValue('x-omnis-csrf')) ?? null;
    const idem = (await request.headerValue('idempotency-key')) ?? null;
    const raw = request.postData();
    let matched: { op: Op; ids: string[] } | null = null;
    for (const [op, verb, pattern] of routes) {
      const found = verb === method ? pattern.exec(path) : null;
      if (found) {
        matched = { op, ids: found.slice(0) };
        break;
      }
    }
    requests.push({
      op: matched?.op ?? null,
      method,
      path,
      search: url.search,
      body: raw ? (JSON.parse(raw) as unknown) : null,
      csrf,
      idempotencyKey: idem,
    });

    if (path === '/api/v1/auth/csrf') return route.fulfill({ json: { csrfToken: token } });
    if (path === '/api/v1/me')
      return route.fulfill({ json: { id: 'owner', displayName: 'Director' } });
    if (path === '/api/v1/tasks' && method === 'GET')
      return route.fulfill({
        json: tasks.map((item) =>
          TaskSchema.parse({
            id: item.id,
            title: item.title,
            detail: `Detail for ${item.title}.`,
            status: item.status,
            createdAt: item.createdAt,
            projectId: item.projectId,
            associationRevision: item.associationRevision,
          }),
        ),
      });
    if (path === '/api/v1/runs' && method === 'GET') return route.fulfill({ json: [] });
    // The Tasks screen reads these two as well; they carry nothing this fixture models.
    if (path === '/api/v1/agents' && method === 'GET')
      return route.fulfill({
        json: AgentDirectoryResponseSchema.parse({
          agents: [],
          page: { total: 0, complete: true, nextCursor: null },
        }),
      });
    if (path === '/api/v1/runtime-capabilities' && method === 'GET')
      return route.fulfill({ json: runtimeCapabilities(false) });
    if (path === '/api/v1/projects' && method === 'GET')
      return route.fulfill({
        json: {
          projects: [
            Object.fromEntries(Object.entries(project).filter(([key]) => key !== 'objective')),
          ],
          total: 1,
          complete: true,
        },
      });
    if (/^\/api\/v1\/runs\/[^/]+\/events$/.test(path))
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });

    if (!matched) {
      unexpected.push(`${method} ${path}`);
      return error(route, 500, 'fixture_contract_violation', `Unexpected ${method} ${path}`);
    }
    const { op, ids } = matched;
    const step = persistent.get(op) ?? queues.get(op)?.shift() ?? {};
    step.before?.();
    if (step.delayMs) await sleep(step.delayMs);
    const failing = Boolean(step.abort || step.status);
    const fail = () =>
      step.abort
        ? route.abort('failed')
        : error(route, step.status ?? 500, step.code ?? 'error', step.message ?? 'Fixture error.');

    if (writes.has(op)) {
      if (csrf !== token)
        return error(route, 403, 'csrf_rejected', 'Refresh the page and retry the action.');
      if (!idem || !uuid.test(idem) || !raw)
        return error(
          route,
          422,
          'invalid_input',
          'Input and a valid Idempotency-Key are required.',
        );
      // A failure that did not commit leaves no trace.
      if (failing && !step.commit) return fail();
      const signature = `${method} ${path} ${raw}`;
      const prior = receipts.get(idem);
      let outcome: Outcome;
      if (prior) {
        outcome =
          prior.signature === signature
            ? prior.outcome
            : { status: 409, code: 'conflict', message: CONFLICT };
      } else {
        try {
          outcome = apply(op, ids, JSON.parse(raw));
        } catch {
          return error(route, 422, 'invalid_input', 'Input is invalid.');
        }
        if (outcome.status < 300) receipts.set(idem, { signature, outcome });
      }
      if (failing) return fail();
      if ('json' in outcome) return route.fulfill({ status: outcome.status, json: outcome.json });
      return error(route, outcome.status, outcome.code, outcome.message);
    }

    if (failing) return fail();
    const projectId = ids[1];
    if (op !== 'task-epic:get' && projectId !== project.id)
      return error(route, 404, 'not_found', 'Project was not found.');

    if (op === 'project:get') return route.fulfill({ json: ProjectSchema.parse(project) });
    if (op === 'project:tasks') {
      const result = paged(tasks, url);
      if (result === 'bad') return error(route, 422, 'invalid_cursor', 'The cursor is invalid.');
      return route.fulfill({
        json: ProjectWorkspaceResponseSchema.parse({
          project,
          tasks: result.slice,
          page: result.page,
        }),
      });
    }
    if (op === 'epics:list' || op === 'milestones:list') {
      const result = paged(op === 'epics:list' ? epics : milestones, url);
      if (result === 'bad') return error(route, 422, 'invalid_cursor', 'The cursor is invalid.');
      return route.fulfill({
        json:
          op === 'epics:list'
            ? EpicListResponseSchema.parse({ epics: result.slice, page: result.page })
            : MilestoneListResponseSchema.parse({ milestones: result.slice, page: result.page }),
      });
    }
    if (op === 'epic:get') {
      const found = epics.find((item) => item.id === ids[2]);
      return found
        ? route.fulfill({ json: found })
        : error(route, 404, 'not_found', 'Project or epic was not found.');
    }
    if (op === 'milestone:get') {
      const found = milestones.find((item) => item.id === ids[2]);
      return found
        ? route.fulfill({ json: found })
        : error(route, 404, 'not_found', 'Project or milestone was not found.');
    }
    if (op === 'epic:tasks') {
      if (!epics.some((item) => item.id === ids[2]))
        return error(route, 404, 'not_found', 'Project or epic was not found.');
      const result = paged(tasksOf(ids[2] ?? ''), url);
      if (result === 'bad') return error(route, 422, 'invalid_cursor', 'The cursor is invalid.');
      return route.fulfill({
        json: ProjectEpicTaskPageSchema.parse({ tasks: result.slice, page: result.page }),
      });
    }
    // task-epic:get
    const current = assoc.get(ids[1] ?? '');
    if (!current) return error(route, 404, 'not_found', 'Task was not found.');
    return route.fulfill({
      json: TaskEpicResponseSchema.parse({
        taskId: ids[1],
        projectId: project.id,
        epic: epics.find((item) => item.id === current.epicId) ?? null,
        associationRevision: current.revision,
      }),
    });
  };

  void page.route('**/api/v1/**', handle);
  return {
    configure(next: {
      project?: Project;
      epics?: Epic[];
      milestones?: Milestone[];
      tasks?: ProjectWorkspaceTaskSummary[];
      /** task id -> epic id */
      assignments?: Record<string, string | null>;
    }) {
      project = next.project ?? project;
      epics = [...(next.epics ?? [])];
      milestones = [...(next.milestones ?? [])];
      tasks = [...(next.tasks ?? [])];
      assoc.clear();
      for (const item of tasks)
        assoc.set(item.id, {
          epicId: next.assignments?.[item.id] ?? null,
          revision: item.associationRevision,
        });
      requests.length = 0;
    },
    next(op: Op, ...steps: Step[]) {
      queues.set(op, [...(queues.get(op) ?? []), ...steps]);
    },
    /** Applies a step to every request of an operation until cleared with null. */
    persist(op: Op, step: Step | null) {
      persistent.set(op, step);
    },
    invalidateCursors() {
      invalidateCursors = true;
    },
    /** Another session edits an epic or milestone: the stored revision advances. */
    editEpicOutside(id: string, changes: Partial<Epic>) {
      epics = epics.map((item) =>
        item.id === id
          ? EpicSchema.parse({ ...item, ...changes, revision: item.revision + 1, updatedAt: later })
          : item,
      );
    },
    editMilestoneOutside(id: string, changes: Partial<Milestone>) {
      milestones = milestones.map((item) =>
        item.id === id
          ? MilestoneSchema.parse({
              ...item,
              ...changes,
              revision: item.revision + 1,
              updatedAt: later,
            })
          : item,
      );
    },
    /** Another session moves a task: its association revision advances. */
    assignOutside(taskId: string, epicId: string | null) {
      const current = assoc.get(taskId);
      if (current) assoc.set(taskId, { epicId, revision: current.revision + 1 });
    },
    rotateCsrf() {
      token = 'csrf-rotated';
    },
    epicStored: (id: string) => epics.find((item) => item.id === id),
    milestoneStored: (id: string) => milestones.find((item) => item.id === id),
    epicCount: () => epics.length,
    milestoneCount: () => milestones.length,
    assignment: (taskId: string) => assoc.get(taskId),
    requests,
    unexpected,
    of: (op: Op) => requests.filter((entry) => entry.op === op),
    writes: () => requests.filter((entry) => entry.op !== null && writes.has(entry.op)),
  };
}

export { makeTask as planningTask, pid, proj };

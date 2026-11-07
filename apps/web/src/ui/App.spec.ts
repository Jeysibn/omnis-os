import AxeBuilder from '@axe-core/playwright';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test as base, type Page, type Route } from '@playwright/test';
import {
  AuthorizationDecisionSchema,
  AuthorizationSchema,
  AgentDirectoryResponseSchema,
  CreateAuthorizationSchema,
  CreateRunSchema,
  CreateTaskSchema,
  RunEventSchema,
  RunSchema,
  SetTaskExecutionAssignmentSchema,
  TaskSchema,
  type Authorization,
  type ProjectSummary,
  type Run,
  type RunEvent,
  type Task,
} from '@omnis/contracts';

const now = '2026-11-03T10:00:00.000Z';
const csrfToken = 'csrf-browser-fixture-token';
const authorizationId = 'b7cece2c-2e6f-4b3b-92da-f0352c24debb';

const makeTask = (id: string, title: string, status: Task['status'] = 'open'): Task => ({
  id,
  title,
  detail: `Read the notes for ${title.toLowerCase()} and report the next action.`,
  status,
  createdAt: now,
  agentId: null,
  profileVersion: null,
  runtimeId: null,
  assignmentRevision: 1,
});

const makeRun = (
  id: string,
  taskId: string,
  taskTitle: string,
  status: Run['status'] = 'completed',
  linkedAuthorizationId?: string,
): Run => ({
  id,
  taskId,
  taskTitle,
  ...(linkedAuthorizationId ? { authorizationId: linkedAuthorizationId } : {}),
  status,
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt: now,
  updatedAt: now,
});

const defaultTasks = [
  makeTask('task-open', 'Review launch checklist'),
  makeTask('task-done', 'Audit access notes', 'completed'),
];
const makeProject = (
  id: string,
  key: string,
  name: string,
  status: ProjectSummary['status'] = 'active',
): ProjectSummary => ({
  id,
  ownerId: 'owner',
  key,
  name,
  status,
  priority: 'normal',
  revision: 1,
  createdAt: now,
  updatedAt: now,
});
const defaultProjects = [
  makeProject(`prj_${'a'.repeat(32)}`, 'OPS', 'Operations'),
  makeProject(`prj_${'b'.repeat(32)}`, 'ARCHIVED', 'Archived project', 'archived'),
];
const defaultRuns = [
  makeRun('run-active', 'task-open', 'Review launch checklist', 'running'),
  makeRun('run-old', 'task-done', 'Audit access notes'),
];

type FixtureOptions = {
  tasks?: Task[];
  runs?: Run[];
  projects?: ProjectSummary[];
  signedOut?: boolean;
  csrfBootstrapFailures?: number;
  taskGetFailures?: number;
  projectGetFailures?: number;
  runGetFailures?: number;
  taskDelayMs?: number;
  taskMutationStatus?: number;
  taskMutationFailures?: number;
  taskMutationRetryStatus?: number;
  assignmentFailures?: number;
  authorizationDisconnects?: number;
  decisionDisconnects?: number;
  runDisconnects?: number;
  decisionStatus?: Authorization['status'];
  decisionMalformed?: boolean;
  decisionTaskId?: string;
  decisionScopeTaskId?: string;
  decisionCapabilities?: Authorization['capabilities'];
  decisionExpiresAt?: string;
  runMutationStatus?: number;
  detailFailures?: number;
  stopMutationStatus?: number;
  stopMutationFailures?: number;
  eventCount?: number;
  eventDisconnects?: boolean;
  eventOrder?: 'reverse';
  eventDuplicates?: boolean;
  /** Scripted native-EventSource scenario: deliver event 1, drop, then replay 1 and send 2. */
  eventReconnectScenario?: boolean;
};

type EventScenarioServer = {
  url: string;
  cursors: string[];
  release: () => void;
  close: () => Promise<void>;
};

const sseFrame = (event: RunEvent) =>
  `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * Real SSE endpoint for the reconnect regression. Connection 1 delivers one nonterminal event and
 * ends the response; connection 2 is held until released, then replays event 1 and sends event 2;
 * later connections stay idle. `cursors` holds each request's true `Last-Event-ID` ('' if absent).
 */
async function startEventScenario(events: RunEvent[]): Promise<EventScenarioServer> {
  const cursors: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server: Server = createServer((request, response) => {
    const header = request.headers['last-event-id'];
    cursors.push(Array.isArray(header) ? header.join(',') : (header ?? ''));
    const connection = cursors.length;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (connection === 1) return void response.end(`retry: 100\n\n${sseFrame(events[0]!)}`);
    if (connection === 2) {
      void gate.then(() => response.end(`${sseFrame(events[0]!)}${sseFrame(events[1]!)}`));
      return;
    }
    response.end('retry: 60000\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/events`,
    cursors,
    release: () => release(),
    close: () =>
      new Promise<void>((resolve) => {
        release();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type MockApi = ReturnType<typeof createMockApi>;

const test = base.extend<{ api: MockApi }>({
  api: async ({ page }, use) => {
    const api = createMockApi(page);
    await use(api);
    await api.dispose();
    expect(api.unexpected, 'all frontend requests must match the fixture contract').toEqual([]);
  },
});

function createMockApi(page: Page) {
  let options: FixtureOptions = {};
  let currentTasks = [...defaultTasks];
  let currentRuns = [...defaultRuns];
  let currentProjects = [...defaultProjects];
  let currentAuthorization: Authorization | null = null;
  let authenticated = true;
  let currentCsrfToken = csrfToken;
  let taskGetFailures = 0;
  let projectGetFailures = 0;
  let runGetFailures = 0;
  let detailFailures = 0;
  let authorizationDisconnects = 0;
  let decisionDisconnects = 0;
  let runDisconnects = 0;
  let eventDisconnects = 0;
  let csrfBootstrapFailures = 0;
  let stopMutationFailures = 0;
  const unexpected: string[] = [];
  const requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const authorizationPosts: Array<{ key: string; taskId: string }> = [];
  const authorizationKeys: string[] = [];
  const decisionAttempts: string[] = [];
  const runPosts: Array<{ key: string; body: ReturnType<typeof CreateRunSchema.parse> }> = [];
  const runKeys: string[] = [];
  const stopRunIds: string[] = [];
  const eventRequestCursors: string[] = [];
  let scenario: EventScenarioServer | undefined;
  const runDetailGets = new Map<string, number>();
  let createdTaskCount = 0;
  let taskMutationFailures = 0;
  let taskMutationRetryUsed = false;
  let assignmentFailures = 0;
  const assignmentWrites: Array<{ taskId: string; key: string; body: unknown }> = [];
  const fixtureAgent = {
    id: 'agent-analyst',
    identityRevision: 1,
    name: 'Research Analyst',
    slug: 'research-analyst',
    department: null,
    lifecycle: 'available' as const,
    archivedAt: null,
    currentVersion: { versionNo: 3, profession: 'Research Analyst', seniority: 'senior' },
    provenance: 'owner_created' as const,
    createdAt: now,
    updatedAt: now,
  };

  const configure = (next: FixtureOptions = {}) => {
    options = next;
    currentTasks = [...(options.tasks ?? defaultTasks)];
    currentRuns = [...(options.runs ?? defaultRuns)];
    currentProjects = [...(options.projects ?? defaultProjects)];
    currentAuthorization = null;
    authenticated = !options.signedOut;
    currentCsrfToken = csrfToken;
    taskGetFailures = options.taskGetFailures ?? 0;
    projectGetFailures = options.projectGetFailures ?? 0;
    runGetFailures = options.runGetFailures ?? 0;
    detailFailures = options.detailFailures ?? 0;
    authorizationDisconnects = options.authorizationDisconnects ?? 0;
    decisionDisconnects = options.decisionDisconnects ?? 0;
    runDisconnects = options.runDisconnects ?? 0;
    eventDisconnects = options.eventDisconnects ? 1 : 0;
    csrfBootstrapFailures = 0;
    stopMutationFailures = options.stopMutationFailures ?? 0;
    createdTaskCount = 0;
    taskMutationFailures = options.taskMutationFailures ?? 0;
    taskMutationRetryUsed = false;
    assignmentFailures = options.assignmentFailures ?? 0;
    assignmentWrites.length = 0;
  };

  const fulfillError = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, json: { error: { code, message, requestId: 'fixture-request' } } });

  const makeAuthorization = (taskId: string): Authorization => ({
    id: authorizationId,
    requestingActor: 'owner',
    runtimeId: 'mock',
    operation: 'execute_task',
    taskId,
    capabilities: ['mock.execute'],
    scope: { kind: 'task', taskId },
    status: 'pending',
    policyVersion: 'mock-policy-v1',
    correlationId: 'correlation-fixture',
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    createdAt: now,
    decidedAt: null,
    decidedBy: null,
    revokedAt: null,
    revokedBy: null,
    consumedAt: null,
    consumedRunId: null,
  });

  const makeDecision = (authorization: Authorization): Authorization => ({
    ...authorization,
    taskId: options.decisionTaskId ?? authorization.taskId,
    scope: { kind: 'task', taskId: options.decisionScopeTaskId ?? authorization.taskId },
    capabilities: options.decisionCapabilities ?? ['mock.execute'],
    status: options.decisionStatus ?? 'authorized',
    expiresAt: options.decisionExpiresAt ?? authorization.expiresAt,
    decidedAt: now,
    decidedBy: 'owner',
  });

  const makeEvents = (run: Run): RunEvent[] => {
    const count =
      options.eventCount === undefined
        ? run.status === 'completed'
          ? 3
          : 2
        : Math.max(0, options.eventCount);
    return Array.from({ length: count }, (_, index) => {
      const sequence = index + 1;
      const type: RunEvent['type'] =
        sequence === count && (run.status === 'completed' || options.eventCount)
          ? 'run.completed'
          : sequence === 1
            ? 'run.queued'
            : sequence === 2
              ? 'run.started'
              : 'run.output';
      const event: RunEvent = {
        id: `event-${run.id}-${sequence}`,
        runId: run.id,
        sequence,
        at: new Date(Date.parse(now) + sequence * 1000).toISOString(),
        type,
        source: 'mock',
        synthetic: true,
        message: `Synthetic ${type.replace('run.', '')} event ${sequence}.`,
      };
      return RunEventSchema.parse(event);
    });
  };

  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const headers = request.headers();
    const body = request.postDataJSON?.() ?? null;
    requests.push({ method, path, headers, body });

    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
      headers['x-omnis-csrf'] !== currentCsrfToken
    ) {
      return fulfillError(route, 403, 'csrf_rejected', 'A valid CSRF header is required.');
    }

    if (path === '/api/v1/auth/csrf' && method === 'GET') {
      if (csrfBootstrapFailures > 0) {
        csrfBootstrapFailures -= 1;
        return fulfillError(route, 503, 'csrf_unavailable', 'Secure sign-in setup is unavailable.');
      }
      return route.fulfill({ json: { csrfToken: currentCsrfToken } });
    }
    if (path === '/api/v1/me' && method === 'GET') {
      return authenticated
        ? route.fulfill({ json: { id: 'owner', displayName: 'Director' } })
        : fulfillError(route, 401, 'unauthorized', 'Sign in to continue.');
    }
    if (path === '/api/v1/agents' && method === 'GET') {
      return route.fulfill({
        json: AgentDirectoryResponseSchema.parse({
          agents: [fixtureAgent],
          page: { total: 1, complete: true, nextCursor: null },
        }),
      });
    }
    if (path === '/api/v1/auth/login' && method === 'POST') {
      authenticated = true;
      return route.fulfill({ json: { authenticated: true } });
    }
    if (path === '/api/v1/auth/logout' && method === 'POST') {
      authenticated = false;
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/api/v1/projects' && method === 'GET') {
      if (projectGetFailures > 0) {
        projectGetFailures -= 1;
        return fulfillError(
          route,
          503,
          'projects_unavailable',
          'Projects are temporarily unavailable.',
        );
      }
      return route.fulfill({
        json: { projects: currentProjects, total: currentProjects.length, complete: true },
      });
    }
    if (path === '/api/v1/tasks' && method === 'GET') {
      if (options.taskDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.taskDelayMs));
      if (taskGetFailures > 0) {
        taskGetFailures -= 1;
        return fulfillError(route, 503, 'tasks_unavailable', 'Tasks are temporarily unavailable.');
      }
      return route.fulfill({ json: currentTasks.map((task) => TaskSchema.parse(task)) });
    }
    if (path === '/api/v1/tasks' && method === 'POST') {
      if (
        options.taskMutationStatus &&
        (taskMutationFailures > 0 ||
          options.taskMutationFailures === undefined ||
          (taskMutationFailures === 0 &&
            options.taskMutationRetryStatus !== undefined &&
            !taskMutationRetryUsed))
      ) {
        const status =
          options.taskMutationFailures !== undefined &&
          taskMutationFailures === 0 &&
          options.taskMutationRetryStatus
            ? options.taskMutationRetryStatus
            : options.taskMutationStatus;
        if (taskMutationFailures > 0) taskMutationFailures -= 1;
        else if (options.taskMutationRetryStatus !== undefined) taskMutationRetryUsed = true;
        if (status === 401) {
          authenticated = false;
          currentCsrfToken = 'csrf-recovered-fixture-token';
          csrfBootstrapFailures = options.csrfBootstrapFailures ?? 0;
        }
        return fulfillError(route, status, 'task_write_failed', 'Task could not be created.');
      }
      const parsed = CreateTaskSchema.safeParse(body);
      if (!parsed.success)
        return fulfillError(route, 400, 'invalid_input', 'Task payload is invalid.');
      const created = TaskSchema.parse({
        id: `task-created-${++createdTaskCount}`,
        ...parsed.data,
        status: 'open',
        createdAt: now,
      });
      currentTasks = [created, ...currentTasks];
      return route.fulfill({ status: 201, json: created });
    }
    const assignmentMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/execution-assignment$/);
    if (assignmentMatch && method === 'PUT') {
      const parsed = SetTaskExecutionAssignmentSchema.safeParse(body);
      const key = headers['idempotency-key'] ?? '';
      if (!parsed.success || !zodUuid(key))
        return fulfillError(route, 400, 'invalid_input', 'Task assignment input is invalid.');
      assignmentWrites.push({ taskId: assignmentMatch[1]!, key, body });
      if (assignmentFailures > 0) {
        assignmentFailures -= 1;
        return fulfillError(
          route,
          503,
          'assignment_unknown',
          'Task assignment outcome is unknown.',
        );
      }
      const existing = currentTasks.find((task) => task.id === assignmentMatch[1]);
      if (!existing) return fulfillError(route, 404, 'not_found', 'Task was not found.');
      const updated = TaskSchema.parse({
        ...existing,
        agentId: parsed.data.agentId,
        profileVersion: parsed.data.profileVersion,
        runtimeId: parsed.data.runtimeId,
        assignmentRevision: existing.assignmentRevision + 1,
      });
      currentTasks = currentTasks.map((task) => (task.id === updated.id ? updated : task));
      return route.fulfill({ json: updated });
    }
    if (path === '/api/v1/runs' && method === 'GET') {
      if (runGetFailures > 0) {
        runGetFailures -= 1;
        return fulfillError(route, 503, 'runs_unavailable', 'Runs are temporarily unavailable.');
      }
      return route.fulfill({ json: currentRuns.map((run) => RunSchema.parse(run)) });
    }
    const auditMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/synthetic-runs\/([^/]+)\/events$/);
    if (auditMatch && method === 'GET') {
      const auditEvent = {
        attemptId: 'b70ef09b-b357-4da9-89c9-981eb90a0b05',
        sequence: 1,
        eventType: 'connector.authorization_consumed',
        outcome: 'recorded',
        revocationGeneration: 0,
        occurredAt: now,
      };
      return route.fulfill({
        json: {
          version: 'omnis.synthetic-task-run-events.v1',
          authorizationId: auditMatch[2],
          taskId: auditMatch[1],
          events: [auditEvent],
          page: { nextAfter: null },
        },
      });
    }
    if (path === '/api/v1/authorizations' && method === 'POST') {
      const key = headers['idempotency-key'] ?? '';
      if (!zodUuid(key))
        return fulfillError(
          route,
          400,
          'invalid_input',
          'A valid UUID Idempotency-Key is required.',
        );
      const parsed = CreateAuthorizationSchema.safeParse(body);
      if (!parsed.success)
        return fulfillError(route, 400, 'invalid_input', 'Authorization payload is invalid.');
      authorizationKeys.push(key);
      if (authorizationDisconnects > 0) {
        authorizationDisconnects -= 1;
        return route.abort();
      }
      authorizationPosts.push({ key, taskId: parsed.data.taskId });
      currentAuthorization = AuthorizationSchema.parse(makeAuthorization(parsed.data.taskId));
      return route.fulfill({ status: 201, json: currentAuthorization });
    }
    const decisionMatch = path.match(/^\/api\/v1\/authorizations\/([^/]+)\/decision$/);
    if (decisionMatch && method === 'POST') {
      decisionAttempts.push(decisionMatch[1]!);
      if (decisionDisconnects > 0) {
        decisionDisconnects -= 1;
        return route.abort();
      }
      const parsed = AuthorizationDecisionSchema.safeParse(body);
      if (
        !parsed.success ||
        !currentAuthorization ||
        currentAuthorization.id !== decisionMatch[1]
      ) {
        return fulfillError(route, 400, 'invalid_input', 'Authorization decision is invalid.');
      }
      currentAuthorization = AuthorizationSchema.parse(makeDecision(currentAuthorization));
      if (options.decisionMalformed) return route.fulfill({ json: { status: 'authorized' } });
      return route.fulfill({ json: currentAuthorization });
    }
    const revokeMatch = path.match(/^\/api\/v1\/authorizations\/([^/]+)\/revoke$/);
    if (revokeMatch && method === 'POST') {
      if (!currentAuthorization || currentAuthorization.id !== revokeMatch[1])
        return fulfillError(route, 404, 'not_found', 'Authorization not found.');
      currentAuthorization = AuthorizationSchema.parse({
        ...currentAuthorization,
        status: 'revoked',
        revokedAt: now,
        revokedBy: 'owner',
      });
      return route.fulfill({ json: currentAuthorization });
    }
    if (path === '/api/v1/runs' && method === 'POST') {
      const key = headers['idempotency-key'] ?? '';
      if (!zodUuid(key))
        return fulfillError(
          route,
          400,
          'invalid_input',
          'A valid UUID Idempotency-Key is required.',
        );
      const parsed = CreateRunSchema.safeParse(body);
      if (!parsed.success)
        return fulfillError(route, 400, 'invalid_input', 'Run payload is invalid.');
      runKeys.push(key);
      if (runDisconnects > 0) {
        runDisconnects -= 1;
        return route.abort();
      }
      runPosts.push({ key, body: parsed.data });
      if (options.runMutationStatus)
        return fulfillError(
          route,
          options.runMutationStatus,
          'run_rejected',
          'The run request was rejected.',
        );
      if (
        !currentAuthorization ||
        currentAuthorization.status !== 'authorized' ||
        currentAuthorization.taskId !== parsed.data.taskId ||
        currentAuthorization.id !== parsed.data.authorizationId
      ) {
        return fulfillError(
          route,
          403,
          'authorization_denied',
          'A matching owner authorization is required.',
        );
      }
      currentAuthorization = AuthorizationSchema.parse({
        ...currentAuthorization,
        consumedAt: now,
        consumedRunId: 'run-created',
      });
      const task = currentTasks.find((item) => item.id === parsed.data.taskId);
      const run = RunSchema.parse(
        makeRun('run-created', parsed.data.taskId, task?.title ?? 'Created task', 'queued'),
      );
      currentRuns = [run, ...currentRuns];
      return route.fulfill({ status: 201, json: run });
    }
    const stopMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/stop$/);
    if (stopMatch && method === 'POST') {
      stopRunIds.push(stopMatch[1]!);
      if (stopMutationFailures > 0) {
        stopMutationFailures -= 1;
        return fulfillError(
          route,
          options.stopMutationStatus ?? 503,
          'stop_failed',
          'Stop request could not be completed.',
        );
      }
      const target = currentRuns.find((run) => run.id === stopMatch[1]);
      if (!target) return fulfillError(route, 404, 'not_found', 'Run not found.');
      const updated = RunSchema.parse({ ...target, status: 'stopping', updatedAt: now });
      currentRuns = currentRuns.map((run) => (run.id === updated.id ? updated : run));
      return route.fulfill({ json: updated });
    }
    const eventMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
    if (eventMatch && method === 'GET') {
      eventRequestCursors.push(headers['last-event-id'] ?? '');
      if (eventDisconnects > 0) {
        eventDisconnects -= 1;
        return route.abort();
      }
      const run = currentRuns.find((item) => item.id === eventMatch[1]);
      if (!run) return fulfillError(route, 404, 'not_found', 'Run not found.');
      if (options.eventReconnectScenario) {
        // Playwright routes never expose Chromium's native Last-Event-ID, so a real HTTP server
        // receives the browser's actual EventSource requests and records the true cursor.
        scenario ??= await startEventScenario(makeEvents(run));
        return route.continue({ url: scenario.url });
      }
      const after = Number(headers['last-event-id'] ?? '0');
      const events = makeEvents(run).filter((event) => event.sequence > after);
      const orderedEvents = options.eventOrder === 'reverse' ? [...events].reverse() : events;
      const deliveredEvents = options.eventDuplicates
        ? orderedEvents.flatMap((event) => [event, event])
        : orderedEvents;
      const bodyText = deliveredEvents
        .map(
          (event) =>
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: bodyText });
    }
    const detailMatch = path.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      runDetailGets.set(detailMatch[1]!, (runDetailGets.get(detailMatch[1]!) ?? 0) + 1);
      if (detailFailures > 0) {
        detailFailures -= 1;
        return fulfillError(
          route,
          503,
          'run_unavailable',
          'Final run state is temporarily unavailable.',
        );
      }
      const run = currentRuns.find((item) => item.id === detailMatch[1]);
      return run
        ? route.fulfill({ json: RunSchema.parse(run) })
        : fulfillError(route, 404, 'not_found', 'Run not found.');
    }
    unexpected.push(`${method} ${path}`);
    return fulfillError(
      route,
      500,
      'fixture_contract_violation',
      `Unexpected API request: ${method} ${path}`,
    );
  };

  void page.route('**/api/v1/**', handle);
  return {
    configure,
    requests,
    unexpected,
    authorizationPosts,
    authorizationKeys,
    decisionAttempts,
    runPosts,
    runKeys,
    stopRunIds,
    eventRequestCursors,
    get scenarioCursors() {
      return scenario?.cursors ?? [];
    },
    releaseReconnect: () => scenario?.release(),
    dispose: async () => scenario?.close(),
    runDetailGets,
    assignmentWrites,
    get tasks() {
      return currentTasks;
    },
    get runs() {
      return currentRuns;
    },
  };
}

function zodUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function openWorkspace(page: Page, hash = '#command-center') {
  await page.goto(`/${hash}`);
  await expect(page.locator('#main-content')).toBeVisible();
  if (hash === '#command-center')
    await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
}

async function openTaskComposer(page: Page, title = 'Prepare rollout notes') {
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByLabel('Task title').fill(title);
  await page.getByLabel('Task detail').fill('Read the change log and draft a rollout checklist.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function openApproval(page: Page, taskTitle = 'Prepare rollout notes') {
  await page
    .getByRole('listitem')
    .filter({ hasText: taskTitle })
    .getByRole('button', { name: 'Approve & run' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Approve one synthetic run?' })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeFocused();
}

async function assertNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious'),
  ).toEqual([]);
}

test('navigation and skip link support keyboard operation', async ({ page, api }) => {
  api.configure();
  await openWorkspace(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Omnis OS home' })).toBeFocused();
  await page.getByRole('link', { name: 'Tasks' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#tasks$/);
  await expect(page.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
});

async function expectVisibleFocusIndicator(page: Page, viewportWidth: number) {
  const main = page.locator('#main-content');
  await expect(main).toBeFocused();
  const state = await main.evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      outlineOffset: Number.parseFloat(style.outlineOffset),
      top: rect.top,
      left: rect.left,
      right: rect.right,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  expect(state.focusVisible).toBe(true);
  expect(state.outlineStyle).not.toBe('none');
  expect(state.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(state.outlineColor).not.toMatch(/rgba\(.*,\s*0\)$/);
  expect(state.outlineColor).not.toBe('transparent');
  // The ring (width + offset) must stay inside the viewport on both sides and add no overflow.
  const ring = state.outlineWidth + Math.max(state.outlineOffset, 0);
  expect(state.top - ring).toBeGreaterThanOrEqual(0);
  expect(state.left - ring).toBeGreaterThanOrEqual(0);
  expect(state.right + ring).toBeLessThanOrEqual(viewportWidth);
  expect(state.scrollWidth).toBeLessThanOrEqual(state.clientWidth);
}

const skipLinkRoutes = [
  { hash: '#command-center', heading: 'Command Center' },
  { hash: '#tasks', heading: 'Tasks' },
  { hash: '#runs', heading: 'Runs' },
  { hash: '#runs/run-old', heading: 'Runs' },
];
const skipLinkViewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: '390px', width: 390, height: 844 },
  { name: '360px', width: 360, height: 740 },
  { name: '320px', width: 320, height: 640 },
];

for (const route of skipLinkRoutes) {
  for (const viewport of skipLinkViewports) {
    test(`skip link keeps ${route.hash} route and history at ${viewport.name}`, async ({
      page,
      api,
    }) => {
      api.configure();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openWorkspace(page, route.hash);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      const skip = page.getByRole('link', { name: 'Skip to main content' });
      const historyBefore = await page.evaluate(() => window.history.length);

      await page.keyboard.press('Tab');
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport({ ratio: 1 });

      await page.keyboard.press('Enter');
      await expect(page.locator('#main-content')).toBeFocused();
      await expectVisibleFocusIndicator(page, viewport.width);
      expect(new URL(page.url()).hash).toBe(route.hash);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      expect(await page.evaluate(() => window.history.length)).toBe(historyBefore);
      await expect(page.getByRole('main')).toHaveCount(1);

      // No focus trap: the next Tab leaves main and does not return to the skip link or body.
      await page.keyboard.press('Tab');
      await expect(skip).not.toBeFocused();
      await expect(page.locator('body')).not.toBeFocused();
    });
  }
}

async function waitForScrollToSettle(page: Page) {
  // Resolve once scrollY has not changed for 10 consecutive animation frames.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = window.scrollY;
        let stable = 0;
        const tick = () => {
          if (window.scrollY === last) stable += 1;
          else {
            stable = 0;
            last = window.scrollY;
          }
          if (stable >= 10) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

const scrolledSkipViewports = [
  { name: 'desktop', width: 1440, height: 500 },
  { name: '390px', width: 390, height: 600 },
  { name: '320px', width: 320, height: 568 },
];

for (const motion of ['no-preference', 'reduce'] as const) {
  for (const route of ['#tasks', '#runs/run-old']) {
    for (const viewport of scrolledSkipViewports) {
      test(`skip link from a scrolled page reveals main and its ring: ${route} ${viewport.name} motion ${motion}`, async ({
        page,
        api,
      }) => {
        api.configure();
        await page.emulateMedia({ reducedMotion: motion });
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openWorkspace(page, route);
        const heading = await page.getByRole('heading', { level: 1 }).innerText();
        const skip = page.getByRole('link', { name: 'Skip to main content' });
        const historyBefore = await page.evaluate(() => window.history.length);

        await page.keyboard.press('Tab');
        await expect(skip).toBeFocused();
        // Scroll while the skip link keeps keyboard focus (it is fixed, so it stays visible).
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await waitForScrollToSettle(page);
        await expect(skip).toBeFocused();
        const before = await page.evaluate(() => ({
          scrollY: window.scrollY,
          mainTop: document.getElementById('main-content')!.getBoundingClientRect().top,
        }));
        // Precondition: genuinely scrolled with the top of main (and its ring) above the viewport.
        expect(before.scrollY).toBeGreaterThan(100);
        expect(before.mainTop).toBeLessThan(-50);

        await page.keyboard.press('Enter');
        await expect(page.locator('#main-content')).toBeFocused();
        // The ring must already be revealed the moment focus lands (no animated catch-up),
        // and must stay revealed once scrolling settles.
        await expectVisibleFocusIndicator(page, viewport.width);
        await waitForScrollToSettle(page);
        await expectVisibleFocusIndicator(page, viewport.width);
        const after = await page.evaluate(() => ({
          scrollY: window.scrollY,
          mainTop: document.getElementById('main-content')!.getBoundingClientRect().top,
        }));
        expect(after.scrollY).toBeLessThan(before.scrollY);
        expect(after.mainTop).toBeGreaterThanOrEqual(6);
        expect(new URL(page.url()).hash).toBe(route);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
        expect(await page.evaluate(() => window.history.length)).toBe(historyBefore);
        await page.keyboard.press('Tab');
        await expect(skip).not.toBeFocused();
        await expect(page.locator('body')).not.toBeFocused();
      });
    }
  }
}

test('skip link does not add a history entry or break back and forward', async ({ page, api }) => {
  api.configure();
  await openWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page).toHaveURL(/#tasks$/);
  await page.getByRole('link', { name: 'Skip to main content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page).toHaveURL(/#tasks$/);
  await page.goBack();
  await expect(page).toHaveURL(/#command-center$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#tasks$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#tasks$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  await assertNoSeriousAxeViolations(page);
});

test('skip link works with mouse click and keeps the route', async ({ page, api }) => {
  api.configure();
  await openWorkspace(page, '#runs/run-old');
  await page.getByRole('link', { name: 'Skip to main content' }).focus();
  await page.getByRole('link', { name: 'Skip to main content' }).click();
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page).toHaveURL(/#runs\/run-old$/);
});

test('loads tasks and runs independently and retries without false empty states', async ({
  page,
  api,
}) => {
  api.configure({ runGetFailures: 1 });
  await openWorkspace(page);
  await expect(page.getByText('Runs unavailable')).toBeVisible();
  await expect(page.getByText('No runs recorded')).toHaveCount(0);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'Review launch checklist' })).toBeVisible();
  await page.getByRole('link', { name: 'Runs' }).click();
  await page.getByRole('button', { name: 'Retry runs' }).first().click();
  await expect(page.getByRole('heading', { name: 'Run history' })).toBeVisible();
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'Review launch checklist' })).toBeVisible();

  await page.goto('/#command-center');
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
  api.configure({ taskGetFailures: 1 });
  await page.reload();
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByText('Tasks unavailable').first()).toBeVisible();
  await expect(page.getByText('No tasks yet')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Review launch checklist' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry tasks' }).first().click();
  await expect(page.getByRole('heading', { name: 'Review launch checklist' })).toBeVisible();
});

test('assigns an available immutable profile to a task on the synthetic runtime', async ({
  page,
  api,
}) => {
  api.configure({ runs: [] });
  await openWorkspace(page, '#tasks');
  await expect(page.getByRole('heading', { name: 'Review launch checklist' })).toBeVisible();
  await expect(page.getByLabel('Agent profile')).toBeVisible();
  await page.getByLabel('Agent profile').selectOption('agent-analyst');
  await expect(page.getByLabel('Runtime')).toHaveValue('mock');
  await page.getByRole('button', { name: 'Save assignment' }).click();
  await expect(page.getByText('Synthetic mock assignment saved.')).toBeVisible();
  await expect(page.getByText(/does not submit profile instructions to a model/)).toBeVisible();

  expect(api.assignmentWrites).toHaveLength(1);
  expect(api.assignmentWrites[0]).toMatchObject({
    taskId: 'task-open',
    body: {
      agentId: 'agent-analyst',
      profileVersion: 3,
      runtimeId: 'mock',
      expectedAssignmentRevision: 1,
    },
  });
  expect(api.assignmentWrites[0]?.key).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByLabel('Agent profile')).toHaveValue('agent-analyst');
});

test('an uncertain task assignment retries the exact request with the same key', async ({
  page,
  api,
}) => {
  api.configure({ runs: [], assignmentFailures: 1 });
  await openWorkspace(page, '#tasks');
  await expect(page.getByLabel('Agent profile')).toBeVisible();
  await page.getByLabel('Agent profile').selectOption('agent-analyst');
  await page.getByRole('button', { name: 'Save assignment' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'The save result is uncertain. Retry the same request to resolve it safely.',
  );
  await page.getByRole('button', { name: 'Retry same save' }).click();
  await expect(page.getByText('Synthetic mock assignment saved.')).toBeVisible();

  expect(api.assignmentWrites).toHaveLength(2);
  expect(api.assignmentWrites[1]).toEqual(api.assignmentWrites[0]);
});

test.describe('persisted authorization audit history', () => {
  test.use({ timezoneId: 'UTC' });

  test('shows history in Asia/Manila time for a linked synthetic run', async ({ page, api }) => {
    api.configure({
      runs: [
        makeRun('run-audit', 'task-open', 'Review launch checklist', 'completed', authorizationId),
      ],
    });
    await openWorkspace(page, '#runs/run-audit');
    await expect(page.getByRole('heading', { name: 'Authorization audit' })).toBeVisible();
    await expect(page.getByText('authorization consumed')).toBeVisible();
    await expect(page.getByText('recorded; revocation generation 0')).toBeVisible();
    await expect(page.locator('.audit-list time')).toHaveText(/11\/3\/2026, 6:00:00 PM/);
    expect(api.requests).toContainEqual({
      method: 'GET',
      path: `/api/v1/tasks/task-open/synthetic-runs/${authorizationId}/events`,
      headers: expect.any(Object),
      body: null,
    });
    await assertNoSeriousAxeViolations(page);
  });

  test('ignores an authorization audit page that resolves after switching Runs', async ({
    page,
    api,
  }) => {
    const otherAuthorizationId = 'cc62d253-2473-4fbc-bfdc-3f2a050ec778';
    api.configure({
      runs: [
        makeRun(
          'run-audit-a',
          'task-open',
          'Review launch checklist',
          'completed',
          authorizationId,
        ),
        makeRun(
          'run-audit-b',
          'task-open',
          'Review launch checklist',
          'completed',
          otherAuthorizationId,
        ),
      ],
    });
    let releasePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    let signalPageRequest!: () => void;
    const pageRequested = new Promise<void>((resolve) => {
      signalPageRequest = resolve;
    });
    await page.route(`**/synthetic-runs/${authorizationId}/events**`, async (route) => {
      const after = new URL(route.request().url()).searchParams.get('after');
      if (after !== '1') {
        return route.fulfill({
          json: {
            version: 'omnis.synthetic-task-run-events.v1',
            authorizationId,
            taskId: 'task-open',
            events: [
              {
                attemptId: 'b70ef09b-b357-4da9-89c9-981eb90a0b05',
                sequence: 1,
                eventType: 'connector.authorization_consumed',
                outcome: 'recorded',
                revocationGeneration: 0,
                occurredAt: now,
              },
            ],
            page: { nextAfter: 1 },
          },
        });
      }
      signalPageRequest();
      await pending;
      await route.fulfill({
        json: {
          version: 'omnis.synthetic-task-run-events.v1',
          authorizationId,
          taskId: 'task-open',
          events: [
            {
              attemptId: 'b70ef09b-b357-4da9-89c9-981eb90a0b05',
              sequence: 2,
              eventType: 'connector.execution_completed',
              outcome: 'recorded',
              revocationGeneration: 0,
              occurredAt: now,
            },
          ],
          page: { nextAfter: null },
        },
      });
    });
    await openWorkspace(page, '#runs/run-audit-a');
    await expect(page.getByRole('heading', { name: 'Authorization audit' })).toBeVisible();
    await page.getByRole('button', { name: 'Load more authorization events' }).click();
    await pageRequested;
    await page.evaluate(() => {
      window.location.hash = '#runs/run-audit-b';
    });
    await expect(page.getByText('authorization consumed')).toBeVisible();
    releasePending();
    await expect(page.getByText('execution completed')).toHaveCount(0);
    await expect(page.getByText('authorization consumed')).toBeVisible();
  });

  test('loads later authorization events in ascending order with an accurate action label', async ({
    page,
    api,
  }) => {
    api.configure({
      runs: [
        makeRun(
          'run-audit-pages',
          'task-open',
          'Review launch checklist',
          'completed',
          authorizationId,
        ),
      ],
    });
    await page.route(`**/synthetic-runs/${authorizationId}/events**`, async (route) => {
      const after = new URL(route.request().url()).searchParams.get('after');
      const sequence = after === '1' ? 2 : 1;
      await route.fulfill({
        json: {
          version: 'omnis.synthetic-task-run-events.v1',
          authorizationId,
          taskId: 'task-open',
          events: [
            {
              attemptId: 'b70ef09b-b357-4da9-89c9-981eb90a0b05',
              sequence,
              eventType:
                sequence === 1
                  ? 'connector.authorization_consumed'
                  : 'connector.submission_started',
              outcome: 'recorded',
              revocationGeneration: 0,
              occurredAt: now,
            },
          ],
          page: { nextAfter: sequence === 1 ? 1 : null },
        },
      });
    });
    await openWorkspace(page, '#runs/run-audit-pages');
    await expect(page.getByText('authorization consumed')).toBeVisible();
    const loadMore = page.getByRole('button', { name: 'Load more authorization events' });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(page.getByText('submission started')).toBeVisible();
    await expect(page.locator('.audit-list li')).toHaveCount(2);
    await expect(page.locator('.audit-list li').nth(0)).toContainText('authorization consumed');
    await expect(page.locator('.audit-list li').nth(1)).toContainText('submission started');
  });
});

test('shows a real loading state until the delayed task request resolves', async ({
  page,
  api,
}) => {
  api.configure({ taskDelayMs: 700 });
  await page.goto('/#tasks');
  await expect(page.locator('#main-content')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
  await expect(page.getByText('Loading tasks…')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review launch checklist' })).toBeVisible();
});

test('creates a task with CSRF, cancels approval without mutations, then approves one mock run', async ({
  page,
  api,
}) => {
  api.configure();
  await openWorkspace(page);
  await openTaskComposer(page);
  await openApproval(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(api.authorizationPosts).toHaveLength(0);
  expect(api.runPosts).toHaveLength(0);
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Prepare rollout notes' })
      .getByRole('button', { name: 'Approve & run' }),
  ).toBeFocused();

  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page).toHaveURL(/#runs\/run-created$/);
  await expect(page.getByRole('heading', { name: 'Run inspector' })).toBeFocused();
  expect(api.authorizationPosts).toHaveLength(1);
  expect(api.runPosts).toHaveLength(1);
  expect(api.authorizationPosts[0]?.key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(api.runPosts[0]?.key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(
    api.requests
      .filter((entry) => entry.method === 'POST')
      .every((entry) => entry.headers['x-omnis-csrf'] === csrfToken),
  ).toBe(true);
  await expect(page.getByRole('heading', { name: 'Run inspector' })).toBeFocused();
});

test('creates a task in the selected active project with an idempotency key', async ({
  page,
  api,
}) => {
  api.configure({
    projects: [
      makeProject(`prj_${'a'.repeat(32)}`, 'OPS', 'Operations'),
      makeProject(`prj_${'b'.repeat(32)}`, 'PROP', 'Proposed project', 'proposed'),
      makeProject(`prj_${'c'.repeat(32)}`, 'PAUSE', 'Paused project', 'paused'),
      makeProject(`prj_${'d'.repeat(32)}`, 'DONE', 'Completed project', 'completed'),
      makeProject(`prj_${'e'.repeat(32)}`, 'ARCHIVED', 'Archived project', 'archived'),
    ],
  });
  await openWorkspace(page, '#tasks');
  await page.getByRole('button', { name: 'Load available projects' }).click();
  await expect(page.getByRole('option', { name: 'Operations (OPS)' })).toBeAttached();
  for (const unavailable of [
    'Proposed project',
    'Paused project',
    'Completed project',
    'Archived project',
  ])
    await expect(page.getByRole('option', { name: new RegExp(unavailable) })).toHaveCount(0);
  await page.getByLabel('Project').selectOption(`prj_${'a'.repeat(32)}`);
  await page.getByLabel('Task title').fill('Review the deployment plan');
  await page.getByLabel('Task detail').fill('Read the deployment plan and report its next action.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('heading', { name: 'Review the deployment plan' })).toBeVisible();
  await expect(page.locator('.task-detail-panel .metadata-list')).toContainText('Operations (OPS)');

  const create = api.requests.find(
    (entry) => entry.path === '/api/v1/tasks' && entry.method === 'POST',
  );
  expect(create?.body).toEqual({
    title: 'Review the deployment plan',
    detail: 'Read the deployment plan and report its next action.',
    projectId: `prj_${'a'.repeat(32)}`,
  });
  expect(create?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(create?.headers['x-omnis-csrf']).toBe(csrfToken);
  expect(api.tasks[0]?.projectId).toBe(`prj_${'a'.repeat(32)}`);
});

test('an uncertain project task create retries the identical request with the same key', async ({
  page,
  api,
}) => {
  api.configure({ taskMutationStatus: 503, taskMutationFailures: 1 });
  await openWorkspace(page, '#tasks');
  await page.getByRole('button', { name: 'Load available projects' }).click();
  await expect(page.getByRole('option', { name: 'Operations (OPS)' })).toBeAttached();
  await page.getByLabel('Project').selectOption(`prj_${'a'.repeat(32)}`);
  await page.getByLabel('Task title').fill('Review the deployment plan');
  await page.getByLabel('Task detail').fill('Read the deployment plan and report its next action.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  await expect(page.getByLabel('Task title')).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Project')).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  await expect(page.getByLabel('Task title')).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Task title')).toHaveValue('Review the deployment plan');
  await expect(page.getByLabel('Task detail')).toHaveValue(
    'Read the deployment plan and report its next action.',
  );
  await expect(page.getByLabel('Project')).toHaveValue(`prj_${'a'.repeat(32)}`);
  await expect(page.getByRole('status')).toContainText('unknown outcome');
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(page.getByRole('heading', { name: 'Review the deployment plan' })).toBeVisible();

  const creates = api.requests.filter(
    (entry) => entry.path === '/api/v1/tasks' && entry.method === 'POST',
  );
  expect(creates).toHaveLength(2);
  expect(creates[1]?.body).toEqual(creates[0]?.body);
  expect(creates[1]?.headers['idempotency-key']).toBe(creates[0]?.headers['idempotency-key']);
  expect(api.tasks.filter((task) => task.title === 'Review the deployment plan')).toHaveLength(1);
});

test('a definitive rejection of a recovered request unlocks the form for correction', async ({
  page,
  api,
}) => {
  api.configure({
    taskMutationStatus: 503,
    taskMutationFailures: 1,
    taskMutationRetryStatus: 409,
  });
  await openWorkspace(page, '#tasks');
  await page.getByRole('button', { name: 'Load available projects' }).click();
  await expect(page.getByRole('option', { name: 'Operations (OPS)' })).toBeAttached();
  await page.getByLabel('Project').selectOption(`prj_${'a'.repeat(32)}`);
  await page.getByLabel('Task title').fill('Review the deployment plan');
  await page.getByLabel('Task detail').fill('Read the deployment plan and report its next action.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(page.getByRole('button', { name: 'Create task' })).toBeVisible();
  await expect(page.getByLabel('Task title')).not.toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Task detail')).not.toHaveAttribute('readonly', '');
  await expect(page.getByText('The project task request may have been accepted')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Task could not be created.');
  expect(
    await page.evaluate(() => sessionStorage.getItem('omnis.pending-task-create.v1')),
  ).toBeNull();
});

test('a retry 401 preserves an uncertain task request for same-owner explicit retry', async ({
  page,
  api,
}) => {
  api.configure({
    taskMutationStatus: 503,
    taskMutationFailures: 1,
    taskMutationRetryStatus: 401,
  });
  await openWorkspace(page, '#tasks');
  await page.getByRole('button', { name: 'Load available projects' }).click();
  await expect(page.getByRole('option', { name: 'Operations (OPS)' })).toBeAttached();
  await page.getByLabel('Project').selectOption(`prj_${'a'.repeat(32)}`);
  await page.getByLabel('Task title').fill('Review the deployment plan');
  await page.getByLabel('Task detail').fill('Read the deployment plan and report its next action.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('session expired');
  expect(
    await page.evaluate(() => sessionStorage.getItem('omnis.pending-task-create.v1')),
  ).not.toBeNull();

  await page.getByLabel('Owner password').fill('fixture-owner-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  await expect(page.getByLabel('Task title')).toHaveValue('Review the deployment plan');
  await expect(page.getByLabel('Task detail')).toHaveValue(
    'Read the deployment plan and report its next action.',
  );
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(page.getByRole('heading', { name: 'Review the deployment plan' })).toBeVisible();

  const creates = api.requests.filter(
    (entry) => entry.path === '/api/v1/tasks' && entry.method === 'POST',
  );
  expect(creates).toHaveLength(3);
  expect(new Set(creates.map((entry) => entry.headers['idempotency-key'])).size).toBe(1);
  expect(new Set(creates.map((entry) => JSON.stringify(entry.body))).size).toBe(1);
  expect(
    await page.evaluate(() => sessionStorage.getItem('omnis.pending-task-create.v1')),
  ).toBeNull();
});

test('does not restore a pending task request for a different owner session', async ({
  page,
  api,
}) => {
  api.configure();
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'omnis.pending-task-create.v1',
      JSON.stringify({
        ownerId: 'another-owner',
        operation: {
          title: 'Private task from another owner',
          detail: 'This task belongs to a different owner session.',
          projectId: `prj_${'a'.repeat(32)}`,
          idempotencyKey: 'b7cece2c-2e6f-4b3b-92da-f0352c24debb',
        },
      }),
    );
  });
  await openWorkspace(page, '#tasks');
  await expect(page.getByLabel('Task title')).toHaveValue('');
  await expect(page.getByLabel('Task title')).not.toHaveAttribute('readonly', '');
  await expect(page.getByText('Private task from another owner')).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem('omnis.pending-task-create.v1')),
  ).toBeNull();
});

test('rejects an invalid project selection before posting a task', async ({ page, api }) => {
  api.configure();
  await openWorkspace(page, '#tasks');
  await page.getByRole('button', { name: 'Load available projects' }).click();
  await expect(page.getByRole('option', { name: 'Operations (OPS)' })).toBeAttached();
  await page.locator('#task-project').evaluate((select) => {
    const invalid = document.createElement('option');
    invalid.value = 'prj_invalid';
    invalid.textContent = 'Invalid project';
    select.append(invalid);
    (select as HTMLSelectElement).value = invalid.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByLabel('Task title').fill('Review the deployment plan');
  await page.getByLabel('Task detail').fill('Read the deployment plan and report its next action.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('alert')).toContainText('valid active project');
  expect(
    api.requests.filter((entry) => entry.path === '/api/v1/tasks' && entry.method === 'POST'),
  ).toHaveLength(0);
});

test('a project-list failure is explicit and unassigned task creation remains available', async ({
  page,
  api,
}) => {
  api.configure({ projectGetFailures: 1 });
  await openWorkspace(page, '#tasks');
  await page.getByRole('button', { name: 'Load available projects' }).click();
  await expect(page.getByText(/Projects are temporarily unavailable/)).toBeVisible();
  await page.getByLabel('Task title').fill('Review the deployment plan');
  await page.getByLabel('Task detail').fill('Read the deployment plan and report its next action.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('heading', { name: 'Review the deployment plan' })).toBeVisible();
  const create = api.requests.find(
    (entry) => entry.path === '/api/v1/tasks' && entry.method === 'POST',
  );
  expect(create?.body).toEqual({
    title: 'Review the deployment plan',
    detail: 'Read the deployment plan and report its next action.',
  });
});

test('fixture rejects mutation requests with missing CSRF or invalid UUID idempotency keys', async ({
  page,
  api,
}) => {
  api.configure();
  await openWorkspace(page);
  const result = await page.evaluate(async () => {
    const csrf = 'csrf-browser-fixture-token';
    const body = JSON.stringify({
      taskId: 'task-open',
      authorizationId: 'b7cece2c-2e6f-4b3b-92da-f0352c24debb',
    });
    const authorizationBody = JSON.stringify({ taskId: 'task-open' });
    const missingCsrf = await fetch('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body,
    });
    const invalidKey = await fetch('/api/v1/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-omnis-csrf': csrf,
        'idempotency-key': 'not-a-uuid',
      },
      body,
    });
    const authMissingKey = await fetch('/api/v1/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-omnis-csrf': csrf },
      body: authorizationBody,
    });
    const authInvalidKey = await fetch('/api/v1/authorizations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-omnis-csrf': csrf,
        'idempotency-key': 'invalid',
      },
      body: authorizationBody,
    });
    return [missingCsrf.status, invalidKey.status, authMissingKey.status, authInvalidKey.status];
  });
  expect(result).toEqual([403, 400, 400, 400]);
  expect(api.runPosts).toHaveLength(0);
  expect(api.runs).toHaveLength(2);
});

test('safe retries reuse authorization and run idempotency keys', async ({ page, api }) => {
  api.configure({ authorizationDisconnects: 1, runDisconnects: 1 });
  await openWorkspace(page);
  await openTaskComposer(page);
  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.getByRole('dialog')).toContainText('result was not confirmed');
  await page.getByRole('dialog').getByRole('button', { name: 'Retry approval request' }).click();
  await expect(page.getByRole('dialog')).toContainText('response was not confirmed');
  await page.getByRole('dialog').getByRole('button', { name: 'Retry run request' }).click();
  await expect(page).toHaveURL(/#runs\/run-created$/);
  expect(api.authorizationKeys).toHaveLength(2);
  expect(new Set(api.authorizationKeys).size).toBe(1);
  expect(api.runKeys).toHaveLength(2);
  expect(new Set(api.runKeys).size).toBe(1);
  expect(api.authorizationPosts).toHaveLength(1);
  expect(api.runPosts).toHaveLength(1);
});

test('an uncertain owner decision is not repeated and never starts a run', async ({
  page,
  api,
}) => {
  api.configure({ decisionDisconnects: 1 });
  await openWorkspace(page);
  await openTaskComposer(page);
  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.getByRole('dialog')).toContainText('decision may have been recorded');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Close' })).toBeVisible();
  expect(api.decisionAttempts).toHaveLength(1);
  expect(api.runPosts).toHaveLength(0);
});

test('an unverifiable owner decision response is not repeated or followed by a run', async ({
  page,
  api,
}) => {
  api.configure({ decisionMalformed: true });
  await openWorkspace(page);
  await openTaskComposer(page);
  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.getByRole('dialog')).toContainText('decision may have been recorded');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Close' })).toBeVisible();
  expect(api.decisionAttempts).toHaveLength(1);
  expect(api.runPosts).toHaveLength(0);
});

for (const status of ['denied', 'expired', 'revoked', 'pending'] as const) {
  test(`does not create a run after an explicit ${status} authorization decision`, async ({
    page,
    api,
  }) => {
    api.configure({ decisionStatus: status });
    await openWorkspace(page);
    await openTaskComposer(page);
    await openApproval(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
    await expect(page.getByRole('dialog')).toContainText(`Authorization is ${status}`);
    expect(api.runPosts).toHaveLength(0);
  });
}

test('rejects a mismatched task scope, missing capability, and expired approval before POST /runs', async ({
  page,
  api,
}) => {
  api.configure({ decisionTaskId: 'another-task' });
  await openWorkspace(page);
  await openTaskComposer(page);
  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.getByRole('dialog')).toContainText('different task');
  expect(api.runPosts).toHaveLength(0);

  api.configure({ decisionScopeTaskId: 'another-scope' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
  await openTaskComposer(page);
  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.getByRole('dialog')).toContainText('different task');
  expect(api.runPosts).toHaveLength(0);

  api.configure({ decisionCapabilities: [] });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
  await openTaskComposer(page);
  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'does not grant the mock execution capability',
  );
  expect(api.runPosts).toHaveLength(0);

  api.configure({ decisionExpiresAt: new Date(Date.now() - 1000).toISOString() });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
  await openTaskComposer(page);
  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.getByRole('dialog')).toContainText('approval has expired');
  expect(api.runPosts).toHaveLength(0);
});

test('completed tasks have a disabled run action with a reason', async ({ page, api }) => {
  api.configure();
  await openWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  const completed = page.getByRole('listitem').filter({ hasText: 'Audit access notes' });
  const action = completed.getByRole('button', { name: 'Approve & run' });
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute('aria-describedby', 'task-run-reason-task-done');
  await expect(page.locator('#task-run-reason-task-done')).toHaveText(
    'Completed tasks cannot be run again.',
  );
  await action.focus();
  await expect(action).toHaveAttribute('title', 'Completed tasks cannot be run again.');
  expect(api.authorizationPosts).toHaveLength(0);
});

test('approval expiry displays the API-provided expiresAt value', async ({ page, api }) => {
  const expiresAt = '2026-11-03T12:34:56.000Z';
  api.configure({ decisionStatus: 'pending', decisionExpiresAt: expiresAt });
  await openWorkspace(page);
  await openTaskComposer(page);
  await openApproval(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & run' }).click();
  await expect(page.getByRole('dialog')).toContainText('Authorization is pending');
  await expect(page.getByRole('dialog').locator(`time[datetime="${expiresAt}"]`)).toBeVisible();
  expect(api.runPosts).toHaveLength(0);
});

test('a mutation 401 refreshes CSRF and allows sign-in again without reloading', async ({
  page,
  api,
}) => {
  api.configure({ taskMutationStatus: 401 });
  await openWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByLabel('Task title').fill('Create a secure follow-up');
  await page.getByLabel('Task detail').fill('Review the allowed task flow and its owner.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('session expired');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0);
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await expect(signIn).toBeEnabled();
  await page.getByLabel('Owner password').fill('fixture-owner-password');
  await signIn.click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
  expect(
    api.requests.filter((entry) => entry.path === '/api/v1/tasks' && entry.method === 'POST'),
  ).toHaveLength(1);
  expect(
    api.requests.find((entry) => entry.path === '/api/v1/auth/login')?.headers['x-omnis-csrf'],
  ).toBe('csrf-recovered-fixture-token');
});

test('expired-session CSRF bootstrap failure has a usable recovery action', async ({
  page,
  api,
}) => {
  api.configure({ taskMutationStatus: 401, csrfBootstrapFailures: 1 });
  await openWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByLabel('Task title').fill('Create a secure follow-up');
  await page.getByLabel('Task detail').fill('Review the allowed task flow and its owner.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByText(/Secure sign-in could not be prepared/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry secure sign-in setup' })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry secure sign-in setup' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('a mutation 403 does not expire the owner session', async ({ page, api }) => {
  api.configure({ taskMutationStatus: 403 });
  await openWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByLabel('Task title').fill('Create a secure follow-up');
  await page.getByLabel('Task detail').fill('Review the allowed task flow and its owner.');
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toHaveCount(0);
});

test('signed-out route preserves owner authentication and CSRF workflow', async ({ page, api }) => {
  api.configure({ signedOut: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Owner password').fill('fixture-owner-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
});

test('deep-linked historical run survives reload and browser back/forward', async ({
  page,
  api,
}) => {
  api.configure();
  await openWorkspace(page, '#runs/run-old');
  await expect(page.getByText('run-old')).toBeVisible();
  await expect(page).toHaveURL(/#runs\/run-old$/);
  await page.reload();
  await expect(page.getByText('run-old')).toBeVisible();
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByRole('link', { name: 'Runs' }).click();
  await page.getByRole('button', { name: /Review launch checklist/ }).click();
  await expect(page).toHaveURL(/#runs\/run-active$/);
  await page.goBack();
  await expect(page).toHaveURL(/#runs$/);
  await page.goForward();
  await expect(page).toHaveURL(/#runs\/run-active$/);
  await expect(page.getByText('run-active')).toBeVisible();
});

test('unknown run links explain the missing run and allow returning to history', async ({
  page,
  api,
}) => {
  api.configure();
  await openWorkspace(page, '#runs/no-such-run');
  await expect(page.getByText('Run not found', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Return to run history' }).click();
  await expect(page).toHaveURL(/#runs$/);
});

test('successful empty task and run resources show their own empty states', async ({
  page,
  api,
}) => {
  api.configure({ tasks: [], runs: [] });
  await openWorkspace(page);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByText('No tasks yet')).toBeVisible();
  await expect(page.getByText('Tasks unavailable')).toHaveCount(0);
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByText('No runs recorded')).toBeVisible();
  await expect(page.getByText('Runs unavailable')).toHaveCount(0);
});

test('event stream retries with the last delivered event sequence', async ({ page, api }) => {
  test.setTimeout(20_000);
  api.configure({ eventDisconnects: true });
  await openWorkspace(page, '#runs/run-active');
  await expect(page.locator('.stream-badge')).toContainText('Reconnecting');
  await expect.poll(() => api.eventRequestCursors.length, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.getByText('2 events')).toBeVisible();
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
});

test('native EventSource reconnect after a delivered event sends Last-Event-ID and dedupes the replay', async ({
  page,
  api,
}) => {
  test.setTimeout(20_000);
  api.configure({ eventReconnectScenario: true });
  await openWorkspace(page, '#runs/run-active');
  const history = page.getByRole('region', { name: 'Event history for Review launch checklist' });
  const rows = history.locator('.event-row');

  // Connection 1 delivers `id: 1` / `event: run.queued`, then the response ends.
  await expect(page.getByText('1 event', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Synthetic queued event 1.');
  await expect(rows.nth(0)).toContainText('Event 1 · mock source · synthetic');
  await expect(page.locator('.stream-badge')).toContainText('Reconnecting');

  // Chromium reconnects on its own; the held request lets us inspect it mid-flight.
  await expect.poll(() => api.scenarioCursors.length, { timeout: 10_000 }).toBe(2);
  expect(api.scenarioCursors.slice(0, 2)).toEqual(['', '1']);
  await expect(rows).toHaveCount(1);

  // Release connection 2: replayed event 1 followed by new event 2.
  api.releaseReconnect();
  await expect(page.getByText('2 events', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Synthetic queued event 1.');
  await expect(rows.nth(1)).toContainText('Synthetic started event 2.');
  await expect(history.getByText('Event 1 · mock source · synthetic')).toHaveCount(1);
  await expect(history.getByText('Event 2 · mock source · synthetic')).toHaveCount(1);
  await expect(page.locator('.inspector-summary .status-pill')).toContainText('Running');

  // The cursor advances to the newest delivered event on the next reconnect.
  await expect.poll(() => api.scenarioCursors.length, { timeout: 10_000 }).toBeGreaterThan(2);
  expect(api.scenarioCursors.slice(0, 3)).toEqual(['', '1', '2']);

  // No duplicate rows, no invalid terminal transition, no surfaced error.
  await expect(rows).toHaveCount(2);
  await expect(page.locator('.stream-badge')).not.toContainText(/Stream ended|Closed/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('event replay sorts out-of-order frames and ignores duplicate sequences', async ({
  page,
  api,
}) => {
  api.configure({ eventOrder: 'reverse', eventDuplicates: true });
  await openWorkspace(page, '#runs/run-active');
  const history = page.getByRole('region', { name: 'Event history for Review launch checklist' });
  await expect(page.getByText('2 events')).toBeVisible();
  const rows = history.locator('.event-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('queued');
  await expect(rows.nth(1)).toContainText('started');
  await expect(page.locator('.inspector-summary .status-pill')).toContainText('Running');
});

test('Stop targets the selected run when the active run is not first in the fixture', async ({
  page,
  api,
}) => {
  api.configure({
    runs: [
      makeRun('run-first-completed', 'task-done', 'Audit access notes'),
      makeRun('run-selected-active', 'task-open', 'Review launch checklist', 'running'),
    ],
  });
  await openWorkspace(page, '#runs');
  await page.getByRole('button', { name: /Review launch checklist/ }).click();
  await page.getByRole('button', { name: 'Request stop' }).click();
  await expect(page.getByRole('button', { name: 'Stop requested' })).toBeVisible();
  expect(api.stopRunIds).toEqual(['run-selected-active']);
});

test('revisiting a terminal run replays history, ends the stream, and stays closed', async ({
  page,
  api,
}) => {
  test.setTimeout(20_000);
  api.configure();
  await openWorkspace(page, '#runs/run-old');
  await expect(page.locator('.stream-badge')).toContainText('Stream ended');
  expect(api.eventRequestCursors).toHaveLength(1);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await page.getByRole('link', { name: 'Runs' }).click();
  await page.getByRole('button', { name: /Audit access notes/ }).click();
  await expect(page.locator('.stream-badge')).toContainText('Stream ended');
  await expect(page.getByText('3 events')).toBeVisible();
  expect(api.eventRequestCursors).toHaveLength(2);
  await page.waitForTimeout(1_500);
  expect(api.eventRequestCursors).toHaveLength(2);
});

test('Command Center Stop ignores rapid duplicate clicks and can retry after failure', async ({
  page,
  api,
}) => {
  api.configure({ stopMutationStatus: 503, stopMutationFailures: 1 });
  await openWorkspace(page);
  const stop = page.getByRole('button', { name: 'Request stop' });
  await expect(stop).toBeVisible();
  await stop.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect(page.getByRole('alert')).toContainText('Stop request could not be completed.');
  expect(api.stopRunIds).toEqual(['run-active']);
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(page.getByRole('button', { name: 'Stop requested' })).toBeVisible();
  expect(api.stopRunIds).toEqual(['run-active', 'run-active']);
});

test('replays 600 events in order without per-event detail reads and reconciles once', async ({
  page,
  api,
}) => {
  api.configure({
    eventCount: 600,
    runs: [
      makeRun('run-active', 'task-open', 'Review launch checklist', 'completed'),
      defaultRuns[1]!,
    ],
  });
  await openWorkspace(page, '#runs/run-active');
  await expect(page.getByText('600 events')).toBeVisible();
  await expect(page.getByText('Event 600 · mock source · synthetic')).toBeVisible();
  expect(api.runDetailGets.get('run-active')).toBe(1);
  const region = page.getByRole('region', { name: 'Event history for Review launch checklist' });
  const bounds = await region.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeLessThan(500);
  const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(documentHeight).toBeLessThan(3000);
  const eventNumbers = await region
    .locator('.event-source')
    .evaluateAll((nodes) =>
      nodes.map((node) => Number(node.textContent?.match(/Event (\d+)/)?.[1])),
    );
  expect(eventNumbers).toHaveLength(600);
  expect(eventNumbers[0]).toBe(1);
  expect(eventNumbers.at(-1)).toBe(600);
  await expect(page.locator('.inspector-summary .status-pill')).toContainText('Completed');
});

test('terminal reconciliation failure is visible and retryable', async ({ page, api }) => {
  api.configure({ detailFailures: 1 });
  await openWorkspace(page, '#runs/run-old');
  await expect(page.getByRole('alert')).toContainText(
    'Final run state is temporarily unavailable.',
  );
  await page.getByRole('button', { name: 'Retry state check' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.runDetailGets.get('run-old')).toBe(2);
});

test('approval dialog stays centered and contained at desktop, tablet, mobile, and narrow widths', async ({
  page,
  api,
}) => {
  api.configure();
  await openWorkspace(page);
  await openTaskComposer(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    ); // let the header settle between inline links and the menu before measuring
    if (!(await page.getByRole('dialog').isVisible())) await openApproval(page);
    const box = await page.getByRole('dialog').boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(1);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(viewport.width);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Prepare rollout notes' })
      .getByRole('button', { name: 'Approve & run' }),
  ).toBeFocused();
});

/** Follows a primary link, opening the navigation menu first when the header has collapsed. */
async function goTo(page: Page, name: 'Command Center' | 'Tasks' | 'Runs' | 'Agents') {
  // A viewport change is followed by the header deciding between inline links and the menu.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const menu = page.getByRole('button', { name: 'Navigation menu' });
  if (await menu.isVisible()) {
    if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  }
  await page.getByRole('link', { name, exact: true }).click();
}

test('axe reports no serious or critical violations on key routes at all target widths', async ({
  page,
  api,
}) => {
  test.setTimeout(120_000);
  api.configure();
  await openWorkspace(page);
  await openTaskComposer(page);
  await goTo(page, 'Command Center');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await assertNoSeriousAxeViolations(page);
    await goTo(page, 'Tasks');
    await assertNoSeriousAxeViolations(page);
    await goTo(page, 'Runs');
    await assertNoSeriousAxeViolations(page);
    await page.getByRole('button', { name: /Review launch checklist/ }).click();
    await expect(page.getByText('2 events')).toBeVisible();
    await assertNoSeriousAxeViolations(page);
    await goTo(page, 'Tasks');
    await openApproval(page);
    await assertNoSeriousAxeViolations(page);
    await page.keyboard.press('Escape');
  }
  await api.configure({ signedOut: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await assertNoSeriousAxeViolations(page);
  }
});

test('axe scans populated and empty run inspectors at all target widths', async ({ page, api }) => {
  test.setTimeout(120_000);
  api.configure();
  await openWorkspace(page, '#runs/run-old');
  await expect(page.getByText('3 events')).toBeVisible();
  const viewports = [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await assertNoSeriousAxeViolations(page);
    await page.screenshot({
      path: `/tmp/omnis-runs-inspector-populated-${viewport.width}.png`,
      fullPage: true,
    });
  }

  api.configure({ eventCount: 0 });
  await page.goto('/#runs/run-active');
  await expect(page.locator('.event-empty')).toBeVisible();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await assertNoSeriousAxeViolations(page);
    await page.screenshot({
      path: `/tmp/omnis-runs-inspector-empty-${viewport.width}.png`,
      fullPage: true,
    });
  }
});

test('captures all requested route screenshots for review', async ({ page, api }) => {
  api.configure({});
  await openWorkspace(page);
  await openTaskComposer(page);
  await goTo(page, 'Command Center');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    const tag = String(viewport.width);
    await goTo(page, 'Command Center');
    await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({ path: `/tmp/omnis-command-center-${tag}.png`, fullPage: true });
    await goTo(page, 'Tasks');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({ path: `/tmp/omnis-tasks-${tag}.png`, fullPage: true });
    await goTo(page, 'Runs');
    await page.getByRole('button', { name: /Review launch checklist/ }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({ path: `/tmp/omnis-runs-${tag}.png`, fullPage: true });
    await goTo(page, 'Tasks');
    await openApproval(page);
    await page.screenshot({ path: `/tmp/omnis-approval-${tag}.png`, fullPage: false });
    await page.keyboard.press('Escape');
  }
  await api.configure({ signedOut: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: '/tmp/omnis-signed-out-1440.png', fullPage: true });

  await api.configure({ tasks: [], runs: [] });
  await page.goto('/#tasks');
  await page.reload();
  await expect(page.getByText('No tasks yet')).toBeVisible();
  await page.screenshot({ path: '/tmp/omnis-tasks-empty-1440.png', fullPage: true });
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByText('No runs recorded')).toBeVisible();
  await page.screenshot({ path: '/tmp/omnis-runs-empty-1440.png', fullPage: true });

  await api.configure({ taskGetFailures: 1, runGetFailures: 1 });
  await page.goto('/#command-center');
  await page.reload();
  await expect(page.getByText('Tasks unavailable').first()).toBeVisible();
  await expect(page.getByText('Runs unavailable').first()).toBeVisible();
  await page.screenshot({ path: '/tmp/omnis-api-errors-1440.png', fullPage: true });

  await api.configure({ taskDelayMs: 1_800 });
  await page.goto('/#tasks');
  await page.reload();
  await expect(page.getByText('Loading tasks…')).toBeVisible();
  await page.screenshot({ path: '/tmp/omnis-tasks-loading-1440.png', fullPage: true });
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();

  await api.configure({ eventCount: 600 });
  await page.goto('/#runs/run-active');
  await page.reload();
  await expect(page.getByText('600 events')).toBeVisible();
  await page.screenshot({ path: '/tmp/omnis-runs-long-600.png', fullPage: true });
});

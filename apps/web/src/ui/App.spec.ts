import AxeBuilder from '@axe-core/playwright';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test as base, type Page, type Route } from '@playwright/test';
import {
  AcceptTaskResultRequestSchema,
  AuthorizationDecisionSchema,
  AuthorizationSchema,
  AgentDirectoryResponseSchema,
  CreateAuthorizationSchema,
  CreateRunSchema,
  CreateTaskSchema,
  RunEventSchema,
  RunSchema,
  AgentProfileVersionResponseSchema,
  SetTaskExecutionAssignmentSchema,
  TaskSchema,
  type Authorization,
  type ProjectSummary,
  type Run,
  type RunEvent,
  type Task,
  type TaskResultAcceptance,
} from '@omnis/contracts';
import {
  ConnectorAuthorizationDecisionSchema,
  ConnectorAuthorizationSchema,
  CreateConnectorAuthorizationSchema,
} from '@omnis/contracts/connector-authorization-schema';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/runtime-capabilities';

const now = '2026-11-03T10:00:00.000Z';
const csrfToken = 'csrf-browser-fixture-token';
const authorizationId = 'b7cece2c-2e6f-4b3b-92da-f0352c24debb';
const connectorAuthorizationId = 'd7cece2c-2e6f-4b3b-92da-f0352c24debb';
const connectorCorrelationId = 'e7cece2c-2e6f-4b3b-92da-f0352c24debb';

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

type AcceptBehavior =
  | 'ok'
  | 'lost-applied'
  | 'lost-not-applied'
  | 'concurrency-limit'
  | 'stale-conflict'
  | 'plain-conflict'
  | 'hold-ok'
  | 'hold-401'
  | 'unauthorized'
  | 'csrf';

type FixtureOptions = {
  /** Scripted POST /tasks/:id/accept-result outcomes, consumed in order; then `ok`. */
  acceptBehaviors?: AcceptBehavior[];
  acceptDelayMs?: number;
  /** After a 409, hold the task/run re-reads this long. */
  conflictReadHoldMs?: number;
  /** After a 409, hold the first task re-read until `api.releaseReads()`. */
  conflictReadsManual?: boolean;
  /** After a 409, fail this many task re-reads with 503. */
  conflictReadFailures?: number;
  /** The first event read finishes a running run and leaves its task in review, as the server does. */
  completeOnStream?: boolean;
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
  /** The session is revoked as the stream opens: the stream drops and authenticated reads 401. */
  eventRevoked?: boolean;
  eventOrder?: 'reverse';
  eventDuplicates?: boolean;
  syntheticEnabled?: boolean;
  /** Scripted native-EventSource scenario: deliver event 1, drop, then replay 1 and send 2. */
  eventReconnectScenario?: boolean;
  /** Synthetic connector authorization expiry (defaults to 20 minutes from now). */
  connectorExpiresAt?: string;
  /** How POST /connector-authorizations/:id/revoke behaves. Default: succeeds. */
  connectorRevoke?: ConnectorRevokeBehavior;
  connectorRevokeDelayMs?: number;
  /** Number of GET /connector-authorizations/:id requests to fail with 503. */
  connectorReadFailures?: number;
  connectorReadDelayMs?: number;
};

type ConnectorRevokeBehavior =
  | 'success'
  | 'already-revoked'
  | 'rejected-expired'
  | 'rejected-still-active'
  | 'lost-response-applied'
  | 'lost-response-not-applied'
  | 'unconfirming-response'
  | 'unauthorized';

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
  let currentConnectorAuthorization: ReturnType<typeof ConnectorAuthorizationSchema.parse> | null =
    null;
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
  let acceptBehaviors: AcceptBehavior[] = [];
  const acceptPosts: Array<{ taskId: string; key: string; body: { runId: string } }> = [];
  const acceptReceipts = new Map<string, TaskResultAcceptance>();
  let releaseAcceptGate = () => {};
  let acceptGate = new Promise<void>((resolve) => {
    releaseAcceptGate = resolve;
  });
  let acceptSettled = 0;
  let readsHeld = false;
  let releaseReadsGate = () => {};
  let readsGate = new Promise<void>((resolve) => {
    releaseReadsGate = resolve;
  });
  let afterConflict = false;
  let conflictReadFailures = 0;
  let currentOwnerId = 'owner';
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
  const connectorRevokeIds: string[] = [];
  let connectorReadFailures = 0;
  const eventRequestCursors: string[] = [];
  const eventRequestRunIds: string[] = [];
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
    currentConnectorAuthorization = null;
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
    acceptBehaviors = [...(options.acceptBehaviors ?? [])];
    acceptPosts.length = 0;
    acceptReceipts.clear();
    acceptGate = new Promise<void>((resolve) => {
      releaseAcceptGate = resolve;
    });
    acceptSettled = 0;
    readsHeld = false;
    readsGate = new Promise<void>((resolve) => {
      releaseReadsGate = resolve;
    });
    afterConflict = false;
    conflictReadFailures = options.conflictReadFailures ?? 0;
    currentOwnerId = 'owner';
    connectorRevokeIds.length = 0;
    connectorReadFailures = options.connectorReadFailures ?? 0;
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
        ? route.fulfill({ json: { id: currentOwnerId, displayName: 'Director' } })
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
    if (path === '/api/v1/runtime-capabilities' && method === 'GET') {
      return route.fulfill({
        json: RuntimeCapabilitiesSchema.parse({
          version: 'omnis.runtime-capabilities.v1',
          mockRuntime: { enabled: true, synthetic: true },
          syntheticConnectorFixture: {
            enabled: options.syntheticEnabled ?? false,
            providerId: 'synthetic',
            modelId: 'synthetic-text-only-v1',
            synthetic: true,
          },
        }),
      });
    }
    const profileMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/versions\/(\d+)$/);
    if (profileMatch && method === 'GET') {
      const version = {
        versionId: 'profile-version-3',
        agentId: profileMatch[1]!,
        versionNo: Number(profileMatch[2]),
        profession: 'Research Analyst',
        seniority: 'senior',
        specialties: ['research'],
        personality: { traits: ['careful'], tone: 'clear', principles: ['cite evidence'] },
        behavior: { autonomy: 'low', escalation: 'ask owner' },
        instructions: 'Summarize the supplied task.',
        createdBy: { id: 'owner', displayName: 'Director' },
        createdAt: now,
      };
      return route.fulfill({
        json: AgentProfileVersionResponseSchema.parse({
          agent: fixtureAgent,
          version,
          isCurrent: true,
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
      if (afterConflict && options.conflictReadsManual && !readsHeld) {
        readsHeld = true;
        await readsGate;
      }
      if (afterConflict && options.conflictReadHoldMs)
        await new Promise((resolve) => setTimeout(resolve, options.conflictReadHoldMs));
      if (afterConflict && conflictReadFailures > 0) {
        conflictReadFailures -= 1;
        return fulfillError(route, 503, 'tasks_unavailable', 'Tasks are temporarily unavailable.');
      }
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
    if (path === '/api/v1/connector-authorizations' && method === 'POST') {
      const input = CreateConnectorAuthorizationSchema.safeParse(body);
      const key = headers['idempotency-key'] ?? '';
      if (!input.success || !zodUuid(key))
        return fulfillError(
          route,
          400,
          'invalid_input',
          'Connector authorization input is invalid.',
        );
      const { renderedRequest, ...binding } = input.data;
      const digest = `sha256:${'a'.repeat(64)}`;
      currentConnectorAuthorization = ConnectorAuthorizationSchema.parse({
        id: connectorAuthorizationId,
        requestId: key,
        correlationId: connectorCorrelationId,
        requestingActor: 'owner',
        ...binding,
        promptDigest: digest,
        status: 'pending',
        policyVersion: 'r1p1-synthetic-connector-v1',
        createdAt: now,
        consentedAt: now,
        decidedAt: null,
        decidedBy: null,
        revokedAt: null,
        revokedBy: null,
        revocationGeneration: 0,
        expiresAt: options.connectorExpiresAt ?? new Date(Date.now() + 20 * 60_000).toISOString(),
        consumedAt: null,
        consumedRequestId: null,
        synthetic: true,
      });
      void renderedRequest;
      return route.fulfill({ status: 201, json: currentConnectorAuthorization });
    }
    const connectorAuthorizationMatch = path.match(
      /^\/api\/v1\/connector-authorizations\/([^/]+)$/,
    );
    if (connectorAuthorizationMatch && method === 'GET') {
      if (options.connectorReadDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.connectorReadDelayMs));
      if (connectorReadFailures > 0) {
        connectorReadFailures -= 1;
        return fulfillError(route, 503, 'unavailable', 'Authorization status is unavailable.');
      }
      return currentConnectorAuthorization?.id === connectorAuthorizationMatch[1]
        ? route.fulfill({ json: currentConnectorAuthorization })
        : fulfillError(route, 404, 'not_found', 'Connector authorization was not found.');
    }
    const connectorRevokeMatch = path.match(
      /^\/api\/v1\/connector-authorizations\/([^/]+)\/revoke$/,
    );
    if (connectorRevokeMatch && method === 'POST') {
      connectorRevokeIds.push(connectorRevokeMatch[1]!);
      if (options.connectorRevokeDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.connectorRevokeDelayMs));
      if (currentConnectorAuthorization?.id !== connectorRevokeMatch[1])
        return fulfillError(route, 404, 'not_found', 'Connector authorization was not found.');
      const applyRevocation = () => {
        currentConnectorAuthorization = ConnectorAuthorizationSchema.parse({
          ...currentConnectorAuthorization,
          status: 'revoked',
          revokedAt: now,
          revokedBy: 'owner',
          revocationGeneration: 1,
        });
      };
      switch (options.connectorRevoke ?? 'success') {
        case 'unauthorized':
          authenticated = false;
          return fulfillError(route, 401, 'unauthorized', 'Sign in to continue.');
        case 'rejected-expired':
          currentConnectorAuthorization = ConnectorAuthorizationSchema.parse({
            ...currentConnectorAuthorization,
            status: 'expired',
          });
          return fulfillError(
            route,
            409,
            'invalid_transition',
            'Only an active connector authorization can be revoked.',
          );
        case 'rejected-still-active':
          return fulfillError(
            route,
            409,
            'invalid_transition',
            'Only an active connector authorization can be revoked.',
          );
        case 'lost-response-applied':
          applyRevocation();
          return route.abort();
        case 'lost-response-not-applied':
          return route.abort();
        case 'unconfirming-response':
          return route.fulfill({ json: currentConnectorAuthorization });
        default:
          applyRevocation(); // 'success', and 'already-revoked' (the server answers 200 again)
          return route.fulfill({ json: currentConnectorAuthorization });
      }
    }
    const connectorDecisionMatch = path.match(
      /^\/api\/v1\/connector-authorizations\/([^/]+)\/decision$/,
    );
    if (connectorDecisionMatch && method === 'POST') {
      const decision = ConnectorAuthorizationDecisionSchema.safeParse(body);
      if (!decision.success || currentConnectorAuthorization?.id !== connectorDecisionMatch[1])
        return fulfillError(route, 400, 'invalid_input', 'Connector decision is invalid.');
      currentConnectorAuthorization = ConnectorAuthorizationSchema.parse({
        ...currentConnectorAuthorization,
        status: decision.data.decision === 'approve' ? 'authorized' : 'denied',
        decidedAt: now,
        decidedBy: 'owner',
      });
      return route.fulfill({ json: currentConnectorAuthorization });
    }
    const syntheticRunMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/synthetic-runs$/);
    if (syntheticRunMatch && method === 'POST') {
      if (!currentConnectorAuthorization || currentConnectorAuthorization.status !== 'authorized')
        return fulfillError(
          route,
          403,
          'authorization_denied',
          'An exact owner approval is required.',
        );
      if (headers['idempotency-key'] !== currentConnectorAuthorization.requestId)
        return fulfillError(
          route,
          409,
          'request_binding_failed',
          'Run request identity did not match.',
        );
      currentConnectorAuthorization = ConnectorAuthorizationSchema.parse({
        ...currentConnectorAuthorization,
        consumedAt: now,
        consumedRequestId: currentConnectorAuthorization.requestId,
      });
      const task = currentTasks.find((item) => item.id === syntheticRunMatch[1]);
      const run = RunSchema.parse(
        makeRun(
          connectorCorrelationId,
          syntheticRunMatch[1]!,
          task?.title ?? 'Synthetic task',
          'queued',
          connectorAuthorizationId,
        ),
      );
      currentRuns = [run, ...currentRuns];
      return route.fulfill({ status: 201, json: run });
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
    const acceptMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/accept-result$/);
    if (acceptMatch && method === 'POST') {
      const taskId = acceptMatch[1]!;
      const key = headers['idempotency-key'] ?? '';
      if (!zodUuid(key))
        return fulfillError(
          route,
          400,
          'invalid_input',
          'A valid UUID Idempotency-Key is required.',
        );
      const parsed = AcceptTaskResultRequestSchema.safeParse(body);
      if (!parsed.success)
        return fulfillError(route, 400, 'invalid_input', 'Accept payload is invalid.');
      acceptPosts.push({ taskId, key, body: parsed.data });
      if (options.acceptDelayMs) await new Promise((r) => setTimeout(r, options.acceptDelayMs));
      let behavior = acceptBehaviors.shift() ?? 'ok';
      if (behavior === 'hold-ok' || behavior === 'hold-401') {
        const held = behavior;
        await acceptGate;
        acceptSettled += 1;
        if (held === 'hold-401')
          return fulfillError(route, 401, 'unauthorized', 'Sign in to continue.');
        behavior = 'ok';
      }
      if (behavior === 'plain-conflict') {
        afterConflict = true;
        return fulfillError(route, 409, 'conflict', 'This run is no longer the current result.');
      }
      if (behavior === 'unauthorized') {
        authenticated = false;
        return fulfillError(route, 401, 'unauthorized', 'Sign in to continue.');
      }
      if (behavior === 'csrf')
        return fulfillError(route, 403, 'csrf', 'The request origin or CSRF token is invalid.');
      if (behavior === 'concurrency-limit')
        return fulfillError(route, 503, 'concurrency_limit', 'Mission Lane is busy. Retry.');
      if (behavior === 'lost-not-applied') return route.abort();
      const task = currentTasks.find((item) => item.id === taskId);
      if (!task) return fulfillError(route, 404, 'not_found', 'Task not found.');
      if (behavior === 'stale-conflict') {
        afterConflict = true;
        // A newer run exists: the task is back in progress and the offered run is stale.
        currentRuns = [
          makeRun('run-newer', taskId, task.title, 'running'),
          ...currentRuns.map((run) => ({ ...run, createdAt: '2026-11-03T09:00:00.000Z' })),
        ];
        currentTasks = currentTasks.map((item) =>
          item.id === taskId ? { ...item, status: 'in_progress' } : item,
        );
        return fulfillError(route, 409, 'conflict', 'This run is no longer the current result.');
      }
      let replay = acceptReceipts.get(taskId);
      if (!replay && task.status === 'in_review' && task.resultAcceptance) {
        // Backend contract (PHASE1_BACKEND_FRONTEND_HANDOFF.md): an owner replay for the same
        // latest run reconciles the task, keeps the original receipt and returns created: false.
        const newest = [...currentRuns]
          .filter((run) => run.taskId === taskId)
          .sort((x, y) => y.createdAt.localeCompare(x.createdAt) || y.id.localeCompare(x.id))[0];
        if (newest?.id === parsed.data.runId && task.resultAcceptance.runId === parsed.data.runId) {
          replay = task.resultAcceptance;
          currentTasks = currentTasks.map((item) =>
            item.id === taskId ? { ...item, status: 'completed' } : item,
          );
        }
      }
      let created = false;
      let receipt = replay;
      if (!receipt) {
        const latest = [...currentRuns]
          .filter((run) => run.taskId === taskId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
        if (task.status !== 'in_review' || latest?.id !== parsed.data.runId)
          return fulfillError(route, 409, 'conflict', 'This task is not awaiting review.');
        receipt = {
          runId: parsed.data.runId,
          acceptedBy: 'owner',
          acceptedAt: now,
          requestId: key,
        };
        acceptReceipts.set(taskId, receipt);
        created = true;
        currentTasks = currentTasks.map((item) =>
          item.id === taskId
            ? { ...item, status: 'completed', resultAcceptance: receipt ?? null }
            : item,
        );
      }
      if (behavior === 'lost-applied') return route.abort();
      const updated = TaskSchema.parse(currentTasks.find((item) => item.id === taskId));
      return route.fulfill({ json: { task: updated, acceptance: receipt, created } });
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
      eventRequestRunIds.push(eventMatch[1]!);
      if (options.eventRevoked) {
        authenticated = false;
        return route.abort();
      }
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
      let streamRun = run;
      if (options.completeOnStream && run.status === 'running') {
        streamRun = { ...run, status: 'completed' };
        currentRuns = currentRuns.map((item) => (item.id === run.id ? streamRun : item));
        currentTasks = currentTasks.map((item) =>
          item.id === run.taskId ? { ...item, status: 'in_review' } : item,
        );
      }
      const events = makeEvents(streamRun).filter((event) => event.sequence > after);
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
      if (!authenticated) return fulfillError(route, 401, 'unauthorized', 'Sign in to continue.');
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
    acceptPosts,
    releaseAccept: () => releaseAcceptGate(),
    releaseReads: () => releaseReadsGate(),
    get acceptSettled() {
      return acceptSettled;
    },
    setOwnerId: (id: string) => {
      currentOwnerId = id;
    },
    connectorRevokeIds,
    eventRequestCursors,
    eventRequestRunIds,
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

test('reviews an exact synthetic operation, explicitly approves it, and starts one persisted Run', async ({
  page,
  api,
}) => {
  const task = TaskSchema.parse({
    ...makeTask('task-synthetic', 'Summarize policy changes'),
    projectId: defaultProjects[0]!.id,
    associationRevision: 1,
    agentId: 'agent-analyst',
    profileVersion: 3,
    runtimeId: 'mock',
  });
  api.configure({ tasks: [task], runs: [], syntheticEnabled: true });
  await openWorkspace(page, '#tasks');
  await page.getByRole('button', { name: 'Load available projects' }).click();
  await page.getByRole('button', { name: 'Summarize policy changes' }).click();
  await page.getByRole('button', { name: 'Review synthetic operation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review synthetic operation' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('synthetic / synthetic-text-only-v1')).toBeVisible();
  await expect(dialog.locator('#synthetic-rendered-request')).toContainText(
    'Summarize policy changes',
  );
  await expect(dialog.getByText(/sha256:a{64}/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve exact operation' }).click();
  await expect(
    page.getByText('Exact synthetic operation approved. No run has started yet.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Start authorized synthetic Run' }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByText(connectorCorrelationId)).toBeVisible();
  expect(api.runs[0]?.id).toBe(connectorCorrelationId);
  expect(
    api.requests.find((item) => item.path === '/api/v1/connector-authorizations')?.headers[
      'x-omnis-csrf'
    ],
  ).toBe(csrfToken);
  const runRequest = api.requests.find(
    (item) => item.path === `/api/v1/tasks/${task.id}/synthetic-runs`,
  );
  expect(runRequest?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(
    api.requests.filter((item) => item.path === `/api/v1/tasks/${task.id}/synthetic-runs`),
  ).toHaveLength(1);
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

test('a session revoked while streaming returns to sign-in and stops reconnecting', async ({
  page,
  api,
}) => {
  test.setTimeout(20_000);
  api.configure({ eventRevoked: true });
  await openWorkspace(page, '#runs/run-active');
  await expect(page.getByRole('alert')).toContainText('session expired');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  // No run action survives the expiry, and the stream is not hammered afterwards.
  await expect(page.getByRole('button', { name: /Stop/ })).toHaveCount(0);
  const seen = api.eventRequestCursors.length;
  await page.waitForTimeout(2500);
  expect(api.eventRequestCursors.length).toBe(seen);
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

const revocableTask = () =>
  TaskSchema.parse({
    ...makeTask('task-synthetic', 'Summarize policy changes'),
    projectId: defaultProjects[0]!.id,
    associationRevision: 1,
    agentId: 'agent-analyst',
    profileVersion: 3,
    runtimeId: 'mock',
  });

async function openSyntheticReview(page: Page, api: MockApi, options: FixtureOptions = {}) {
  api.configure({ tasks: [revocableTask()], runs: [], syntheticEnabled: true, ...options });
  await openWorkspace(page, '#tasks');
  await page.getByRole('button', { name: 'Load available projects' }).click();
  await page.getByRole('button', { name: 'Summarize policy changes' }).click();
  await page.getByRole('button', { name: 'Review synthetic operation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review synthetic operation' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function approveExactOperation(dialog: ReturnType<Page['getByRole']>) {
  await dialog.getByRole('button', { name: 'Approve exact operation' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
  ).toBeVisible();
}

const syntheticRunPosts = (api: MockApi) =>
  api.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/synthetic-runs'));

test.describe('synthetic approval expiry timezone', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('shows the approval expiry in Asia/Manila (PHT) whatever the browser timezone', async ({
    page,
    api,
  }) => {
    // 2026-11-03T20:30:00Z is 12:30 PM in Los Angeles but 4:30 AM on Nov 4 in Manila.
    const expiresAt = '2026-11-03T20:30:00.000Z';
    const dialog = await openSyntheticReview(page, api, { connectorExpiresAt: expiresAt });
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
      'America/Los_Angeles',
    );
    const expiry = dialog.locator('time');
    await expect(expiry).toHaveAttribute('datetime', expiresAt);
    await expect(expiry).toHaveText(/^Nov 4, 2026, 4:30:00\s?am PHT$/i);
    await expect(dialog).not.toContainText('12:30');
  });
});

test.describe('synthetic approval revocation', () => {
  test('is offered only for an approved, unused, unexpired approval', async ({ page, api }) => {
    const dialog = await openSyntheticReview(page, api);
    await expect(dialog.getByRole('button', { name: 'Revoke approval' })).toHaveCount(0);
    await approveExactOperation(dialog);
    await expect(dialog.getByRole('button', { name: 'Revoke approval' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeEnabled();
  });

  test('is not offered when the approval has already expired', async ({ page, api }) => {
    const dialog = await openSyntheticReview(page, api, {
      connectorExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await approveExactOperation(dialog);
    await expect(dialog.getByRole('button', { name: 'Revoke approval' })).toHaveCount(0);
  });

  test('asks for deliberate confirmation, can be cancelled, and is keyboard and axe clean', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api);
    await approveExactOperation(dialog);
    const revoke = dialog.getByRole('button', { name: 'Revoke approval' });
    await revoke.click();
    const confirm = dialog.getByRole('region', { name: 'Revoke this approval?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('does not stop, cancel or change any Run');
    await expect(confirm.getByRole('button', { name: 'Keep approval' })).toBeFocused();
    await assertNoSeriousAxeViolations(page);
    expect(api.connectorRevokeIds).toEqual([]);

    await confirm.getByRole('button', { name: 'Keep approval' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(revoke).toBeFocused();

    await revoke.click();
    await page.keyboard.press('Escape'); // closes the confirmation only, not the dialog
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(revoke).toBeFocused();
    expect(api.connectorRevokeIds).toEqual([]);
    expect(syntheticRunPosts(api)).toHaveLength(0);
  });

  test('revokes with the owner session and CSRF, announces it, and blocks any run', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api);
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();

    await expect(
      dialog
        .getByRole('status')
        .filter({ hasText: 'Approval revoked. It can no longer be used, and no Run was started' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Revoke approval' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    expect(api.connectorRevokeIds).toEqual([connectorAuthorizationId]);
    const revokeRequest = api.requests.find((item) => item.path.endsWith('/revoke'));
    expect(revokeRequest?.method).toBe('POST');
    expect(revokeRequest?.headers['x-omnis-csrf']).toBe(csrfToken);
    expect(syntheticRunPosts(api)).toHaveLength(0);

    // A revoked approval cannot be resumed: closing and reviewing again prepares a new operation.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Review synthetic operation' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Review synthetic operation' }).getByRole('button', {
        name: 'Approve exact operation',
      }),
    ).toBeVisible();
    expect(
      api.requests.filter(
        (item) => item.method === 'POST' && item.path === '/api/v1/connector-authorizations',
      ),
    ).toHaveLength(2);
  });

  test('an idempotent already-revoked answer is accepted as revoked', async ({ page, api }) => {
    const dialog = await openSyntheticReview(page, api, { connectorRevoke: 'already-revoked' });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(
      dialog.getByText('This approval was revoked and can no longer be used.'),
    ).toBeVisible();
  });

  test('a rejected revocation of an expired approval shows its real state and allows no run', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api, { connectorRevoke: 'rejected-expired' });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'The approval was not revoked. Only an active connector authorization can be revoked.',
    );
    await expect(
      dialog.getByText('This authorization is expired; create a new operation'),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toHaveCount(0);
    expect(syntheticRunPosts(api)).toHaveLength(0);
  });

  test('a lost response that was applied is confirmed by re-reading the approval', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api, {
      connectorRevoke: 'lost-response-applied',
    });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Approval confirmed revoked.' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toHaveCount(0);
    expect(api.connectorRevokeIds).toHaveLength(1);
  });

  test('a lost response that was not applied reports the approval as still active', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api, {
      connectorRevoke: 'lost-response-not-applied',
    });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'The revocation did not take effect. This approval is still active.',
    );
    await expect(dialog.getByText(/approval revoked/i)).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toBeEnabled();
  });

  test('an unresolved outcome blocks every action until the status is re-checked', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api, {
      connectorRevoke: 'lost-response-applied',
      connectorReadFailures: 1,
    });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Do not assume the approval was revoked.',
    );
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Revoke approval' })).toHaveCount(0);
    expect(syntheticRunPosts(api)).toHaveLength(0);

    await dialog.getByRole('button', { name: 'Check approval status' }).click();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Approval confirmed revoked.' }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Check approval status' })).toHaveCount(0);
  });

  test('a response that does not confirm revocation is never reported as success', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api, {
      connectorRevoke: 'unconfirming-response',
    });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(dialog.getByRole('alert')).toContainText('The revocation did not take effect.');
    await expect(dialog.getByText(/Approval revoked\./)).toHaveCount(0);
  });

  test('rapid double activation sends a single revocation request', async ({ page, api }) => {
    const dialog = await openSyntheticReview(page, api, { connectorRevokeDelayMs: 600 });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    const confirm = dialog.getByRole('button', { name: 'Confirm revoke' });
    await confirm.evaluate((element) => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(dialog.getByRole('button', { name: 'Revoking approval…' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeDisabled();
    await expect(
      dialog.getByText('This approval was revoked and can no longer be used.'),
    ).toBeVisible();
    expect(api.connectorRevokeIds).toHaveLength(1);
  });

  test('a 401 while revoking uses the existing sign-out flow', async ({ page, api }) => {
    const dialog = await openSyntheticReview(page, api, { connectorRevoke: 'unauthorized' });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(syntheticRunPosts(api)).toHaveLength(0);
  });

  test('start and close behave as before when the approval is not revoked', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api);
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    // Existing behaviour: reopening prepares a fresh operation that needs its own approval.
    await page.getByRole('button', { name: 'Resume operation review' }).click();
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Start authorized synthetic Run' }).click();
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    expect(syntheticRunPosts(api)).toHaveLength(1);
    expect(api.connectorRevokeIds).toEqual([]);
  });
});

test.describe('synthetic approval revocation fails closed', () => {
  const read = (api: MockApi) =>
    api.requests.filter(
      (item) =>
        item.method === 'GET' &&
        item.path === `/api/v1/connector-authorizations/${connectorAuthorizationId}`,
    );

  test('a rejected revoke whose status read fails stays closed until the status is confirmed', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api, {
      connectorRevoke: 'rejected-expired',
      connectorReadFailures: 1,
    });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();

    // The backend refused, but a refusal does not say what the approval's state is.
    await expect(dialog.getByRole('alert')).toContainText(
      /rejected the revoke request, but this approval's current status could not be confirmed/,
    );
    await expect(dialog.getByRole('alert')).toContainText('Do not rely on the approval shown');
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Revoke approval' })).toHaveCount(0);
    await expect(dialog.getByText(/approval revoked/i)).toHaveCount(0);
    expect(syntheticRunPosts(api)).toHaveLength(0);

    // A later successful read is authoritative: the approval turned out to be expired.
    await dialog.getByRole('button', { name: 'Check approval status' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Its status is now expired.');
    await expect(
      dialog.getByText('This authorization is expired; create a new operation'),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Check approval status' })).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toHaveCount(0);
    expect(syntheticRunPosts(api)).toHaveLength(0);
  });

  test('a rejected revoke that reconciles to a still-active approval re-enables the actions', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api, {
      connectorRevoke: 'rejected-still-active',
      connectorReadFailures: 1,
    });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toBeDisabled();

    await dialog.getByRole('button', { name: 'Check approval status' }).click();
    await expect(dialog.getByRole('alert')).toContainText('The approval was not revoked.');
    await expect(dialog.getByRole('alert')).toContainText('It is still active.');
    await expect(
      dialog.getByRole('button', { name: 'Start authorized synthetic Run' }),
    ).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Revoke approval' })).toBeVisible();
    expect(api.connectorRevokeIds).toHaveLength(1);
  });

  test('duplicate activation cannot send a second status read or revoke while unresolved', async ({
    page,
    api,
  }) => {
    const dialog = await openSyntheticReview(page, api, {
      connectorRevoke: 'lost-response-not-applied',
      connectorReadFailures: 1,
      connectorReadDelayMs: 500,
    });
    await approveExactOperation(dialog);
    await dialog.getByRole('button', { name: 'Revoke approval' }).click();
    await dialog.getByRole('button', { name: 'Confirm revoke' }).click();
    const check = dialog.getByRole('button', { name: 'Check approval status' });
    await expect(check).toBeEnabled();
    expect(read(api)).toHaveLength(1); // the failed read made by the revoke itself

    await check.evaluate((element) => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText('This approval is still active.');
    expect(read(api)).toHaveLength(2); // exactly one more
    expect(api.connectorRevokeIds).toHaveLength(1); // and no second revoke
    expect(syntheticRunPosts(api)).toHaveLength(0);
  });
});

test.describe('R1 owner result acceptance', () => {
  const reviewTask = makeTask('task-review', 'Review quarterly notes', 'in_review');
  const reviewRun = makeRun('run-review', 'task-review', 'Review quarterly notes');
  const accept = (page: Page) => page.getByRole('button', { name: 'Accept Result' });
  const confirmGroup = (page: Page) =>
    page.getByRole('group', { name: 'Confirm result acceptance' });
  const openReview = async (page: Page, hash = '#runs/run-review') => {
    await openWorkspace(page, hash);
    await expect(page.getByRole('complementary', { name: 'Run inspector' })).toBeVisible();
  };

  test('every task status has its own label and in_review is not Completed', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [
        makeTask('t-open', 'Open one'),
        makeTask('t-prog', 'Progress one', 'in_progress'),
        reviewTask,
        makeTask('t-done', 'Done one', 'completed'),
      ],
      runs: [],
    });
    await openWorkspace(page);
    await page.getByRole('link', { name: 'Tasks' }).click();
    const row = (title: string) => page.getByRole('listitem').filter({ hasText: title });
    await expect(row('Open one').locator('.status-pill')).toHaveText('Open');
    await expect(row('Progress one').locator('.status-pill')).toHaveText('In Progress');
    await expect(row('Review quarterly notes').locator('.status-pill')).toHaveText(
      'Awaiting review',
    );
    await expect(row('Done one').locator('.status-pill')).toHaveText('Completed');
    await expect(row('Review quarterly notes').locator('.status-pill')).not.toHaveText(/Completed/);
    // A task awaiting review can still be re-run through the normal approval path.
    await expect(
      row('Review quarterly notes').getByRole('button', { name: 'Approve & run' }),
    ).toBeEnabled();
  });

  test('a finished run leaves the task awaiting review with an Accept Result action', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun] });
    await openReview(page);
    await expect(page.getByText('Awaiting your review.')).toBeVisible();
    await expect(page.getByText('the task is not completed')).toBeVisible();
    await expect(accept(page)).toBeVisible();
    await expect(confirmGroup(page)).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(0);
    await assertNoSeriousAxeViolations(page);
  });

  test('Command Center and the task detail point the owner at the pending review', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun] });
    await openWorkspace(page);
    await expect(page.getByRole('heading', { name: /Awaiting your review/ })).toBeVisible();
    await page.getByRole('button', { name: 'Review result of Review quarterly notes' }).click();
    await expect(page).toHaveURL(/#runs\/run-review$/);
    await expect(accept(page)).toBeVisible();
    await page.getByRole('link', { name: 'Tasks' }).click();
    await page.getByRole('button', { name: /Review quarterly notes/ }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Awaiting your review' }),
    ).toBeVisible();
  });

  test('issue #106: an in_review task with an existing receipt shows the receipt and no Accept Result', async ({
    page,
    api,
  }) => {
    const restored = {
      ...reviewTask,
      resultAcceptance: {
        runId: 'run-review',
        acceptedBy: 'owner' as const,
        acceptedAt: '2026-11-03T10:00:00.000Z',
        requestId: '00000000-0000-4000-8000-000000000000',
      },
    };
    api.configure({ tasks: [restored], runs: [reviewRun] });
    await openReview(page);
    await expect(page.getByRole('heading', { name: 'Owner receipt on record.' })).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await expect(page.getByText('Awaiting your review.')).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(0);
    await assertNoSeriousAxeViolations(page);
    const shots = process.env.OMNIS_SHOT_DIR;
    if (shots) {
      await page
        .locator('.accept-result')
        .screenshot({ path: `${shots}/receipt-in-review-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .locator('.accept-result')
        .screenshot({ path: `${shots}/receipt-in-review-390.png` });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    // Command Center no longer lists it as awaiting the owner; the task detail says why.
    await page.getByRole('link', { name: 'Command Center' }).click();
    await expect(
      page.getByRole('button', { name: 'Review result of Review quarterly notes' }),
    ).toHaveCount(0);
    await page.getByRole('link', { name: 'Tasks' }).click();
    await page.getByRole('button', { name: /Review quarterly notes/ }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'already exists, but the task still reads in review' }),
    ).toBeVisible();
  });

  const receiptFor = (runId: string) => ({
    runId,
    acceptedBy: 'owner' as const,
    acceptedAt: '2026-11-03T10:00:00.000Z',
    requestId: '00000000-0000-4000-8000-000000000000',
  });
  const restoredTask = { ...reviewTask, resultAcceptance: receiptFor('run-review') };
  const reconcile = (page: Page) => page.getByRole('button', { name: 'Reconcile task status' });
  const confirmReconcile = (page: Page) =>
    page.getByRole('group', { name: 'Confirm task status reconciliation' });

  test('reconcile: deliberate two-step action reuses the same run, keeps the receipt, shows the server task', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [restoredTask], runs: [reviewRun] });
    await openReview(page);
    await expect(reconcile(page)).toBeVisible();
    const shots = process.env.OMNIS_SHOT_DIR;
    if (shots)
      await page.locator('.accept-result').screenshot({ path: `${shots}/reconcile-action.png` });
    await reconcile(page).click();
    if (shots)
      await page.locator('.accept-result').screenshot({ path: `${shots}/reconcile-confirm.png` });
    // Nothing is sent until the owner confirms; Cancel is the safe default focus.
    expect(api.acceptPosts).toHaveLength(0);
    await expect(confirmReconcile(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirmReconcile(page).getByRole('button', { name: 'Confirm reconciliation' }).click();
    await expect(page.getByRole('heading', { name: 'Result accepted by owner.' })).toBeFocused();
    expect(api.acceptPosts).toHaveLength(1);
    expect(api.acceptPosts[0]!.body).toEqual({ runId: 'run-review' });
    // The original receipt is unchanged (not re-stamped) and the task now reads Completed.
    await expect(page.getByText('Nov 3, 2026, 6:00:00 PM PHT')).toBeVisible();
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: 'Review quarterly notes' })
        .locator('.status-pill'),
    ).toHaveText('Completed');
  });

  test('reconcile: cancelling sends nothing and rapid clicks submit once', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [restoredTask], runs: [reviewRun], acceptDelayMs: 400 });
    await openReview(page);
    await reconcile(page).click();
    await confirmReconcile(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(reconcile(page)).toBeFocused();
    expect(api.acceptPosts).toHaveLength(0);
    await reconcile(page).click();
    const confirm = confirmReconcile(page).getByRole('button', {
      name: /Confirm reconciliation|Reconciling/,
    });
    await confirm.evaluate((element) => {
      for (let i = 0; i < 4; i += 1)
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(page.getByRole('heading', { name: 'Result accepted by owner.' })).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('reconcile: a receipt for an older run is never reconciled against a newer run', async ({
    page,
    api,
  }) => {
    const older = { ...makeRun('run-old', 'task-review', 'Review quarterly notes') };
    older.createdAt = '2026-11-03T08:00:00.000Z';
    api.configure({
      tasks: [{ ...reviewTask, resultAcceptance: receiptFor('run-old') }],
      runs: [reviewRun, older],
    });
    await openReview(page, '#runs/run-old');
    await expect(reconcile(page)).toHaveCount(0);
    await expect(page.getByText('A newer run exists for this task.')).toBeVisible();
    // The newer run has no receipt of its own, so it is a normal review, not a reconciliation.
    await openReview(page, '#runs/run-review');
    await expect(reconcile(page)).toHaveCount(0);
    await expect(accept(page)).toBeVisible();
    expect(api.acceptPosts).toHaveLength(0);
  });

  test('reconcile: a 409 refreshes from the server and offers nothing stale', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [restoredTask],
      runs: [reviewRun],
      acceptBehaviors: ['stale-conflict'],
    });
    await openReview(page);
    await reconcile(page).click();
    await confirmReconcile(page).getByRole('button', { name: 'Confirm reconciliation' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'no longer the current result' }),
    ).toBeVisible();
    await expect(reconcile(page)).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('reconcile: 403 is shown as a rejection without signing out or retrying', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [restoredTask], runs: [reviewRun], acceptBehaviors: ['csrf'] });
    await openReview(page);
    await reconcile(page).click();
    await confirmReconcile(page).getByRole('button', { name: 'Confirm reconciliation' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'CSRF' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('reconcile: an expired session returns to sign-in and the task is not changed locally', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [restoredTask], runs: [reviewRun], acceptBehaviors: ['unauthorized'] });
    await openReview(page);
    await reconcile(page).click();
    await confirmReconcile(page).getByRole('button', { name: 'Confirm reconciliation' }).click();
    await expect(page.getByRole('alert')).toContainText('session expired');
    await expect(page.getByRole('heading', { name: 'Result accepted by owner.' })).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('reconcile: an uncertain outcome reads server state first and never auto-retries', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [restoredTask], runs: [reviewRun], acceptBehaviors: ['lost-applied'] });
    await openReview(page);
    await reconcile(page).click();
    await confirmReconcile(page).getByRole('button', { name: 'Confirm reconciliation' }).click();
    // The reconciliation did apply, and the authoritative re-read shows it; no second POST.
    await expect(page.getByRole('heading', { name: 'Result accepted by owner.' })).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('reconcile: an ambiguous 503 keeps one idempotency key for the explicit retry', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [restoredTask],
      runs: [reviewRun],
      acceptBehaviors: ['concurrency-limit'],
    });
    await openReview(page);
    await reconcile(page).click();
    await confirmReconcile(page).getByRole('button', { name: 'Confirm reconciliation' }).click();
    const retry = confirmReconcile(page).getByRole('button', { name: 'Retry reconciliation' });
    await expect(retry).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
    await retry.click();
    await expect(page.getByRole('heading', { name: 'Result accepted by owner.' })).toBeVisible();
    expect(api.acceptPosts).toHaveLength(2);
    expect(new Set(api.acceptPosts.map((entry) => entry.key)).size).toBe(1);
  });

  test("reconcile: a late response for run A never recreates or corrupts run B's event stream", async ({
    page,
    api,
  }) => {
    // B is also completed, so the review panel stays mounted while the owner moves from A to B and
    // A's response can still settle into the same component.
    const runB = makeRun('run-b', 'task-b', 'Second task', 'completed');
    api.configure({
      tasks: [restoredTask, makeTask('task-b', 'Second task', 'completed')],
      runs: [reviewRun, runB],
      acceptDelayMs: 1200,
    });
    await openReview(page);
    await reconcile(page).click();
    await confirmReconcile(page).getByRole('button', { name: 'Confirm reconciliation' }).click();
    await expect.poll(() => api.acceptPosts.length).toBe(1);
    // The owner moves to run B before A's response settles.
    await page.evaluate(() => {
      window.location.hash = '#runs/run-b';
    });
    await expect(page.locator('.event-row')).toHaveCount(3);
    const streamsFor = (id: string) =>
      api.eventRequestRunIds.filter((entry) => entry === id).length;
    expect(streamsFor('run-b')).toBe(1);
    // Let A's late response land, then give any wrongly scheduled stream refresh time to act.
    await page.waitForTimeout(2500);
    expect(api.acceptPosts).toHaveLength(1);
    // B's stream was opened once and not recreated by A's response; B still shows its own events.
    expect(streamsFor('run-b')).toBe(1);
    await expect(page.locator('.event-row')).toHaveCount(3);
    // The reconciliation of A reached the server once and its task was updated from the response.
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: 'Review quarterly notes' })
        .locator('.status-pill'),
    ).toHaveText('Completed');
  });

  test('ineligible results get no action: not latest, still in progress, failed, historical', async ({
    page,
    api,
  }) => {
    const older = { ...makeRun('run-old-1', 'task-review', 'Review quarterly notes') };
    older.createdAt = '2026-11-03T08:00:00.000Z';
    api.configure({
      tasks: [
        reviewTask,
        makeTask('t-prog', 'Progress one', 'in_progress'),
        makeTask('t-hist', 'Historic one', 'completed'),
        makeTask('t-fail', 'Failed one', 'in_progress'),
      ],
      runs: [
        reviewRun,
        older,
        makeRun('r-prog', 't-prog', 'Progress one'),
        makeRun('r-hist', 't-hist', 'Historic one'),
        makeRun('r-fail', 't-fail', 'Failed one', 'failed'),
      ],
    });
    await openReview(page, '#runs/run-old-1');
    await expect(accept(page)).toHaveCount(0);
    await expect(page.getByText('A newer run exists for this task.')).toBeVisible();

    await page.goto('/#runs/r-prog');
    await expect(page.getByText('r-prog').first()).toBeVisible();
    await expect(accept(page)).toHaveCount(0);

    await page.goto('/#runs/r-fail');
    await expect(page.getByText('r-fail').first()).toBeVisible();
    await expect(accept(page)).toHaveCount(0);

    await page.goto('/#runs/r-hist');
    await expect(page.getByText('r-hist').first()).toBeVisible();
    await expect(page.getByText('completed before owner acceptance was recorded')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(0);
  });

  test('acceptance needs a deliberate second step that is keyboard operable and cancellable', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun] });
    await openReview(page);
    await accept(page).focus();
    await page.keyboard.press('Enter');
    const group = confirmGroup(page);
    await expect(group).toContainText('run-review');
    await expect(group).toContainText('Review quarterly notes');
    // Safe default focus: Cancel, never the consequential action.
    await expect(group.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(group).toHaveCount(0);
    await expect(accept(page)).toBeFocused();
    await accept(page).click();
    await group.getByRole('button', { name: 'Cancel' }).press('Enter');
    await expect(group).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(0);
    await expect(api.tasks[0]?.status).toBe('in_review');
  });

  test('confirming sends the secure request and shows the server outcome as completed', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun] });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(1);
    const post = api.requests.find((entry) => entry.path.endsWith('/accept-result'));
    expect(post?.path).toBe('/api/v1/tasks/task-review/accept-result');
    expect(post?.headers['x-omnis-csrf']).toBe(csrfToken);
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(post?.body).toEqual({ runId: 'run-review' });
    // Server timestamp, rendered in Philippine time.
    await expect(page.locator('.accept-result-receipt')).toContainText('PHT');
    await expect(page.locator('.accept-result-receipt')).toContainText('6:00');
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: 'Review quarterly notes' })
        .locator('.status-pill'),
    ).toHaveText('Completed');
    await expect(page.getByText('Owner accepted run run-review')).toBeVisible();
  });

  test('rapid repeated clicks submit one acceptance and show progress', async ({ page, api }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptDelayMs: 400 });
    await openReview(page);
    await accept(page).click();
    const confirm = confirmGroup(page).getByRole('button', {
      name: /Confirm acceptance|Accepting/,
    });
    await confirm.evaluate((element) => {
      for (let i = 0; i < 4; i += 1)
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(confirmGroup(page).getByRole('button', { name: 'Accepting…' })).toBeDisabled();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('keyboard focus stays on Confirm while acceptance is pending, and Escape cannot cancel it', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptDelayMs: 600 });
    await openReview(page);
    await accept(page).click();
    const confirm = confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' });
    await confirm.focus();
    await page.keyboard.press('Enter');
    const pending = confirmGroup(page).getByRole('button', { name: 'Accepting…' });
    await expect(pending).toBeFocused();
    await expect(pending).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(confirmGroup(page)).toBeVisible();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('an uncertain response is not reported as success and the retry reuses the same key', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [reviewTask],
      runs: [reviewRun],
      acceptBehaviors: ['concurrency-limit', 'concurrency-limit'],
    });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByRole('alert')).toContainText('may or may not have been accepted');
    await expect(page.getByText('Result accepted by owner.')).toHaveCount(0);
    await confirmGroup(page).getByRole('button', { name: 'Retry acceptance' }).click();
    await expect(page.getByRole('alert')).toContainText('Mission Lane is busy');
    await confirmGroup(page).getByRole('button', { name: 'Retry acceptance' }).click();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    expect(api.acceptPosts).toHaveLength(3);
    expect(new Set(api.acceptPosts.map((entry) => entry.key)).size).toBe(1);
  });

  test('a lost response that did apply is learned from an authoritative re-read, not a blind retry', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptBehaviors: ['lost-applied'] });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('a network failure that never applied can be retried with the same key', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [reviewTask],
      runs: [reviewRun],
      acceptBehaviors: ['lost-not-applied'],
    });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByRole('alert')).toContainText("Can't reach Omnis OS");
    await confirmGroup(page).getByRole('button', { name: 'Retry acceptance' }).click();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    expect(api.acceptPosts).toHaveLength(2);
    expect(api.acceptPosts[1]?.key).toBe(api.acceptPosts[0]?.key);
  });

  test('a stale-run conflict refreshes the task and runs and offers no action on the old run', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptBehaviors: ['stale-conflict'] });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByRole('alert')).toContainText('no longer the current result');
    await expect(page.getByText('The task and runs were refreshed from the server.')).toBeVisible();
    await expect(page.getByText('A newer run exists for this task.')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await expect(page.getByText('Result accepted by owner.')).toHaveCount(0);
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('a lost session signs the owner out without reporting acceptance, and keeps the key', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptBehaviors: ['unauthorized'] });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await expect(page.getByText('Result accepted by owner.')).toHaveCount(0);
    await page.getByLabel('Owner password').fill('fixture-owner-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    expect(api.acceptPosts).toHaveLength(2);
    expect(api.acceptPosts[1]?.key).toBe(api.acceptPosts[0]?.key);
  });

  test('an authorization failure keeps the session, reports the error, and a new attempt gets a new key', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptBehaviors: ['csrf'] });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByRole('alert')).toContainText('CSRF');
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await expect(page.getByText('Result accepted by owner.')).toHaveCount(0);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    expect(api.acceptPosts).toHaveLength(2);
    expect(api.acceptPosts[1]?.key).not.toBe(api.acceptPosts[0]?.key);
  });

  test('after a mock rerun only the latest run can be accepted and the receipt belongs to it', async ({
    page,
    api,
  }) => {
    const first = makeRun('run-first', 'task-review', 'Review quarterly notes');
    first.createdAt = '2026-11-03T08:00:00.000Z';
    const second = makeRun('run-second', 'task-review', 'Review quarterly notes');
    api.configure({ tasks: [reviewTask], runs: [first, second] });
    await openReview(page, '#runs/run-first');
    await expect(accept(page)).toHaveCount(0);
    await page.goto('/#runs/run-second');
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByText('Result accepted by owner.')).toBeVisible();
    expect(api.acceptPosts[0]?.body).toEqual({ runId: 'run-second' });
    // The earlier run never shows the later run's receipt.
    await page
      .getByRole('button', { name: /Review quarterly notes/ })
      .first()
      .click();
    await page.goto('/#runs/run-first');
    await expect(page.getByText('Result accepted by owner.')).toHaveCount(0);
    await expect(page.getByText('A newer run exists for this task.')).toBeVisible();
  });

  test('a live run that completes surfaces the review state without a reload', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [makeTask('task-live', 'Live task', 'in_progress')],
      runs: [makeRun('run-live', 'task-live', 'Live task', 'running')],
      completeOnStream: true,
    });
    await openReview(page, '#runs/run-live');
    // The stream delivers run.completed; the run and its task are re-read from the API.
    await expect(accept(page)).toBeVisible();
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Live task' }).locator('.status-pill'),
    ).toHaveText('Awaiting review');
  });

  test('the review panel fits a narrow phone viewport and keeps targets reachable', async ({
    page,
    api,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    api.configure({ tasks: [reviewTask], runs: [reviewRun] });
    await openReview(page);
    await accept(page).scrollIntoViewIfNeeded();
    await accept(page).click();
    await expect(confirmGroup(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await confirmGroup(page)
      .getByRole('button', { name: 'Confirm acceptance' })
      .boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
    await assertNoSeriousAxeViolations(page);
  });

  const signOutAndBackIn = async (page: Page) => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await page.getByLabel('Owner password').fill('fixture-owner-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  };
  const startHeldAcceptance = async (page: Page) => {
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(confirmGroup(page).getByRole('button', { name: 'Accepting…' })).toBeDisabled();
  };
  const settle = async (page: Page, api: MockApi, count = 1) => {
    api.releaseAccept();
    await expect.poll(() => api.acceptSettled).toBe(count);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
  };

  for (const [name, otherOwner] of [
    ['the same owner signing out and back in', null],
    ['a different owner signing in', 'owner-two'],
  ] as const) {
    test(`a delayed 401 for ${name} does not expire the replacement session`, async ({
      page,
      api,
    }) => {
      api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptBehaviors: ['hold-401'] });
      await startHeldAcceptance(page);
      if (otherOwner) api.setOwnerId(otherOwner);
      await signOutAndBackIn(page);
      await settle(page, api);
      await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Welcome back.' })).toHaveCount(0);
      await expect(page.getByText('Your owner session expired')).toHaveCount(0);
      await expect(page.getByText('Result accepted by owner.')).toHaveCount(0);
      // No automatic replay after login.
      expect(api.acceptPosts).toHaveLength(1);
    });
  }

  test('an outdated success after session replacement is not applied to the new session', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptBehaviors: ['hold-ok'] });
    await startHeldAcceptance(page);
    await signOutAndBackIn(page);
    // Wait until the new session has read the task, then let the old answer arrive.
    await page.getByRole('link', { name: 'Tasks' }).click();
    const pill = page
      .getByRole('listitem')
      .filter({ hasText: 'Review quarterly notes' })
      .locator('.status-pill');
    await expect(pill).toHaveText('Awaiting review');
    await settle(page, api);
    await expect(page.getByText('Result accepted by owner.')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('H4');
    // The old answer changed nothing in the new session.
    await expect(pill).toHaveText('Awaiting review');
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('a current-session 401 still expires that session', async ({ page, api }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptBehaviors: ['hold-401'] });
    await startHeldAcceptance(page);
    api.releaseAccept();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await expect(page.getByText('Result accepted by owner.')).toHaveCount(0);
  });

  test('after a 409 the action stays unavailable until the refresh finishes, with no early message', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [reviewTask],
      runs: [reviewRun],
      acceptBehaviors: ['plain-conflict'],
      conflictReadHoldMs: 700,
    });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByText('Refreshing the task and runs from the server.')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await expect(page.getByText('were refreshed')).toHaveCount(0);
    await expect(page.getByText('The task and runs were refreshed from the server.')).toBeVisible();
    // The server still says this run is the current result, so it is offered again.
    await expect(accept(page)).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('a superseded run never becomes eligible again, even mid-refresh', async ({ page, api }) => {
    api.configure({
      tasks: [reviewTask],
      runs: [reviewRun],
      acceptBehaviors: ['stale-conflict'],
      conflictReadHoldMs: 500,
    });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByText('Refreshing the task and runs from the server.')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await expect(page.getByText('A newer run exists for this task.')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
  });

  test('a failed refresh keeps acceptance unavailable until an explicit successful reload', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [reviewTask],
      runs: [reviewRun],
      acceptBehaviors: ['plain-conflict'],
      conflictReadFailures: 1,
    });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByText('could not be refreshed')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await expect(page.getByText('were refreshed')).toHaveCount(0);
    await page.getByRole('button', { name: 'Reload task and runs' }).click();
    await expect(page.getByText('The task and runs were refreshed from the server.')).toBeVisible();
    await expect(accept(page)).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('focus moves to the receipt heading only after the server confirms acceptance', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptDelayMs: 300 });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByRole('heading', { name: 'Result accepted by owner.' })).toHaveCount(0);
    const heading = page.getByRole('heading', { name: 'Result accepted by owner.' });
    await expect(heading).toBeFocused();
    await expect(page.locator('.accept-result-receipt[role="status"]')).toContainText(
      'The task is completed.',
    );
  });

  test('an uncertain or rejected attempt does not move focus to a receipt', async ({
    page,
    api,
  }) => {
    api.configure({ tasks: [reviewTask], runs: [reviewRun], acceptBehaviors: ['csrf'] });
    await openReview(page);
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
    await expect(page.getByRole('alert')).toContainText('CSRF');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('H4');
  });

  const otherTask = makeTask('task-other', 'Draft vendor summary', 'in_review');
  const otherRun = makeRun('run-other', 'task-other', 'Draft vendor summary');
  const pick = (page: Page, title: string) =>
    page
      .getByRole('button', { name: new RegExp(title) })
      .first()
      .click();
  const confirmAccept = async (page: Page) => {
    await accept(page).click();
    await confirmGroup(page).getByRole('button', { name: 'Confirm acceptance' }).click();
  };
  const refreshing = (page: Page) =>
    page.getByText('Refreshing the task and runs from the server.');
  const refreshed = (page: Page) =>
    page.getByText('The task and runs were refreshed from the server.');

  test('switching runs during a pending 409 refresh cannot re-enable acceptance', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [reviewTask, otherTask],
      runs: [reviewRun, otherRun],
      acceptBehaviors: ['plain-conflict'],
      conflictReadsManual: true,
    });
    await openReview(page);
    await confirmAccept(page);
    await expect(refreshing(page)).toBeVisible();
    await pick(page, 'Draft vendor summary');
    await expect(page.getByText('Owner review')).toBeVisible();
    await expect(refreshing(page)).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await pick(page, 'Review quarterly notes');
    await expect(refreshing(page)).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await expect(page.getByText('were refreshed')).toHaveCount(0);
    api.releaseReads();
    await expect(refreshed(page)).toBeVisible();
    await expect(accept(page)).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });

  test('switching runs after a failed refresh keeps acceptance blocked until a successful reload', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [reviewTask, otherTask],
      runs: [reviewRun, otherRun],
      acceptBehaviors: ['plain-conflict'],
      conflictReadFailures: 1,
    });
    await openReview(page);
    await confirmAccept(page);
    await expect(page.getByText('could not be refreshed')).toBeVisible();
    await pick(page, 'Draft vendor summary');
    await expect(page.getByText('could not be refreshed')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await pick(page, 'Review quarterly notes');
    await expect(page.getByText('could not be refreshed')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Reload task and runs' }).click();
    await expect(refreshed(page)).toBeVisible();
    await expect(accept(page)).toBeVisible();
    await pick(page, 'Draft vendor summary');
    await expect(accept(page)).toBeVisible();
  });

  test('a result superseded during a held refresh stays unacceptable after switching away and back', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [reviewTask, otherTask],
      runs: [reviewRun, otherRun],
      acceptBehaviors: ['stale-conflict'],
      conflictReadsManual: true,
    });
    await openReview(page);
    await confirmAccept(page);
    await expect(refreshing(page)).toBeVisible();
    await pick(page, 'Draft vendor summary');
    await expect(accept(page)).toHaveCount(0);
    await pick(page, 'Review quarterly notes');
    await expect(accept(page)).toHaveCount(0);
    api.releaseReads();
    await expect(page.getByText('A newer run exists for this task.')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await pick(page, 'Draft vendor summary');
    // Two runs now share the title, so return to the original one by route (no reload).
    await page.evaluate(() => {
      window.location.hash = '#runs/run-review';
    });
    await expect(page.getByText('A newer run exists for this task.')).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
  });

  test('a refresh held across a session replacement cannot touch the replacement session', async ({
    page,
    api,
  }) => {
    api.configure({
      tasks: [reviewTask],
      runs: [reviewRun],
      acceptBehaviors: ['plain-conflict'],
      conflictReadsManual: true,
    });
    await openReview(page);
    await confirmAccept(page);
    await expect(refreshing(page)).toBeVisible();
    await signOutAndBackIn(page);
    await openReview(page);
    // The new session has its own fresh data and no inherited gate.
    await expect(accept(page)).toBeVisible();
    await expect(refreshing(page)).toHaveCount(0);
    api.releaseReads();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(refreshed(page)).toHaveCount(0);
    await expect(refreshing(page)).toHaveCount(0);
    await expect(accept(page)).toBeVisible();
    expect(api.acceptPosts).toHaveLength(1);
  });
});

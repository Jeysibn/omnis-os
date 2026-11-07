import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Authorization, Department, Epic, Milestone, Project } from '@omnis/contracts';
import { AgentLifecycleStoreError } from '@omnis/db';
import { createAuthorizerApp, type AuthorizerStore } from './app.ts';
import type { ConnectorAuthorizerStore } from './connector-authorization-routes.ts';

const serviceToken = 'synthetic-authorizer-service-token-'.padEnd(64, 'x');
const authorization: Authorization = {
  id: 'a7ad90d2-57d1-4cf0-9e42-a57e2f5a9f06',
  requestingActor: 'owner',
  runtimeId: 'mock',
  operation: 'execute_task',
  taskId: 'task-0001',
  capabilities: ['mock.execute'],
  scope: { kind: 'task', taskId: 'task-0001' },
  status: 'pending',
  policyVersion: 'r1g4-mock-v1',
  correlationId: '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2',
  expiresAt: '2026-11-03T12:00:00.000Z',
  createdAt: '2026-11-03T11:40:00.000Z',
  decidedAt: null,
  decidedBy: null,
  revokedAt: null,
  revokedBy: null,
  consumedAt: null,
  consumedRunId: null,
};
const department: Department = {
  id: 'dep_engineering',
  slug: 'engineering',
  name: 'Engineering',
  archivedAt: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};
const project: Project = {
  id: 'prj_0123456789abcdef0123456789abcdef',
  ownerId: 'owner',
  key: 'OMNIS-OS',
  name: 'Omnis OS',
  objective: 'Synthetic project fixture.',
  status: 'proposed',
  priority: 'normal',
  revision: 1,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};
const projectSummary = {
  id: project.id,
  ownerId: project.ownerId,
  key: project.key,
  name: project.name,
  status: project.status,
  priority: project.priority,
  revision: project.revision,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
};
const milestone: Milestone = {
  id: 'mil_0123456789abcdef0123456789abcdef',
  projectId: project.id,
  title: 'First release',
  description: null,
  status: 'planned',
  targetDate: null,
  revision: 1,
  archivedAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
};
const epic: Epic = {
  id: 'epc_0123456789abcdef0123456789abcdef',
  projectId: project.id,
  title: 'First epic',
  description: null,
  status: 'planned',
  revision: 1,
  archivedAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
};

function makeStore() {
  const calls: Array<{
    method: string;
    actor?: string;
    correlationId?: string;
    requestId?: string;
  }> = [];
  const store: AuthorizerStore = {
    async request(taskId, actor, correlationId) {
      calls.push({ method: 'request', actor, correlationId });
      return { ...authorization, taskId, scope: { kind: 'task', taskId } };
    },
    async decide(_id, actor, decision) {
      calls.push({ method: decision, actor });
      return { ...authorization, status: decision === 'approve' ? 'authorized' : 'denied' };
    },
    async revoke(_id, actor) {
      calls.push({ method: 'revoke', actor });
      return { ...authorization, status: 'revoked' };
    },
    async get() {
      return authorization;
    },
    async listDepartments() {
      calls.push({ method: 'listDepartments' });
      return { departments: [department], total: 1 };
    },
    async createDepartment(_input, requestId) {
      calls.push({ method: 'createDepartment', requestId });
      return department;
    },
    async updateDepartment(_id, _input, requestId) {
      calls.push({ method: 'updateDepartment', requestId });
      return department;
    },
    async archiveDepartment(_id, requestId) {
      calls.push({ method: 'archiveDepartment', requestId });
      return { ...department, archivedAt: '2026-11-04T01:00:00.000Z' };
    },
    async listProjects() {
      return { projects: [projectSummary], total: 1, complete: true };
    },
    async getProject(id) {
      return id === project.id ? project : undefined;
    },
    async createProject(_input, requestId) {
      calls.push({ method: 'createProject', requestId });
      return project;
    },
    async updateProject(_id, _input, requestId) {
      calls.push({ method: 'updateProject', requestId });
      return { ...project, name: 'Updated name', revision: 2 };
    },
    async archiveProject(_id, _input, requestId) {
      calls.push({ method: 'archiveProject', requestId });
      return { ...project, status: 'archived', revision: 2 };
    },
    projectMilestones: {
      async list(id, query) {
        calls.push({ method: 'listMilestones', requestId: `${id}:${JSON.stringify(query)}` });
        return {
          milestones: [milestone],
          page: { observedTotal: 1, complete: true, nextCursor: null },
        };
      },
      async get(projectId, milestoneId) {
        return projectId === project.id && milestoneId === milestone.id ? milestone : undefined;
      },
      async create(projectId, _input, requestId) {
        calls.push({ method: 'createMilestone', requestId });
        return { ...milestone, projectId };
      },
      async update(_projectId, _milestoneId, _input, requestId) {
        calls.push({ method: 'updateMilestone', requestId });
        return { ...milestone, revision: 2 };
      },
      async archive(_projectId, _milestoneId, _input, requestId) {
        calls.push({ method: 'archiveMilestone', requestId });
        return { ...milestone, status: 'archived', revision: 2, archivedAt: milestone.createdAt };
      },
    },
    projectEpics: {
      async list(id, query) {
        calls.push({ method: 'listEpics', requestId: `${id}:${JSON.stringify(query)}` });
        return { epics: [epic], page: { observedTotal: 1, complete: true, nextCursor: null } };
      },
      async get(projectId, epicId) {
        return projectId === project.id && epicId === epic.id ? epic : undefined;
      },
      async create(projectId, _input, requestId) {
        calls.push({ method: 'createEpic', requestId });
        return { ...epic, projectId };
      },
      async update(_projectId, _epicId, _input, requestId) {
        calls.push({ method: 'updateEpic', requestId });
        return { ...epic, revision: 2 };
      },
      async archive(_projectId, _epicId, _input, requestId) {
        calls.push({ method: 'archiveEpic', requestId });
        return { ...epic, status: 'archived', revision: 2, archivedAt: epic.createdAt };
      },
      async listTasks(projectId, epicId, query) {
        calls.push({
          method: 'listEpicTasks',
          requestId: `${projectId}:${epicId}:${JSON.stringify(query)}`,
        });
        return { tasks: [], page: { observedTotal: 0, complete: true, nextCursor: null } };
      },
      async getTaskEpic(taskId) {
        calls.push({ method: 'getTaskEpic', requestId: taskId });
        return {
          taskId,
          projectId: project.id,
          epic,
          associationRevision: 2,
        };
      },
      async setTaskEpic(taskId, _input, requestId) {
        calls.push({ method: 'setTaskEpic', requestId });
        return { taskId, projectId: project.id, epicId: epic.id, associationRevision: 3 };
      },
    },
  };
  return { store, calls };
}

describe('independent authorizer service boundary', () => {
  it('rejects runtime and unauthenticated requests before calling the authorization store', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/authorizations',
        headers: { 'idempotency-key': authorization.correlationId },
        payload: { taskId: 'task-0001' },
      });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('keeps connector grants behind the service token and rejects caller-supplied identity', async () => {
    const { store } = makeStore();
    let connectorCalls = 0;
    const connectorStore: ConnectorAuthorizerStore = {
      async request() {
        connectorCalls += 1;
        throw new Error('invalid requests must not reach the grant store');
      },
      async get() {
        connectorCalls += 1;
        return undefined;
      },
      async decide() {
        connectorCalls += 1;
        throw new Error('invalid requests must not reach the grant store');
      },
      async revoke() {
        connectorCalls += 1;
        throw new Error('invalid requests must not reach the grant store');
      },
    };
    const app = createAuthorizerApp({
      store,
      connectorStore,
      serviceToken,
      checkDatabase: async () => undefined,
    });
    try {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/internal/v1/connector-authorizations',
        headers: { 'idempotency-key': '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2' },
        payload: { connectorId: 'synthetic.codex.fixture', actor: 'owner' },
      });
      assert.equal(unauthenticated.statusCode, 401);
      const callerSuppliedIdentity = await app.inject({
        method: 'POST',
        url: '/internal/v1/connector-authorizations',
        headers: {
          'x-omnis-authorizer-token': serviceToken,
          'idempotency-key': '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2',
        },
        payload: { connectorId: 'synthetic.codex.fixture', actor: 'owner' },
      });
      assert.equal(callerSuppliedIdentity.statusCode, 400);
      assert.equal(connectorCalls, 0);
    } finally {
      await app.close();
    }
  });

  it('exposes synthetic execution status only behind the authorizer service token', async () => {
    const { store } = makeStore();
    const authorizationId = '11111111-1111-4111-8111-111111111111';
    const connectorStore: ConnectorAuthorizerStore = {
      async request() {
        throw new Error('not used');
      },
      async get() {
        return {
          id: authorizationId,
          requestId: '22222222-2222-4222-8222-222222222222',
          correlationId: '33333333-3333-4333-8333-333333333333',
          requestingActor: 'owner',
          projectId: `prj_${'a'.repeat(32)}`,
          projectRevision: 1,
          taskId: 'task-0001',
          taskRevision: 1,
          agentId: 'fixture-agent',
          profileVersion: 1,
          connectorId: 'synthetic.codex.fixture',
          connectorVersion: '0.0.0-synthetic.1',
          providerId: 'synthetic',
          modelId: 'synthetic-text-only-v1',
          operation: 'connector.respond',
          capabilities: [],
          limits: {
            maxInputTokens: 10,
            maxOutputTokens: 10,
            maxDurationSeconds: 10,
            maxConcurrentRuns: 1,
            maxUsageUnits: 10,
            maxCostMicrousd: 10,
          },
          promptDigest: `sha256:${'a'.repeat(64)}`,
          status: 'authorized',
          policyVersion: 'r1p1-synthetic-connector-v1',
          createdAt: '2026-11-07T00:00:00.000Z',
          consentedAt: '2026-11-07T00:00:00.000Z',
          decidedAt: '2026-11-07T00:00:00.000Z',
          decidedBy: 'owner',
          revokedAt: null,
          revokedBy: null,
          revocationGeneration: 0,
          expiresAt: '2999-01-01T00:00:00.000Z',
          consumedAt: null,
          consumedRequestId: null,
          synthetic: true,
        };
      },
      async getExecutionForAuthorization() {
        return {
          attempt: {
            id: '44444444-4444-4444-8444-444444444444',
            authorizationId,
            requestId: '55555555-5555-4555-8555-555555555555',
            status: 'completed',
            synthetic: true,
            createdAt: '2026-11-07T00:00:00.000Z',
            responseText: 'Synthetic result',
          },
          usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
        };
      },
      async listSyntheticTaskRunEvents(_authorizationId, after, limit) {
        assert.equal(after, 2);
        assert.equal(limit, 10);
        return {
          events: [
            {
              attemptId: '44444444-4444-4444-8444-444444444444',
              sequence: 3,
              eventType: 'connector.execution_completed',
              outcome: 'recorded',
              revocationGeneration: 0,
              occurredAt: '2026-11-07T00:00:03.000Z',
            },
          ],
          nextAfter: null,
        };
      },
      async decide() {
        throw new Error('not used');
      },
      async revoke() {
        throw new Error('not used');
      },
    };
    const app = createAuthorizerApp({
      store,
      connectorStore,
      serviceToken,
      checkDatabase: async () => undefined,
    });
    try {
      const url = `/internal/v1/connector-authorizations/${authorizationId}/execution`;
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-omnis-authorizer-token': serviceToken },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().taskId, 'task-0001');
      assert.equal(response.json().attempt.status, 'completed');
      assert.equal(response.json().usage.kind, 'unknown');
      const eventsUrl = `/internal/v1/connector-authorizations/${authorizationId}/events?after=2&limit=10`;
      assert.equal((await app.inject({ method: 'GET', url: eventsUrl })).statusCode, 401);
      const events = await app.inject({
        method: 'GET',
        url: eventsUrl,
        headers: { 'x-omnis-authorizer-token': serviceToken },
      });
      assert.equal(events.statusCode, 200);
      assert.equal(events.json().taskId, 'task-0001');
      assert.equal(events.json().events[0].attemptId, '44444444-4444-4444-8444-444444444444');
      const invalidPage = await app.inject({
        method: 'GET',
        url: `/internal/v1/connector-authorizations/${authorizationId}/events?limit=101`,
        headers: { 'x-omnis-authorizer-token': serviceToken },
      });
      assert.equal(invalidPage.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('keeps milestone operations behind the service token and validates internal contracts', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    const headers = { 'x-omnis-authorizer-token': serviceToken };
    try {
      const denied = await app.inject({
        method: 'GET',
        url: `/internal/v1/projects/${project.id}/milestones`,
      });
      assert.equal(denied.statusCode, 401);
      const list = await app.inject({
        method: 'GET',
        url: `/internal/v1/projects/${project.id}/milestones?limit=10`,
        headers,
      });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().milestones[0].id, milestone.id);
      const create = await app.inject({
        method: 'POST',
        url: `/internal/v1/projects/${project.id}/milestones`,
        headers: { ...headers, 'idempotency-key': authorization.correlationId },
        payload: { title: 'First release' },
      });
      assert.equal(create.statusCode, 201);
      assert.equal(create.json().id, milestone.id);
      assert.deepEqual(calls.at(-1), {
        method: 'createMilestone',
        requestId: authorization.correlationId,
      });
      const invalid = await app.inject({
        method: 'POST',
        url: `/internal/v1/projects/${project.id}/milestones`,
        headers: { ...headers, 'idempotency-key': authorization.correlationId },
        payload: { title: '   ' },
      });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('keeps Epic operations behind the service token and validates the internal contract', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    const headers = { 'x-omnis-authorizer-token': serviceToken };
    try {
      const denied = await app.inject({
        method: 'GET',
        url: `/internal/v1/projects/${project.id}/epics`,
      });
      assert.equal(denied.statusCode, 401);
      const list = await app.inject({
        method: 'GET',
        url: `/internal/v1/projects/${project.id}/epics?limit=10`,
        headers,
      });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().epics[0].id, epic.id);
      const create = await app.inject({
        method: 'POST',
        url: `/internal/v1/projects/${project.id}/epics`,
        headers: { ...headers, 'idempotency-key': authorization.correlationId },
        payload: { title: 'First epic' },
      });
      assert.equal(create.statusCode, 201);
      assert.equal(create.json().id, epic.id);
      assert.deepEqual(calls.at(-1), {
        method: 'createEpic',
        requestId: authorization.correlationId,
      });
      const malformed = await app.inject({
        method: 'POST',
        url: `/internal/v1/projects/${project.id}/epics`,
        headers: { ...headers, 'idempotency-key': authorization.correlationId },
        payload: { title: ' ' },
      });
      assert.equal(malformed.statusCode, 400);
      const taskPage = await app.inject({
        method: 'GET',
        url: `/internal/v1/projects/${project.id}/epics/${epic.id}/tasks?limit=5`,
        headers,
      });
      assert.equal(taskPage.statusCode, 200);
      assert.deepEqual(taskPage.json().tasks, []);
      const taskEpic = await app.inject({
        method: 'GET',
        url: '/internal/v1/tasks/task-0001/epic',
        headers,
      });
      assert.equal(taskEpic.statusCode, 200);
      assert.equal(taskEpic.json().epic.id, epic.id);
      const assigned = await app.inject({
        method: 'PUT',
        url: '/internal/v1/tasks/task-0001/epic',
        headers: { ...headers, 'idempotency-key': authorization.correlationId },
        payload: { expectedAssociationRevision: 2, epicId: epic.id },
      });
      assert.equal(assigned.statusCode, 200);
      assert.equal(assigned.json().associationRevision, 3);
    } finally {
      await app.close();
    }
  });

  it('keeps project reads and idempotent creation behind the authorizer service token', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    try {
      const denied = await app.inject({ method: 'GET', url: '/internal/v1/projects' });
      assert.equal(denied.statusCode, 401);
      const headers = { 'x-omnis-authorizer-token': serviceToken };
      const list = await app.inject({ method: 'GET', url: '/internal/v1/projects', headers });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().complete, true);
      const missing = await app.inject({
        method: 'GET',
        url: '/internal/v1/projects/prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headers,
      });
      assert.equal(missing.statusCode, 404);
      const created = await app.inject({
        method: 'POST',
        url: '/internal/v1/projects',
        headers: { ...headers, 'idempotency-key': '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2' },
        payload: { key: 'OMNIS-OS', name: 'Omnis OS', objective: 'Synthetic project.' },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(
        calls.some((call) => call.method === 'createProject' && !!call.requestId),
        true,
      );
      const requestId = '1208f993-29f8-40ee-9d56-c2cbe4f63100';
      const updated = await app.inject({
        method: 'PATCH',
        url: `/internal/v1/projects/${project.id}`,
        headers: { ...headers, 'idempotency-key': requestId },
        payload: { expectedRevision: 1, name: 'Updated name' },
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().revision, 2);
      assert.equal(calls.at(-1)?.method, 'updateProject');
      const archived = await app.inject({
        method: 'POST',
        url: `/internal/v1/projects/${project.id}/archive`,
        headers: { ...headers, 'idempotency-key': '2208f993-29f8-40ee-9d56-c2cbe4f63102' },
        payload: { expectedRevision: 1 },
      });
      assert.equal(archived.statusCode, 200);
      assert.equal(archived.json().status, 'archived');
      assert.equal(calls.at(-1)?.method, 'archiveProject');
    } finally {
      await app.close();
    }
  });

  it('does not expose uncertain project write failures or rejected input details', async () => {
    const { store } = makeStore();
    const failingStore: AuthorizerStore = {
      ...store,
      async createProject() {
        throw new Error('synthetic-private-value-must-not-leak');
      },
    };
    const app = createAuthorizerApp({
      store: failingStore,
      serviceToken,
      checkDatabase: async () => undefined,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/projects',
        headers: {
          'x-omnis-authorizer-token': serviceToken,
          'idempotency-key': '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2',
        },
        payload: { key: 'SAFE', name: 'Safe name', objective: 'A safe description.' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'project_outcome_unknown');
      assert.doesNotMatch(response.body, /synthetic-private-value-must-not-leak/);
    } finally {
      await app.close();
    }
  });

  it('returns definite safe 400 and 413 errors for malformed or oversized project requests', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    const headers = {
      'x-omnis-authorizer-token': serviceToken,
      'idempotency-key': '3a167582-1dc3-48a4-a69f-8b1fe0c58ee2',
      'content-type': 'application/json',
    };
    try {
      const malformed = await app.inject({
        method: 'POST',
        url: '/internal/v1/projects',
        headers,
        payload: '{',
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().error.code, 'invalid_input');
      const oversized = await app.inject({
        method: 'POST',
        url: '/internal/v1/projects',
        headers,
        payload: JSON.stringify({ key: 'SAFE', name: 'Safe', objective: 'x'.repeat(40_000) }),
      });
      assert.equal(oversized.statusCode, 413);
      assert.equal(oversized.json().error.code, 'payload_too_large');
      assert.equal(
        calls.some((call) => call.method === 'createProject'),
        false,
      );
    } finally {
      await app.close();
    }
  });

  it('validates and dispatches owner agent lifecycle operations behind the internal token', async () => {
    const { store, calls } = makeStore();
    let createdInput: unknown;
    store.agentLifecycle = {
      async getDraft(agentId) {
        return { agentId, draftRevision: 0, baseVersionNo: null, profile: null, updatedAt: null };
      },
      async createAgent(input, requestId) {
        createdInput = input;
        calls.push({ method: 'createAgent', requestId });
        return {
          requestId,
          operation: 'agent.created',
          agentId: 'agt_created',
          lifecycle: 'draft',
          versionId: null,
          versionNo: null,
          draftRevision: 0,
          occurredAt: '2026-11-04T00:00:00.000Z',
        };
      },
      async saveDraft() {
        throw new AgentLifecycleStoreError('disallowed_credential_material', 422);
      },
      async publish() {
        throw new Error('not used');
      },
      async archive() {
        throw new Error('not used');
      },
    };
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    const headers = {
      'x-omnis-authorizer-token': serviceToken,
      'idempotency-key': '123e4567-e89b-42d3-a456-426614174000',
    };
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/internal/v1/agents',
        headers: { 'idempotency-key': headers['idempotency-key'] },
        payload: { name: 'Atlas', slug: 'atlas', departmentId: null },
      });
      assert.equal(denied.statusCode, 401);
      const invalid = await app.inject({
        method: 'POST',
        url: '/internal/v1/agents',
        headers,
        payload: { name: 'Atlas', slug: 'Atlas', departmentId: null },
      });
      assert.equal(invalid.statusCode, 400);
      const created = await app.inject({
        method: 'POST',
        url: '/internal/v1/agents',
        headers,
        payload: { name: 'Atlas', slug: 'atlas', departmentId: null },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().agentId, 'agt_created');
      assert.deepEqual(createdInput, { name: 'Atlas', slug: 'atlas', departmentId: null });
      assert.deepEqual(
        calls.filter((call) => call.method === 'createAgent'),
        [{ method: 'createAgent', requestId: headers['idempotency-key'] }],
      );
      const rejectedText = 'password: "synthetic-secret-value-123"';
      const rejected = await app.inject({
        method: 'PUT',
        url: '/internal/v1/agents/agt_created/draft-profile',
        headers,
        payload: {
          expectedDraftRevision: 0,
          baseVersionNo: null,
          profile: {
            profession: 'Analyst',
            seniority: null,
            specialties: [],
            personality: { traits: [], tone: null, principles: [] },
            behavior: { autonomy: null, escalation: null },
            instructions: rejectedText,
          },
        },
      });
      assert.equal(rejected.statusCode, 422);
      assert.doesNotMatch(rejected.body, /synthetic-secret-value-123/);
    } finally {
      await app.close();
    }
  });

  it('derives the approval actor in the authorizer and rejects caller-supplied identity', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    try {
      const forged = await app.inject({
        method: 'POST',
        url: '/internal/v1/authorizations',
        headers: {
          'x-omnis-authorizer-token': serviceToken,
          'idempotency-key': authorization.correlationId,
        },
        payload: { taskId: 'task-0001', requestingActor: 'worker', actorId: 'owner' },
      });
      assert.equal(forged.statusCode, 400);
      assert.deepEqual(calls, []);

      const accepted = await app.inject({
        method: 'POST',
        url: '/internal/v1/authorizations',
        headers: {
          'x-omnis-authorizer-token': serviceToken,
          'idempotency-key': authorization.correlationId,
        },
        payload: { taskId: 'task-0001' },
      });
      assert.equal(accepted.statusCode, 201);
      assert.deepEqual(calls[0], {
        method: 'request',
        actor: 'owner',
        correlationId: authorization.correlationId,
      });
    } finally {
      await app.close();
    }
  });

  it('does not report health when the authorizer database is unavailable', async () => {
    const { store } = makeStore();
    const app = createAuthorizerApp({
      store,
      serviceToken,
      checkDatabase: async () => {
        throw new Error('synthetic database outage');
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/internal/v1/health' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'authorizer_unavailable');
    } finally {
      await app.close();
    }
  });

  it('reports an unknown decision outcome when a mutation fails outside a confirmed rollback path', async () => {
    const { store } = makeStore();
    const failingStore: AuthorizerStore = {
      ...store,
      async request() {
        throw new Error('synthetic connection loss during commit');
      },
    };
    const app = createAuthorizerApp({
      store: failingStore,
      serviceToken,
      checkDatabase: async () => undefined,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/authorizations',
        headers: {
          'x-omnis-authorizer-token': serviceToken,
          'idempotency-key': authorization.correlationId,
        },
        payload: { taskId: 'task-0001' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'authorization_outcome_unknown');
      assert.match(response.json().error.message, /same idempotency key/i);
    } finally {
      await app.close();
    }
  });
});

describe('authorizer department management boundary', () => {
  it('requires the internal service token and validates department bodies', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    try {
      const unauthenticated = await app.inject({ method: 'GET', url: '/internal/v1/departments' });
      assert.equal(unauthenticated.statusCode, 401);
      const invalid = await app.inject({
        method: 'POST',
        url: '/internal/v1/departments',
        headers: { 'x-omnis-authorizer-token': serviceToken },
        payload: { slug: 'Engineering', name: 'Engineering', ownerId: 'attacker' },
      });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });

  it('serves exact directory data and derives owner operations internally', async () => {
    const { store, calls } = makeStore();
    const app = createAuthorizerApp({ store, serviceToken, checkDatabase: async () => undefined });
    const headers = { 'x-omnis-authorizer-token': serviceToken };
    try {
      const listed = await app.inject({ method: 'GET', url: '/internal/v1/departments', headers });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json(), { departments: [department], total: 1 });
      const created = await app.inject({
        method: 'POST',
        url: '/internal/v1/departments',
        headers,
        payload: { slug: 'engineering', name: 'Engineering' },
      });
      assert.equal(created.statusCode, 201);
      const archived = await app.inject({
        method: 'POST',
        url: '/internal/v1/departments/dep_engineering/archive',
        headers,
      });
      assert.equal(archived.statusCode, 200);
      assert.equal(archived.json().archivedAt, '2026-11-04T01:00:00.000Z');
      assert.equal(
        calls.some((call) => call.method === 'createDepartment' && !!call.requestId),
        true,
      );
      assert.equal(
        calls.some((call) => call.method === 'archiveDepartment' && !!call.requestId),
        true,
      );
    } finally {
      await app.close();
    }
  });

  it('returns a generic uncertain-outcome response without error details on mutation failure', async () => {
    const { store } = makeStore();
    const failingStore: AuthorizerStore = {
      ...store,
      async createDepartment() {
        throw new Error('synthetic-secret-value-must-not-leak');
      },
    };
    const app = createAuthorizerApp({
      store: failingStore,
      serviceToken,
      checkDatabase: async () => undefined,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/v1/departments',
        headers: { 'x-omnis-authorizer-token': serviceToken },
        payload: { slug: 'engineering', name: 'Engineering' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'department_outcome_unknown');
      assert.doesNotMatch(response.body, /synthetic-secret-value-must-not-leak/);
    } finally {
      await app.close();
    }
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'project-workspace-test-session-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'project-workspace-test-internal-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'project-workspace-test-authorizer-token-'.padEnd(
  64,
  'y',
);
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { registerProjectWorkspaceRoutes } = await import('./project-workspace-routes.ts');
const projectId = 'prj_0123456789abcdef0123456789abcdef';
const at = '2026-11-04T00:00:00.000Z';
const project = {
  id: projectId,
  ownerId: 'owner',
  key: 'AO-105',
  name: 'Project workspace',
  objective: 'Read task state for this project.',
  status: 'archived',
  priority: 'normal',
  revision: 2,
  createdAt: at,
  updatedAt: at,
};
const taskPage = {
  tasks: [
    {
      id: 'task-0001',
      title: 'Read project task status',
      status: 'completed',
      createdAt: at,
      projectId,
      associationRevision: 1,
      latestRun: {
        id: 'run-0001',
        status: 'failed',
        createdAt: at,
        updatedAt: at,
      },
    },
  ],
  page: { observedTotal: 1, complete: true, nextCursor: null },
};

function createApp(
  owner: boolean,
  calls: Array<{ kind: 'project' | 'tasks'; path: string }>,
  result = taskPage,
) {
  const app = Fastify();
  app.decorateRequest('omnisSession', undefined);
  app.addHook('onRequest', async (request) => {
    if (owner)
      request.omnisSession = {
        id: 'session',
        owner: true,
        csrfToken: 'csrf-token-123456',
        expiresAt: Date.now() + 1000,
      };
  });
  registerProjectWorkspaceRoutes(
    app,
    async <T>(path: string, _init: RequestInit | undefined, parse: (value: unknown) => T) => {
      calls.push({ kind: 'project', path });
      return parse(project);
    },
    async <T>(path: string, _init: RequestInit | undefined, parse: (value: unknown) => T) => {
      calls.push({ kind: 'tasks', path });
      return parse(result);
    },
  );
  return app;
}

describe('owner project workspace route', () => {
  it('requires owner authentication and validates route and pagination input', async () => {
    const calls: Array<{ kind: 'project' | 'tasks'; path: string }> = [];
    const anonymous = createApp(false, calls);
    const owner = createApp(true, calls);
    try {
      const unauthorized = await anonymous.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/tasks`,
      });
      assert.equal(unauthorized.statusCode, 401);
      const invalidId = await owner.inject({ method: 'GET', url: '/api/v1/projects/bad/tasks' });
      const invalidQuery = await owner.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/tasks?limit=101`,
      });
      assert.equal(invalidId.statusCode, 422);
      assert.equal(invalidQuery.statusCode, 422);
      assert.deepEqual(calls, []);
    } finally {
      await Promise.all([anonymous.close(), owner.close()]);
    }
  });

  it('keeps archived projects readable and composes the bounded worker projection', async () => {
    const calls: Array<{ kind: 'project' | 'tasks'; path: string }> = [];
    const app = createApp(true, calls);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/tasks?limit=25&cursor=opaque.cursor`,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().project.status, 'archived');
      assert.equal(response.json().tasks[0].latestRun.status, 'failed');
      assert.deepEqual(calls, [
        { kind: 'project', path: `/internal/v1/projects/${projectId}` },
        {
          kind: 'tasks',
          path: `/internal/v1/projects/${projectId}/tasks?cursor=opaque.cursor&limit=25`,
        },
      ]);
      assert.equal('detail' in response.json().tasks[0], false);
      assert.equal('usage' in response.json().tasks[0].latestRun, false);
    } finally {
      await app.close();
    }
  });

  it('returns an honest empty project page', async () => {
    const calls: Array<{ kind: 'project' | 'tasks'; path: string }> = [];
    const app = createApp(true, calls, {
      tasks: [],
      page: { observedTotal: 0, complete: true, nextCursor: null },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/tasks`,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().tasks, []);
      assert.deepEqual(response.json().page, {
        observedTotal: 0,
        complete: true,
        nextCursor: null,
      });
    } finally {
      await app.close();
    }
  });
});

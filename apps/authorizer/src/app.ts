import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  AuthorizationDecisionSchema,
  AuthorizationSchema,
  CreateAuthorizationSchema,
  CreateDepartmentSchema,
  DepartmentIdSchema,
  DepartmentListQuerySchema,
  DepartmentListResponseSchema,
  DepartmentSchema,
  UpdateDepartmentSchema,
  AgentIdSchema,
  AgentIdempotencyKeySchema,
  AgentMutationReceiptSchema,
  AgentProfileDraftResponseSchema,
  CreateAgentInputSchema,
  PublishAgentProfileInputSchema,
  SaveAgentProfileDraftInputSchema,
  type Authorization,
  type Department,
  ProjectIdSchema,
  CreateProjectSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  type Project,
  type ProjectListResponse,
} from '@omnis/contracts';
import { AgentLifecycleStoreError, DepartmentStoreError, ProjectStoreError } from '@omnis/db';

export type AuthorizerStore = {
  request(taskId: string, actor: 'owner', correlationId: string): Promise<Authorization>;
  decide(id: string, actor: 'owner', decision: 'approve' | 'deny'): Promise<Authorization>;
  revoke(id: string, actor: 'owner'): Promise<Authorization>;
  get(id: string): Promise<Authorization | undefined>;
  listDepartments(includeArchived?: boolean): Promise<{ departments: Department[]; total: number }>;
  createDepartment(input: { slug: string; name: string }, requestId: string): Promise<Department>;
  updateDepartment(
    id: string,
    input: { slug: string; name: string },
    requestId: string,
  ): Promise<Department>;
  archiveDepartment(id: string, requestId: string): Promise<Department>;
  listProjects(): Promise<ProjectListResponse>;
  getProject(id: string): Promise<Project | undefined>;
  createProject(input: unknown, requestId: string): Promise<Project>;
  agentLifecycle?:
    | {
        getDraft(agentId: string): Promise<unknown>;
        createAgent(
          input: { name: string; slug: string; departmentId: string | null },
          requestId: string,
        ): Promise<unknown>;
        saveDraft(agentId: string, input: unknown, requestId: string): Promise<unknown>;
        publish(agentId: string, input: unknown, requestId: string): Promise<unknown>;
        archive(agentId: string, requestId: string): Promise<unknown>;
      }
    | undefined;
};

export function createAuthorizerApp(input: {
  store: AuthorizerStore;
  serviceToken: string;
  checkDatabase: () => Promise<void>;
}): FastifyInstance {
  const app = Fastify({
    logger: { redact: ['req.headers.x-omnis-authorizer-token', 'req.headers.cookie'] },
  });

  app.get('/internal/v1/health', async (_request, reply) => {
    try {
      await input.checkDatabase();
      return { status: 'ok', product: 'Omnis OS', service: 'authorizer' };
    } catch {
      return reply.code(503).send({
        error: {
          code: 'authorizer_unavailable',
          message: 'The authorization store is unavailable.',
        },
      });
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.url === '/internal/v1/health') return;
    const supplied = request.headers['x-omnis-authorizer-token'];
    const candidate = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
    const expected = Buffer.from(input.serviceToken);
    const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (!matches) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'Control-plane authentication failed.' },
      });
    }
  });

  app.get('/internal/v1/departments', async (request, reply) => {
    const parsed = DepartmentListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Department query is invalid.' },
      });
    }
    try {
      return DepartmentListResponseSchema.parse(
        await input.store.listDepartments(parsed.data.includeArchived === 'true'),
      );
    } catch (error) {
      return sendDepartmentStoreError(error, reply);
    }
  });

  app.post('/internal/v1/departments', async (request, reply) => {
    const parsed = CreateDepartmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Department input is invalid.' },
      });
    }
    try {
      return reply
        .code(201)
        .send(DepartmentSchema.parse(await input.store.createDepartment(parsed.data, request.id)));
    } catch (error) {
      return sendDepartmentStoreError(error, reply);
    }
  });

  app.patch<{ Params: { departmentId: string } }>(
    '/internal/v1/departments/:departmentId',
    async (request, reply) => {
      const id = DepartmentIdSchema.safeParse(request.params.departmentId);
      const parsed = UpdateDepartmentSchema.safeParse(request.body);
      if (!id.success || !parsed.success) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Department update is invalid.' },
        });
      }
      try {
        return DepartmentSchema.parse(
          await input.store.updateDepartment(id.data, parsed.data, request.id),
        );
      } catch (error) {
        return sendDepartmentStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { departmentId: string } }>(
    '/internal/v1/departments/:departmentId/archive',
    async (request, reply) => {
      const id = DepartmentIdSchema.safeParse(request.params.departmentId);
      if (!id.success) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Department identifier is invalid.' },
        });
      }
      try {
        return DepartmentSchema.parse(await input.store.archiveDepartment(id.data, request.id));
      } catch (error) {
        return sendDepartmentStoreError(error, reply);
      }
    },
  );

  app.get('/internal/v1/projects', async (_request, reply) => {
    try {
      return ProjectListResponseSchema.parse(await input.store.listProjects());
    } catch (error) {
      return sendProjectStoreError(error, reply);
    }
  });

  app.get<{ Params: { projectId: string } }>(
    '/internal/v1/projects/:projectId',
    async (request, reply) => {
      const id = ProjectIdSchema.safeParse(request.params.projectId);
      if (!id.success)
        return reply
          .code(400)
          .send({ error: { code: 'invalid_input', message: 'Project identifier is invalid.' } });
      try {
        const project = await input.store.getProject(id.data);
        if (!project)
          return reply
            .code(404)
            .send({ error: { code: 'not_found', message: 'Project was not found.' } });
        return ProjectSchema.parse(project);
      } catch (error) {
        return sendProjectStoreError(error, reply);
      }
    },
  );

  app.post('/internal/v1/projects', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const body = CreateProjectSchema.safeParse(request.body);
    const requestId = request.headers['idempotency-key'];
    if (!body.success || typeof requestId !== 'string' || !isUuid(requestId))
      return reply.code(400).send({
        error: {
          code: 'invalid_input',
          message: 'Project input and Idempotency-Key are required.',
        },
      });
    try {
      return reply
        .code(201)
        .send(ProjectSchema.parse(await input.store.createProject(body.data, requestId)));
    } catch (error) {
      return sendProjectStoreError(error, reply);
    }
  });

  app.get<{ Params: { agentId: string } }>(
    '/internal/v1/agents/:agentId/draft-profile',
    async (request, reply) => {
      const id = AgentIdSchema.safeParse(request.params.agentId);
      if (!id.success)
        return reply
          .code(400)
          .send({ error: { code: 'invalid_input', message: 'Agent identifier is invalid.' } });
      try {
        const draft = await requireAgentLifecycle(input.store).getDraft(id.data);
        return AgentProfileDraftResponseSchema.parse(draft);
      } catch (error) {
        return sendAgentLifecycleError(error, reply);
      }
    },
  );

  app.post('/internal/v1/agents', async (request, reply) => {
    const body = CreateAgentInputSchema.safeParse(request.body);
    const requestId = AgentIdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!body.success || !requestId.success)
      return reply
        .code(400)
        .send({ error: { code: 'invalid_input', message: 'Agent input is invalid.' } });
    try {
      const result = await requireAgentLifecycle(input.store).createAgent(
        body.data,
        requestId.data,
      );
      return reply.code(201).send(AgentMutationReceiptSchema.parse(result));
    } catch (error) {
      return sendAgentLifecycleError(error, reply);
    }
  });

  app.put<{ Params: { agentId: string } }>(
    '/internal/v1/agents/:agentId/draft-profile',
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const id = AgentIdSchema.safeParse(request.params.agentId);
      const body = SaveAgentProfileDraftInputSchema.safeParse(request.body);
      const requestId = AgentIdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      if (!id.success || !body.success || !requestId.success)
        return reply
          .code(400)
          .send({ error: { code: 'invalid_input', message: 'Profile draft input is invalid.' } });
      try {
        const result = await requireAgentLifecycle(input.store).saveDraft(
          id.data,
          body.data,
          requestId.data,
        );
        return AgentMutationReceiptSchema.parse(result);
      } catch (error) {
        return sendAgentLifecycleError(error, reply);
      }
    },
  );

  app.post<{ Params: { agentId: string } }>(
    '/internal/v1/agents/:agentId/publish',
    async (request, reply) => {
      const id = AgentIdSchema.safeParse(request.params.agentId);
      const body = PublishAgentProfileInputSchema.safeParse(request.body);
      const requestId = AgentIdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      if (!id.success || !body.success || !requestId.success)
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Profile publication input is invalid.' },
        });
      try {
        const result = await requireAgentLifecycle(input.store).publish(
          id.data,
          body.data,
          requestId.data,
        );
        return reply.code(201).send(AgentMutationReceiptSchema.parse(result));
      } catch (error) {
        return sendAgentLifecycleError(error, reply);
      }
    },
  );

  app.post<{ Params: { agentId: string } }>(
    '/internal/v1/agents/:agentId/archive',
    async (request, reply) => {
      const id = AgentIdSchema.safeParse(request.params.agentId);
      const requestId = AgentIdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      if (!id.success || !requestId.success)
        return reply
          .code(400)
          .send({ error: { code: 'invalid_input', message: 'Agent archive input is invalid.' } });
      try {
        const result = await requireAgentLifecycle(input.store).archive(id.data, requestId.data);
        return AgentMutationReceiptSchema.parse(result);
      } catch (error) {
        return sendAgentLifecycleError(error, reply);
      }
    },
  );

  app.post('/internal/v1/authorizations', async (request, reply) => {
    const parsed = CreateAuthorizationSchema.safeParse(request.body);
    const requestId = request.headers['idempotency-key'];
    if (!parsed.success || typeof requestId !== 'string' || !isUuid(requestId)) {
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Authorization request is invalid.' },
      });
    }
    try {
      const authorization = await input.store.request(parsed.data.taskId, 'owner', requestId);
      return reply.code(201).send(AuthorizationSchema.parse(authorization));
    } catch (error) {
      return sendStoreError(error, reply);
    }
  });

  app.get<{ Params: { authorizationId: string } }>(
    '/internal/v1/authorizations/:authorizationId',
    async (request, reply) => {
      if (!isUuid(request.params.authorizationId)) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_input', message: 'Authorization ID is invalid.' } });
      }
      const authorization = await input.store.get(request.params.authorizationId);
      return authorization
        ? AuthorizationSchema.parse(authorization)
        : reply
            .code(404)
            .send({ error: { code: 'not_found', message: 'Authorization was not found.' } });
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/internal/v1/authorizations/:authorizationId/decision',
    async (request, reply) => {
      const parsed = AuthorizationDecisionSchema.safeParse(request.body);
      if (!parsed.success || !isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Authorization decision is invalid.' },
        });
      }
      try {
        const authorization = await input.store.decide(
          request.params.authorizationId,
          'owner',
          parsed.data.decision,
        );
        return AuthorizationSchema.parse(authorization);
      } catch (error) {
        return sendStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { authorizationId: string } }>(
    '/internal/v1/authorizations/:authorizationId/revoke',
    async (request, reply) => {
      if (!isUuid(request.params.authorizationId)) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Authorization ID is invalid.' },
        });
      }
      try {
        const authorization = await input.store.revoke(request.params.authorizationId, 'owner');
        return AuthorizationSchema.parse(authorization);
      } catch (error) {
        return sendStoreError(error, reply);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Authorizer request failed.',
    );
    const statusCode =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    if (
      (request.url.startsWith('/internal/v1/agents') ||
        request.url.startsWith('/internal/v1/projects')) &&
      (statusCode === 400 || statusCode === 413)
    ) {
      return reply.code(statusCode).send({
        error: {
          code: statusCode === 413 ? 'payload_too_large' : 'invalid_input',
          message:
            statusCode === 413
              ? 'Management request exceeds the allowed size.'
              : 'Management request is malformed.',
        },
      });
    }
    const decisionOutcomeUnknown =
      request.method !== 'GET' && request.url.startsWith('/internal/v1/authorizations');
    const departmentOutcomeUnknown =
      request.method !== 'GET' && request.url.startsWith('/internal/v1/departments');
    const agentOutcomeUnknown =
      request.method !== 'GET' && request.url.startsWith('/internal/v1/agents');
    const projectOutcomeUnknown =
      request.method !== 'GET' && request.url.startsWith('/internal/v1/projects');
    return reply.code(503).send({
      error: {
        code: decisionOutcomeUnknown
          ? 'authorization_outcome_unknown'
          : departmentOutcomeUnknown
            ? 'department_outcome_unknown'
            : agentOutcomeUnknown
              ? 'management_outcome_unknown'
              : projectOutcomeUnknown
                ? 'project_outcome_unknown'
                : 'authorizer_unavailable',
        message: decisionOutcomeUnknown
          ? 'The authorizer could not confirm whether the decision committed. Read the authorization state or retry with the same idempotency key.'
          : departmentOutcomeUnknown
            ? 'The authorizer could not confirm whether the department change committed. Read the department state before retrying.'
            : agentOutcomeUnknown
              ? 'The authorizer could not confirm whether the agent change committed. Read agent state or retry with the same idempotency key.'
              : projectOutcomeUnknown
                ? 'The authorizer could not confirm whether the project was created. Retry with the same idempotency key or read the project list.'
                : 'The authorization store is unavailable.',
      },
    });
  });

  return app;
}

function sendDepartmentStoreError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof DepartmentStoreError)) throw error;
  return reply.code(error.statusCode).send({
    error: { code: error.code, message: error.message },
  });
}

function sendProjectStoreError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof ProjectStoreError)) throw error;
  return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
}

function requireAgentLifecycle(store: AuthorizerStore) {
  if (!store.agentLifecycle) throw new Error('Agent lifecycle store is unavailable.');
  return store.agentLifecycle;
}

function sendAgentLifecycleError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof AgentLifecycleStoreError)) throw error;
  return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
}

function sendStoreError(error: unknown, reply: FastifyReply) {
  if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') {
    return reply.code(503).send({
      error: {
        code: 'authorization_busy',
        message:
          'The authorization change was not committed because its database row is busy. Retry.',
      },
    });
  }
  if (error instanceof Error && error.message === 'Authorization task was not found.') {
    return reply.code(404).send({ error: { code: 'not_found', message: error.message } });
  }
  if (
    error instanceof Error &&
    (error.message.includes('Authorization is missing') ||
      error.message.includes('Only an active') ||
      error.message.includes('idempotency key belongs'))
  ) {
    return reply.code(409).send({
      error: {
        code: 'invalid_transition',
        message: 'Authorization state does not allow this operation.',
      },
    });
  }
  throw error;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

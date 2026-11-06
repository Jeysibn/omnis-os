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
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceTaskPageSchema,
  SetTaskEpicSchema,
  TaskEpicAssociationSchema,
  TaskEpicResponseSchema,
  TaskIdSchema,
  UpdateProjectSchema,
  ArchiveProjectSchema,
  ArchiveMilestoneSchema,
  CreateMilestoneSchema,
  MilestoneIdSchema,
  MilestoneListQuerySchema,
  MilestoneListResponseSchema,
  MilestoneSchema,
  UpdateMilestoneSchema,
  type Milestone,
  type MilestoneListResponse,
  ArchiveEpicSchema,
  CreateEpicSchema,
  EpicIdSchema,
  EpicListQuerySchema,
  EpicListResponseSchema,
  EpicSchema,
  UpdateEpicSchema,
  type Epic,
  type EpicListResponse,
  type ProjectWorkspaceTaskPage,
  type TaskEpicAssociation,
  type TaskEpicResponse,
} from '@omnis/contracts';
import type { ConnectorAuthorizerStore } from './connector-authorization-routes.ts';
import { registerConnectorAuthorizationRoutes } from './connector-authorization-routes.ts';
import {
  AgentLifecycleStoreError,
  DepartmentStoreError,
  MilestoneStoreError,
  EpicStoreError,
  ProjectStoreError,
} from '@omnis/db';

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
  updateProject(id: string, input: unknown, requestId: string): Promise<Project>;
  archiveProject(id: string, input: unknown, requestId: string): Promise<Project>;
  projectMilestones?:
    | {
        list(projectId: string, query: unknown): Promise<MilestoneListResponse>;
        get(projectId: string, milestoneId: string): Promise<Milestone | undefined>;
        create(projectId: string, input: unknown, requestId: string): Promise<Milestone>;
        update(
          projectId: string,
          milestoneId: string,
          input: unknown,
          requestId: string,
        ): Promise<Milestone>;
        archive(
          projectId: string,
          milestoneId: string,
          input: unknown,
          requestId: string,
        ): Promise<Milestone>;
      }
    | undefined;
  projectEpics?:
    | {
        list(projectId: string, query: unknown): Promise<EpicListResponse>;
        get(projectId: string, epicId: string): Promise<Epic | undefined>;
        create(projectId: string, input: unknown, requestId: string): Promise<Epic>;
        update(projectId: string, epicId: string, input: unknown, requestId: string): Promise<Epic>;
        archive(
          projectId: string,
          epicId: string,
          input: unknown,
          requestId: string,
        ): Promise<Epic>;
        listTasks(
          projectId: string,
          epicId: string,
          query: unknown,
        ): Promise<ProjectWorkspaceTaskPage>;
        getTaskEpic(taskId: string): Promise<TaskEpicResponse | undefined>;
        setTaskEpic(
          taskId: string,
          input: unknown,
          requestId: string,
        ): Promise<TaskEpicAssociation>;
      }
    | undefined;
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
  connectorStore?: ConnectorAuthorizerStore;
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

  app.patch<{ Params: { projectId: string } }>(
    '/internal/v1/projects/:projectId',
    { bodyLimit: 32 * 1024 },
    async (request, reply) => {
      const id = ProjectIdSchema.safeParse(request.params.projectId);
      const body = UpdateProjectSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (!id.success || !body.success || typeof requestId !== 'string' || !isUuid(requestId))
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Project update input is invalid.' },
        });
      try {
        return ProjectSchema.parse(await input.store.updateProject(id.data, body.data, requestId));
      } catch (error) {
        return sendProjectStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/internal/v1/projects/:projectId/archive',
    { bodyLimit: 32 * 1024 },
    async (request, reply) => {
      const id = ProjectIdSchema.safeParse(request.params.projectId);
      const body = ArchiveProjectSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (!id.success || !body.success || typeof requestId !== 'string' || !isUuid(requestId))
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Project archive input is invalid.' },
        });
      try {
        return ProjectSchema.parse(await input.store.archiveProject(id.data, body.data, requestId));
      } catch (error) {
        return sendProjectStoreError(error, reply);
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/internal/v1/projects/:projectId/milestones',
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const query = MilestoneListQuerySchema.safeParse(request.query);
      if (!projectId.success || !query.success)
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Milestone query is invalid.' },
        });
      try {
        return MilestoneListResponseSchema.parse(
          await requireProjectMilestones(input.store).list(projectId.data, query.data),
        );
      } catch (error) {
        return sendMilestoneStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/internal/v1/projects/:projectId/milestones',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const body = CreateMilestoneSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (
        !projectId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(400).send({
          error: {
            code: 'invalid_input',
            message: 'Milestone input and Idempotency-Key are required.',
          },
        });
      try {
        return reply
          .code(201)
          .send(
            MilestoneSchema.parse(
              await requireProjectMilestones(input.store).create(
                projectId.data,
                body.data,
                requestId,
              ),
            ),
          );
      } catch (error) {
        return sendMilestoneStoreError(error, reply);
      }
    },
  );

  app.get<{ Params: { projectId: string; milestoneId: string } }>(
    '/internal/v1/projects/:projectId/milestones/:milestoneId',
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const milestoneId = MilestoneIdSchema.safeParse(request.params.milestoneId);
      if (!projectId.success || !milestoneId.success)
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Milestone identifier is invalid.' },
        });
      try {
        const milestone = await requireProjectMilestones(input.store).get(
          projectId.data,
          milestoneId.data,
        );
        if (!milestone)
          return reply.code(404).send({
            error: { code: 'not_found', message: 'Project or milestone was not found.' },
          });
        return MilestoneSchema.parse(milestone);
      } catch (error) {
        return sendMilestoneStoreError(error, reply);
      }
    },
  );

  app.patch<{ Params: { projectId: string; milestoneId: string } }>(
    '/internal/v1/projects/:projectId/milestones/:milestoneId',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const milestoneId = MilestoneIdSchema.safeParse(request.params.milestoneId);
      const body = UpdateMilestoneSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (
        !projectId.success ||
        !milestoneId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Milestone update input is invalid.' },
        });
      try {
        return MilestoneSchema.parse(
          await requireProjectMilestones(input.store).update(
            projectId.data,
            milestoneId.data,
            body.data,
            requestId,
          ),
        );
      } catch (error) {
        return sendMilestoneStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { projectId: string; milestoneId: string } }>(
    '/internal/v1/projects/:projectId/milestones/:milestoneId/archive',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const milestoneId = MilestoneIdSchema.safeParse(request.params.milestoneId);
      const body = ArchiveMilestoneSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (
        !projectId.success ||
        !milestoneId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Milestone archive input is invalid.' },
        });
      try {
        return MilestoneSchema.parse(
          await requireProjectMilestones(input.store).archive(
            projectId.data,
            milestoneId.data,
            body.data,
            requestId,
          ),
        );
      } catch (error) {
        return sendMilestoneStoreError(error, reply);
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/internal/v1/projects/:projectId/epics',
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const query = EpicListQuerySchema.safeParse(request.query);
      if (!projectId.success || !query.success)
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Epic query is invalid.' },
        });
      try {
        return EpicListResponseSchema.parse(
          await requireProjectEpics(input.store).list(projectId.data, query.data),
        );
      } catch (error) {
        return sendEpicStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/internal/v1/projects/:projectId/epics',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const body = CreateEpicSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (
        !projectId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(400).send({
          error: {
            code: 'invalid_input',
            message: 'Epic input and Idempotency-Key are required.',
          },
        });
      try {
        return reply
          .code(201)
          .send(
            EpicSchema.parse(
              await requireProjectEpics(input.store).create(projectId.data, body.data, requestId),
            ),
          );
      } catch (error) {
        return sendEpicStoreError(error, reply);
      }
    },
  );

  app.get<{ Params: { projectId: string; epicId: string } }>(
    '/internal/v1/projects/:projectId/epics/:epicId',
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const epicId = EpicIdSchema.safeParse(request.params.epicId);
      if (!projectId.success || !epicId.success)
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Epic identifier is invalid.' },
        });
      try {
        const epic = await requireProjectEpics(input.store).get(projectId.data, epicId.data);
        if (!epic)
          return reply.code(404).send({
            error: { code: 'not_found', message: 'Project or epic was not found.' },
          });
        return EpicSchema.parse(epic);
      } catch (error) {
        return sendEpicStoreError(error, reply);
      }
    },
  );

  app.get<{
    Params: { projectId: string; epicId: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/internal/v1/projects/:projectId/epics/:epicId/tasks', async (request, reply) => {
    const projectId = ProjectIdSchema.safeParse(request.params.projectId);
    const epicId = EpicIdSchema.safeParse(request.params.epicId);
    const query = ProjectWorkspaceQuerySchema.safeParse(request.query);
    if (!projectId.success || !epicId.success || !query.success)
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Epic task query is invalid.' },
      });
    try {
      return ProjectWorkspaceTaskPageSchema.parse(
        await requireProjectEpics(input.store).listTasks(projectId.data, epicId.data, query.data),
      );
    } catch (error) {
      return sendEpicStoreError(error, reply);
    }
  });

  app.get<{ Params: { taskId: string } }>(
    '/internal/v1/tasks/:taskId/epic',
    async (request, reply) => {
      const taskId = TaskIdSchema.safeParse(request.params.taskId);
      if (!taskId.success)
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Task identifier is invalid.' },
        });
      try {
        const association = await requireProjectEpics(input.store).getTaskEpic(taskId.data);
        if (!association)
          return reply.code(404).send({
            error: { code: 'not_found', message: 'Task was not found.' },
          });
        return TaskEpicResponseSchema.parse(association);
      } catch (error) {
        return sendEpicStoreError(error, reply);
      }
    },
  );

  app.put<{ Params: { taskId: string } }>(
    '/internal/v1/tasks/:taskId/epic',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const taskId = TaskIdSchema.safeParse(request.params.taskId);
      const body = SetTaskEpicSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (!taskId.success || !body.success || typeof requestId !== 'string' || !isUuid(requestId))
        return reply.code(400).send({
          error: {
            code: 'invalid_input',
            message: 'Task Epic input and Idempotency-Key are required.',
          },
        });
      try {
        return TaskEpicAssociationSchema.parse(
          await requireProjectEpics(input.store).setTaskEpic(taskId.data, body.data, requestId),
        );
      } catch (error) {
        return sendEpicStoreError(error, reply);
      }
    },
  );

  app.patch<{ Params: { projectId: string; epicId: string } }>(
    '/internal/v1/projects/:projectId/epics/:epicId',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const epicId = EpicIdSchema.safeParse(request.params.epicId);
      const body = UpdateEpicSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (
        !projectId.success ||
        !epicId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Epic update input is invalid.' },
        });
      try {
        return EpicSchema.parse(
          await requireProjectEpics(input.store).update(
            projectId.data,
            epicId.data,
            body.data,
            requestId,
          ),
        );
      } catch (error) {
        return sendEpicStoreError(error, reply);
      }
    },
  );

  app.post<{ Params: { projectId: string; epicId: string } }>(
    '/internal/v1/projects/:projectId/epics/:epicId/archive',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const projectId = ProjectIdSchema.safeParse(request.params.projectId);
      const epicId = EpicIdSchema.safeParse(request.params.epicId);
      const body = ArchiveEpicSchema.safeParse(request.body);
      const requestId = request.headers['idempotency-key'];
      if (
        !projectId.success ||
        !epicId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Epic archive input is invalid.' },
        });
      try {
        return EpicSchema.parse(
          await requireProjectEpics(input.store).archive(
            projectId.data,
            epicId.data,
            body.data,
            requestId,
          ),
        );
      } catch (error) {
        return sendEpicStoreError(error, reply);
      }
    },
  );

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

  if (input.connectorStore) registerConnectorAuthorizationRoutes(app, input.connectorStore);

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
      request.method !== 'GET' &&
      (request.url.startsWith('/internal/v1/authorizations') ||
        request.url.startsWith('/internal/v1/connector-authorizations'));
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

function requireProjectMilestones(store: AuthorizerStore) {
  if (!store.projectMilestones) throw new Error('Project milestone store is unavailable.');
  return store.projectMilestones;
}

function sendMilestoneStoreError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof MilestoneStoreError)) throw error;
  return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
}

function requireProjectEpics(store: AuthorizerStore) {
  if (!store.projectEpics) throw new Error('Project epic store is unavailable.');
  return store.projectEpics;
}

function sendEpicStoreError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof EpicStoreError)) throw error;
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

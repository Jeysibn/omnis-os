import type { FastifyInstance } from 'fastify';
import {
  ProjectIdSchema,
  ProjectSchema,
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceResponseSchema,
  ProjectWorkspaceTaskPageSchema,
} from '@omnis/contracts';
import { requireOwner } from './auth.ts';
import { authorizerRequest } from './authorizer-client.ts';
import { workerRequest } from './worker-client.ts';

type AuthorizerRequest = typeof authorizerRequest;
type WorkerRequest = typeof workerRequest;

export function registerProjectWorkspaceRoutes(
  app: FastifyInstance,
  projectRequest: AuthorizerRequest = authorizerRequest,
  taskRequest: WorkerRequest = workerRequest,
) {
  app.get<{
    Params: { projectId: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/api/v1/projects/:projectId/tasks', { preHandler: requireOwner }, async (request, reply) => {
    const projectId = ProjectIdSchema.safeParse(request.params.projectId);
    const query = ProjectWorkspaceQuerySchema.safeParse(request.query);
    if (!projectId.success || !query.success) {
      return reply.code(422).send({
        error: { code: 'invalid_input', message: 'Project workspace query is invalid.' },
      });
    }

    const project = await projectRequest(
      `/internal/v1/projects/${encodeURIComponent(projectId.data)}`,
      {},
      (value) => ProjectSchema.parse(value),
    );
    const params = new URLSearchParams();
    if (query.data.cursor) params.set('cursor', query.data.cursor);
    if (query.data.limit !== undefined) params.set('limit', String(query.data.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const taskPage = await taskRequest(
      `/internal/v1/projects/${encodeURIComponent(projectId.data)}/tasks${suffix}`,
      {},
      (value) => ProjectWorkspaceTaskPageSchema.parse(value),
    );
    return ProjectWorkspaceResponseSchema.parse({ project, ...taskPage });
  });
}

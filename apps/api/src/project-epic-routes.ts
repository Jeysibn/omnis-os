import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyError } from 'fastify';
import {
  ArchiveEpicSchema,
  CreateEpicSchema,
  EpicIdSchema,
  EpicListQuerySchema,
  EpicListResponseSchema,
  EpicSchema,
  ProjectIdSchema,
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceTaskPageSchema,
  UpdateEpicSchema,
} from '@omnis/contracts';
import { requireMutationProtection, requireOwner } from './auth.ts';
import { authorizerRequest, AuthorizerRequestError } from './authorizer-client.ts';

type AuthorizerRequest = typeof authorizerRequest;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function epicErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AuthorizerRequestError) return reply.code(error.statusCode).send(error.body);
  if (error.statusCode === 400 || error.statusCode === 413)
    return reply.code(error.statusCode).send({
      error: {
        code: error.statusCode === 413 ? 'payload_too_large' : 'invalid_input',
        message:
          error.statusCode === 413
            ? 'Epic request exceeds the allowed size.'
            : 'Epic request is malformed.',
      },
    });
  request.log.error(
    { errorType: error instanceof Error ? error.name : 'unknown', requestId: request.id },
    'Project epic request failed.',
  );
  return reply.code(500).send({
    error: {
      code: 'internal_error',
      message: 'The epic request could not be completed.',
      requestId: request.id,
    },
  });
}

export function registerProjectEpicRoutes(
  app: FastifyInstance,
  request: AuthorizerRequest = authorizerRequest,
) {
  app.get<{
    Params: { projectId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    '/api/v1/projects/:projectId/epics',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const query = EpicListQuerySchema.safeParse(httpRequest.query);
      if (!projectId.success || !query.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Epic query is invalid.' },
        });
      const params = new URLSearchParams();
      if (query.data.cursor) params.set('cursor', query.data.cursor);
      if (query.data.limit !== undefined) params.set('limit', String(query.data.limit));
      const suffix = params.size ? `?${params.toString()}` : '';
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/epics${suffix}`,
        {},
        (value) => EpicListResponseSchema.parse(value),
      );
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/epics',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 16 * 1024,
      errorHandler: epicErrorHandler,
    },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const body = CreateEpicSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (
        !projectId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Epic input and a valid Idempotency-Key are required.',
          },
        });
      const epic = await request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/epics`,
        {
          method: 'POST',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => EpicSchema.parse(value),
      );
      return reply.code(201).send(epic);
    },
  );

  app.get<{ Params: { projectId: string; epicId: string } }>(
    '/api/v1/projects/:projectId/epics/:epicId',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const epicId = EpicIdSchema.safeParse(httpRequest.params.epicId);
      if (!projectId.success || !epicId.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Epic identifier is invalid.' },
        });
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/epics/${encodeURIComponent(epicId.data)}`,
        {},
        (value) => EpicSchema.parse(value),
      );
    },
  );

  app.get<{
    Params: { projectId: string; epicId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    '/api/v1/projects/:projectId/epics/:epicId/tasks',
    { preHandler: requireOwner, errorHandler: epicErrorHandler },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const epicId = EpicIdSchema.safeParse(httpRequest.params.epicId);
      const query = ProjectWorkspaceQuerySchema.safeParse(httpRequest.query);
      if (!projectId.success || !epicId.success || !query.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Epic task query is invalid.' },
        });
      const params = new URLSearchParams();
      if (query.data.cursor) params.set('cursor', query.data.cursor);
      if (query.data.limit !== undefined) params.set('limit', String(query.data.limit));
      const suffix = params.size ? `?${params.toString()}` : '';
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/epics/${encodeURIComponent(epicId.data)}/tasks${suffix}`,
        {},
        (value) => ProjectWorkspaceTaskPageSchema.parse(value),
      );
    },
  );

  app.patch<{ Params: { projectId: string; epicId: string } }>(
    '/api/v1/projects/:projectId/epics/:epicId',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 16 * 1024,
      errorHandler: epicErrorHandler,
    },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const epicId = EpicIdSchema.safeParse(httpRequest.params.epicId);
      const body = UpdateEpicSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (
        !projectId.success ||
        !epicId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Epic update input and a valid Idempotency-Key are required.',
          },
        });
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/epics/${encodeURIComponent(epicId.data)}`,
        {
          method: 'PATCH',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => EpicSchema.parse(value),
      );
    },
  );

  app.post<{ Params: { projectId: string; epicId: string } }>(
    '/api/v1/projects/:projectId/epics/:epicId/archive',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 16 * 1024,
      errorHandler: epicErrorHandler,
    },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const epicId = EpicIdSchema.safeParse(httpRequest.params.epicId);
      const body = ArchiveEpicSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (
        !projectId.success ||
        !epicId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Epic archive input and a valid Idempotency-Key are required.',
          },
        });
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/epics/${encodeURIComponent(epicId.data)}/archive`,
        {
          method: 'POST',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => EpicSchema.parse(value),
      );
    },
  );
}

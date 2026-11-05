import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyError } from 'fastify';
import {
  ArchiveMilestoneSchema,
  CreateMilestoneSchema,
  MilestoneIdSchema,
  MilestoneListQuerySchema,
  MilestoneListResponseSchema,
  MilestoneSchema,
  ProjectIdSchema,
  UpdateMilestoneSchema,
} from '@omnis/contracts';
import { requireMutationProtection, requireOwner } from './auth.ts';
import { authorizerRequest, AuthorizerRequestError } from './authorizer-client.ts';

type AuthorizerRequest = typeof authorizerRequest;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function milestoneErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AuthorizerRequestError) return reply.code(error.statusCode).send(error.body);
  if (error.statusCode === 400 || error.statusCode === 413)
    return reply.code(error.statusCode).send({
      error: {
        code: error.statusCode === 413 ? 'payload_too_large' : 'invalid_input',
        message:
          error.statusCode === 413
            ? 'Milestone request exceeds the allowed size.'
            : 'Milestone request is malformed.',
      },
    });
  request.log.error(
    { errorType: error instanceof Error ? error.name : 'unknown', requestId: request.id },
    'Project milestone request failed.',
  );
  return reply.code(500).send({
    error: {
      code: 'internal_error',
      message: 'The milestone request could not be completed.',
      requestId: request.id,
    },
  });
}

export function registerProjectMilestoneRoutes(
  app: FastifyInstance,
  request: AuthorizerRequest = authorizerRequest,
) {
  app.get<{
    Params: { projectId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    '/api/v1/projects/:projectId/milestones',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const query = MilestoneListQuerySchema.safeParse(httpRequest.query);
      if (!projectId.success || !query.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Milestone query is invalid.' },
        });
      const params = new URLSearchParams();
      if (query.data.cursor) params.set('cursor', query.data.cursor);
      if (query.data.limit !== undefined) params.set('limit', String(query.data.limit));
      const suffix = params.size ? `?${params.toString()}` : '';
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/milestones${suffix}`,
        {},
        (value) => MilestoneListResponseSchema.parse(value),
      );
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/milestones',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 16 * 1024,
      errorHandler: milestoneErrorHandler,
    },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const body = CreateMilestoneSchema.safeParse(httpRequest.body);
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
            message: 'Milestone input and a valid Idempotency-Key are required.',
          },
        });
      const milestone = await request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/milestones`,
        {
          method: 'POST',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => MilestoneSchema.parse(value),
      );
      return reply.code(201).send(milestone);
    },
  );

  app.get<{ Params: { projectId: string; milestoneId: string } }>(
    '/api/v1/projects/:projectId/milestones/:milestoneId',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const milestoneId = MilestoneIdSchema.safeParse(httpRequest.params.milestoneId);
      if (!projectId.success || !milestoneId.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Milestone identifier is invalid.' },
        });
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/milestones/${encodeURIComponent(milestoneId.data)}`,
        {},
        (value) => MilestoneSchema.parse(value),
      );
    },
  );

  app.patch<{ Params: { projectId: string; milestoneId: string } }>(
    '/api/v1/projects/:projectId/milestones/:milestoneId',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 16 * 1024,
      errorHandler: milestoneErrorHandler,
    },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const milestoneId = MilestoneIdSchema.safeParse(httpRequest.params.milestoneId);
      const body = UpdateMilestoneSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (
        !projectId.success ||
        !milestoneId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Milestone update input and a valid Idempotency-Key are required.',
          },
        });
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/milestones/${encodeURIComponent(milestoneId.data)}`,
        {
          method: 'PATCH',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => MilestoneSchema.parse(value),
      );
    },
  );

  app.post<{ Params: { projectId: string; milestoneId: string } }>(
    '/api/v1/projects/:projectId/milestones/:milestoneId/archive',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 16 * 1024,
      errorHandler: milestoneErrorHandler,
    },
    async (httpRequest, reply) => {
      const projectId = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const milestoneId = MilestoneIdSchema.safeParse(httpRequest.params.milestoneId);
      const body = ArchiveMilestoneSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (
        !projectId.success ||
        !milestoneId.success ||
        !body.success ||
        typeof requestId !== 'string' ||
        !isUuid(requestId)
      )
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Milestone archive input and a valid Idempotency-Key are required.',
          },
        });
      return request(
        `/internal/v1/projects/${encodeURIComponent(projectId.data)}/milestones/${encodeURIComponent(milestoneId.data)}/archive`,
        {
          method: 'POST',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => MilestoneSchema.parse(value),
      );
    },
  );
}

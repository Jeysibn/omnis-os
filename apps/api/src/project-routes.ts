import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ArchiveProjectSchema,
  CreateProjectSchema,
  ProjectIdSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  UpdateProjectSchema,
} from '@omnis/contracts';
import { requireMutationProtection, requireOwner } from './auth.ts';
import { authorizerRequest, AuthorizerRequestError } from './authorizer-client.ts';

type AuthorizerRequest = typeof authorizerRequest;

export function registerProjectRoutes(
  app: FastifyInstance,
  request: AuthorizerRequest = authorizerRequest,
) {
  const mutationErrorHandler = (
    error: FastifyError,
    httpRequest: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (error instanceof AuthorizerRequestError)
      return reply.code(error.statusCode).send(error.body);
    if (error.statusCode === 400 || error.statusCode === 413) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.statusCode === 413 ? 'payload_too_large' : 'invalid_input',
          message:
            error.statusCode === 413
              ? 'Project request exceeds the allowed size.'
              : 'Project request is malformed.',
        },
      });
    }
    httpRequest.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown', requestId: httpRequest.id },
      'Project management request failed.',
    );
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        message: 'The project request could not be completed.',
        requestId: httpRequest.id,
      },
    });
  };

  app.get('/api/v1/projects', { preHandler: requireOwner }, async () =>
    request('/internal/v1/projects', {}, (value) => ProjectListResponseSchema.parse(value)),
  );

  app.post(
    '/api/v1/projects',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 32 * 1024,
      errorHandler: mutationErrorHandler,
    },
    async (httpRequest, reply) => {
      const body = CreateProjectSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (!body.success || typeof requestId !== 'string' || !isUuid(requestId)) {
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Project input and a valid Idempotency-Key are required.',
          },
        });
      }
      const project = await request(
        '/internal/v1/projects',
        {
          method: 'POST',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => ProjectSchema.parse(value),
      );
      return reply.code(201).send(project);
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 32 * 1024,
      errorHandler: mutationErrorHandler,
    },
    async (httpRequest, reply) => {
      const id = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const body = UpdateProjectSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (!id.success || !body.success || typeof requestId !== 'string' || !isUuid(requestId))
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Project input and a valid Idempotency-Key are required.',
          },
        });
      const project = await request(
        `/internal/v1/projects/${encodeURIComponent(id.data)}`,
        {
          method: 'PATCH',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => ProjectSchema.parse(value),
      );
      return reply.code(200).send(project);
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/archive',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 32 * 1024,
      errorHandler: mutationErrorHandler,
    },
    async (httpRequest, reply) => {
      const id = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      const body = ArchiveProjectSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (!id.success || !body.success || typeof requestId !== 'string' || !isUuid(requestId))
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Project input and a valid Idempotency-Key are required.',
          },
        });
      const project = await request(
        `/internal/v1/projects/${encodeURIComponent(id.data)}/archive`,
        {
          method: 'POST',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => ProjectSchema.parse(value),
      );
      return reply.code(200).send(project);
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const id = ProjectIdSchema.safeParse(httpRequest.params.projectId);
      if (!id.success)
        return reply
          .code(422)
          .send({ error: { code: 'invalid_input', message: 'Project identifier is invalid.' } });
      return request(`/internal/v1/projects/${encodeURIComponent(id.data)}`, {}, (value) =>
        ProjectSchema.parse(value),
      );
    },
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

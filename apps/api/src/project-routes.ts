import type { FastifyInstance } from 'fastify';
import {
  CreateProjectSchema,
  ProjectIdSchema,
  ProjectListResponseSchema,
  ProjectSchema,
} from '@omnis/contracts';
import { requireMutationProtection, requireOwner } from './auth.ts';
import { authorizerRequest } from './authorizer-client.ts';

type AuthorizerRequest = typeof authorizerRequest;

export function registerProjectRoutes(
  app: FastifyInstance,
  request: AuthorizerRequest = authorizerRequest,
) {
  app.get('/api/v1/projects', { preHandler: requireOwner }, async () =>
    request('/internal/v1/projects', {}, (value) => ProjectListResponseSchema.parse(value)),
  );

  app.post(
    '/api/v1/projects',
    { preHandler: [requireOwner, requireMutationProtection], bodyLimit: 32 * 1024 },
    async (httpRequest, reply) => {
      const body = CreateProjectSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (
        !body.success ||
        typeof requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestId,
        )
      ) {
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

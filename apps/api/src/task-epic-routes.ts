import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SetTaskEpicSchema,
  TaskEpicAssociationSchema,
  TaskEpicResponseSchema,
  TaskIdSchema,
} from '@omnis/contracts';
import { requireMutationProtection, requireOwner } from './auth.ts';
import { authorizerRequest, AuthorizerRequestError } from './authorizer-client.ts';

type AuthorizerRequest = typeof authorizerRequest;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function taskEpicErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AuthorizerRequestError) return reply.code(error.statusCode).send(error.body);
  if (error.statusCode === 400 || error.statusCode === 413)
    return reply.code(error.statusCode).send({
      error: {
        code: error.statusCode === 413 ? 'payload_too_large' : 'invalid_input',
        message:
          error.statusCode === 413
            ? 'Task Epic request exceeds the allowed size.'
            : 'Task Epic request is malformed.',
      },
    });
  request.log.error(
    { errorType: error instanceof Error ? error.name : 'unknown', requestId: request.id },
    'Task Epic request failed.',
  );
  return reply.code(500).send({
    error: {
      code: 'internal_error',
      message: 'The task Epic request could not be completed.',
      requestId: request.id,
    },
  });
}

export function registerTaskEpicRoutes(
  app: FastifyInstance,
  request: AuthorizerRequest = authorizerRequest,
) {
  app.get<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/epic',
    { preHandler: requireOwner, errorHandler: taskEpicErrorHandler },
    async (httpRequest, reply) => {
      const taskId = TaskIdSchema.safeParse(httpRequest.params.taskId);
      if (!taskId.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Task identifier is invalid.' },
        });
      return request(`/internal/v1/tasks/${encodeURIComponent(taskId.data)}/epic`, {}, (value) =>
        TaskEpicResponseSchema.parse(value),
      );
    },
  );

  app.put<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/epic',
    {
      preHandler: [requireOwner, requireMutationProtection],
      bodyLimit: 4 * 1024,
      errorHandler: taskEpicErrorHandler,
    },
    async (httpRequest, reply) => {
      const taskId = TaskIdSchema.safeParse(httpRequest.params.taskId);
      const body = SetTaskEpicSchema.safeParse(httpRequest.body);
      const requestId = httpRequest.headers['idempotency-key'];
      if (!taskId.success || !body.success || typeof requestId !== 'string' || !isUuid(requestId))
        return reply.code(422).send({
          error: {
            code: 'invalid_input',
            message: 'Task Epic input and a valid Idempotency-Key are required.',
          },
        });
      const receipt = await request(
        `/internal/v1/tasks/${encodeURIComponent(taskId.data)}/epic`,
        {
          method: 'PUT',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => TaskEpicAssociationSchema.parse(value),
      );
      return reply.send(receipt);
    },
  );
}

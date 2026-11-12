import type { FastifyInstance } from 'fastify';
import {
  CreateTaskSchema,
  SetTaskExecutionAssignmentSchema,
  SetTaskProjectSchema,
  TaskIdSchema,
  TaskSchema,
  AcceptTaskResultRequestSchema,
  TaskResultAcceptanceResponseSchema,
} from '@omnis/contracts';
import { requireMutationProtection, requireOwner } from './auth.ts';
import { parseTaskList, workerRequest } from './worker-client.ts';
import { authorizerRequest } from './authorizer-client.ts';

type WorkerRequest = typeof workerRequest;
type AuthorizerRequest = typeof authorizerRequest;

export function registerTaskRoutes(
  app: FastifyInstance,
  request: WorkerRequest = workerRequest,
  authorize: AuthorizerRequest = authorizerRequest,
) {
  app.get('/api/v1/tasks', { preHandler: requireOwner }, async () =>
    request('/internal/v1/tasks', {}, parseTaskList),
  );

  app.post(
    '/api/v1/tasks',
    { preHandler: [requireOwner, requireMutationProtection] },
    async (httpRequest, reply) => {
      const parsed = CreateTaskSchema.safeParse(httpRequest.body);
      const requestId = parseIdempotencyKey(httpRequest.headers['idempotency-key']);
      const keyWasSupplied = httpRequest.headers['idempotency-key'] !== undefined;
      if (
        !parsed.success ||
        (keyWasSupplied && !requestId) ||
        (parsed.data?.projectId != null && !requestId)
      ) {
        return reply.code(400).send({
          error: {
            code: 'invalid_input',
            message: 'Task input is invalid; project tasks require a valid Idempotency-Key.',
          },
        });
      }
      const task = await request(
        '/internal/v1/tasks',
        {
          method: 'POST',
          ...(requestId ? { headers: { 'idempotency-key': requestId } } : {}),
          body: JSON.stringify(parsed.data),
        },
        (value) => TaskSchema.parse(value),
      );
      return reply.code(201).send(task);
    },
  );

  app.put<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/project',
    { preHandler: [requireOwner, requireMutationProtection] },
    async (httpRequest, reply) => {
      const taskId = TaskIdSchema.safeParse(httpRequest.params.taskId);
      const body = SetTaskProjectSchema.safeParse(httpRequest.body);
      const requestId = parseIdempotencyKey(httpRequest.headers['idempotency-key']);
      if (!taskId.success || !body.success || !requestId) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Task project input is invalid.' },
        });
      }
      const task = await request(
        `/internal/v1/tasks/${encodeURIComponent(taskId.data)}/project`,
        {
          method: 'PUT',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => TaskSchema.parse(value),
      );
      return reply.send(task);
    },
  );

  app.put<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/execution-assignment',
    { preHandler: [requireOwner, requireMutationProtection] },
    async (httpRequest, reply) => {
      const taskId = TaskIdSchema.safeParse(httpRequest.params.taskId);
      const body = SetTaskExecutionAssignmentSchema.safeParse(httpRequest.body);
      const requestId = parseIdempotencyKey(httpRequest.headers['idempotency-key']);
      if (!taskId.success || !body.success || !requestId) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Task execution assignment input is invalid.' },
        });
      }
      const task = await request(
        `/internal/v1/tasks/${encodeURIComponent(taskId.data)}/execution-assignment`,
        {
          method: 'PUT',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => TaskSchema.parse(value),
      );
      return reply.send(task);
    },
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/v1/tasks/:taskId/accept-result',
    { preHandler: [requireOwner, requireMutationProtection] },
    async (httpRequest, reply) => {
      const taskId = TaskIdSchema.safeParse(httpRequest.params.taskId);
      const body = AcceptTaskResultRequestSchema.safeParse(httpRequest.body);
      const requestId = parseIdempotencyKey(httpRequest.headers['idempotency-key']);
      if (!taskId.success || !body.success || !requestId) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Task result acceptance input is invalid.' },
        });
      }
      return authorize(
        `/internal/v1/tasks/${encodeURIComponent(taskId.data)}/accept-result`,
        {
          method: 'POST',
          headers: { 'idempotency-key': requestId },
          body: JSON.stringify(body.data),
        },
        (value) => TaskResultAcceptanceResponseSchema.parse(value),
      );
    },
  );
}

function parseIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    return undefined;
  }
  return value;
}

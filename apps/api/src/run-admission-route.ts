import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { CreateRunSchema, type Run } from '@omnis/contracts';
import type { ExecutionMode } from '@omnis/contracts/execution-mode';

type WorkerRequest = <T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
) => Promise<T>;

export function registerRunAdmissionRoute(
  app: FastifyInstance,
  input: {
    requireOwner: preHandlerHookHandler;
    requireMutationProtection: preHandlerHookHandler;
    executionMode: ExecutionMode;
    authorizationAvailable: () => Promise<boolean>;
    workerRequest: WorkerRequest;
    parseRun: (value: unknown) => Run;
  },
): void {
  app.post(
    '/api/v1/runs',
    { preHandler: [input.requireOwner, input.requireMutationProtection] },
    async (request, reply) => {
      if (input.executionMode === 'disabled') {
        return reply.code(503).send({
          error: {
            code: 'execution_disabled',
            message: 'Run execution is disabled by application configuration.',
          },
        });
      }
      if (!(await input.authorizationAvailable())) {
        return reply.code(503).send({
          error: {
            code: 'authorization_unavailable',
            message: 'Run execution is unavailable while authorization is unavailable.',
          },
        });
      }

      const parsed = CreateRunSchema.safeParse(request.body);
      const idempotencyKey = request.headers['idempotency-key'];
      if (
        !parsed.success ||
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < 16 ||
        idempotencyKey.length > 128
      ) {
        return reply.code(400).send({
          error: {
            code: 'invalid_input',
            message: 'A task and valid Idempotency-Key are required.',
          },
        });
      }
      const run = await input.workerRequest(
        '/internal/v1/runs',
        {
          method: 'POST',
          headers: { 'idempotency-key': idempotencyKey },
          body: JSON.stringify(parsed.data),
        },
        input.parseRun,
      );
      return reply.code(run.status === 'queued' ? 201 : 200).send(run);
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { CreateRunSchema, RunSchema } from '@omnis/contracts';
import { CoordinatorError, type RunCoordinator } from './run-coordinator.ts';

export function registerRunExecutionRoutes(
  app: FastifyInstance,
  coordinator: Pick<RunCoordinator, 'startRun' | 'stopRun'>,
): void {
  app.post('/internal/v1/runs', async (request, reply) => {
    const parsed = CreateRunSchema.safeParse(request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (
      !parsed.success ||
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 16 ||
      idempotencyKey.length > 128
    ) {
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Run input or Idempotency-Key is invalid.' },
      });
    }
    try {
      const result = await coordinator.startRun(
        parsed.data.taskId,
        idempotencyKey,
        parsed.data.authorizationId,
      );
      return reply.code(result.created ? 201 : 200).send(RunSchema.parse(result.run));
    } catch (error) {
      if (error instanceof CoordinatorError) {
        return reply
          .code(error.statusCode)
          .send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post<{ Params: { runId: string } }>(
    '/internal/v1/runs/:runId/stop',
    async (request, reply) => {
      try {
        return RunSchema.parse(await coordinator.stopRun(request.params.runId));
      } catch (error) {
        if (error instanceof CoordinatorError) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    },
  );
}

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { SyntheticTaskRunRequestSchema } from '@omnis/contracts/synthetic-task-run';
import type { PostgresRunStore } from '@omnis/db';
import type { SyntheticBrokerExecutor } from './synthetic-broker-client.ts';

export function registerSyntheticTaskRunRoute(
  app: FastifyInstance,
  input: {
    authenticate: preHandlerHookHandler;
    enabled: boolean;
    store: Pick<PostgresRunStore, 'getTask'>;
    broker: SyntheticBrokerExecutor;
  },
): void {
  if (!input.enabled) return;
  app.post<{ Params: { taskId: string } }>(
    '/internal/v1/tasks/:taskId/synthetic-runs',
    { preHandler: input.authenticate },
    async (request, reply) => {
      const parsed = SyntheticTaskRunRequestSchema.safeParse(request.body);
      const idempotencyKey = request.headers['idempotency-key'];
      if (
        !parsed.success ||
        parsed.data.request.taskId !== request.params.taskId ||
        typeof idempotencyKey !== 'string' ||
        idempotencyKey !== parsed.data.requestId
      ) {
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Synthetic task run request is invalid.' },
        });
      }
      const task = await input.store.getTask(request.params.taskId);
      if (!task) {
        return reply.code(404).send({
          error: { code: 'not_found', message: 'Task was not found.' },
        });
      }
      try {
        return await input.broker.execute(task.id, parsed.data);
      } catch {
        return reply.code(503).send({
          error: {
            code: 'synthetic_broker_unavailable',
            message:
              'The synthetic broker did not confirm the execution outcome. Do not resubmit with a new request identity.',
          },
        });
      }
    },
  );
}

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { AgentProfileVersionSchema } from '@omnis/contracts';
import { renderSyntheticConnectorRequest } from '@omnis/contracts/synthetic-connector-prompt';
import { SyntheticTaskRunRequestSchema } from '@omnis/contracts/synthetic-task-run';
import type { PostgresAgentProfileStore, PostgresRunStore } from '@omnis/db';
import type { SyntheticBrokerExecutor } from './synthetic-broker-client.ts';

export function registerSyntheticTaskRunRoute(
  app: FastifyInstance,
  input: {
    authenticate: preHandlerHookHandler;
    enabled: boolean;
    store: Pick<PostgresRunStore, 'getTask'>;
    profiles: Pick<PostgresAgentProfileStore, 'getVersion'>;
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
      const profileResponse = await input.profiles.getVersion(
        parsed.data.request.agentId,
        parsed.data.request.profileVersion,
      );
      const profile = profileResponse
        ? AgentProfileVersionSchema.safeParse(profileResponse.version)
        : undefined;
      if (
        !profile?.success ||
        task.status === 'completed' ||
        profile.data.agentId !== parsed.data.request.agentId ||
        profile.data.versionNo !== parsed.data.request.profileVersion ||
        task.projectId !== parsed.data.request.projectId ||
        task.associationRevision !== parsed.data.request.taskRevision
      ) {
        return reply.code(409).send({
          error: {
            code: 'authorization_context_changed',
            message: 'The task or immutable agent profile no longer matches the approved request.',
          },
        });
      }
      let renderedRequest: string;
      try {
        renderedRequest = renderSyntheticConnectorRequest(task, profile.data);
      } catch {
        return reply.code(400).send({
          error: { code: 'invalid_rendered_request', message: 'The request cannot be rendered.' },
        });
      }
      if (
        renderedRequest !== parsed.data.renderedRequest ||
        createRenderedRequestDigest(renderedRequest) !== parsed.data.request.promptDigest
      ) {
        return reply.code(409).send({
          error: {
            code: 'request_binding_failed',
            message: 'The rendered request does not match the canonical approved task and profile.',
          },
        });
      }
      try {
        return await input.broker.execute(task.id, { ...parsed.data, renderedRequest });
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

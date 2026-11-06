import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';
import { AgentProfileVersionSchema, type Run } from '@omnis/contracts';
import { renderSyntheticConnectorRequest } from '@omnis/contracts/synthetic-connector-prompt';
import {
  SyntheticTaskRunAdmissionRequestSchema,
  SyntheticTaskRunAdmissionResponseSchema,
  type SyntheticTaskRunAdmissionRequest,
} from '@omnis/contracts/synthetic-task-run';
import type { PostgresAgentProfileStore, PostgresRunStore } from '@omnis/db';

const CancellationInputSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    authorizationId: z.string().uuid(),
  })
  .strict();

type AdmitSyntheticRun = (input: {
  taskId: string;
  authorizationId: string;
  requestId: string;
  correlationId: string;
  binding: SyntheticTaskRunAdmissionRequest['request'];
}) => Promise<{ run: Run; created: boolean }>;

type CancelSyntheticRun = (input: {
  runId: string;
  taskId: string;
  authorizationId: string;
}) => Promise<void>;

export function registerSyntheticTaskRunRoute(
  app: FastifyInstance,
  input: {
    authenticate: preHandlerHookHandler;
    enabled: boolean;
    store: Pick<PostgresRunStore, 'getTask'>;
    profiles: Pick<PostgresAgentProfileStore, 'getVersion'>;
    admit: AdmitSyntheticRun;
    cancel: CancelSyntheticRun;
  },
): void {
  if (!input.enabled) return;
  app.post<{ Params: { taskId: string } }>(
    '/internal/v1/tasks/:taskId/synthetic-runs',
    { preHandler: input.authenticate },
    async (request, reply) => {
      const parsed = SyntheticTaskRunAdmissionRequestSchema.safeParse(request.body);
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
        task.id !== request.params.taskId ||
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
        const admitted = await input.admit({
          taskId: task.id,
          authorizationId: parsed.data.authorizationId,
          requestId: parsed.data.requestId,
          correlationId: parsed.data.correlationId,
          binding: parsed.data.request,
        });
        return reply.code(admitted.created ? 202 : 200).send(
          SyntheticTaskRunAdmissionResponseSchema.parse({
            version: 'omnis.synthetic-task-run.v1',
            created: admitted.created,
            run: admitted.run,
          }),
        );
      } catch {
        return reply.code(503).send({
          error: {
            code: 'synthetic_run_admission_unavailable',
            message:
              'The durable synthetic Run admission could not be confirmed. Retry only with the same request identity.',
          },
        });
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    '/internal/v1/synthetic-runs/:runId/cancel',
    { preHandler: input.authenticate },
    async (request, reply) => {
      const parsed = CancellationInputSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: { code: 'invalid_input', message: 'Synthetic cancellation input is invalid.' },
        });
      try {
        await input.cancel({ runId: request.params.runId, ...parsed.data });
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({
          error: { code: 'not_found', message: 'Synthetic task run was not found.' },
        });
      }
    },
  );
}

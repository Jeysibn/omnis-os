import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ApiErrorSchema, RunSchema } from '@omnis/contracts';
import { stopSyntheticRunBeforeStandardStop } from './synthetic-run-stop.ts';

type Forwarder = <TResult>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => TResult,
) => Promise<TResult>;

export function registerRunStopRoute(
  app: FastifyInstance,
  input: {
    requireOwner: preHandlerHookHandler;
    requireMutationProtection: preHandlerHookHandler;
    syntheticBrokerEnabled: boolean;
    forwardWorker?: Forwarder;
    forwardAuthorizer?: Forwarder;
  },
): void {
  const toWorker: Forwarder =
    input.forwardWorker ??
    ((path, init, parse) =>
      import('./worker-client.ts').then(({ workerRequest }) => workerRequest(path, init, parse)));
  const toAuthorizer: Forwarder =
    input.forwardAuthorizer ??
    ((path, init, parse) =>
      import('./authorizer-client.ts').then(({ authorizerRequest }) =>
        authorizerRequest(path, init, parse),
      ));

  app.post<{ Params: { runId: string } }>(
    '/api/v1/runs/:runId/stop',
    { preHandler: [input.requireOwner, input.requireMutationProtection] },
    async (request, reply) => {
      if (input.syntheticBrokerEnabled) {
        try {
          const syntheticRun = await stopSyntheticRunBeforeStandardStop(request.params.runId, {
            forwardWorker: toWorker,
            forwardAuthorizer: toAuthorizer,
          });
          if (syntheticRun) return reply.send(syntheticRun);
        } catch (error) {
          const forwardingError = parseForwardingError(error);
          if (forwardingError) return reply.code(503).send(forwardingError);
          throw error;
        }
      }
      return toWorker(
        `/internal/v1/runs/${encodeURIComponent(request.params.runId)}/stop`,
        { method: 'POST' },
        (value) => RunSchema.parse(value),
      );
    },
  );
}

function parseForwardingError(error: unknown) {
  if (!error || typeof error !== 'object' || !('body' in error)) return undefined;
  const parsed = ApiErrorSchema.safeParse(error.body);
  return parsed.success ? parsed.data : undefined;
}

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  runtimeCapabilities,
  type RuntimeCapabilities,
} from '@omnis/contracts/runtime-capabilities';

export function registerRuntimeCapabilityRoutes(
  app: FastifyInstance,
  input: {
    requireOwner: preHandlerHookHandler;
    syntheticConnectorEnabled: boolean;
    getWorkerCapabilities: () => Promise<RuntimeCapabilities>;
  },
) {
  app.get('/api/v1/runtime-capabilities', { preHandler: input.requireOwner }, async () => {
    const worker = await input.getWorkerCapabilities();
    return runtimeCapabilities(input.syntheticConnectorEnabled, worker.executionMode);
  });
}

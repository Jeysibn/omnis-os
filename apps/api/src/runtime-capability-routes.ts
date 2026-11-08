import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { runtimeCapabilities } from '@omnis/contracts/runtime-capabilities';

export function registerRuntimeCapabilityRoutes(
  app: FastifyInstance,
  input: { requireOwner: preHandlerHookHandler; syntheticConnectorEnabled: boolean },
) {
  app.get('/api/v1/runtime-capabilities', { preHandler: input.requireOwner }, async () =>
    runtimeCapabilities(input.syntheticConnectorEnabled),
  );
}

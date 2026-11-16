import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  runtimeCapabilities,
  type WorkerExecutionStatus,
} from '@omnis/contracts/runtime-capabilities';
import type { ExecutionMode } from '@omnis/contracts/execution-mode';

export function registerRuntimeCapabilityRoutes(
  app: FastifyInstance,
  input: {
    requireOwner: preHandlerHookHandler;
    configuredMode: ExecutionMode;
    syntheticConnectorEnabled: boolean;
    getWorkerStatus: () => Promise<WorkerExecutionStatus>;
    checkAuthorizationDependency: () => Promise<boolean>;
  },
) {
  app.get('/api/v1/runtime-capabilities', { preHandler: input.requireOwner }, async () => {
    const [workerStatus, authorizationAvailable] = await Promise.all([
      input.getWorkerStatus().catch(() => undefined),
      input.checkAuthorizationDependency().catch(() => false),
    ]);
    return runtimeCapabilities({
      apiExecutionMode: input.configuredMode,
      ...(workerStatus ? { workerStatus } : {}),
      authorizationAvailable,
      syntheticConnectorEnabled: input.syntheticConnectorEnabled,
    });
  });
}

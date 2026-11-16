import { runtimeCapabilities } from '@omnis/contracts/runtime-capabilities';

/** Available synthetic mock execution, for fixtures that only need the Tasks page to load. */
export const capabilityFixtureJson = () =>
  runtimeCapabilities({
    apiExecutionMode: 'mock',
    workerStatus: {
      version: 'omnis.worker-execution-status.v1',
      serviceAvailability: 'healthy',
      executionMode: 'mock',
      queueAvailability: 'available',
      launcherAvailability: 'available',
    },
    authorizationAvailable: true,
    syntheticConnectorEnabled: false,
  });

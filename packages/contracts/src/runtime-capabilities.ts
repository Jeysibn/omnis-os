import { z } from 'zod';
import { ExecutionModeSchema, type ExecutionMode } from './execution-mode.ts';

export const WorkerExecutionStatusSchema = z
  .object({
    version: z.literal('omnis.worker-execution-status.v1'),
    serviceAvailability: z.enum(['healthy', 'unavailable']),
    executionMode: ExecutionModeSchema,
    queueAvailability: z.enum(['not_required', 'available', 'unavailable']),
    launcherAvailability: z.enum(['not_required', 'available', 'unavailable']),
  })
  .strict()
  .refine(
    (value) =>
      (value.executionMode === 'disabled' &&
        value.queueAvailability === 'not_required' &&
        value.launcherAvailability === 'not_required') ||
      (value.executionMode === 'mock' &&
        value.queueAvailability !== 'not_required' &&
        value.launcherAvailability !== 'not_required'),
  );
export type WorkerExecutionStatus = z.infer<typeof WorkerExecutionStatusSchema>;

export const RuntimeCapabilitiesSchema = z
  .object({
    version: z.literal('omnis.runtime-capabilities.v3'),
    services: z
      .object({
        api: z.literal('healthy'),
        worker: z.enum(['healthy', 'unavailable']),
      })
      .strict(),
    execution: z
      .object({
        configuredMode: ExecutionModeSchema,
        workerMode: ExecutionModeSchema.nullable(),
        capability: z.enum(['disabled', 'mock_synthetic', 'unavailable']),
        availability: z.enum(['disabled', 'available', 'unavailable']),
        queueAvailability: z.enum(['not_required', 'available', 'unavailable', 'unknown']),
        launcherAvailability: z.enum(['not_required', 'available', 'unavailable', 'unknown']),
      })
      .strict(),
    authorization: z.object({ availability: z.enum(['available', 'unavailable']) }).strict(),
    syntheticConnectorFixture: z
      .object({
        enabled: z.boolean(),
        providerId: z.literal('synthetic'),
        modelId: z.literal('synthetic-text-only-v1'),
        synthetic: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .refine((value) => {
    const { execution, services, authorization } = value;
    if (services.worker === 'unavailable') {
      return (
        execution.workerMode === null &&
        execution.capability === 'unavailable' &&
        execution.availability === 'unavailable' &&
        execution.queueAvailability === 'unknown' &&
        execution.launcherAvailability === 'unknown'
      );
    }
    if (execution.workerMode !== execution.configuredMode) {
      return execution.capability === 'unavailable' && execution.availability === 'unavailable';
    }
    if (execution.configuredMode === 'disabled') {
      return (
        execution.capability === 'disabled' &&
        execution.availability === 'disabled' &&
        execution.queueAvailability === 'not_required' &&
        execution.launcherAvailability === 'not_required' &&
        !value.syntheticConnectorFixture.enabled
      );
    }
    return (
      execution.capability === 'mock_synthetic' &&
      execution.availability ===
        (execution.queueAvailability === 'available' &&
        execution.launcherAvailability === 'available' &&
        services.worker === 'healthy' &&
        authorization.availability === 'available'
          ? 'available'
          : 'unavailable') &&
      (!value.syntheticConnectorFixture.enabled || execution.availability === 'available')
    );
  });
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export function runtimeCapabilities(input: {
  apiExecutionMode: ExecutionMode;
  workerStatus?: WorkerExecutionStatus;
  authorizationAvailable: boolean;
  syntheticConnectorEnabled: boolean;
}): RuntimeCapabilities {
  const workerStatus = input.workerStatus;
  const workerAvailable = workerStatus?.serviceAvailability === 'healthy';
  const workerMode = workerAvailable && workerStatus ? workerStatus.executionMode : null;
  const queueAvailability =
    workerAvailable && workerStatus ? workerStatus.queueAvailability : 'unknown';
  const launcherAvailability =
    workerAvailable && workerStatus ? workerStatus.launcherAvailability : 'unknown';
  let capability: RuntimeCapabilities['execution']['capability'] = 'unavailable';
  let availability: RuntimeCapabilities['execution']['availability'] = 'unavailable';

  if (workerAvailable && workerMode === input.apiExecutionMode) {
    if (input.apiExecutionMode === 'disabled') {
      capability = 'disabled';
      availability = 'disabled';
    } else {
      capability = 'mock_synthetic';
      availability =
        queueAvailability === 'available' &&
        launcherAvailability === 'available' &&
        input.authorizationAvailable
          ? 'available'
          : 'unavailable';
    }
  }

  return RuntimeCapabilitiesSchema.parse({
    version: 'omnis.runtime-capabilities.v3',
    services: { api: 'healthy', worker: workerAvailable ? 'healthy' : 'unavailable' },
    execution: {
      configuredMode: input.apiExecutionMode,
      workerMode,
      capability,
      availability,
      queueAvailability,
      launcherAvailability,
    },
    authorization: { availability: input.authorizationAvailable ? 'available' : 'unavailable' },
    syntheticConnectorFixture: {
      enabled: input.syntheticConnectorEnabled && availability === 'available',
      providerId: 'synthetic',
      modelId: 'synthetic-text-only-v1',
      synthetic: true,
    },
  });
}

import type { ExecutionMode } from '@omnis/contracts/execution-mode';
import type { WorkerExecutionStatus } from '@omnis/contracts/runtime-capabilities';

export async function resolveWorkerExecutionStatus(input: {
  executionMode: ExecutionMode;
  queueAvailability: WorkerExecutionStatus['queueAvailability'];
  checkDatabase: () => Promise<void>;
  checkLauncher: () => Promise<boolean>;
}): Promise<WorkerExecutionStatus> {
  let serviceAvailability: WorkerExecutionStatus['serviceAvailability'] = 'healthy';
  try {
    await input.checkDatabase();
  } catch {
    serviceAvailability = 'unavailable';
  }

  if (input.executionMode === 'disabled') {
    return {
      version: 'omnis.worker-execution-status.v1',
      serviceAvailability,
      executionMode: 'disabled',
      queueAvailability: 'not_required',
      launcherAvailability: 'not_required',
    };
  }

  let launcherAvailability: WorkerExecutionStatus['launcherAvailability'] = 'unavailable';
  try {
    if (await input.checkLauncher()) launcherAvailability = 'available';
  } catch {
    launcherAvailability = 'unavailable';
  }
  return {
    version: 'omnis.worker-execution-status.v1',
    serviceAvailability,
    executionMode: 'mock',
    queueAvailability: input.queueAvailability,
    launcherAvailability,
  };
}

import { z } from 'zod';

export const ExecutionModeSchema = z.enum(['disabled', 'mock']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/** Missing configuration is deliberately non-executing. Unknown values fail startup. */
export function executionModeFromEnvironment(value: string | undefined): ExecutionMode {
  return value === undefined || value.trim() === '' ? 'disabled' : ExecutionModeSchema.parse(value);
}

export function validateExecutionConfiguration(
  mode: ExecutionMode,
  launcherSocket: string | undefined,
): void {
  if (mode === 'mock' && (!launcherSocket || !launcherSocket.startsWith('/'))) {
    throw new Error('Mock execution requires an absolute OMNIS_SANDBOX_LAUNCHER_SOCKET.');
  }
}

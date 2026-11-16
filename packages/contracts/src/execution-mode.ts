import { z } from 'zod';

export const ExecutionModeSchema = z.enum(['disabled', 'mock']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export function restrictedDevelopmentFromEnvironment(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('OMNIS_RESTRICTED_DEVELOPMENT must be true or false when configured.');
}

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

/**
 * Locks each API/Worker process to disabled mode. Operators must stop older mock-enabled Workers
 * before switching profiles; this process-local check is not global Worker revocation.
 */
export function validateRestrictedDevelopmentConfiguration(input: {
  restrictedDevelopment: boolean;
  configuredMode: ExecutionMode;
  rawMode: string | undefined;
  authorizerToken?: string | undefined;
  authorizerSocket?: string | undefined;
  launcherSocket?: string | undefined;
  authorizerSecrets?: readonly (string | undefined)[];
}): void {
  if (!input.restrictedDevelopment) return;
  if (input.configuredMode !== 'disabled' || input.rawMode !== 'disabled') {
    throw new Error(
      'The restricted development profile requires OMNIS_EXECUTION_MODE=disabled explicitly.',
    );
  }
  if (
    input.authorizerToken ||
    input.authorizerSocket ||
    input.launcherSocket ||
    input.authorizerSecrets?.some(Boolean)
  ) {
    throw new Error(
      'The restricted development profile must not configure Authorizer secrets or socket, or launcher endpoints.',
    );
  }
}

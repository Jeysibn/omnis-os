import { z } from 'zod';
import { ExecutionModeSchema, type ExecutionMode } from './execution-mode.ts';

export const RuntimeCapabilitiesSchema = z
  .object({
    version: z.literal('omnis.runtime-capabilities.v2'),
    executionMode: ExecutionModeSchema,
    mockRuntime: z.object({ enabled: z.boolean(), synthetic: z.literal(true) }).strict(),
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
  .refine((value) => value.mockRuntime.enabled === (value.executionMode === 'mock'));
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export function runtimeCapabilities(
  syntheticConnectorEnabled: boolean,
  executionMode: ExecutionMode = 'mock',
): RuntimeCapabilities {
  return RuntimeCapabilitiesSchema.parse({
    version: 'omnis.runtime-capabilities.v2',
    executionMode,
    mockRuntime: { enabled: executionMode === 'mock', synthetic: true },
    syntheticConnectorFixture: {
      enabled: syntheticConnectorEnabled && executionMode === 'mock',
      providerId: 'synthetic',
      modelId: 'synthetic-text-only-v1',
      synthetic: true,
    },
  });
}

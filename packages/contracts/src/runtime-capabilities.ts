import { z } from 'zod';

export const RuntimeCapabilitiesSchema = z
  .object({
    version: z.literal('omnis.runtime-capabilities.v1'),
    mockRuntime: z.object({ enabled: z.literal(true), synthetic: z.literal(true) }).strict(),
    syntheticConnectorFixture: z
      .object({
        enabled: z.boolean(),
        providerId: z.literal('synthetic'),
        modelId: z.literal('synthetic-text-only-v1'),
        synthetic: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export function runtimeCapabilities(syntheticConnectorEnabled: boolean): RuntimeCapabilities {
  return RuntimeCapabilitiesSchema.parse({
    version: 'omnis.runtime-capabilities.v1',
    mockRuntime: { enabled: true, synthetic: true },
    syntheticConnectorFixture: {
      enabled: syntheticConnectorEnabled,
      providerId: 'synthetic',
      modelId: 'synthetic-text-only-v1',
      synthetic: true,
    },
  });
}

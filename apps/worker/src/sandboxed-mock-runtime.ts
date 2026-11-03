import { z } from 'zod';
import type { RunEvent, RuntimeCapabilities } from '@omnis/contracts';
import type { RuntimeAdapter } from '@omnis/runtime-adapters';
import type { MockSandboxLauncherClient } from './sandbox-launcher-client.ts';

const RunOutputSchema = z.object({
  type: z.literal('run.output'),
  message: z.string().min(1).max(2_000),
});

export class SandboxedMockRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'mock' as const;
  private readonly sandbox: MockSandboxLauncherClient;

  constructor(sandbox: MockSandboxLauncherClient) {
    this.sandbox = sandbox;
  }

  discoverCapabilities(): RuntimeCapabilities {
    return {
      runtimeKind: 'mock',
      allowedUse: 'both',
      canStreamEvents: true,
      canCancel: true,
      canReportUsage: false,
      synthetic: true,
    };
  }

  async execute({
    runId,
    lease,
    signal,
    emit,
  }: Parameters<RuntimeAdapter['execute']>[0]): Promise<{ output: string }> {
    const result = await this.sandbox.execute({ runId, ...lease, signal });

    const events = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => RunOutputSchema.parse(JSON.parse(line)));
    if (events.length !== 2) throw new Error('Sandbox mock output was invalid.');

    for (const event of events)
      emit(event as Omit<RunEvent, 'id' | 'runId' | 'sequence' | 'at' | 'source' | 'synthetic'>);
    return { output: events[1]!.message };
  }
}

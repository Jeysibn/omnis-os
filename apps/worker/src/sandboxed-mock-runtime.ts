import { z } from 'zod';
import type { RunEvent, RuntimeCapabilities } from '@omnis/contracts';
import type { RuntimeAdapter } from '@omnis/runtime-adapters';
import type { SandboxExecutor } from './docker-sandbox.ts';

const RunOutputSchema = z.object({
  type: z.literal('run.output'),
  message: z.string().min(1).max(2_000),
});

const mockProgram = `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof input.title !== 'string') process.exit(2);
    const emit = (message) => process.stdout.write(JSON.stringify({ type: 'run.output', message }) + '\\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    emit('Mock runtime accepted the task. No provider was contacted.');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    emit('Synthetic result for “' + input.title + '”: the mock lifecycle completed. This is not provider evidence.');
  } catch {
    process.exitCode = 2;
  }
});
`;

export class SandboxedMockRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'mock' as const;
  private readonly sandbox: SandboxExecutor;

  constructor(sandbox: SandboxExecutor) {
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

  async cleanupOrphanedExecutions(
    resolveActiveRunIds: (candidateRunIds: readonly string[]) => Promise<readonly string[]>,
  ): Promise<void> {
    await this.sandbox.cleanupOrphanedContainers(resolveActiveRunIds);
  }

  async execute({
    runId,
    task,
    signal,
    emit,
  }: Parameters<RuntimeAdapter['execute']>[0]): Promise<{ output: string }> {
    const result = await this.sandbox.execute({
      runId,
      argv: ['node', '-e', mockProgram],
      stdin: JSON.stringify({ title: task.title }),
      timeoutMs: 8_000,
      signal,
    });

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

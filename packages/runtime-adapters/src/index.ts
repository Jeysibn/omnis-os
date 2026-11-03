import type { RunEvent, RuntimeCapabilities, Task } from '@omnis/contracts';

export interface RuntimeAdapter {
  readonly kind: 'mock';
  discoverCapabilities(): RuntimeCapabilities;
  cleanupOrphanedExecutions?(
    resolveActiveRunIds: (candidateRunIds: readonly string[]) => Promise<readonly string[]>,
  ): Promise<void>;
  execute(input: {
    runId: string;
    lease: { workerId: string; generation: number };
    task: Task;
    signal: AbortSignal;
    emit(event: Omit<RunEvent, 'id' | 'runId' | 'sequence' | 'at' | 'source' | 'synthetic'>): void;
  }): Promise<{ output: string }>;
}

export class MockRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'mock' as const;

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
    task,
    signal,
    emit,
  }: Parameters<RuntimeAdapter['execute']>[0]): Promise<{ output: string }> {
    await wait(500, signal);
    emit({
      type: 'run.output',
      message: 'Mock runtime accepted the task. No provider was contacted.',
    });
    await wait(1200, signal);
    const output = `Synthetic result for “${task.title}”: the mock lifecycle completed. This is not provider evidence.`;
    emit({ type: 'run.output', message: output });
    return { output };
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Run cancelled', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Run cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

import type { ExecutionMode } from '@omnis/contracts/execution-mode';

export async function startExecutionQueue(
  mode: ExecutionMode,
  actions: {
    startQueue: () => Promise<unknown>;
    createQueue: () => Promise<unknown>;
    reconcileEnabled: () => Promise<unknown>;
    consume: () => Promise<unknown>;
  },
): Promise<boolean> {
  if (mode === 'disabled') return false;
  await actions.startQueue();
  await actions.createQueue();
  await actions.reconcileEnabled();
  await actions.consume();
  return true;
}

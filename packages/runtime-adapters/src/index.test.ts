import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockRuntimeAdapter } from './index.ts';

describe('mock runtime adapter contract', () => {
  it('advertises synthetic capabilities and reports usage unavailable', () => {
    const adapter = new MockRuntimeAdapter();
    assert.deepEqual(adapter.discoverCapabilities(), {
      runtimeKind: 'mock',
      allowedUse: 'both',
      canStreamEvents: true,
      canCancel: true,
      canReportUsage: false,
      synthetic: true,
    });
  });

  it('emits a deterministic synthetic response and supports cancellation', async () => {
    const adapter = new MockRuntimeAdapter();
    const controller = new AbortController();
    const events: unknown[] = [];
    const execution = adapter.execute({
      runId: 'run-0001',
      lease: { workerId: 'worker-test', generation: 1 },
      task: {
        id: 'task-0001',
        title: 'Inspect the workspace',
        detail: 'List top-level files without changing them.',
        status: 'in_progress',
        createdAt: '2026-11-02T00:00:00.000Z',
      },
      signal: controller.signal,
      emit: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(events.length, 1);
    controller.abort();
    await assert.rejects(execution, { name: 'AbortError' });
  });
});

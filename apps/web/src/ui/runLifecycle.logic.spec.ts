import { expect, test } from '@playwright/test';
import type { Run } from '@omnis/contracts';
import { describeRunLifecycle, eventsForRun } from './runLifecycle.js';

const stop = [{ type: 'run.stop_requested' as const }];
const lifecycle = (status: Run['status'], events: Array<{ type: 'run.stop_requested' }> = []) =>
  describeRunLifecycle({ status }, events);

test.describe('run lifecycle model', () => {
  test('stopping is Requested and never reads as cancelled', () => {
    const result = lifecycle('stopping', stop);
    expect(result.cancellation).toBe('requested');
    expect(result.detail).toContain('not cancelled until the runtime confirms');
  });

  test('only a cancelled status is authoritatively Confirmed', () => {
    for (const status of [
      'queued',
      'running',
      'stopping',
      'unknown',
      'interrupted',
      'failed',
      'completed',
    ] as const) {
      expect(lifecycle(status, stop).cancellation).not.toBe('confirmed');
    }
    expect(lifecycle('cancelled').cancellation).toBe('confirmed');
  });

  test('a recorded stop on a still-running run is Pending, not success', () => {
    expect(lifecycle('running', stop).cancellation).toBe('pending');
    expect(lifecycle('queued', stop).cancellation).toBe('pending');
    expect(lifecycle('running').cancellation).toBeNull();
  });

  test('unknown after a stop request stays Unknown and tells the owner to check state', () => {
    const result = lifecycle('unknown', stop);
    expect(result.cancellation).toBe('unknown');
    expect(result.tone).toBe('warning');
    expect(result.detail).toContain('do not assume it was cancelled');
  });

  test('unknown without a stop is not labelled as a cancellation', () => {
    expect(lifecycle('unknown').cancellation).toBeNull();
  });

  test('interrupted is a warning and explicitly not a confirmed cancellation', () => {
    const result = lifecycle('interrupted');
    expect(result.tone).toBe('warning');
    expect(result.cancellation).toBeNull();
    expect(result.detail).toContain('not a confirmed cancellation');
  });
});

test.describe('events scoped to the selected run', () => {
  const mixed = [
    { runId: 'run-a', type: 'run.stop_requested' as const },
    { runId: 'run-b', type: 'run.started' as const },
  ];

  test("another run's stop event cannot make this run Pending or Unknown", () => {
    const run = { id: 'run-b', status: 'running' as const };
    const scoped = eventsForRun(run, mixed);
    expect(scoped).toEqual([mixed[1]]);
    expect(describeRunLifecycle(run, scoped).cancellation).toBeNull();
    // Without scoping, the same input would wrongly report a pending stop.
    expect(describeRunLifecycle(run, mixed).cancellation).toBe('pending');
    const unknown = { id: 'run-b', status: 'unknown' as const };
    expect(describeRunLifecycle(unknown, eventsForRun(unknown, mixed)).cancellation).toBeNull();
  });

  test('no selected run yields no events', () => {
    expect(eventsForRun(null, mixed)).toEqual([]);
  });
});

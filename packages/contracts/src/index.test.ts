import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RunEventSchema, RunSchema } from './index.ts';

describe('run contracts', () => {
  it('accepts only events marked as synthetic mock activity', () => {
    const event = {
      id: 'evt-run-0001-0001',
      runId: 'run-0001',
      sequence: 1,
      at: '2026-11-02T00:00:00.000Z',
      type: 'run.queued',
      source: 'mock',
      synthetic: true,
      message: 'Queued.',
    };
    assert.equal(RunEventSchema.parse(event).synthetic, true);
    assert.equal(
      RunEventSchema.safeParse({ ...event, source: 'hermes', synthetic: false }).success,
      false,
    );
  });

  it('keeps unavailable usage unknown rather than presenting zero', () => {
    const run = {
      id: 'run-0001',
      taskId: 'task-0001',
      taskTitle: 'Read the file list',
      status: 'queued',
      runtimeKind: 'mock',
      synthetic: true,
      usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    assert.equal(RunSchema.parse(run).usage.inputTokens, null);
    assert.equal(
      RunSchema.safeParse({ ...run, usage: { quality: 'measured', inputTokens: 0 } }).success,
      false,
    );
  });
});

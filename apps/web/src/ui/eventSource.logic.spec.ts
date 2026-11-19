import { expect, test } from '@playwright/test';
import { describeEventFeed } from './eventSource.js';

test.describe('event feed notice', () => {
  test('live only while connected and the run is not terminal', () => {
    expect(describeEventFeed({ status: 'running' }, 'connected').kind).toBe('live');
    expect(describeEventFeed({ status: 'completed' }, 'connected').kind).toBe('history');
  });
  test('disconnected states never read as live', () => {
    for (const s of ['connecting', 'reconnecting', 'paused', 'closed', 'ended'] as const)
      expect(describeEventFeed({ status: 'running' }, s).kind).not.toBe('live');
    expect(describeEventFeed({ status: 'running' }, 'paused').kind).toBe('stale');
  });
  test('terminal runs are recorded history', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const)
      expect(describeEventFeed({ status }, 'ended').kind).toBe('history');
  });
  test('terminal runs are history even while the stream is not connected', () => {
    for (const s of ['connecting', 'reconnecting', 'paused', 'closed'] as const) {
      const n = describeEventFeed({ status: 'completed' }, s);
      expect(n.kind).toBe('history');
      expect(n.detail).toContain('not confirmed');
    }
  });
});

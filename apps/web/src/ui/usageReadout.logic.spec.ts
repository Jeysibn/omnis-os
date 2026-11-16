import { expect, test } from '@playwright/test';
import { RunSchema, type Run } from '@omnis/contracts';
import { describeUsage, formatUsageCount, unknownLabel } from './usageReadout.js';

const unknownUsage = {
  quality: 'unknown',
  inputTokens: null,
  outputTokens: null,
  cost: null,
} as const;

const baseRun = (usage: unknown) => ({
  id: 'run-1',
  taskId: 'task-1',
  taskTitle: 'A task',
  status: 'completed',
  runtimeKind: 'mock',
  synthetic: true,
  usage,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
});

test.describe('usage readout model', () => {
  test('null is Unknown and zero is a real 0: a missing count is never shown as zero', () => {
    expect(formatUsageCount(null)).toBe(unknownLabel);
    expect(formatUsageCount(0)).toBe('0');
    expect(formatUsageCount(0)).not.toBe(formatUsageCount(null));
    expect(formatUsageCount(1234567)).toBe('1,234,567');
  });

  test('a record with no usage reads Unknown for every field and says unknown is not zero', () => {
    const readout = describeUsage(unknownUsage);
    expect(readout.rows.map((row) => [row.key, row.label, row.value])).toEqual([
      ['input', 'Input tokens', 'Unknown'],
      ['output', 'Output tokens', 'Unknown'],
      ['cost', 'Cost', 'Unknown'],
    ]);
    expect(readout.note).toContain('Unknown does not mean zero');
  });

  test('no cost is ever formatted: the contract carries no currency, so none is invented', () => {
    for (const row of describeUsage(unknownUsage).rows) {
      expect(row.value).not.toMatch(/[$€£]|USD|\d/);
    }
  });
});

test.describe('Phase 1 usage contract (tripwire)', () => {
  test('the contract accepts only unknown usage, so the UI has nothing else to display', () => {
    const run: Run = RunSchema.parse(baseRun(unknownUsage));
    expect(run.usage.quality).toBe('unknown');
  });

  test('measured, estimated or non-null usage is rejected by the contract', () => {
    // If the contract is ever extended to carry real usage, these parses start succeeding: this test
    // then fails on purpose, and RunUsageReadout and its tests must be updated together with it.
    for (const usage of [
      { quality: 'measured', inputTokens: 10, outputTokens: 5, cost: null },
      { quality: 'unknown', inputTokens: 0, outputTokens: null, cost: null },
      { quality: 'unknown', inputTokens: null, outputTokens: null, cost: 0 },
      { quality: 'estimated', inputTokens: null, outputTokens: null, cost: null },
    ]) {
      expect(RunSchema.safeParse(baseRun(usage)).success, JSON.stringify(usage)).toBe(false);
    }
  });
});

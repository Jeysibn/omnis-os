import type { Usage } from '@omnis/contracts';

/**
 * Display model for a Run's usage. The Phase 1 contract (`UsageSchema`) can only express
 * "unknown": quality `unknown` with null token counts and null cost. There is no event that carries
 * usage and no measured or estimated variant, so nothing here is derived, estimated or inferred.
 */
export const unknownLabel = 'Unknown';

/**
 * A count is "Unknown" only when it is null. Zero is a real reported value and is shown as 0; it is
 * never produced as a stand-in for a missing value. (Kept so a future contract extension cannot
 * silently turn missing data into a zero.)
 */
export function formatUsageCount(value: number | null): string {
  return value === null ? unknownLabel : value.toLocaleString('en-US');
}

export type UsageRow = { key: 'input' | 'output' | 'cost'; label: string; value: string };

export type UsageReadout = { rows: UsageRow[]; note: string };

export function describeUsage(usage: Usage): UsageReadout {
  return {
    rows: [
      { key: 'input', label: 'Input tokens', value: formatUsageCount(usage.inputTokens) },
      { key: 'output', label: 'Output tokens', value: formatUsageCount(usage.outputTokens) },
      // The contract carries no currency, so a cost can never be formatted truthfully: it is either
      // unknown or reported without a unit this interface can show.
      {
        key: 'cost',
        label: 'Cost',
        value: usage.cost === null ? unknownLabel : 'Reported (currency not available here)',
      },
    ],
    note: 'No usage was reported for this run. Unknown does not mean zero.',
  };
}

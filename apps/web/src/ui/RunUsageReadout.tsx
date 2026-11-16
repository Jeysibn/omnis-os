import { useId } from 'react';
import type { Usage } from '@omnis/contracts';
import { describeUsage } from './usageReadout.js';

/** Compact, read-only usage section for the Run inspector. Never estimates or substitutes zero. */
export function RunUsageReadout({ usage }: { usage: Usage }) {
  const headingId = useId();
  const readout = describeUsage(usage);
  return (
    <section className="run-usage" aria-labelledby={headingId}>
      <h3 id={headingId}>Usage</h3>
      <dl className="metadata-list run-usage-list">
        {readout.rows.map((row) => (
          <div key={row.key} data-usage={row.key}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="run-usage-note">{readout.note}</p>
    </section>
  );
}

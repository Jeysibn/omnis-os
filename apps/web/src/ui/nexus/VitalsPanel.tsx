import { metricText, type Metric, type Vitals } from './vitals.js';
import { formatManilaStamp } from './time.js';

type Row = { label: string; metric: Metric; source: string; onOpen: () => void };

export function VitalsPanel({
  vitals,
  onOpenRuns,
  onOpenTasks,
}: {
  vitals: Vitals;
  onOpenRuns: () => void;
  onOpenTasks: () => void;
}) {
  const rows: Row[] = [
    { label: 'Active runs', metric: vitals.activeRuns, source: 'Open Runs', onOpen: onOpenRuns },
    { label: 'Queued runs', metric: vitals.queuedRuns, source: 'Open Runs', onOpen: onOpenRuns },
    { label: 'Open tasks', metric: vitals.openTasks, source: 'Open Tasks', onOpen: onOpenTasks },
    {
      label: 'Failed or interrupted',
      metric: vitals.failedRuns,
      source: 'Open Runs',
      onOpen: onOpenRuns,
    },
  ];
  return (
    <aside className="nx-side nx-left" aria-labelledby="nx-vitals-h">
      <h2 id="nx-vitals-h" className="nx-label nx-heading">
        System vitals
      </h2>
      <dl className="nx-vitals">
        {rows.map((row) => (
          <div key={row.label} className="nx-vital">
            <dt>{row.label}</dt>
            <dd data-state={row.metric.state}>
              <button type="button" onClick={row.onOpen}>
                <span className="nx-sr">{row.label}: </span>
                <span className="nx-value">{metricText(row.metric)}</span>{' '}
                <span className="nx-source">{row.source}</span>
              </button>
            </dd>
          </div>
        ))}
        <div className="nx-vital">
          <dt>Last verified record</dt>
          <dd>
            <span className="nx-mono">
              {vitals.lastRecordAt ? formatManilaStamp(vitals.lastRecordAt) : 'None recorded'}
            </span>
          </dd>
        </div>
      </dl>
      <section className="nx-context" aria-labelledby="nx-context-h">
        <h2 id="nx-context-h" className="nx-label nx-heading">
          System context
        </h2>
        <dl className="nx-kv">
          <dt>Environment</dt>
          <dd>Local workspace</dd>
          <dt>Execution</dt>
          <dd>Mock-only · synthetic</dd>
          <dt>Runtime</dt>
          <dd>Mock adapter (health not reported)</dd>
          <dt>Project / department</dt>
          <dd>Not available in this view</dd>
        </dl>
      </section>
    </aside>
  );
}

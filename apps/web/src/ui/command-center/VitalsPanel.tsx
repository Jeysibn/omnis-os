import { ArrowRight } from 'lucide-react';
import { InfoGroup, Panel } from '../design/index.js';
import { metricText, type Metric, type Vitals } from './vitals.js';
import { formatManilaStamp } from './time.js';

type Row = { label: string; metric: Metric; target: 'runs' | 'tasks'; source: string };

/** Counts come only from the loaded task and run lists. Unconfirmed values are never shown as 0. */
export function VitalsPanel({
  vitals,
  onNavigate,
}: {
  vitals: Vitals;
  onNavigate: (page: 'runs' | 'tasks') => void;
}) {
  const rows: Row[] = [
    { label: 'Running', metric: vitals.running, target: 'runs', source: 'Open Runs' },
    { label: 'Queued', metric: vitals.queued, target: 'runs', source: 'Open Runs' },
    { label: 'Open tasks', metric: vitals.openTasks, target: 'tasks', source: 'Open Tasks' },
    {
      label: 'Failed or interrupted',
      metric: vitals.failedOrInterrupted,
      target: 'runs',
      source: 'Open Runs',
    },
    {
      label: 'Outcome unknown',
      metric: vitals.unknownOutcome,
      target: 'runs',
      source: 'Open Runs',
    },
  ];
  return (
    <div className="ccx-vitals">
      <Panel title="System vitals" label="Telemetry">
        <dl className="ccx-vital-list">
          {rows.map((row) => (
            <div key={row.label} className="ccx-vital" data-state={row.metric.state}>
              <dt>{row.label}</dt>
              <dd>
                <button
                  type="button"
                  className="ccx-vital-button"
                  aria-label={`${row.label}: ${metricText(row.metric)}. ${row.source}`}
                  onClick={() => onNavigate(row.target)}
                >
                  <span className="ccx-vital-value">{metricText(row.metric)}</span>
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              </dd>
            </div>
          ))}
        </dl>
        <p className="nx-muted ccx-fine">
          Last recorded run update:{' '}
          <span className="nx-mono">
            {vitals.lastRunUpdate
              ? `${formatManilaStamp(vitals.lastRunUpdate)} PHT`
              : 'None recorded'}
          </span>
        </p>
      </Panel>
    </div>
  );
}

/** Static facts about this deployment. Nothing here is measured, so nothing can be stale. */
export function SystemContext() {
  return (
    <Panel title="System context" level={3}>
      <InfoGroup
        items={[
          { label: 'Environment', value: 'Local workspace' },
          { label: 'Execution', value: 'Mock-only, synthetic' },
          { label: 'Runtime', value: 'Mock adapter (health not reported)' },
          { label: 'Project / department', value: 'Not shown in this view' },
        ]}
      />
    </Panel>
  );
}

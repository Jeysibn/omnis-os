import { useLayoutEffect, useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import { InfoGroup, Panel } from '../design/index.js';
import { metricText, type Metric, type Vitals } from './vitals.js';
import { formatManilaStamp } from './time.js';

type Row = {
  /** Stable identity of the control, so the same one can be found again after a remount. */
  id: string;
  label: string;
  metric: Metric;
  target: 'runs' | 'tasks';
  source: string;
};

/**
 * Carries keyboard focus from one vitals panel instance to the next. CommandCenter renders the
 * panel at a different place in the document on either side of the wide breakpoint, so React
 * unmounts one instance and mounts another in the same commit. The id of the focused control is
 * held here between the two and consumed immediately; `null` means nothing was focused.
 */
export type VitalsFocusHandoff = { current: string | null };

/** Counts come only from the loaded task and run lists. Unconfirmed values are never shown as 0. */
export function VitalsPanel({
  vitals,
  onNavigate,
  focusHandoff,
}: {
  vitals: Vitals;
  onNavigate: (page: 'runs' | 'tasks') => void;
  focusHandoff: VitalsFocusHandoff;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = root.current;
    // Mount: take over focus from the instance this one replaces. Same commit, so the user cannot
    // have moved focus in between.
    const id = focusHandoff.current;
    focusHandoff.current = null;
    const restored = id ? panel?.querySelector<HTMLElement>(`[data-vital="${id}"]`) : null;
    if (restored) {
      // The panel has moved on screen, so keeping focus is not enough: the control and its focus
      // ring must also be visible. Focus without the browser's own (centring) scroll, then scroll
      // only if the control is outside the viewport, and only to the nearest edge. This is a no-op
      // when it is already visible, and instant (never animated) so reduced-motion users are safe.
      // .ccx-vital-button's scroll-margin keeps the focus ring clear of the edge.
      restored.focus({ preventScroll: true });
      restored.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    return () => {
      // Unmount: React runs this before the DOM is removed, so the focused control is still
      // attached and still the active element. Record it only if focus really is inside Vitals.
      const focused = document.activeElement;
      focusHandoff.current =
        focused instanceof HTMLElement && panel?.contains(focused)
          ? (focused.dataset.vital ?? null)
          : null;
    };
  }, [focusHandoff]);
  const rows: Row[] = [
    {
      id: 'running',
      label: 'Running',
      metric: vitals.running,
      target: 'runs',
      source: 'Open Runs',
    },
    { id: 'queued', label: 'Queued', metric: vitals.queued, target: 'runs', source: 'Open Runs' },
    {
      id: 'open-tasks',
      label: 'Open tasks',
      metric: vitals.openTasks,
      target: 'tasks',
      source: 'Open Tasks',
    },
    {
      id: 'failed-or-interrupted',
      label: 'Failed or interrupted',
      metric: vitals.failedOrInterrupted,
      target: 'runs',
      source: 'Open Runs',
    },
    {
      id: 'outcome-unknown',
      label: 'Outcome unknown',
      metric: vitals.unknownOutcome,
      target: 'runs',
      source: 'Open Runs',
    },
  ];
  return (
    <div className="ccx-vitals" ref={root}>
      <Panel title="System vitals" label="Telemetry">
        <dl className="ccx-vital-list">
          {rows.map((row) => (
            <div key={row.label} className="ccx-vital" data-state={row.metric.state}>
              <dt>{row.label}</dt>
              <dd>
                <button
                  type="button"
                  className="ccx-vital-button"
                  data-vital={row.id}
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

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Pause, Play, RefreshCw } from 'lucide-react';
import { StatusGlyph } from './StatusGlyph.js';
import { formatManilaStamp } from './time.js';
import type { LaneStatus, MissionEvent } from './missionEvents.js';
import type { LoadState } from './vitals.js';

type Props = {
  events: MissionEvent[];
  status: LaneStatus;
  monitoredCount: number;
  totalRuns: number;
  runsState: LoadState;
  selectedRunId: string | null;
  loadedAt: Date | null;
  onSelectRun: (runId: string) => void;
  onRefresh: () => void;
};

const STATUS_TEXT: Record<LaneStatus, string> = {
  loading: 'Loading event history…',
  live: 'Live: receiving updates for unfinished runs.',
  history: 'Historical events. No run is receiving live updates.',
  reconnecting: 'Connection interrupted. Reconnecting; loaded history is kept.',
  disconnected: 'Disconnected. Showing the history loaded so far; it may be out of date.',
  unavailable: 'Event source unavailable. No history could be loaded.',
  empty: 'No events recorded.',
};

export function MissionLane({
  events,
  status,
  monitoredCount,
  totalRuns,
  runsState,
  selectedRunId,
  loadedAt,
  onSelectRun,
  onRefresh,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const scroller = useRef<HTMLOListElement | null>(null);
  const shown = expanded ? events : events.slice(-24);

  useEffect(() => {
    const el = scroller.current;
    if (!el || paused) return;
    el.scrollLeft = el.scrollWidth;
    el.scrollTop = el.scrollHeight;
  }, [events.length, expanded, paused]);

  useEffect(() => {
    if (!selectedRunId) return;
    const el = scroller.current?.querySelector<HTMLElement>(
      `[data-run="${CSS.escape(selectedRunId)}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [selectedRunId]);

  return (
    <section className="nx-lane" data-expanded={expanded} aria-labelledby="nx-lane-h">
      <div className="nx-lane-head">
        <div>
          <h2 id="nx-lane-h" className="nx-label nx-heading">
            Mission lane
          </h2>
          <p className="nx-lane-status" data-lane-status={status} role="status">
            {STATUS_TEXT[status]}
          </p>
          <p className="nx-quiet">
            Persisted run events, Asia/Manila time. Following {monitoredCount} of {totalRuns} runs
            (unfinished first, then most recent); output lines are in the run inspector.
            {loadedAt ? ` Run list loaded ${formatManilaStamp(loadedAt.toISOString())}.` : ''}
          </p>
        </div>
        <div className="nx-lane-actions">
          <button type="button" className="nx-btn" onClick={onRefresh} aria-label="Refresh data">
            <RefreshCw size={14} aria-hidden="true" /> <span>Refresh</span>
          </button>
          <button
            type="button"
            className="nx-btn"
            aria-pressed={paused}
            onClick={() => setPaused((v) => !v)}
          >
            {paused ? (
              <Play size={14} aria-hidden="true" />
            ) : (
              <Pause size={14} aria-hidden="true" />
            )}
            <span>{paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}</span>
          </button>
          <button
            type="button"
            className="nx-btn nx-lane-toggle"
            aria-expanded={expanded}
            aria-controls="nx-lane-list"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronDown size={14} aria-hidden="true" />
            ) : (
              <ChevronUp size={14} aria-hidden="true" />
            )}
            <span>{expanded ? 'Collapse' : 'Expand'}</span>
          </button>
        </div>
      </div>
      {events.length === 0 && runsState === 'loading' ? (
        <p className="nx-empty" role="status">
          Loading mission records…
        </p>
      ) : events.length === 0 && runsState === 'error' ? (
        <p className="nx-empty">
          Mission records are unavailable until runs load. Use the retry control in Current
          activity.
        </p>
      ) : events.length === 0 ? (
        <p className="nx-empty">
          {status === 'loading'
            ? 'Loading event history…'
            : status === 'unavailable'
              ? 'The event source could not be reached. Use Refresh to try again, or open a run.'
              : 'No events recorded. Approved mock runs will appear here in order.'}
        </p>
      ) : (
        <ol
          id="nx-lane-list"
          className="nx-lane-list"
          ref={scroller}
          tabIndex={0}
          aria-label="Mission events, oldest first"
        >
          {shown.map((event) => (
            <li key={event.id}>
              <button
                type="button"
                data-run={event.runId}
                data-status={event.status}
                aria-pressed={selectedRunId === event.runId}
                className="nx-node"
                onClick={() => onSelectRun(event.runId)}
              >
                <StatusGlyph status={event.status} />
                <span className="nx-node-label">{event.label}</span>
                <time className="nx-mono nx-node-time" dateTime={event.at}>
                  {formatManilaStamp(event.at)}
                </time>
                <span className="nx-node-title">{event.taskTitle}</span>
                <span className="nx-sr">{event.message}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

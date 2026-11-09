import { useMemo, useRef } from 'react';
import { Plus } from 'lucide-react';
import type { Run, Task } from '@omnis/contracts';
import { ErrorState, LoadingState, NxButton, NxTheme, StatusBadge } from '../design/index.js';
import { AttentionPanel } from './AttentionPanel.js';
import { PhtClock } from './PhtClock.js';
import { Reactor } from './reactor/Reactor.js';
import { markerCounts } from './reactor/visual.js';
import { RecentRecords } from './RecentRecords.js';
import { SystemContext, VitalsPanel, type VitalsFocusHandoff } from './VitalsPanel.js';
import { deriveSystemState } from './systemState.js';
import { useMediaQuery } from './useMediaQuery.js';
import { computeVitals, type LoadState } from './vitals.js';
import './command-center.css';

export type CommandCenterProps = {
  tasks: Task[];
  runs: Run[];
  tasksLoading: boolean;
  runsLoading: boolean;
  tasksError: string;
  runsError: string;
  busy: boolean;
  onRetryTasks: () => void;
  onRetryRuns: () => void;
  onNavigate: (page: 'tasks' | 'runs') => void;
  onSelectRun: (run: Run) => void;
  onStop: (run: Run) => void;
  onCreate: () => void;
  onReviewApproval: (task: Task, trigger: HTMLButtonElement) => void;
};

/**
 * The wide layout draws vitals | stage | attention. Narrower layouts draw the stage, then attention
 * and vitals. The CSS grid areas place the panels; THIS query decides where the single vitals panel
 * sits in the document, so reading order, Tab order and visual order agree at every width.
 * Keep it in step with the `not all and (min-width: 1200px)` rule in command-center.css.
 */
export const WIDE_LAYOUT_QUERY = '(min-width: 1200px)';

const loadState = (loading: boolean, error: string): LoadState =>
  loading ? 'loading' : error ? 'error' : 'ready';

function connection(tasks: LoadState, runs: LoadState) {
  if (tasks === 'error' || runs === 'error') return 'API: a request failed';
  if (tasks === 'loading' || runs === 'loading') return 'API: checking';
  return 'API: responding';
}

/**
 * OMNIS NEXUS V2 Command Center: the shell (environment strip, PHT clock, vitals, attention panel,
 * recent records) around the Reactor, the cinematic centrepiece of the stage.
 *
 * Everything shown comes from the task and run lists the application already loads and from the
 * existing stop, create and approval actions; nothing is fabricated or simulated, and a failed
 * load shows "Unavailable", never a zero. The Reactor (`./reactor`) is decorative and
 * `aria-hidden`: it is drawn from the same system state and run list and only animates the states
 * that are genuinely alive (idle, queued, active); every other state is drawn once and stays still.
 * It lives in a lazy chunk with a static SVG fallback, which is also the whole presentation under
 * `prefers-reduced-motion`, so this component never depends on the renderer being available.
 *
 * Not here: a global Mission Lane or any event stream. That needs the approved backend contract and
 * is a later stage.
 */
export function CommandCenter(props: CommandCenterProps) {
  const tasksState = loadState(props.tasksLoading, props.tasksError);
  const runsState = loadState(props.runsLoading, props.runsError);
  // Stale records are never shown as current: a failed refresh hides them rather than reusing them.
  const tasks = useMemo(
    () => (tasksState === 'ready' ? props.tasks : []),
    [tasksState, props.tasks],
  );
  const runs = useMemo(() => (runsState === 'ready' ? props.runs : []), [runsState, props.runs]);
  const vitals = useMemo(
    () => computeVitals({ tasks, runs, tasksState, runsState }),
    [tasks, runs, tasksState, runsState],
  );
  const state = useMemo(
    () => deriveSystemState({ tasksState, runsState, runs }),
    [tasksState, runsState, runs],
  );
  // Markers come from the same loaded run list as the vitals; unavailable data draws none.
  const reactorMarkers = useMemo(
    () => (runsState === 'ready' ? markerCounts(runs) : null),
    [runsState, runs],
  );
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const approvalsHeading = useRef<HTMLHeadingElement>(null);
  const focusApprovals = () => {
    approvalsHeading.current?.scrollIntoView({ block: 'nearest' });
    approvalsHeading.current?.focus();
  };

  // Owned here (not by either vitals instance) so it survives the swap and dies with this component.
  const vitalsFocus = useRef<VitalsFocusHandoff['current']>(null);
  const vitalsPanel = (
    <VitalsPanel vitals={vitals} onNavigate={props.onNavigate} focusHandoff={vitalsFocus} />
  );

  return (
    <NxTheme>
      <div className="ccx-root">
        <ul className="ccx-strip" aria-label="Environment and connection">
          <li>
            <span className="nx-label">Environment</span> Local workspace
          </li>
          <li>
            <span className="nx-label">Mode</span> Mock-only, synthetic
          </li>
          <li data-problem={tasksState === 'error' || runsState === 'error'}>
            <span className="nx-label">Connection</span> {connection(tasksState, runsState)}
          </li>
          <li>
            <span className="nx-label">Runtime</span> Mock adapter
          </li>
          <li className="ccx-strip-clock">
            <span className="nx-label">Time</span> <PhtClock />
          </li>
        </ul>

        {(props.tasksError && !props.tasksLoading) || (props.runsError && !props.runsLoading) ? (
          <div className="ccx-notices">
            {props.tasksError && !props.tasksLoading && (
              <ErrorState
                title="Tasks unavailable"
                description={props.tasksError}
                onRetry={props.onRetryTasks}
                retryLabel="Retry tasks"
              />
            )}
            {props.runsError && !props.runsLoading && (
              <ErrorState
                title="Runs unavailable"
                description={props.runsError}
                onRetry={props.onRetryRuns}
                retryLabel="Retry runs"
              />
            )}
          </div>
        ) : null}

        <div className="ccx-grid">
          {/* One vitals panel, never two: first on wide screens, after attention on narrower ones.
              The null slots keep the stage and attention panels in place, so they never remount
              (focus survives a resize across the breakpoint). */}
          {wide ? vitalsPanel : null}
          <section className="ccx-stage" aria-labelledby="ccx-state-heading">
            <span className="nx-label">Omnis Nexus</span>
            <h2 id="ccx-state-heading" className="ccx-visually-hidden">
              System state
            </h2>
            <div className="ccx-state" data-state={state.id}>
              <Reactor state={state.id} markers={reactorMarkers} />
              {state.id === 'loading' ? (
                <LoadingState label={state.label} />
              ) : (
                <p className="ccx-state-label" role="status">
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                </p>
              )}
              <p className="nx-muted ccx-state-detail">{state.detail}</p>
            </div>
            <div className="ccx-deck" role="group" aria-label="Command deck">
              <NxButton variant="primary" onClick={props.onCreate}>
                <Plus size={16} aria-hidden="true" /> Create task
              </NxButton>
              <NxButton onClick={() => props.onNavigate('runs')}>View runs</NxButton>
              <NxButton onClick={focusApprovals}>Review approvals</NxButton>
            </div>
            <SystemContext />
          </section>

          <AttentionPanel
            tasks={tasks}
            runs={runs}
            tasksState={tasksState}
            runsState={runsState}
            busy={props.busy}
            approvalsHeadingRef={approvalsHeading}
            onSelectRun={props.onSelectRun}
            onStop={props.onStop}
            onNavigate={props.onNavigate}
            onReviewApproval={props.onReviewApproval}
          />
          {wide ? null : vitalsPanel}
        </div>

        <RecentRecords
          tasks={tasks}
          runs={runs}
          tasksState={tasksState}
          runsState={runsState}
          onNavigate={props.onNavigate}
          onSelectRun={props.onSelectRun}
          onCreate={props.onCreate}
        />
      </div>
    </NxTheme>
  );
}

import { useMemo, useRef } from 'react';
import { Plus } from 'lucide-react';
import type { Run, Task } from '@omnis/contracts';
import { ErrorState, LoadingState, NxButton, NxTheme, StatusBadge } from '../design/index.js';
import { AttentionPanel } from './AttentionPanel.js';
import { PhtClock } from './PhtClock.js';
import { RecentRecords } from './RecentRecords.js';
import { SystemContext, VitalsPanel } from './VitalsPanel.js';
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
 * OMNIS NEXUS V2, Stage 1: the Command Center shell with vitals, attention panel and PHT clock.
 * It draws only on the task and run lists the application already loads and on the existing
 * stop, create and approval actions. The reactor and a global Mission Lane are later stages and
 * are intentionally absent; nothing here is fabricated, simulated or animated.
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
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const approvalsHeading = useRef<HTMLHeadingElement>(null);
  const focusApprovals = () => {
    approvalsHeading.current?.scrollIntoView({ block: 'nearest' });
    approvalsHeading.current?.focus();
  };

  const vitalsPanel = <VitalsPanel vitals={vitals} onNavigate={props.onNavigate} />;

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
              <svg className="ccx-mark" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
                <circle
                  cx="60"
                  cy="60"
                  r="52"
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity="0.35"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="34"
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity="0.55"
                />
                <circle cx="60" cy="60" r="10" fill="currentColor" />
              </svg>
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

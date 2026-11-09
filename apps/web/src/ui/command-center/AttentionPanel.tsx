import { type Ref } from 'react';
import type { Run, Task } from '@omnis/contracts';
import { NxButton, Panel } from '../design/index.js';
import { RunStatusBadge, isActiveRun } from './status.js';
import { formatManilaStamp } from './time.js';
import type { LoadState } from './vitals.js';

const PRIORITY_LIMIT = 5;
const DECISION_LIMIT = 4;

type Props = {
  tasks: Task[];
  runs: Run[];
  tasksState: LoadState;
  runsState: LoadState;
  busy: boolean;
  approvalsHeadingRef: Ref<HTMLHeadingElement>;
  onSelectRun: (run: Run) => void;
  onStop: (run: Run) => void;
  onNavigate: (page: 'tasks' | 'runs') => void;
  onReviewApproval: (task: Task, trigger: HTMLButtonElement) => void;
};

/**
 * "What needs my attention?" Only categories the current API can support are shown:
 *  - open tasks waiting for the owner's start decision (same rule as the Tasks list),
 *  - active runs (with the existing stop request),
 *  - failed, interrupted and unknown-outcome runs.
 * There is no pending-approval list, security alert or agent-attribution endpoint, so none is
 * invented. Resources that failed to load are reported once, above the panels.
 */
export function AttentionPanel(props: Props) {
  const { tasks, runs, tasksState, runsState, busy } = props;
  const runsReady = runsState === 'ready';
  const tasksReady = tasksState === 'ready';
  const taskHasActiveRun = new Set(runs.filter((r) => isActiveRun(r.status)).map((r) => r.taskId));
  const awaiting = tasks.filter((task) => task.status === 'open' && !taskHasActiveRun.has(task.id));
  const active = runs.filter((run) => isActiveRun(run.status));
  const problems = runs
    .filter((run) => ['failed', 'interrupted', 'unknown'].includes(run.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="ccx-attention">
      <Panel title="Requires attention" label="Priority">
        <div className="ccx-block">
          <h3 ref={props.approvalsHeadingRef} tabIndex={-1}>
            Awaiting your decision{' '}
            {tasksReady && runsReady && <span className="ccx-count">{awaiting.length}</span>}
          </h3>
          {!tasksReady || !runsReady ? (
            <p className="nx-muted">Available once tasks and runs load.</p>
          ) : awaiting.length ? (
            <ul className="ccx-list">
              {awaiting.slice(0, DECISION_LIMIT).map((task) => (
                <li key={task.id}>
                  <span className="ccx-item-title">{task.title}</span>
                  <NxButton
                    disabled={busy}
                    aria-label={`Review approval to start ${task.title}`}
                    onClick={(event) => props.onReviewApproval(task, event.currentTarget)}
                  >
                    Review approval
                  </NxButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="nx-muted">No open task is waiting for a start decision.</p>
          )}
          {tasksReady && runsReady && awaiting.length > DECISION_LIMIT && (
            <NxButton variant="ghost" onClick={() => props.onNavigate('tasks')}>
              {awaiting.length - DECISION_LIMIT} more in Tasks
            </NxButton>
          )}
          <p className="nx-muted ccx-fine">
            The owner approves each run when it starts; the API has no list of pending approvals.
          </p>
        </div>

        <div className="ccx-block">
          <h3>Current activity</h3>
          {!runsReady ? (
            <p className="nx-muted">Available once runs load.</p>
          ) : active.length ? (
            <ul className="ccx-list">
              {active.map((run) => (
                <li key={run.id}>
                  <button type="button" className="ccx-row" onClick={() => props.onSelectRun(run)}>
                    <RunStatusBadge status={run.status} />
                    <span className="ccx-item-title">{run.taskTitle}</span>
                    <span className="ccx-visually-hidden">, open run</span>
                  </button>
                  <NxButton
                    variant="danger"
                    disabled={busy || run.status === 'stopping'}
                    aria-label={`${run.status === 'stopping' ? 'Stop requested' : 'Request stop'} for ${run.taskTitle}`}
                    onClick={() => props.onStop(run)}
                  >
                    {run.status === 'stopping' ? 'Stop requested' : 'Request stop'}
                  </NxButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="nx-muted">No active run.</p>
          )}
          <p className="nx-muted ccx-fine">
            Mock runtime, synthetic. The API does not report which agent handles a run.
          </p>
        </div>

        <div className="ccx-block">
          <h3>
            Priority events{' '}
            {runsReady && problems.length > 0 && (
              <span className="ccx-count">{problems.length}</span>
            )}
          </h3>
          {!runsReady ? (
            <p className="nx-muted">Available once runs load.</p>
          ) : problems.length ? (
            <ul className="ccx-list">
              {problems.slice(0, PRIORITY_LIMIT).map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    className="ccx-row ccx-row-stack"
                    onClick={() => props.onSelectRun(run)}
                  >
                    <span className="ccx-row-top">
                      <RunStatusBadge status={run.status} />
                      <span className="ccx-item-title">{run.taskTitle}</span>
                      <span className="ccx-visually-hidden">, open run</span>
                    </span>
                    <span className="nx-mono nx-muted">
                      <time dateTime={run.updatedAt}>{formatManilaStamp(run.updatedAt)}</time> PHT
                    </span>
                    {run.status === 'unknown' && (
                      <span className="nx-muted ccx-fine">
                        Not verified as completed or failed.
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="nx-muted">No failed, interrupted or unknown-outcome runs recorded.</p>
          )}
          {runsReady && problems.length > PRIORITY_LIMIT && (
            <NxButton variant="ghost" onClick={() => props.onNavigate('runs')}>
              {problems.length - PRIORITY_LIMIT} more in Runs
            </NxButton>
          )}
        </div>
      </Panel>
    </div>
  );
}

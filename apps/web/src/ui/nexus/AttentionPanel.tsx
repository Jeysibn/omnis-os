import { ArrowRight, CircleStop, ShieldCheck, X } from 'lucide-react';
import type { Run, Task } from '@omnis/contracts';
import { StatusGlyph } from './StatusGlyph.js';
import { formatManilaStamp } from './time.js';
import { isActiveStatus, type LoadState } from './vitals.js';

const label = (value: string) =>
  value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

type Props = {
  tasks: Task[];
  runs: Run[];
  tasksState: LoadState;
  runsState: LoadState;
  tasksError: string;
  runsError: string;
  busy: boolean;
  selectedRun: Run | null;
  onRetryTasks: () => void;
  onRetryRuns: () => void;
  onSelectRun: (runId: string) => void;
  onClearSelection: () => void;
  onOpenRun: (run: Run) => void;
  onStop: (run: Run) => void;
  onReviewApproval: (task: Task, trigger: HTMLButtonElement) => void;
};

function Failure({
  resource,
  message,
  onRetry,
}: {
  resource: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="nx-failure" role="alert">
      <X size={14} aria-hidden="true" />
      <div>
        <strong>{resource} unavailable</strong>
        <p>{message}</p>
      </div>
      <button type="button" className="nx-btn" onClick={onRetry}>
        Retry {resource.toLowerCase()}
      </button>
    </div>
  );
}

export function AttentionPanel(props: Props) {
  const { tasks, runs, tasksState, runsState, selectedRun, busy } = props;
  const busyTaskIds = new Set(
    runs.filter((r) => isActiveStatus(r.status) || r.status === 'queued').map((r) => r.taskId),
  );
  const awaiting = tasks.filter((task) => task.status === 'open' && !busyTaskIds.has(task.id));
  const active = runs.filter((run) => isActiveStatus(run.status) || run.status === 'queued');
  const problems = runs
    .filter((run) => ['failed', 'interrupted', 'unknown'].includes(run.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 4);

  return (
    <aside className="nx-side nx-right" aria-labelledby="nx-attention-h" tabIndex={0}>
      <h2 id="nx-attention-h" className="nx-label nx-heading nx-attention-title">
        Requires attention
      </h2>

      <section className="nx-block" aria-labelledby="nx-approvals-heading">
        <h3 id="nx-approvals-heading" tabIndex={-1}>
          Approvals
          {tasksState === 'ready' && <span className="nx-count">{awaiting.length}</span>}
        </h3>
        {tasksState === 'loading' ? (
          <p className="nx-quiet" role="status">
            Checking tasks…
          </p>
        ) : tasksState === 'error' ? (
          <Failure resource="Tasks" message={props.tasksError} onRetry={props.onRetryTasks} />
        ) : (
          <>
            <p className="nx-quiet nx-note">
              <ShieldCheck size={13} aria-hidden="true" /> There is no standing approval queue. The
              owner approves each run at the moment it is started.
            </p>
            {awaiting.length ? (
              <ul className="nx-list">
                {awaiting.slice(0, 4).map((task) => (
                  <li key={task.id}>
                    <span className="nx-item-title">{task.title}</span>
                    <button
                      type="button"
                      className="nx-btn nx-btn-amber"
                      disabled={busy}
                      onClick={(event) => props.onReviewApproval(task, event.currentTarget)}
                      aria-label={`Review approval to start ${task.title}`}
                    >
                      Review approval
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="nx-empty-line">No open task is waiting for a start decision.</p>
            )}
          </>
        )}
      </section>

      <section className="nx-block" aria-labelledby="nx-activity-h">
        <h3 id="nx-activity-h">Current activity</h3>
        {runsState === 'loading' ? (
          <p className="nx-quiet" role="status">
            Checking current runs…
          </p>
        ) : runsState === 'error' ? (
          <Failure resource="Runs" message={props.runsError} onRetry={props.onRetryRuns} />
        ) : active.length ? (
          <ul className="nx-list">
            {active.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="nx-row"
                  onClick={() => props.onSelectRun(run.id)}
                  aria-pressed={selectedRun?.id === run.id}
                >
                  <StatusGlyph status={run.status} />
                  <span className="nx-item-title">{run.taskTitle}</span>
                  <span className="nx-status">{label(run.status)}</span>
                </button>
                {isActiveStatus(run.status) && (
                  <button
                    type="button"
                    className="nx-btn nx-btn-danger"
                    onClick={() => props.onStop(run)}
                    disabled={busy || run.status === 'stopping'}
                  >
                    <CircleStop size={14} aria-hidden="true" />
                    {run.status === 'stopping' ? 'Stop requested' : 'Request stop'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="nx-empty-line">No active run.</p>
        )}
        <p className="nx-quiet nx-fine">
          Mock runtime, synthetic. The API does not report which agent handles a run, so none is
          shown.
        </p>
      </section>

      <section className="nx-block" aria-labelledby="nx-priority-h">
        <h3 id="nx-priority-h">Priority events</h3>
        {runsState !== 'ready' ? (
          <p className="nx-quiet">Available once runs load.</p>
        ) : problems.length ? (
          <ul className="nx-list">
            {problems.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="nx-row"
                  onClick={() => props.onSelectRun(run.id)}
                  aria-pressed={selectedRun?.id === run.id}
                >
                  <StatusGlyph status={run.status} />
                  <span className="nx-item-title">{run.taskTitle}</span>
                  <span className="nx-status">{label(run.status)}</span>
                  <time className="nx-mono nx-fine" dateTime={run.updatedAt}>
                    {formatManilaStamp(run.updatedAt)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="nx-empty-line">No failed or interrupted runs recorded.</p>
        )}
      </section>

      <section className="nx-block" aria-labelledby="nx-selected-h" aria-live="polite">
        <h3 id="nx-selected-h">Selected mission</h3>
        {selectedRun ? (
          <>
            <dl className="nx-kv">
              <dt>Task</dt>
              <dd>{selectedRun.taskTitle}</dd>
              <dt>Status</dt>
              <dd>
                <StatusGlyph status={selectedRun.status} /> {label(selectedRun.status)}
              </dd>
              <dt>Queued</dt>
              <dd className="nx-mono">{formatManilaStamp(selectedRun.createdAt)}</dd>
              <dt>Last change</dt>
              <dd className="nx-mono">{formatManilaStamp(selectedRun.updatedAt)}</dd>
              <dt>Runtime</dt>
              <dd>Mock · synthetic</dd>
              <dt>Usage</dt>
              <dd>Not reported</dd>
              <dt>Run ID</dt>
              <dd className="nx-mono nx-break">{selectedRun.id}</dd>
            </dl>
            <div className="nx-actions">
              <button type="button" className="nx-btn" onClick={() => props.onOpenRun(selectedRun)}>
                Open run and event replay <ArrowRight size={14} aria-hidden="true" />
              </button>
              <button type="button" className="nx-btn" onClick={props.onClearSelection}>
                Whole-system view
              </button>
            </div>
          </>
        ) : (
          <p className="nx-quiet">
            Choose a run in a list, in the mission lane, or by its marker on the reactor to inspect
            it here.
          </p>
        )}
      </section>
    </aside>
  );
}

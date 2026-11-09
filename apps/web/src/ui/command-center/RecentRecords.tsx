import { ArrowRight } from 'lucide-react';
import type { Run, Task } from '@omnis/contracts';
import { EmptyState, LoadingState, NxButton, Panel } from '../design/index.js';
import { RunStatusBadge, TaskStatusBadge } from './status.js';
import { formatManilaStamp } from './time.js';
import type { LoadState } from './vitals.js';

/**
 * The most recent task and run records, as plain lists. This is the existing V1 content, kept so
 * every run stays one click away; it is deliberately not an event stream or a Mission Lane.
 */
export function RecentRecords(props: {
  tasks: Task[];
  runs: Run[];
  tasksState: LoadState;
  runsState: LoadState;
  onNavigate: (page: 'tasks' | 'runs') => void;
  onSelectRun: (run: Run) => void;
  onCreate: () => void;
}) {
  const recentTasks = [...props.tasks]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  const recentRuns = [...props.runs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  return (
    <div className="ccx-records">
      <Panel
        title="Recent tasks"
        label="Records"
        actions={
          <NxButton variant="ghost" onClick={() => props.onNavigate('tasks')}>
            All tasks <ArrowRight size={14} aria-hidden="true" />
          </NxButton>
        }
      >
        {props.tasksState === 'loading' ? (
          <LoadingState label="Loading tasks…" />
        ) : props.tasksState === 'error' ? (
          <p className="nx-muted">Available once tasks load.</p>
        ) : recentTasks.length ? (
          <ul className="ccx-list">
            {recentTasks.map((task) => (
              <li key={task.id}>
                <span className="ccx-row-stack">
                  <span className="ccx-item-title">{task.title}</span>
                  <span className="nx-mono nx-muted">{formatManilaStamp(task.createdAt)}</span>
                </span>
                <TaskStatusBadge status={task.status} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No tasks yet"
            description="Create a task to start a mock workflow."
            action={<NxButton onClick={props.onCreate}>Create a task</NxButton>}
          />
        )}
      </Panel>
      <Panel
        title="Recent runs"
        label="Records"
        actions={
          <NxButton variant="ghost" onClick={() => props.onNavigate('runs')}>
            All runs <ArrowRight size={14} aria-hidden="true" />
          </NxButton>
        }
      >
        {props.runsState === 'loading' ? (
          <LoadingState label="Loading runs…" />
        ) : props.runsState === 'error' ? (
          <p className="nx-muted">Available once runs load.</p>
        ) : recentRuns.length ? (
          <ul className="ccx-list">
            {recentRuns.map((run) => (
              <li key={run.id}>
                <button type="button" className="ccx-row" onClick={() => props.onSelectRun(run)}>
                  <span className="ccx-row-stack">
                    <span className="ccx-item-title">{run.taskTitle}</span>
                    <span className="nx-mono nx-muted">{formatManilaStamp(run.createdAt)}</span>
                  </span>
                  <RunStatusBadge status={run.status} />
                  <span className="ccx-visually-hidden">, open run</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No runs yet"
            description="Runs will appear after an owner approves a mock execution."
            action={<NxButton onClick={() => props.onNavigate('tasks')}>Review tasks</NxButton>}
          />
        )}
      </Panel>
    </div>
  );
}

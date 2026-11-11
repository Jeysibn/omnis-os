import { useId } from 'react';
import type { Epic, ProjectWorkspaceTaskSummary } from '@omnis/contracts';
import { EmptyState, ErrorState, LoadingState, NxButton, StatusBadge } from '../../design/index.js';
import { readFailureView } from '../readFailure.js';
import { formatManila, RunStatusBadge, TaskStatusBadge } from '../parts.js';
import { fetchEpicTasks } from './data.js';
import { ListFooter } from './records.js';
import { summariseTasks, taskStatuses } from './summary.js';
import { usePagedList } from './usePagedList.js';

export type EpicTaskRef = Pick<ProjectWorkspaceTaskSummary, 'id' | 'title' | 'associationRevision'>;

/** `#tasks/<id>` opens the Tasks screen with that task selected. */
export const taskHash = (taskId: string) => `#tasks/${encodeURIComponent(taskId)}`;

/**
 * The tasks in one epic, with counts by status taken only from the tasks actually loaded. The API
 * has no per-status totals, so when not every page is loaded the counts say so instead of
 * standing in for the epic's totals.
 */
export function EpicTasks({
  projectId,
  epic,
  version,
  readOnly,
  onUnauthorized,
  onChangeEpic,
}: {
  projectId: string;
  epic: Epic;
  /** Changes when a task was moved, so this list is read again. */
  version: number;
  readOnly: boolean;
  onUnauthorized: (cause: unknown) => void;
  onChangeEpic: (task: EpicTaskRef) => void;
}) {
  const list = usePagedList<ProjectWorkspaceTaskSummary>(
    `${projectId}:${epic.id}:${version}`,
    true,
    (cursor, signal) =>
      fetchEpicTasks(projectId, epic.id, cursor, signal).then((result) => ({
        items: result.tasks,
        page: result.page,
      })),
    onUnauthorized,
  );
  const headingId = useId();
  const { state } = list;

  if (state.first.status === 'loading') return <LoadingState label="Loading epic tasks…" />;
  if (state.first.status === 'error') {
    const view = readFailureView(state.first.error, 'epic task list');
    return (
      <ErrorState
        title={view.title}
        description={view.description}
        onRetry={view.retry ? list.reload : undefined}
      />
    );
  }
  const summary = summariseTasks(state.items, state.page);
  return (
    <div className="pw-epic-tasks" role="group" aria-labelledby={headingId}>
      <h4 id={headingId} className="pw-subhead">
        Tasks in {epic.title}
      </h4>
      <p className="pw-counts" data-partial={summary.partial ? 'true' : 'false'}>
        {taskStatuses.map((status) => (
          <span key={status} className="pw-count">
            <TaskStatusBadge status={status} /> <strong>{summary.counts[status]}</strong>
          </span>
        ))}
      </p>
      <p className="nx-muted pw-summary">{summary.text}</p>
      {state.items.length === 0 ? (
        <EmptyState
          title="No tasks in this epic"
          description="Assign a task from the project's task list."
        />
      ) : (
        <ul className="pw-task-list">
          {state.items.map((task) => (
            <li key={task.id}>
              <div className="pw-task-main">
                <a href={taskHash(task.id)} className="pw-title">
                  {task.title}
                </a>
                <TaskStatusBadge status={task.status} />
                {task.latestRun ? (
                  <a
                    href={`#runs/${encodeURIComponent(task.latestRun.id)}`}
                    className="pw-run-link"
                  >
                    <RunStatusBadge status={task.latestRun.status} />
                    <span className="nx-muted"> {formatManila(task.latestRun.updatedAt)}</span>
                  </a>
                ) : (
                  <StatusBadge tone="neutral">No runs</StatusBadge>
                )}
              </div>
              {!readOnly && (
                <NxButton
                  aria-label={`Change epic for ${task.title}`}
                  onClick={() => onChangeEpic(task)}
                >
                  Change epic
                </NxButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <ListFooter
        state={state}
        noun="tasks"
        loadMore={list.loadMore}
        reload={list.reload}
        hideSummary
      />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectWorkspaceTaskSummary } from '@omnis/contracts';
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  InfoGroup,
  LoadingState,
  NxButton,
  Panel,
  type Column,
} from '../design/index.js';
import { ApiRequestError } from '../api.js';
import { archiveProject, classifyMutationFailure, fetchProject, type ReadFailure } from './data.js';
import { useProject, useProjectTasks, type TaskListState } from './hooks.js';
import { IdempotentIntent } from './intent.js';
import type { Msg } from './messages.js';
import {
  formatManila,
  Message,
  Notice,
  PriorityBadge,
  ProjectStatusBadge,
  RunStatusBadge,
  TaskStatusBadge,
  useFocusOnArrival,
} from './parts.js';
import { analyse, type Conclusion, type Observation, type RecoveryAction } from './recovery.js';
import { editProjectHash, projectsHash } from './route.js';

type Props = {
  projectId: string;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
  flash: Msg | null;
  arrivedByNavigation: boolean;
};

export function readFailureView(error: ReadFailure, noun: string) {
  switch (error.kind) {
    case 'notFound':
      return {
        title: `This ${noun} was not found.`,
        description: 'It may have been removed, or the link is wrong.',
        retry: false,
      };
    case 'forbidden':
      return {
        title: `You don't have access to this ${noun}.`,
        description: undefined,
        retry: false,
      };
    case 'unexpected':
      return {
        title: `Omnis OS received an unexpected ${noun} response.`,
        description: 'Do not repeat any action. Reload the page.',
        retry: true,
      };
    case 'limit':
      return {
        title: `The ${noun} is too large to show reliably.`,
        description: undefined,
        retry: false,
      };
    default:
      return { title: `The ${noun} could not be loaded.`, description: error.message, retry: true };
  }
}

type ArchiveRecovery = { conclusion: Conclusion; expectedRevision: number };

export function ProjectDetail({
  projectId,
  csrfToken,
  refreshCsrf,
  onUnauthorized,
  flash,
  arrivedByNavigation,
}: Props) {
  const project = useProject(projectId, true, onUnauthorized);
  const ready = project.value.status === 'ready';
  const tasks = useProjectTasks(projectId, ready, onUnauthorized);
  const headingRef = useFocusOnArrival(arrivedByNavigation && ready, projectId);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<'archive' | 'check' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; msg: Msg } | null>(
    flash ? { tone: 'success', msg: flash } : null,
  );
  const [recovery, setRecovery] = useState<ArchiveRecovery | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const intent = useRef(new IdempotentIntent());
  const inflight = useRef(false);
  const mounted = useRef(true);
  const csrfRef = useRef(csrfToken);
  csrfRef.current = csrfToken;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const replaceRef = useRef(project.replace);
  replaceRef.current = project.replace;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The archive action vanishes once it succeeds, so focus would otherwise fall to the document.
  const [moveFocusToStatus, setMoveFocusToStatus] = useState(0);
  useEffect(() => {
    if (moveFocusToStatus > 0) statusRef.current?.focus();
  }, [moveFocusToStatus]);

  if (project.value.status === 'loading') return <LoadingState label="Loading project…" />;
  if (project.value.status === 'error') {
    const view = readFailureView(project.value.error, 'project');
    return (
      <div className="pw-stack">
        <BackLink />
        <ErrorState
          title={view.title}
          description={view.description}
          onRetry={view.retry ? project.reload : undefined}
        />
      </div>
    );
  }

  const current: Project = project.value.data;
  const archived = current.status === 'archived';

  async function recheck(expectedRevision: number) {
    setBusy('check');
    let observation: Observation;
    try {
      observation = { kind: 'project', project: await fetchProject(projectId) };
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        unauthorizedRef.current(cause);
        return;
      }
      observation =
        cause instanceof ApiRequestError && cause.status === 404
          ? { kind: 'absent' }
          : { kind: 'failed' };
    }
    if (!mounted.current) return;
    const conclusion = analyse({ kind: 'archive', id: projectId, expectedRevision }, observation);
    setBusy(null);
    if (conclusion.settled && conclusion.project) {
      intent.current.settle();
      replaceRef.current(conclusion.project);
      setRecovery(null);
      setNotice({ tone: 'success', msg: conclusion.message });
      setMoveFocusToStatus((tick) => tick + 1);
    } else setRecovery({ conclusion, expectedRevision });
  }

  async function runArchive(expectedRevision: number) {
    if (inflight.current) return; // a second activation cannot send a second request
    inflight.current = true;
    setBusy('archive');
    setNotice(null);
    setRecovery(null);
    const key = intent.current.keyFor(JSON.stringify({ archive: projectId, expectedRevision }));
    try {
      const saved = await archiveProject(projectId, expectedRevision, key, csrfRef.current);
      intent.current.settle();
      if (!mounted.current) return;
      replaceRef.current(saved);
      setNotice({ tone: 'success', msg: { key: 'confirmed.archive' } });
      setMoveFocusToStatus((tick) => tick + 1);
    } catch (cause) {
      const failure = classifyMutationFailure(cause);
      if (failure.evidence === 'unauthorized') {
        unauthorizedRef.current(cause);
        return;
      }
      if (failure.evidence === 'unknown') {
        intent.current.markUncertain();
        if (mounted.current) await recheck(expectedRevision);
        return;
      }
      intent.current.settle();
      if (!mounted.current) return;
      const error = (msg: Msg) => setNotice({ tone: 'error', msg });
      if (failure.status === 403) {
        try {
          csrfRef.current = await refreshCsrf();
        } catch {
          // The notice still asks the owner to retry.
        }
        error({ key: 'rejected.csrf' });
      } else if (failure.status === 404) error({ key: 'rejected.notFound' });
      else if (failure.status === 422) error({ key: 'rejected.invalidInput' });
      else if (failure.code === 'invalid_transition' || failure.code === 'conflict') {
        // Read why: already archived, or changed since this page was loaded.
        try {
          const latest = await fetchProject(projectId);
          if (!mounted.current) return;
          replaceRef.current(latest);
          error({
            key: latest.status === 'archived' ? 'rejected.archived' : 'rejected.archive.stale',
          });
        } catch (readCause) {
          if (readCause instanceof ApiRequestError && readCause.status === 401) {
            unauthorizedRef.current(readCause);
            return;
          }
          if (mounted.current) error({ key: 'rejected.readbackFailed' });
        }
      } else error({ key: 'rejected.readbackFailed' });
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy((value) => (value === 'archive' ? null : value));
    }
  }

  const act = (action: RecoveryAction) => {
    if (!recovery || busy) return;
    if (action === 'checkAgain') void recheck(recovery.expectedRevision);
    else if (action === 'tryAgain') void runArchive(recovery.expectedRevision);
    else if (action === 'close') setRecovery(null);
    else if (action === 'loadLatest' && recovery.conclusion.project) {
      replaceRef.current(recovery.conclusion.project);
      intent.current.settle();
      setRecovery(null);
    }
  };
  const recoveryLabel: Partial<Record<RecoveryAction, string>> = {
    checkAgain: 'Check again',
    tryAgain: 'Try again',
    close: 'Close',
    loadLatest: 'Show latest project',
  };

  return (
    <div className="pw-stack">
      <BackLink />
      <div ref={statusRef} tabIndex={-1} className="pw-live" aria-live="polite">
        {busy === 'archive' && (
          <Notice tone="progress">
            <Message msg={{ key: 'inflight.archive' }} />
          </Notice>
        )}
        {busy === 'check' && (
          <Notice tone="progress">
            <Message msg={{ key: 'inflight.check' }} />
          </Notice>
        )}
        {notice && (
          <Notice tone={notice.tone}>
            <Message msg={notice.msg} />
          </Notice>
        )}
      </div>
      {recovery && (
        <Notice
          tone="warning"
          actions={recovery.conclusion.actions.map((action) => (
            <NxButton
              key={action}
              variant={action === 'tryAgain' ? 'primary' : 'secondary'}
              busy={busy === 'check' && action === 'checkAgain'}
              disabled={busy === 'archive'}
              onClick={() => act(action)}
            >
              {recoveryLabel[action] ?? action}
            </NxButton>
          ))}
        >
          <Message msg={recovery.conclusion.message} />
        </Notice>
      )}

      <Panel
        title={current.name}
        label={current.key}
        headingRef={headingRef}
        actions={
          archived ? undefined : (
            <div className="pw-actions">
              <NxButton onClick={() => (window.location.hash = editProjectHash(current.id))}>
                Edit project
              </NxButton>
              <NxButton
                variant="danger"
                busy={busy === 'archive'}
                disabled={busy === 'check'}
                onClick={() => setConfirmOpen(true)}
              >
                Archive project
              </NxButton>
            </div>
          )
        }
      >
        {archived && (
          <Notice tone="static">
            This project is archived and read-only. There is no restore action.
          </Notice>
        )}
        <InfoGroup
          items={[
            { label: 'Status', value: <ProjectStatusBadge status={current.status} /> },
            { label: 'Priority', value: <PriorityBadge priority={current.priority} /> },
            { label: 'Revision', value: current.revision },
            { label: 'Created', value: formatManila(current.createdAt) },
            { label: 'Updated', value: formatManila(current.updatedAt) },
            { label: 'Project ID', value: <span className="nx-mono nx-break">{current.id}</span> },
          ]}
        />
        <h3 className="pw-subhead">Objective</h3>
        <p className="pw-prose">{current.objective}</p>
      </Panel>

      <TaskPanel
        projectName={current.name}
        tasks={tasks.state}
        reload={tasks.reload}
        loadMore={tasks.loadMore}
      />

      <ConfirmDialog
        open={confirmOpen}
        danger
        title="Archive this project?"
        description={`Archiving "${current.name}" cannot be undone. There is no restore action. The project stays readable, but it can no longer be edited and new runs can no longer be started for its tasks. Runs already started are not cancelled.`}
        confirmLabel="Archive project"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          void runArchive(current.revision);
        }}
      />
    </div>
  );
}

function BackLink() {
  return (
    <nav aria-label="Project navigation" className="pw-back">
      <a href={projectsHash()}>← All projects</a>
    </nav>
  );
}

const columns: readonly Column<ProjectWorkspaceTaskSummary>[] = [
  {
    key: 'task',
    header: 'Task',
    render: (task) => (
      <>
        <span className="pw-title">{task.title}</span>
        <br />
        <span className="nx-mono nx-muted nx-break">{task.id}</span>
      </>
    ),
  },
  {
    key: 'status',
    header: 'Task status',
    render: (task) => <TaskStatusBadge status={task.status} />,
  },
  {
    key: 'run',
    header: 'Latest run',
    render: (task) =>
      task.latestRun ? (
        <>
          <RunStatusBadge status={task.latestRun.status} />
          <br />
          <a href={`#runs/${encodeURIComponent(task.latestRun.id)}`} className="nx-mono nx-break">
            {task.latestRun.id}
          </a>
          <br />
          <span className="nx-muted">Updated {formatManila(task.latestRun.updatedAt)}</span>
        </>
      ) : (
        <span className="nx-muted">No runs yet</span>
      ),
  },
  { key: 'created', header: 'Created', render: (task) => formatManila(task.createdAt) },
];

function TaskPanel({
  projectName,
  tasks,
  reload,
  loadMore,
}: {
  projectName: string;
  tasks: TaskListState;
  reload: () => void;
  loadMore: () => void;
}) {
  const { first, page } = tasks;
  let body;
  if (first.status === 'loading') body = <LoadingState label="Loading tasks…" />;
  else if (first.status === 'error') {
    const view = readFailureView(first.error, 'task list');
    body = (
      <ErrorState
        title={view.title}
        description={view.description}
        onRetry={view.retry ? reload : undefined}
      />
    );
  } else if (tasks.tasks.length === 0 && page?.complete) {
    body = (
      <EmptyState
        title="No tasks in this project"
        description="Tasks that are associated with this project appear here, with the state of their latest run."
      />
    );
  } else {
    const shown = tasks.tasks.length;
    const observed = page?.observedTotal ?? shown;
    const summary = !page?.complete
      ? `Showing ${shown} tasks so far. ${observed} tasks were associated with this project when the latest page was read.`
      : shown === observed
        ? `Showing all ${shown} tasks.`
        : `Showing ${shown} tasks. ${observed} tasks were associated when the last page was read, so this list may be out of date.`;
    body = (
      <>
        <p className="nx-muted" data-testid="task-summary">
          {summary}
        </p>
        <DataTable
          caption={`Tasks in ${projectName}`}
          columns={columns}
          rows={tasks.tasks}
          rowKey={(task) => task.id}
          empty={{ title: 'No tasks' }}
        />
        {tasks.moreError?.kind === 'cursor' && (
          <Notice
            tone="warning"
            actions={<NxButton onClick={reload}>Restart from the first page</NxButton>}
          >
            The task list changed while it was being read, so the next page can no longer be
            continued.
          </Notice>
        )}
        {tasks.moreError?.kind === 'failure' && (
          <Notice
            tone="error"
            actions={<NxButton onClick={loadMore}>Retry loading more tasks</NxButton>}
          >
            {tasks.moreError.message}
          </Notice>
        )}
        {page && !page.complete && tasks.moreError === null && (
          <div className="pw-actions">
            <NxButton busy={tasks.loadingMore} onClick={loadMore}>
              Load more tasks
            </NxButton>
          </div>
        )}
        {page?.complete && shown !== observed && (
          <div className="pw-actions">
            <NxButton onClick={reload}>Reload tasks</NxButton>
          </div>
        )}
      </>
    );
  }
  return (
    <Panel title="Tasks" label="Project-scoped summaries" level={2}>
      {body}
    </Panel>
  );
}

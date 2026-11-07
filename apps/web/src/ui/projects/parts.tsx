import { useEffect, useRef, type ReactNode } from 'react';
import type { Project, ProjectWorkspaceTaskSummary } from '@omnis/contracts';
import { StatusBadge, type StatusTone } from '../design/index.js';
import { messageText, type Msg } from './messages.js';

export { formatManila } from '../agents/shared.js';

type ProjectStatus = Project['status'];
type Priority = Project['priority'];
type TaskStatus = ProjectWorkspaceTaskSummary['status'];
type RunStatus = NonNullable<ProjectWorkspaceTaskSummary['latestRun']>['status'];

const label = (value: string) => value.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());

const projectTone: Record<ProjectStatus, StatusTone> = {
  proposed: 'info',
  active: 'ok',
  paused: 'attention',
  completed: 'neutral',
  archived: 'neutral',
};
const priorityTone: Record<Priority, StatusTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'attention',
  urgent: 'danger',
};
const taskTone: Record<TaskStatus, StatusTone> = {
  open: 'info',
  in_progress: 'attention',
  completed: 'ok',
};
const runTone: Record<RunStatus, StatusTone> = {
  queued: 'info',
  running: 'info',
  stopping: 'attention',
  completed: 'ok',
  cancelled: 'neutral',
  failed: 'danger',
  interrupted: 'attention',
  unknown: 'unknown',
};

export const ProjectStatusBadge = ({ status }: { status: ProjectStatus }) => (
  <StatusBadge tone={projectTone[status]}>{label(status)}</StatusBadge>
);
export const PriorityBadge = ({ priority }: { priority: Priority }) => (
  <StatusBadge tone={priorityTone[priority]}>{label(priority)}</StatusBadge>
);
export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => (
  <StatusBadge tone={taskTone[status]}>{label(status)}</StatusBadge>
);
export const RunStatusBadge = ({ status }: { status: RunStatus }) => (
  <StatusBadge tone={runTone[status]}>{label(status)}</StatusBadge>
);

export const priorityOptions: readonly Priority[] = ['low', 'normal', 'high', 'urgent'];
export const priorityLabel = label;

/** A message from the catalog. The key is exposed so tests can assert it with the exact text. */
export function Message({ msg }: { msg: Msg }) {
  return <span data-message-key={msg.key}>{messageText(msg)}</span>;
}

/**
 * An in-page notice. Errors and uncertain outcomes are announced immediately (`alert`); success
 * and progress are announced politely (`status`).
 */
export function Notice({
  tone,
  children,
  actions,
}: {
  /** `static` is a standing state, not an event, so it is not announced. */
  tone: 'success' | 'error' | 'warning' | 'progress' | 'static';
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className="pw-notice"
      data-tone={tone}
      role={
        tone === 'static' ? undefined : tone === 'error' || tone === 'warning' ? 'alert' : 'status'
      }
    >
      <p>{children}</p>
      {actions && <div className="pw-actions">{actions}</div>}
    </div>
  );
}

/** Moves focus to a heading when it appears after in-app navigation (never on a direct load). */
export function useFocusOnArrival(enabled: boolean, dependency: unknown) {
  const ref = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus({ preventScroll: false });
  }, [enabled, dependency]);
  return ref;
}

import type { Run, Task } from '@omnis/contracts';
import { StatusBadge, type StatusTone } from '../design/index.js';

type Descriptor = { tone: StatusTone; label: string };

/**
 * Every authoritative run status maps to a tone (shape + colour) AND a text label. `unknown` is its
 * own tone and label: an outcome that was not verified is never drawn as completed or failed.
 */
const runStatuses: Record<Run['status'], Descriptor> = {
  queued: { tone: 'info', label: 'Queued' },
  running: { tone: 'ok', label: 'Running' },
  stopping: { tone: 'attention', label: 'Stopping' },
  completed: { tone: 'ok', label: 'Completed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  failed: { tone: 'danger', label: 'Failed' },
  interrupted: { tone: 'attention', label: 'Interrupted' },
  unknown: { tone: 'unknown', label: 'Outcome unknown' },
};

const taskStatuses: Record<Task['status'], Descriptor> = {
  open: { tone: 'neutral', label: 'Open' },
  in_progress: { tone: 'info', label: 'In progress' },
  // A finished run is not an accepted task: the owner has not yet verified the result.
  in_review: { tone: 'attention', label: 'Awaiting review' },
  completed: { tone: 'ok', label: 'Completed' },
};

export const runStatusLabel = (status: Run['status']) => runStatuses[status].label;
export const isActiveRun = (status: Run['status']) =>
  status === 'queued' || status === 'running' || status === 'stopping';

export function RunStatusBadge({ status }: { status: Run['status'] }) {
  const { tone, label } = runStatuses[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export function TaskStatusBadge({ status }: { status: Task['status'] }) {
  const { tone, label } = taskStatuses[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

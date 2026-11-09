import type { Run, Task } from '@omnis/contracts';

export type LoadState = 'loading' | 'error' | 'ready';

/** `value: null` means the source has not confirmed a count; it is never rendered as zero. */
export type Metric = { value: number | null; state: LoadState };

export type Vitals = {
  running: Metric;
  queued: Metric;
  openTasks: Metric;
  failedOrInterrupted: Metric;
  unknownOutcome: Metric;
  /** Latest `updatedAt` among the loaded runs, or null when none is loaded or recorded. */
  lastRunUpdate: string | null;
};

const metric = (state: LoadState, count: () => number): Metric =>
  state === 'ready' ? { value: count(), state } : { value: null, state };

export function computeVitals(input: {
  tasks: Task[];
  runs: Run[];
  tasksState: LoadState;
  runsState: LoadState;
}): Vitals {
  const { tasks, runs, tasksState, runsState } = input;
  const countRuns = (...statuses: Run['status'][]) =>
    runs.filter((run) => statuses.includes(run.status)).length;
  const latest = runs.reduce<string | null>(
    (best, run) => (best === null || run.updatedAt > best ? run.updatedAt : best),
    null,
  );
  return {
    running: metric(runsState, () => countRuns('running', 'stopping')),
    queued: metric(runsState, () => countRuns('queued')),
    openTasks: metric(tasksState, () => tasks.filter((task) => task.status === 'open').length),
    failedOrInterrupted: metric(runsState, () => countRuns('failed', 'interrupted')),
    unknownOutcome: metric(runsState, () => countRuns('unknown')),
    lastRunUpdate: runsState === 'ready' ? latest : null,
  };
}

export const metricText = (m: Metric): string =>
  m.value !== null ? String(m.value) : m.state === 'loading' ? 'Loading' : 'Unavailable';

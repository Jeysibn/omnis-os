import type { Run, Task } from '@omnis/contracts';

export type LoadState = 'loading' | 'error' | 'ready';

/** `value: null` means the source has not confirmed a count; never render it as zero. */
export type Metric = { value: number | null; state: LoadState };

export type Vitals = {
  activeRuns: Metric;
  queuedRuns: Metric;
  openTasks: Metric;
  failedRuns: Metric;
  lastRecordAt: string | null;
};

const metric = (state: LoadState, count: () => number): Metric =>
  state === 'ready' ? { value: count(), state } : { value: null, state };

export const isActiveStatus = (status: Run['status']) =>
  status === 'running' || status === 'stopping';

export function computeVitals(input: {
  tasks: Task[];
  runs: Run[];
  tasksState: LoadState;
  runsState: LoadState;
}): Vitals {
  const { tasks, runs, tasksState, runsState } = input;
  const latest = runs.reduce<string | null>(
    (best, run) => (best === null || run.updatedAt > best ? run.updatedAt : best),
    null,
  );
  return {
    activeRuns: metric(runsState, () => runs.filter((run) => isActiveStatus(run.status)).length),
    queuedRuns: metric(runsState, () => runs.filter((run) => run.status === 'queued').length),
    openTasks: metric(tasksState, () => tasks.filter((task) => task.status === 'open').length),
    failedRuns: metric(
      runsState,
      () => runs.filter((run) => run.status === 'failed' || run.status === 'interrupted').length,
    ),
    lastRecordAt: runsState === 'ready' ? latest : null,
  };
}

export const metricText = (m: Metric): string =>
  m.value !== null ? String(m.value) : m.state === 'loading' ? 'Loading' : 'Unavailable';

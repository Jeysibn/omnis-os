import type { Run } from '@omnis/contracts';
import type { StatusTone } from '../design/index.js';
import type { LoadState } from './vitals.js';

export type SystemStateId =
  | 'loading'
  | 'unavailable'
  | 'active'
  | 'queued'
  | 'unknown'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'idle';

export type SystemState = { id: SystemStateId; label: string; detail: string; tone: StatusTone };

const copy: Record<SystemStateId, Omit<SystemState, 'id'>> = {
  loading: {
    label: 'Loading system state',
    detail: 'Waiting for tasks and runs from the API.',
    tone: 'neutral',
  },
  unavailable: {
    label: 'System state unavailable',
    detail:
      'Tasks or runs could not be loaded, so no activity is shown. Retry from the notice above.',
    tone: 'unknown',
  },
  active: {
    label: 'Mock execution active',
    detail: 'A synthetic mock run is in progress. No provider is contacted.',
    tone: 'ok',
  },
  queued: {
    label: 'Queued',
    detail: 'A synthetic mock run is queued and waiting to start.',
    tone: 'info',
  },
  unknown: {
    label: 'Outcome unknown',
    detail:
      'A run ended without an authoritative outcome. It is not recorded as completed or failed.',
    tone: 'unknown',
  },
  failed: {
    label: 'Run failed',
    detail: 'The most recent run failed. Open it in Runs for its recorded events.',
    tone: 'danger',
  },
  interrupted: {
    label: 'Run interrupted',
    detail: 'The most recent run was interrupted. Open it in Runs for its recorded events.',
    tone: 'attention',
  },
  cancelled: {
    label: 'Cancelled',
    detail: 'The most recent run was cancelled. Its history is retained.',
    tone: 'neutral',
  },
  idle: {
    label: 'Idle',
    detail: 'No run is active. Mock-only mode: no provider is contacted.',
    tone: 'ok',
  },
};

/**
 * Precedence: data problems first (never imply activity that cannot be verified), then current
 * activity, then any unresolved unknown outcome, then the outcome of the most recent run.
 * Only authoritative run records are used; nothing here is inferred from a connection.
 */
export function deriveSystemState(input: {
  tasksState: LoadState;
  runsState: LoadState;
  runs: Run[];
}): SystemState {
  const id = pick(input);
  return { id, ...copy[id] };
}

function pick({ tasksState, runsState, runs }: Parameters<typeof deriveSystemState>[0]) {
  if (tasksState === 'error' || runsState === 'error') return 'unavailable' as const;
  if (tasksState === 'loading' || runsState === 'loading') return 'loading' as const;
  if (runs.some((run) => run.status === 'running' || run.status === 'stopping')) return 'active';
  if (runs.some((run) => run.status === 'queued')) return 'queued';
  if (runs.some((run) => run.status === 'unknown')) return 'unknown';
  const latest = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (latest?.status === 'failed') return 'failed';
  if (latest?.status === 'interrupted') return 'interrupted';
  if (latest?.status === 'cancelled') return 'cancelled';
  return 'idle';
}

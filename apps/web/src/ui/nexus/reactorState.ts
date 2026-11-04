import type { Run, Task } from '@omnis/contracts';
import { isActiveStatus, type LoadState } from './vitals.js';

export type ReactorStateId =
  | 'loading'
  | 'data-unavailable'
  | 'runtime-unavailable'
  | 'disconnected'
  | 'approval'
  | 'active'
  | 'queued'
  | 'failed'
  | 'cancelled'
  | 'idle';

export type Tint = 'jade' | 'amber' | 'red' | 'slate';

/** Renderer-facing parameters. The renderer never sees run or task records. */
export type ReactorVisual = {
  energy: number; // nucleus breathing amplitude and brightness, 0..1
  speed: number; // drift multiplier, 0 stops motion
  orbit: number; // orbital activity, 0..1
  dim: number; // overall dimming, 0..1
  tint: Tint;
  cue: boolean; // one-shot failure cue on entry
};

export type ReactorState = {
  id: ReactorStateId;
  label: string;
  detail: string;
  visual: ReactorVisual;
};

export type ReactorInput = {
  tasksState: LoadState;
  runsState: LoadState;
  runs: Run[];
  tasks: Task[];
  /** Verified count of pending owner approvals, or `null` when the API cannot report it. */
  pendingApprovals: number | null;
  /** Live event stream state, or `'not-applicable'` when this screen holds no stream. */
  stream: 'live' | 'disconnected' | 'not-applicable';
  /** Verified runtime availability, or `undefined` when unreported. Never inferred from a stream. */
  runtimeAvailable: boolean | undefined;
};

const visuals: Record<ReactorStateId, ReactorVisual> = {
  loading: { energy: 0.25, speed: 0, orbit: 0, dim: 0.5, tint: 'slate', cue: false },
  'data-unavailable': { energy: 0.2, speed: 0, orbit: 0, dim: 0.55, tint: 'slate', cue: false },
  'runtime-unavailable': {
    energy: 0.35,
    speed: 0.4,
    orbit: 0.1,
    dim: 0.35,
    tint: 'slate',
    cue: false,
  },
  disconnected: { energy: 0.3, speed: 0, orbit: 0, dim: 0.5, tint: 'slate', cue: false },
  approval: { energy: 0.7, speed: 0.7, orbit: 0.4, dim: 0, tint: 'amber', cue: false },
  active: { energy: 0.9, speed: 1.2, orbit: 1, dim: 0, tint: 'jade', cue: false },
  queued: { energy: 0.6, speed: 0.8, orbit: 0.35, dim: 0, tint: 'jade', cue: false },
  failed: { energy: 0.55, speed: 0.5, orbit: 0.15, dim: 0.1, tint: 'red', cue: true },
  cancelled: { energy: 0.4, speed: 0.3, orbit: 0, dim: 0.2, tint: 'jade', cue: false },
  idle: { energy: 0.5, speed: 0.6, orbit: 0.1, dim: 0, tint: 'jade', cue: false },
};

const copy: Record<ReactorStateId, { label: string; detail: string }> = {
  loading: { label: 'Loading system state', detail: 'Waiting for tasks and runs from the API.' },
  'data-unavailable': {
    label: 'System state unavailable',
    detail: 'Tasks or runs could not be loaded, so no activity is shown. Retry from the panels.',
  },
  'runtime-unavailable': {
    label: 'Runtime unavailable',
    detail: 'The runtime reports that it is not available.',
  },
  disconnected: {
    label: 'Live updates disconnected',
    detail: 'The live event stream is disconnected. Recorded history remains available.',
  },
  approval: { label: 'Approval required', detail: 'An owner approval is pending.' },
  active: { label: 'Mock execution active', detail: 'A synthetic mock run is in progress.' },
  queued: { label: 'Queued', detail: 'A mock run is queued and waiting to start.' },
  failed: {
    label: 'Run failed',
    detail: 'The most recent run failed or was interrupted. Open it in Runs for the event history.',
  },
  cancelled: {
    label: 'Canceled',
    detail: 'The most recent run was canceled. History is retained.',
  },
  idle: { label: 'Idle', detail: 'No run is active. Mock-only mode: no provider is contacted.' },
};

/**
 * Precedence: data problems first (never imply activity we cannot verify), then explicit
 * attention states, then current activity, then the outcome of the most recent run.
 */
export function deriveReactorState(input: ReactorInput): ReactorState {
  const id = pick(input);
  return { id, ...copy[id], visual: visuals[id] };
}

function pick(input: ReactorInput): ReactorStateId {
  if (input.tasksState === 'loading' || input.runsState === 'loading') return 'loading';
  if (input.tasksState === 'error' || input.runsState === 'error') return 'data-unavailable';
  if (input.runtimeAvailable === false) return 'runtime-unavailable';
  if (input.stream === 'disconnected') return 'disconnected';
  if (input.pendingApprovals !== null && input.pendingApprovals > 0) return 'approval';
  if (input.runs.some((run) => isActiveStatus(run.status))) return 'active';
  if (input.runs.some((run) => run.status === 'queued')) return 'queued';
  const latest = [...input.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (latest?.status === 'failed' || latest?.status === 'interrupted') return 'failed';
  if (latest?.status === 'cancelled') return 'cancelled';
  return 'idle';
}

import type { Run, RunEvent } from '@omnis/contracts';

/**
 * Cancellation display state, derived only from the Run's authoritative status and the validated
 * event trail. Transmitting a stop request is never treated as success: only a `cancelled` status
 * is Confirmed.
 */
export type CancellationState = 'requested' | 'pending' | 'unknown' | 'confirmed';

export type RunLifecycle = {
  label: string;
  detail: string;
  tone: 'active' | 'terminal' | 'warning';
  cancellation: CancellationState | null;
  cancellationLabel: string | null;
};

const cancellationLabels: Record<CancellationState, string> = {
  requested: 'Stop requested',
  pending: 'Stop pending',
  unknown: 'Stop outcome unknown',
  confirmed: 'Stop confirmed',
};

export function describeRunLifecycle(
  run: Pick<Run, 'status'>,
  events: ReadonlyArray<Pick<RunEvent, 'type'>>,
): RunLifecycle {
  const stopSeen = events.some((event) => event.type === 'run.stop_requested');
  const make = (
    label: string,
    detail: string,
    tone: RunLifecycle['tone'],
    cancellation: CancellationState | null = null,
  ): RunLifecycle => ({
    label,
    detail,
    tone,
    cancellation,
    cancellationLabel: cancellation ? cancellationLabels[cancellation] : null,
  });

  switch (run.status) {
    case 'queued':
      return stopSeen
        ? make(
            'Queued',
            'A stop was recorded in the event trail, but the run has not reported a stopping state yet. It is not cancelled.',
            'active',
            'pending',
          )
        : make('Queued', 'Waiting to start. No synthetic activity has happened yet.', 'active');
    case 'running':
      return stopSeen
        ? make(
            'Running',
            'A stop was recorded in the event trail, but the run has not reported a stopping state yet. It is not cancelled.',
            'active',
            'pending',
          )
        : make('Running', 'The synthetic run is in progress.', 'active');
    case 'stopping':
      return make(
        'Stopping',
        'A stop was requested. The run is not cancelled until the runtime confirms it.',
        'active',
        'requested',
      );
    case 'cancelled':
      return make(
        'Cancelled',
        'The runtime confirmed this run was cancelled.',
        'terminal',
        'confirmed',
      );
    case 'unknown':
      return make(
        'Outcome unknown',
        stopSeen
          ? 'A stop was requested, but the runtime has not confirmed whether the run stopped. Check state to look again; do not assume it was cancelled.'
          : 'The runtime has not confirmed how this run ended. Check state to look again.',
        'warning',
        stopSeen ? 'unknown' : null,
      );
    case 'completed':
      return make('Completed', 'The run finished. Its output remains synthetic.', 'terminal');
    case 'failed':
      return make(
        'Failed',
        'The run failed. Review the event trail for recorded state changes.',
        'terminal',
      );
    case 'interrupted':
      return make(
        'Interrupted',
        'The run was interrupted before it finished. This is not a confirmed cancellation.',
        'warning',
      );
  }
}

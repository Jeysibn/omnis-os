import type { Run } from '@omnis/contracts';

export type EventFeedKind = 'live' | 'history' | 'stale' | 'connecting';

export type EventFeedNotice = { kind: EventFeedKind; label: string; detail: string };

type StreamStateLike = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'ended' | 'paused';

const terminal: ReadonlyArray<Run['status']> = ['completed', 'failed', 'cancelled', 'interrupted'];

/**
 * Says whether the event trail is updating now or is recorded history. Derived only from the Run's
 * persisted status and the stream's connection state; never implies provider activity.
 */
export function describeEventFeed(
  run: Pick<Run, 'status'>,
  streamState: StreamStateLike,
): EventFeedNotice {
  if (streamState === 'connected' && !terminal.includes(run.status))
    return {
      kind: 'live',
      label: 'Live',
      detail: 'New events appear as they are recorded. Earlier events are replayed history.',
    };
  if (streamState === 'connecting' || streamState === 'reconnecting')
    return {
      kind: 'connecting',
      label: 'Recorded history',
      detail:
        'Showing recorded events. The live connection is not established, so newer events may be missing.',
    };
  if (streamState === 'paused' || streamState === 'closed')
    return {
      kind: 'stale',
      label: 'Not live',
      detail: 'Showing recorded events only. They are not updating and may be out of date.',
    };
  return {
    kind: 'history',
    label: 'Recorded history',
    detail: 'Showing the persisted event trail for this run. No live events are expected.',
  };
}

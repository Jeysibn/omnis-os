import type { Run, RunEvent } from '@omnis/contracts';

/** Persisted run events keyed by run id, each list ordered by the authoritative sequence. */
export type RunEventLog = Record<string, RunEvent[]>;

export type MissionEvent = {
  id: string;
  runId: string;
  sequence: number;
  at: string;
  type: RunEvent['type'];
  status: Run['status'];
  label: string;
  message: string;
  taskTitle: string;
};

/** Bounds: concurrent streams and retained events per run. */
export const MAX_STREAMS = 4;
export const MAX_EVENTS_PER_RUN = 40;

const LABELS: Record<RunEvent['type'], string> = {
  'run.queued': 'Queued',
  'run.started': 'Started',
  'run.output': 'Output',
  'run.stop_requested': 'Stop requested',
  'run.completed': 'Completed',
  'run.cancelled': 'Canceled',
  'run.failed': 'Failed',
  'run.interrupted': 'Interrupted',
};

export const isTerminalEvent = (type: RunEvent['type']) =>
  type === 'run.completed' ||
  type === 'run.cancelled' ||
  type === 'run.failed' ||
  type === 'run.interrupted';

export const isUnfinished = (status: Run['status']) =>
  status === 'queued' || status === 'running' || status === 'stopping';

export function statusForEvent(type: RunEvent['type']): Run['status'] {
  switch (type) {
    case 'run.queued':
      return 'queued';
    case 'run.stop_requested':
      return 'stopping';
    case 'run.completed':
      return 'completed';
    case 'run.cancelled':
      return 'cancelled';
    case 'run.failed':
      return 'failed';
    case 'run.interrupted':
      return 'interrupted';
    default:
      return 'running';
  }
}

/**
 * Adds one event. Duplicates (same run and sequence, e.g. after a replay) leave the log
 * unchanged and return the same reference; out-of-order arrivals are inserted by sequence.
 * The per-run list is bounded: output lines are dropped oldest-first, then the oldest event.
 */
export function addRunEvent(log: RunEventLog, event: RunEvent): RunEventLog {
  const current = log[event.runId] ?? [];
  if (current.some((existing) => existing.sequence === event.sequence)) return log;
  let next = [...current, event].sort((a, b) => a.sequence - b.sequence);
  while (next.length > MAX_EVENTS_PER_RUN) {
    const output = next.findIndex((entry) => entry.type === 'run.output');
    const drop = output >= 0 ? output : 0;
    next = next.filter((_, index) => index !== drop);
  }
  return { ...log, [event.runId]: next };
}

/** Drops history for runs that are no longer monitored so memory stays bounded. */
export function pruneRunEvents(log: RunEventLog, keep: ReadonlySet<string>): RunEventLog {
  const ids = Object.keys(log);
  if (ids.every((id) => keep.has(id))) return log;
  return Object.fromEntries(ids.filter((id) => keep.has(id)).map((id) => [id, log[id]!]));
}

/**
 * Runs the lane follows: unfinished runs first, then the most recent, never more than
 * MAX_STREAMS. The browser allows few concurrent connections per origin, so this is a bound,
 * not a global feed.
 */
export function selectMonitoredRuns(runs: Run[]): Run[] {
  return [...runs]
    .sort(
      (a, b) =>
        Number(isUnfinished(b.status)) - Number(isUnfinished(a.status)) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_STREAMS);
}

/**
 * Lifecycle nodes across runs, oldest first. Output lines are omitted from the lane (they stay
 * in the run inspector) so one chatty run cannot push the others out.
 */
export function buildMissionEvents(log: RunEventLog, runs: Run[]): MissionEvent[] {
  const titles = new Map(runs.map((run) => [run.id, run.taskTitle]));
  const nodes: MissionEvent[] = [];
  for (const [runId, events] of Object.entries(log)) {
    for (const event of events) {
      if (event.type === 'run.output') continue;
      nodes.push({
        id: `${runId}:${event.sequence}`,
        runId,
        sequence: event.sequence,
        at: event.at,
        type: event.type,
        status: statusForEvent(event.type),
        label: LABELS[event.type],
        message: event.message,
        taskTitle: titles.get(runId) ?? 'Run',
      });
    }
  }
  return nodes.sort(
    (a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId) || a.sequence - b.sequence,
  );
}

export type StreamHealth =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'ended' // finished normally after a terminal event; never a failure
  | 'failed' // an event broke the shared contract; the stream is no longer trusted
  | 'exhausted' // the reconnect budget ran out; only a user retry restarts it
  | 'suspended'; // closed on purpose while the tab is hidden

export type LaneStatus =
  | 'loading'
  | 'live' // every unfinished run has an open stream
  | 'partial' // some unfinished runs are live, others are not
  | 'reconnecting'
  | 'exhausted' // retry budget used up; history kept
  | 'disconnected' // the run list itself is unavailable; history kept
  | 'unavailable' // nothing could be loaded
  | 'paused' // tab hidden
  | 'history' // nothing unfinished, so no live stream is needed
  | 'empty';

export type StreamCounts = {
  unfinished: number;
  live: number;
  reconnecting: number;
  exhausted: number;
};

export function countStreams(runs: Run[], health: Record<string, StreamHealth>): StreamCounts {
  const counts: StreamCounts = { unfinished: 0, live: 0, reconnecting: 0, exhausted: 0 };
  for (const run of runs) {
    const h = health[run.id] ?? 'connecting';
    if (isUnfinished(run.status)) {
      counts.unfinished += 1;
      if (h === 'open') counts.live += 1;
    }
    if (h === 'reconnecting') counts.reconnecting += 1;
    if (h === 'exhausted' || h === 'failed') counts.exhausted += 1;
  }
  return counts;
}

/**
 * Aggregates every followed stream. "live" means all unfinished runs are receiving updates and
 * no followed stream is degraded; a finished run's stream ending normally is not a failure.
 * Loaded history stays visible in every state.
 */
export function deriveLaneStatus(input: {
  runs: Run[];
  health: Record<string, StreamHealth>;
  eventCount: number;
  paused: boolean;
}): LaneStatus {
  const { runs, health, eventCount, paused } = input;
  if (paused) return eventCount > 0 ? 'disconnected' : 'unavailable';
  if (runs.length === 0) return 'empty';
  const states = runs.map((run) => health[run.id] ?? 'connecting');
  if (states.every((h) => h === 'suspended' || h === 'ended')) {
    if (states.some((h) => h === 'suspended')) return 'paused';
  }
  const c = countStreams(runs, health);
  const degraded = c.reconnecting + c.exhausted;
  const connecting = runs.filter(
    (run) =>
      (health[run.id] ?? 'connecting') === 'connecting' ||
      ((health[run.id] ?? 'connecting') === 'open' && !isUnfinished(run.status)),
  ).length;
  if (c.unfinished > 0) {
    if (c.live === c.unfinished && degraded === 0) return 'live';
    if (c.live > 0) return 'partial';
  }
  if (c.reconnecting > 0) return 'reconnecting';
  if (c.exhausted > 0) return eventCount > 0 ? 'exhausted' : 'unavailable';
  if (connecting > 0) return 'loading';
  if (states.some((h) => h === 'suspended')) return 'paused';
  return c.unfinished > 0 ? 'loading' : eventCount > 0 ? 'history' : 'empty';
}

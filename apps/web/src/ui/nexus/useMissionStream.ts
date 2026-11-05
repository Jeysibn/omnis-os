import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RunEventSchema, type Run, type RunEvent } from '@omnis/contracts';
import {
  addRunEvent,
  isTerminalEvent,
  isUnfinished,
  pruneRunEvents,
  selectMonitoredRuns,
  type RunEventLog,
  type StreamHealth,
} from './missionEvents.js';

const EVENT_TYPES: RunEvent['type'][] = [
  'run.queued',
  'run.started',
  'run.output',
  'run.stop_requested',
  'run.completed',
  'run.cancelled',
  'run.failed',
  'run.interrupted',
];

/**
 * Reconnect budget, shared by browser-managed and application-managed reconnects.
 * A "failure" is any error event. The budget resets only on documented progress: a new,
 * validated event, or a connection that stayed open for STABLE_OPEN_MS continuously. Visibility
 * changes, followed-set changes, transport replacement and rerenders never reset it.
 * Exceeding MAX_FAILURES, or accumulating FAILURE_WINDOW_MS of disconnected time, closes the
 * stream for good until the user presses Refresh. Disconnected time is cumulative: time while a
 * transport is genuinely open, and time in a hidden tab, is not charged to the allowance.
 */
export const MAX_FAILURES = 4;
export const FAILURE_WINDOW_MS = 30_000;
export const STABLE_OPEN_MS = 10_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 8000;

/**
 * Per-run recovery state. It is owned by the hook, not by an EventSource: transports come and
 * go (hidden tab, eviction from the followed set, re-creation) and this record survives them.
 * Records are dropped only for runs that left the run list, or by an explicit user Refresh.
 */
type Recovery = {
  failures: number;
  downSince: number; // start of the active disconnected interval; 0 = not disconnected
  spentMs: number; // disconnected time accumulated by intervals that have ended
  openedAt: number; // when the current transport opened; 0 = not open
  maxSequence: number; // highest validated sequence; replays below it are not progress
  progressed: boolean;
  status: 'active' | 'exhausted' | 'failed';
};

/** The current transport only; replaced freely without touching Recovery. */
type Handle = {
  source: EventSource | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  health: StreamHealth;
};

const newRecovery = (): Recovery => ({
  failures: 0,
  downSince: 0,
  spentMs: 0,
  openedAt: 0,
  maxSequence: 0,
  progressed: false,
  status: 'active',
});

/** Closes the active disconnected interval (if any) into the accumulated total. */
const settle = (record: Recovery, now: number) => {
  if (record.downSince) record.spentMs += now - record.downSince;
  record.downSince = 0;
};

const newHandle = (health: StreamHealth): Handle => ({
  source: null,
  retryTimer: null,
  deadlineTimer: null,
  closed: false,
  health,
});

/**
 * Follows the per-run event stream (`/api/v1/runs/:id/events`) for a bounded set of runs.
 *
 * Continuity: the API honours `Last-Event-ID`, which the browser sends itself when it
 * reconnects a stream. A stream this hook re-creates cannot set that header, so it is replayed
 * from the first persisted event instead; every event is de-duplicated by (run, sequence), so
 * a replay can repeat events but never lose or duplicate them.
 *
 * There is no global stream: coverage is the monitored runs only. Streams are suspended while
 * the document is hidden and replayed when it is shown again.
 */
export function useMissionStream(
  runs: Run[],
  enabled: boolean,
  onRefreshRuns: () => void,
): {
  log: RunEventLog;
  health: Record<string, StreamHealth>;
  monitored: Run[];
  reconnect: () => void;
} {
  const [log, setLog] = useState<RunEventLog>({});
  const [health, setHealth] = useState<Record<string, StreamHealth>>({});
  const [nonce, setNonce] = useState(0);
  const [visible, setVisible] = useState(() => !document.hidden);
  const handles = useRef(new Map<string, Handle>());
  const recoveries = useRef(new Map<string, Recovery>());
  const runsRef = useRef(runs);
  const refreshRef = useRef(onRefreshRuns);
  const refreshedFor = useRef(new Set<string>());
  const seenNonce = useRef(0);

  useEffect(() => {
    runsRef.current = runs;
    refreshRef.current = onRefreshRuns;
  }, [runs, onRefreshRuns]);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const monitored = useMemo(() => (enabled ? selectMonitoredRuns(runs) : []), [runs, enabled]);
  const key = monitored.map((run) => run.id).join('|');

  const recoveryFor = useCallback((runId: string) => {
    let record = recoveries.current.get(runId);
    if (!record) recoveries.current.set(runId, (record = newRecovery()));
    return record;
  }, []);

  const setRunHealth = useCallback((runId: string, handle: Handle, value: StreamHealth) => {
    handle.health = value;
    setHealth((current) => (current[runId] === value ? current : { ...current, [runId]: value }));
  }, []);

  const stopTransport = useCallback((handle: Handle) => {
    if (handle.retryTimer) clearTimeout(handle.retryTimer);
    if (handle.deadlineTimer) clearTimeout(handle.deadlineTimer);
    handle.retryTimer = null;
    handle.deadlineTimer = null;
    handle.source?.close();
    handle.source = null;
  }, []);

  /**
   * Removes the transport only. The run's Recovery record is deliberately left alone, apart from
   * freezing the disconnected time already spent so a later return does not restart the window.
   */
  const close = useCallback(
    (runId: string) => {
      const handle = handles.current.get(runId);
      if (!handle) return;
      const record = recoveries.current.get(runId);
      if (record) {
        settle(record, Date.now());
        record.openedAt = 0;
      }
      handle.closed = true;
      stopTransport(handle);
      handles.current.delete(runId);
    },
    [stopTransport],
  );

  const exhaust = useCallback(
    (runId: string, handle: Handle) => {
      if (handle.closed || handle.health === 'exhausted') return;
      recoveryFor(runId).status = 'exhausted';
      stopTransport(handle);
      setRunHealth(runId, handle, 'exhausted');
      // Session expiry is not inferable from an EventSource error. A normal authenticated
      // request is what establishes it, so ask the owner's data loader to check once.
      if (!refreshedFor.current.has(`exhausted:${runId}`)) {
        refreshedFor.current.add(`exhausted:${runId}`);
        refreshRef.current();
      }
    },
    [recoveryFor, setRunHealth, stopTransport],
  );

  const armDeadline = useCallback(
    (runId: string, handle: Handle, now: number) => {
      const record = recoveryFor(runId);
      if (handle.deadlineTimer || !record.downSince) return;
      const remaining = FAILURE_WINDOW_MS - record.spentMs - (now - record.downSince);
      handle.deadlineTimer = setTimeout(() => exhaust(runId, handle), Math.max(0, remaining));
    },
    [exhaust, recoveryFor],
  );

  const open = useCallback(
    (runId: string, handle: Handle) => {
      if (handle.closed) return;
      const record = recoveryFor(runId);
      // An exhausted or untrusted run is never reconnected automatically.
      if (record.status !== 'active') {
        setRunHealth(runId, handle, record.status === 'failed' ? 'failed' : 'exhausted');
        return;
      }
      handle.retryTimer = null;
      const source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
      handle.source = source;
      const current = () => !handle.closed && handle.source === source; // retired transports are inert

      source.onopen = () => {
        if (!current()) return;
        if (handle.deadlineTimer) clearTimeout(handle.deadlineTimer);
        handle.deadlineTimer = null;
        const now = Date.now();
        settle(record, now); // connected time is not charged to the disconnected allowance
        record.openedAt = now;
        setRunHealth(runId, handle, 'open');
      };

      const onEvent = (name: RunEvent['type']) => (message: Event) => {
        if (!current()) return;
        try {
          const raw = message as MessageEvent<string>;
          const event = RunEventSchema.parse(JSON.parse(raw.data));
          if (
            event.runId !== runId ||
            event.type !== name ||
            raw.lastEventId !== String(event.sequence)
          ) {
            throw new Error('Event identity did not match its stream.');
          }
          if (event.sequence > record.maxSequence) {
            record.maxSequence = event.sequence; // duplicates and stale replays are not progress
            record.progressed = true;
          }
          setLog((existing) => addRunEvent(existing, event));
          if (isTerminalEvent(event.type)) {
            stopTransport(handle);
            record.failures = 0;
            record.downSince = 0;
            record.spentMs = 0;
            setRunHealth(runId, handle, 'ended');
            const snapshot = runsRef.current.find((run) => run.id === runId);
            if (snapshot && isUnfinished(snapshot.status) && !refreshedFor.current.has(runId)) {
              refreshedFor.current.add(runId);
              refreshRef.current();
            }
          }
        } catch {
          // An event that breaks the contract is not shown; stop trusting this stream.
          record.status = 'failed';
          stopTransport(handle);
          setRunHealth(runId, handle, 'failed');
        }
      };
      for (const name of EVENT_TYPES) source.addEventListener(name, onEvent(name));

      source.onerror = () => {
        if (!current()) return;
        if (['ended', 'failed', 'exhausted', 'suspended'].includes(handle.health)) return;
        const now = Date.now();
        const stable = record.openedAt > 0 && now - record.openedAt >= STABLE_OPEN_MS;
        if (record.progressed || stable) {
          record.failures = 0;
          record.downSince = 0;
          record.spentMs = 0;
        }
        record.progressed = false;
        record.openedAt = 0;
        record.failures += 1;
        if (!record.downSince) record.downSince = now;
        const spent = record.spentMs + (now - record.downSince);
        if (record.failures > MAX_FAILURES || spent >= FAILURE_WINDOW_MS) {
          exhaust(runId, handle);
          return;
        }
        setRunHealth(runId, handle, 'reconnecting');
        armDeadline(runId, handle, now);
        if (source.readyState === EventSource.CLOSED) {
          // The browser gave up (for example a non-200 response); recreate with backoff.
          source.close();
          handle.source = null;
          const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (record.failures - 1));
          handle.retryTimer = setTimeout(() => open(runId, handle), delay);
        }
        // Otherwise the browser is reconnecting on its own (with Last-Event-ID); the budget
        // above still bounds it.
      };
    },
    [armDeadline, exhaust, recoveryFor, setRunHealth, stopTransport],
  );

  /** Hidden tab: drop the transport but keep the budget; disconnected time stops counting. */
  const suspend = useCallback(
    (runId: string, handle: Handle) => {
      const record = recoveryFor(runId);
      settle(record, Date.now());
      record.openedAt = 0; // a stable open must be continuous
      stopTransport(handle);
      setRunHealth(runId, handle, 'suspended');
    },
    [recoveryFor, setRunHealth, stopTransport],
  );

  /** Shown again: a new transport, the same budget, the deadline continues where it stopped. */
  const resume = useCallback(
    (runId: string, handle: Handle) => {
      const record = recoveryFor(runId);
      if (record.status !== 'active') {
        setRunHealth(runId, handle, record.status === 'failed' ? 'failed' : 'exhausted');
        return;
      }
      const now = Date.now();
      // An unrecovered failure means the stream is still disconnected: charge from now.
      if (record.failures > 0 && !record.downSince) record.downSince = now;
      setRunHealth(runId, handle, record.failures > 0 ? 'reconnecting' : 'connecting');
      open(runId, handle);
      if (record.downSince) armDeadline(runId, handle, now);
    },
    [armDeadline, open, recoveryFor, setRunHealth],
  );

  useEffect(() => {
    const retried = nonce !== seenNonce.current;
    seenNonce.current = nonce;
    const wanted = new Set(key ? key.split('|') : []);
    if (retried) {
      // Explicit user Refresh is the only thing that clears an exhausted or partly spent budget.
      for (const [runId, record] of recoveries.current) {
        const handle = handles.current.get(runId);
        if (record.status !== 'active' && handle) close(runId);
        Object.assign(record, newRecovery(), { maxSequence: record.maxSequence });
        refreshedFor.current.delete(`exhausted:${runId}`);
      }
    }
    for (const runId of [...handles.current.keys()]) if (!wanted.has(runId)) close(runId);
    for (const runId of wanted) {
      if (handles.current.has(runId)) continue;
      const record = recoveryFor(runId);
      const hidden = document.hidden;
      const handle = newHandle(
        record.status === 'exhausted'
          ? 'exhausted'
          : record.status === 'failed'
            ? 'failed'
            : hidden
              ? 'suspended'
              : record.failures > 0
                ? 'reconnecting'
                : 'connecting',
      );
      handles.current.set(runId, handle);
      setRunHealth(runId, handle, handle.health);
      if (record.status !== 'active') continue; // stays closed until Refresh
      if (hidden) continue;
      const now = Date.now();
      if (record.failures > 0 && !record.downSince) record.downSince = now;
      open(runId, handle);
      if (record.downSince) armDeadline(runId, handle, now);
    }
    // Bound memory: forget recovery state only for runs that left the run list entirely.
    if (enabled) {
      const known = new Set(runsRef.current.map((run) => run.id));
      for (const runId of [...recoveries.current.keys()]) {
        if (!known.has(runId) && !handles.current.has(runId)) recoveries.current.delete(runId);
      }
      setLog((current) => pruneRunEvents(current, wanted));
      setHealth((current) =>
        Object.fromEntries(Object.entries(current).filter(([runId]) => wanted.has(runId))),
      );
    }
  }, [key, enabled, nonce, open, close, recoveryFor, armDeadline, setRunHealth]);

  // Hidden tabs hold no connections; showing the tab replays the persisted history.
  useEffect(() => {
    for (const [runId, handle] of handles.current) {
      if (!visible) {
        if (['connecting', 'open', 'reconnecting'].includes(handle.health)) suspend(runId, handle);
      } else if (handle.health === 'suspended') {
        resume(runId, handle);
      }
    }
  }, [visible, resume, suspend]);

  useEffect(() => {
    const active = handles.current;
    return () => {
      for (const runId of [...active.keys()]) close(runId);
    };
  }, [close]);

  const reconnect = useCallback(() => setNonce((value) => value + 1), []);
  return { log, health, monitored, reconnect };
}

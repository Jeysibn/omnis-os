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
 * A "failure" is any error event. The counter resets only after real progress: a new event
 * arrived or the connection stayed open for STABLE_OPEN_MS. Exceeding MAX_FAILURES, or staying
 * disconnected for FAILURE_WINDOW_MS after the first failure, closes the stream for good until
 * the user retries.
 */
export const MAX_FAILURES = 4;
export const FAILURE_WINDOW_MS = 30_000;
export const STABLE_OPEN_MS = 10_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 8000;

type Handle = {
  source: EventSource | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  failures: number;
  firstFailureAt: number;
  openedAt: number;
  maxSequence: number;
  progressed: boolean;
  closed: boolean;
  health: StreamHealth;
};

const newHandle = (health: StreamHealth): Handle => ({
  source: null,
  retryTimer: null,
  deadlineTimer: null,
  failures: 0,
  firstFailureAt: 0,
  openedAt: 0,
  maxSequence: 0,
  progressed: false,
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

  const close = useCallback(
    (runId: string) => {
      const handle = handles.current.get(runId);
      if (!handle) return;
      handle.closed = true;
      stopTransport(handle);
      handles.current.delete(runId);
    },
    [stopTransport],
  );

  const open = useCallback(
    (runId: string, handle: Handle) => {
      if (handle.closed) return;
      handle.retryTimer = null;
      const source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
      handle.source = source;

      const exhaust = () => {
        if (handle.closed || handle.health === 'exhausted') return;
        stopTransport(handle);
        setRunHealth(runId, handle, 'exhausted');
        // Session expiry is not inferable from an EventSource error. A normal authenticated
        // request is what establishes it, so ask the owner's data loader to check once.
        if (!refreshedFor.current.has(`exhausted:${runId}`)) {
          refreshedFor.current.add(`exhausted:${runId}`);
          refreshRef.current();
        }
      };

      source.onopen = () => {
        if (handle.closed || handle.source !== source) return;
        if (handle.deadlineTimer) clearTimeout(handle.deadlineTimer);
        handle.deadlineTimer = null;
        handle.openedAt = Date.now();
        setRunHealth(runId, handle, 'open');
      };

      const onEvent = (name: RunEvent['type']) => (message: Event) => {
        if (handle.closed || handle.source !== source) return;
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
          if (event.sequence > handle.maxSequence) {
            handle.maxSequence = event.sequence;
            handle.progressed = true;
          }
          setLog((current) => addRunEvent(current, event));
          if (isTerminalEvent(event.type)) {
            stopTransport(handle);
            setRunHealth(runId, handle, 'ended');
            const snapshot = runsRef.current.find((run) => run.id === runId);
            if (snapshot && isUnfinished(snapshot.status) && !refreshedFor.current.has(runId)) {
              refreshedFor.current.add(runId);
              refreshRef.current();
            }
          }
        } catch {
          // An event that breaks the contract is not shown; stop trusting this stream.
          stopTransport(handle);
          setRunHealth(runId, handle, 'failed');
        }
      };
      for (const name of EVENT_TYPES) source.addEventListener(name, onEvent(name));

      source.onerror = () => {
        if (handle.closed || handle.source !== source) return;
        if (['ended', 'failed', 'exhausted', 'suspended'].includes(handle.health)) return;
        const now = Date.now();
        const stable = handle.openedAt > 0 && now - handle.openedAt >= STABLE_OPEN_MS;
        if (handle.progressed || stable) {
          handle.failures = 0;
          handle.firstFailureAt = 0;
        }
        handle.progressed = false;
        handle.openedAt = 0;
        handle.failures += 1;
        if (!handle.firstFailureAt) handle.firstFailureAt = now;
        if (handle.failures > MAX_FAILURES || now - handle.firstFailureAt >= FAILURE_WINDOW_MS) {
          exhaust();
          return;
        }
        setRunHealth(runId, handle, 'reconnecting');
        if (!handle.deadlineTimer) {
          const remaining = FAILURE_WINDOW_MS - (now - handle.firstFailureAt);
          handle.deadlineTimer = setTimeout(exhaust, remaining);
        }
        if (source.readyState === EventSource.CLOSED) {
          // The browser gave up (for example a non-200 response); recreate with backoff.
          source.close();
          handle.source = null;
          const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (handle.failures - 1));
          handle.retryTimer = setTimeout(() => open(runId, handle), delay);
        }
        // Otherwise the browser is reconnecting on its own (with Last-Event-ID); the budget
        // above still bounds it.
      };
    },
    [setRunHealth, stopTransport],
  );

  const resume = useCallback(
    (runId: string, handle: Handle) => {
      stopTransport(handle);
      Object.assign(handle, newHandle('connecting'), {
        maxSequence: handle.maxSequence,
        source: null,
      });
      setRunHealth(runId, handle, 'connecting');
      open(runId, handle);
    },
    [open, setRunHealth, stopTransport],
  );

  useEffect(() => {
    const retried = nonce !== seenNonce.current;
    seenNonce.current = nonce;
    const wanted = new Set(key ? key.split('|') : []);
    for (const runId of [...handles.current.keys()]) {
      const handle = handles.current.get(runId)!;
      if (!wanted.has(runId)) close(runId);
      // Exhausted or failed streams are only ever restarted by an explicit user retry.
      else if (retried && (handle.health === 'exhausted' || handle.health === 'failed')) {
        refreshedFor.current.delete(`exhausted:${runId}`);
        close(runId);
      }
    }
    for (const runId of wanted) {
      if (handles.current.has(runId)) continue;
      const hidden = document.hidden;
      const handle = newHandle(hidden ? 'suspended' : 'connecting');
      handles.current.set(runId, handle);
      setRunHealth(runId, handle, handle.health);
      if (!hidden) open(runId, handle);
    }
    if (enabled) {
      setLog((current) => pruneRunEvents(current, wanted));
      setHealth((current) =>
        Object.fromEntries(Object.entries(current).filter(([runId]) => wanted.has(runId))),
      );
    }
  }, [key, enabled, nonce, open, close, setRunHealth]);

  // Hidden tabs hold no connections; showing the tab replays the persisted history.
  useEffect(() => {
    for (const [runId, handle] of handles.current) {
      if (!visible) {
        if (['connecting', 'open', 'reconnecting'].includes(handle.health)) {
          stopTransport(handle);
          setRunHealth(runId, handle, 'suspended');
        }
      } else if (handle.health === 'suspended') {
        resume(runId, handle);
      }
    }
  }, [visible, resume, setRunHealth, stopTransport]);

  useEffect(() => {
    const active = handles.current;
    return () => {
      for (const runId of [...active.keys()]) close(runId);
    };
  }, [close]);

  const reconnect = useCallback(() => setNonce((value) => value + 1), []);
  return { log, health, monitored, reconnect };
}

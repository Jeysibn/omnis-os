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
const MAX_MANUAL_RETRIES = 3;
const RETRY_BASE_MS = 1000;

type Handle = {
  source: EventSource | null;
  timer: ReturnType<typeof setTimeout> | null;
  retries: number;
  closed: boolean;
  health: StreamHealth;
};

/**
 * Follows the per-run event stream (`/api/v1/runs/:id/events`) for a bounded set of runs.
 * That endpoint replays the persisted history on connect and resumes from `Last-Event-ID`,
 * so history, live updates and reconnects all arrive through one path and are de-duplicated
 * by sequence. There is no global stream: coverage is the monitored runs only.
 */
export function useMissionStream(
  runs: Run[],
  enabled: boolean,
  onRunMoved: () => void,
): {
  log: RunEventLog;
  health: Record<string, StreamHealth>;
  monitored: Run[];
  reconnect: () => void;
} {
  const [log, setLog] = useState<RunEventLog>({});
  const [health, setHealth] = useState<Record<string, StreamHealth>>({});
  const [nonce, setNonce] = useState(0);
  const handles = useRef(new Map<string, Handle>());
  const runsRef = useRef(runs);
  const movedRef = useRef(onRunMoved);
  const notified = useRef(new Set<string>());

  useEffect(() => {
    runsRef.current = runs;
    movedRef.current = onRunMoved;
  }, [runs, onRunMoved]);

  const monitored = useMemo(() => (enabled ? selectMonitoredRuns(runs) : []), [runs, enabled]);
  const key = monitored.map((run) => run.id).join('|');

  const setRunHealth = useCallback((runId: string, value: StreamHealth) => {
    const handle = handles.current.get(runId);
    if (handle) handle.health = value;
    setHealth((current) => (current[runId] === value ? current : { ...current, [runId]: value }));
  }, []);

  const close = useCallback((runId: string) => {
    const handle = handles.current.get(runId);
    if (!handle) return;
    handle.closed = true;
    if (handle.timer) clearTimeout(handle.timer);
    handle.source?.close();
    handles.current.delete(runId);
  }, []);

  const open = useCallback(
    (runId: string, handle: Handle) => {
      if (handle.closed) return;
      const source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
      handle.source = source;
      source.onopen = () => {
        if (handle.closed) return;
        handle.retries = 0;
        setRunHealth(runId, 'open');
      };
      const onEvent = (name: RunEvent['type']) => (message: Event) => {
        if (handle.closed) return;
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
          setLog((current) => addRunEvent(current, event));
          if (isTerminalEvent(event.type)) {
            source.close();
            setRunHealth(runId, 'ended');
            const snapshot = runsRef.current.find((run) => run.id === runId);
            if (snapshot && isUnfinished(snapshot.status) && !notified.current.has(runId)) {
              notified.current.add(runId);
              movedRef.current();
            }
          }
        } catch {
          // An event that breaks the contract is not shown; stop trusting this stream.
          source.close();
          setRunHealth(runId, 'failed');
        }
      };
      for (const name of EVENT_TYPES) source.addEventListener(name, onEvent(name));
      source.onerror = () => {
        if (handle.closed || handle.health === 'ended' || handle.health === 'failed') return;
        if (source.readyState === EventSource.CONNECTING) {
          setRunHealth(runId, 'reconnecting'); // the browser resumes with Last-Event-ID
          return;
        }
        // The browser gave up (e.g. a non-200 response). Retry a few times, then stop.
        source.close();
        if (handle.retries >= MAX_MANUAL_RETRIES) {
          setRunHealth(runId, 'failed');
          return;
        }
        setRunHealth(runId, 'reconnecting');
        const delay = RETRY_BASE_MS * 2 ** handle.retries;
        handle.retries += 1;
        handle.timer = setTimeout(() => open(runId, handle), delay);
      };
    },
    [setRunHealth],
  );

  useEffect(() => {
    const wanted = new Set(key ? key.split('|') : []);
    for (const runId of [...handles.current.keys()]) {
      const handle = handles.current.get(runId)!;
      if (!wanted.has(runId) || (handle.health === 'failed' && nonce > 0)) close(runId);
    }
    for (const runId of wanted) {
      if (handles.current.has(runId)) continue;
      const handle: Handle = {
        source: null,
        timer: null,
        retries: 0,
        closed: false,
        health: 'connecting',
      };
      handles.current.set(runId, handle);
      setRunHealth(runId, 'connecting');
      open(runId, handle);
    }
    if (enabled) {
      setLog((current) => pruneRunEvents(current, wanted));
      setHealth((current) =>
        Object.fromEntries(Object.entries(current).filter(([runId]) => wanted.has(runId))),
      );
    }
  }, [key, enabled, nonce, open, close, setRunHealth]);

  useEffect(() => {
    const active = handles.current;
    return () => {
      for (const runId of [...active.keys()]) close(runId);
    };
  }, [close]);

  const reconnect = useCallback(() => setNonce((value) => value + 1), []);
  return { log, health, monitored, reconnect };
}

/**
 * Decides what to do when a Run event stream reports an error, within a retry budget that outlives
 * any single EventSource or React effect.
 *
 * Native EventSource cannot expose an HTTP status, so a stream error alone never tells the app
 * whether the network dropped or the owner session ended. This controller asks the authenticated
 * API instead (the injected `probe`) and acts only on a confirmed answer:
 *
 *   unauthorized  the existing session-expiry flow already ran inside the probe; stop here
 *   stale         the probe belongs to an older session or a disposed stream; ignore it entirely
 *   rejected      a non-401 refusal (for example 403): stop and let the owner retry deliberately
 *   unreachable   network or server trouble; retry the probe with bounded backoff, never sign out
 *   valid         the session is fine; if the browser closed the stream, recreate it (bounded)
 *
 * The budget (`RunStreamBudget`) is owned by the caller and keyed by session and Run, so a stream
 * recreated by this controller, or by an unrelated effect re-run, cannot get a fresh allowance.
 * It is replenished only by verified progress: an event not seen before, or a connection that
 * stays open for `STABLE_OPEN_MS`. Merely opening, or replaying known history, is not progress.
 * When it is spent the stream is closed explicitly (so the browser's native reconnect loop stops)
 * and `onExhausted` hands control to a deliberate, user-initiated retry.
 *
 * Every timer and in-flight probe is owned here so `dispose()` leaves nothing behind.
 */
export type SessionProbeResult = 'valid' | 'unauthorized' | 'unreachable' | 'rejected' | 'stale';

export type RunStreamBudget = {
  /** Stream errors since the last verified progress (native retries included). */
  failures: number;
  /** Streams recreated by the app since the last verified progress. */
  recreates: number;
  /** Consecutive unreachable session checks. */
  probeRetries: number;
  exhausted: boolean;
};

export const PROBE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const MAX_STREAM_FAILURES = 5;
export const MAX_STREAM_RECREATES = 3;
export const STABLE_OPEN_MS = 10_000;
const RECREATE_DELAY_MS = 1_000;

export const createRunStreamBudget = (): RunStreamBudget => ({
  failures: 0,
  recreates: 0,
  probeRetries: 0,
  exhausted: false,
});

/** Replenish the budget: verified progress, or an explicit owner retry. */
export function resetRunStreamBudget(budget: RunStreamBudget) {
  budget.failures = 0;
  budget.recreates = 0;
  budget.probeRetries = 0;
  budget.exhausted = false;
}

type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export function createRunStreamRecovery(input: {
  budget: RunStreamBudget;
  probe: (signal: AbortSignal) => Promise<SessionProbeResult>;
  recreate: () => void;
  /** The budget is spent or access was refused: close the stream and offer a deliberate retry. */
  onExhausted: () => void;
  timers?: Timers;
}) {
  const { budget } = input;
  const timers: Timers = input.timers ?? {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
  let disposed = false;
  let probing: AbortController | null = null;
  let retryTimer: unknown = null;
  let stableTimer: unknown = null;
  // Latest known state of the stream. An error that arrives while a probe is already pending is
  // not probed again, but it must still be remembered: a stream that was merely reconnecting when
  // the probe started may have been closed by the browser (rejected reconnect) before it returns.
  let streamIsClosed = false;

  function clearRetryTimer() {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }
  function clearStableTimer() {
    if (stableTimer !== null) timers.clearTimeout(stableTimer);
    stableTimer = null;
  }

  function exhaust() {
    if (budget.exhausted) return;
    budget.exhausted = true;
    clearRetryTimer();
    clearStableTimer();
    input.onExhausted();
  }

  async function runProbe() {
    const controller = new AbortController();
    probing = controller;
    let result: SessionProbeResult;
    try {
      result = await input.probe(controller.signal);
    } catch {
      result = 'unreachable';
    }
    if (probing === controller) probing = null;
    if (disposed || result === 'stale' || controller.signal.aborted) return;
    if (result === 'unauthorized' || budget.exhausted) return;
    if (result === 'rejected') return exhaust();
    if (result === 'unreachable') {
      const delay = PROBE_RETRY_DELAYS_MS[budget.probeRetries];
      if (delay === undefined) return exhaust();
      budget.probeRetries += 1;
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        if (!disposed && !budget.exhausted) void runProbe();
      }, delay);
      return;
    }
    budget.probeRetries = 0;
    if (streamIsClosed) {
      if (budget.recreates >= MAX_STREAM_RECREATES) return exhaust();
      budget.recreates += 1;
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        if (!disposed && !budget.exhausted) input.recreate();
      }, RECREATE_DELAY_MS * budget.recreates);
    }
  }

  return {
    /** The stream reported an error. `streamClosed` means the browser will not retry by itself. */
    streamError(streamClosed: boolean) {
      if (disposed || budget.exhausted) return;
      clearStableTimer();
      streamIsClosed = streamClosed;
      budget.failures += 1;
      // A session check is still worth making when the budget runs out: a confirmed 401 should
      // sign the owner out rather than merely pause the stream.
      if (probing === null && retryTimer === null) void runProbe();
      if (budget.failures >= MAX_STREAM_FAILURES) exhaust();
    },
    /** The connection opened. Opening alone is not progress; staying open is. */
    opened() {
      if (disposed || budget.exhausted) return;
      clearStableTimer();
      streamIsClosed = false;
      stableTimer = timers.setTimeout(() => {
        stableTimer = null;
        if (!disposed && !budget.exhausted) resetRunStreamBudget(budget);
      }, STABLE_OPEN_MS);
    },
    /** A validated event the client had not seen before arrived. Replays must not call this. */
    progress() {
      if (disposed || budget.exhausted) return;
      clearRetryTimer();
      streamIsClosed = false;
      resetRunStreamBudget(budget);
    },
    dispose() {
      disposed = true;
      clearRetryTimer();
      clearStableTimer();
      probing?.abort();
      probing = null;
    },
  };
}

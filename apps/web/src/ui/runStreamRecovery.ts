/**
 * Decides what to do when a Run event stream reports an error.
 *
 * Native EventSource cannot expose an HTTP status, so a stream error alone never tells the app
 * whether the network dropped or the owner session ended. This controller asks the authenticated
 * API instead (the injected `probe`) and acts only on a confirmed answer:
 *
 *   unauthorized  the existing session-expiry flow already ran inside the probe; stop here
 *   rejected      a non-401 refusal (for example 403); surfaced by the probe, never a sign-out
 *   unreachable   network or server trouble; retry the probe with bounded backoff, never sign out
 *   valid         the session is fine; if the browser gave up on the stream, recreate it (bounded)
 *
 * Everything is bounded and owned here so that `dispose()` leaves no timer or callback behind.
 */
export type SessionProbeResult = 'valid' | 'unauthorized' | 'unreachable' | 'rejected';

export const PROBE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const MAX_STREAM_RECREATES = 3;
const RECREATE_DELAY_MS = 1_000;

type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export function createRunStreamRecovery(input: {
  probe: () => Promise<SessionProbeResult>;
  recreate: () => void;
  timers?: Timers;
}) {
  const timers: Timers = input.timers ?? {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
  let disposed = false;
  let probing = false;
  let timer: unknown = null;
  let retries = 0;
  let recreates = 0;
  // Errors the browser retries by itself (CONNECTING) are probed a bounded number of times.
  let transientProbes = 0;
  // Latest known state of the stream. An error that arrives while a probe is already pending is
  // not probed again, but it must still be remembered: a stream that was merely reconnecting when
  // the probe started may have been closed by the browser (rejected reconnect) before it returns.
  let streamIsClosed = false;

  function clearTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  async function runProbe() {
    probing = true;
    let result: SessionProbeResult;
    try {
      result = await input.probe();
    } catch {
      result = 'unreachable';
    }
    probing = false;
    if (disposed) return;
    if (result === 'unreachable') {
      const delay = PROBE_RETRY_DELAYS_MS[retries];
      if (delay === undefined) return;
      retries += 1;
      timer = timers.setTimeout(() => {
        timer = null;
        void runProbe();
      }, delay);
      return;
    }
    retries = 0;
    if (result === 'valid' && streamIsClosed && recreates < MAX_STREAM_RECREATES) {
      recreates += 1;
      timer = timers.setTimeout(() => {
        timer = null;
        if (!disposed) input.recreate();
      }, RECREATE_DELAY_MS * recreates);
    }
  }

  return {
    /** The stream reported an error. `streamClosed` means the browser will not retry by itself. */
    streamError(streamClosed: boolean) {
      if (disposed) return;
      streamIsClosed = streamClosed;
      if (probing || timer !== null) return;
      if (!streamClosed) {
        if (transientProbes >= PROBE_RETRY_DELAYS_MS.length + 1) return;
        transientProbes += 1;
      }
      void runProbe();
    },
    /** The stream opened or delivered a validated event: the connection is healthy again. */
    progress() {
      if (disposed) return;
      clearTimer();
      streamIsClosed = false;
      retries = 0;
      recreates = 0;
      transientProbes = 0;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

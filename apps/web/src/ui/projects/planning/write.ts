import { useCallback, useEffect, useRef, useState } from 'react';
import { classifyMutationFailure } from '../data.js';
import { IdempotentIntent } from '../intent.js';

export type WriteOutcome<T> =
  | { kind: 'saved'; value: T }
  | { kind: 'rejected'; status: 403 | 404 | 409 | 422 | 503; code: string; message: string }
  /** No verified result. The change may or may not have been applied. */
  | { kind: 'unknown' }
  /** The session ended; the shell has already handled it. */
  | { kind: 'unauthorized' }
  /** Another write from this control is still running; nothing was sent. */
  | { kind: 'busy' };

type Input = {
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
};

/**
 * One owner write at a time per control, with idempotency handled correctly:
 *
 *  - a new request gets a new Idempotency-Key;
 *  - the same request sent again after an unknown outcome reuses its key, so the server replays the
 *    stored result instead of applying the change twice;
 *  - a confirmed or definitively rejected request ends the intent.
 *
 * Only a valid error envelope with a definitive status is a rejection. Network loss, 5xx and a body
 * that cannot be verified leave the outcome unknown.
 */
export function useWriter({ csrfToken, refreshCsrf, onUnauthorized }: Input) {
  const [busy, setBusy] = useState(false);
  const intent = useRef(new IdempotentIntent());
  const inflight = useRef(false);
  const csrf = useRef(csrfToken);
  csrf.current = csrfToken;
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const refresh = useRef(refreshCsrf);
  refresh.current = refreshCsrf;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async <T>(
      signature: string,
      send: (key: string, csrfToken: string) => Promise<T>,
      /**
       * A key owned by the caller, used as is. A create keeps its key in storage so that it
       * survives a reload; this writer must then neither generate nor retire it.
       */
      options: { key?: string } = {},
    ): Promise<WriteOutcome<T>> => {
      if (inflight.current) return { kind: 'busy' };
      inflight.current = true;
      setBusy(true);
      const owned = options.key !== undefined;
      const key = options.key ?? intent.current.keyFor(signature);
      const settle = () => {
        if (!owned) intent.current.settle();
      };
      try {
        const value = await send(key, csrf.current);
        settle();
        return { kind: 'saved', value };
      } catch (cause) {
        const failure = classifyMutationFailure(cause);
        if (failure.evidence === 'unauthorized') {
          settle();
          unauthorized.current(cause);
          return { kind: 'unauthorized' };
        }
        if (failure.evidence === 'unknown') {
          if (!owned) intent.current.markUncertain();
          return { kind: 'unknown' };
        }
        settle();
        if (failure.status === 403) {
          try {
            csrf.current = await refresh.current();
          } catch {
            // The message still asks the owner to try again.
          }
        }
        const message = cause instanceof Error ? cause.message : '';
        return { kind: 'rejected', status: failure.status, code: failure.code, message };
      } finally {
        inflight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );

  /** End the current intent, for example when the owner abandons an unknown outcome. */
  const settle = useCallback(() => intent.current.settle(), []);
  return { busy, run, settle };
}

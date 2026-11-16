import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/runtime-capabilities';
import { request } from './api.js';
import { captureSession } from './sessionScope.js';

/**
 * What the backend currently reports about the Authorizer that owner result acceptance depends on.
 * `unavailable` only adds an advisory note: it is a health reading, not a statement about the accept
 * route (outside the restricted profile it comes from a separate probe), so it never blocks anything.
 * `available` and `unknown` (not yet loaded or the read failed) change nothing.
 */
export type AcceptanceAvailability = 'available' | 'unavailable' | 'unknown';

/**
 * Reads `authorization.availability` from `omnis.runtime-capabilities.v3`, which the API computes
 * with a health request through the Authorizer client that result acceptance also uses (it is
 * hard-wired unavailable in the restricted profile). Advice only; the accept route still decides. It
 * deliberately keeps its own state and never touches the Tasks page's execution gate. `scope` (the
 * selected run) re-reads when the owner moves to another completed run.
 */
export function useAcceptanceAvailability(
  enabled: boolean,
  onSessionExpired: (cause: unknown) => boolean,
  sessionGeneration: { readonly current: number },
  scope: string | null = null,
) {
  const [availability, setAvailability] = useState<AcceptanceAvailability>('unknown');
  const seq = useRef(0);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;

  const check = useCallback(async () => {
    const mine = (seq.current += 1);
    const live = captureSession(sessionGeneration);
    const current = () => mine === seq.current && live();
    try {
      const value = await request('/api/v1/runtime-capabilities', {}, (raw) =>
        RuntimeCapabilitiesSchema.parse(raw),
      );
      // A newer check, a replaced session or leaving the page: this answer is ignored.
      if (!current()) return;
      setAvailability(value.authorization.availability);
    } catch (cause) {
      if (!current()) return;
      if (expired.current(cause)) {
        seq.current += 1;
        setAvailability('unknown');
        return;
      }
      setAvailability('unknown'); // a failed read claims nothing
    }
  }, [sessionGeneration]);

  useEffect(() => {
    if (!enabled) {
      seq.current += 1;
      setAvailability('unknown');
      return;
    }
    void check();
    return () => {
      seq.current += 1;
    };
  }, [enabled, check, scope]);

  return { availability, recheck: check };
}

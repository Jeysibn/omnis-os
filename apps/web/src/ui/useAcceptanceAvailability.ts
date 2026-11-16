import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/runtime-capabilities';
import { request } from './api.js';
import { captureSession } from './sessionScope.js';

/**
 * What the backend currently reports about the Authorizer that owner result acceptance depends on.
 * `unavailable` is the only value that changes the UI: `available` and `unknown` (not yet loaded or
 * the read failed) leave the control as it is and the backend stays the authority.
 */
export type AcceptanceAvailability = 'available' | 'unavailable' | 'unknown';

/**
 * Reads `authorization.availability` from `omnis.runtime-capabilities.v3`, which the API computes
 * with the same Authorizer request that result acceptance uses (it is hard-wired unavailable in the
 * restricted profile). This is a UX hint only; the accept route still decides. It deliberately keeps
 * its own state and never touches the Tasks page's execution gate.
 */
export function useAcceptanceAvailability(
  enabled: boolean,
  onSessionExpired: (cause: unknown) => boolean,
  sessionGeneration: { readonly current: number },
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
  }, [enabled, check]);

  return { availability, recheck: check };
}

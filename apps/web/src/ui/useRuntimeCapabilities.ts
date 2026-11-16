import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/runtime-capabilities';
import { request } from './api.js';
import type { CapabilityCheck, CapabilityLoad } from './executionCapability.js';

/**
 * Loads the authenticated runtime-capabilities contract. `refresh` returns an explicit
 * CapabilityCheck so callers can re-check right before an execution-triggering step.
 *
 * A request is valid only while it is both the newest request AND still belongs to the owner
 * session it started in (`sessionGeneration`, rotated on sign-in, sign-out and expiry). Validity
 * is established before anything else, including HTTP 401 handling, so a stale 401 can never
 * expire a newer request's or a replacement session's state.
 */
export function useRuntimeCapabilities(
  enabled: boolean,
  onSessionExpired: (cause: unknown) => boolean,
  sessionGeneration: { readonly current: number },
) {
  const [load, setLoad] = useState<CapabilityLoad>({ status: 'loading' });
  const generation = useRef(0);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  const refreshRef = useRef<() => Promise<CapabilityCheck>>(() =>
    Promise.resolve({ status: 'failed' }),
  );
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refresh = useCallback(async (): Promise<CapabilityCheck> => {
    // One counter per App-owned hook instance; every consumer receives this same `refresh` by
    // prop, so dashboard, banner and connector refreshes all order against each other here.
    const mine = ++generation.current;
    const session = sessionGeneration.current;
    const valid = () => mine === generation.current && session === sessionGeneration.current;
    // Invalidated only by a session rotation (no newer request exists): the owner session this
    // request used was replaced while the hook is still active (e.g. StrictMode's second boot).
    // Fail this caller closed, but re-read under the current session so state cannot stay stuck.
    const supersede = (): CapabilityCheck => {
      if (mine === generation.current && enabledRef.current) void refreshRef.current();
      return { status: 'superseded' };
    };
    try {
      const value = await request('/api/v1/runtime-capabilities', {}, (raw) =>
        RuntimeCapabilitiesSchema.parse(raw),
      );
      // A newer request, session expiry or unmount invalidated this one: it neither updates state
      // nor may authorize the caller, even if it says "available".
      if (!valid()) return supersede();
      setLoad({ status: 'ready', capabilities: value });
      return { status: 'current', capabilities: value };
    } catch (cause) {
      // Validity first: a superseded or old-session failure (including 401) has no side effects.
      if (!valid()) return supersede();
      if (expired.current(cause)) {
        generation.current++;
        setLoad({ status: 'loading' });
        return { status: 'expired' };
      }
      setLoad({
        status: 'error',
        message: 'Execution capability could not be loaded from Omnis OS.',
      });
      return { status: 'failed' };
    }
  }, [sessionGeneration]);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) {
      generation.current++;
      setLoad({ status: 'loading' });
      return;
    }
    void refresh();
    return () => {
      // Unmount, sign-out or leaving the Tasks page invalidates any in-flight check.
      generation.current++;
    };
  }, [enabled, refresh]);

  return { load, refresh };
}

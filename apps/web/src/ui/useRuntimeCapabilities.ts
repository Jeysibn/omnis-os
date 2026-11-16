import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/runtime-capabilities';
import { request } from './api.js';
import type { CapabilityCheck, CapabilityLoad } from './executionCapability.js';

/**
 * Loads the authenticated runtime-capabilities contract. `refresh` returns the freshly validated
 * value (or null) so callers can re-check right before an execution-triggering step.
 */
export function useRuntimeCapabilities(
  enabled: boolean,
  onSessionExpired: (cause: unknown) => boolean,
) {
  const [load, setLoad] = useState<CapabilityLoad>({ status: 'loading' });
  const generation = useRef(0);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;

  const refresh = useCallback(async (): Promise<CapabilityCheck> => {
    // One counter per App-owned hook instance; every consumer receives this same `refresh` by
    // prop, so dashboard, banner and connector refreshes all order against each other here.
    const mine = ++generation.current;
    try {
      const value = await request('/api/v1/runtime-capabilities', {}, (raw) =>
        RuntimeCapabilitiesSchema.parse(raw),
      );
      // A newer request, session expiry or unmount invalidated this one: it neither updates state
      // nor may authorize the caller, even if it says "available".
      if (mine !== generation.current) return { status: 'superseded' };
      setLoad({ status: 'ready', capabilities: value });
      return { status: 'current', capabilities: value };
    } catch (cause) {
      if (expired.current(cause)) {
        generation.current++;
        setLoad({ status: 'loading' });
        return { status: 'expired' };
      }
      if (mine !== generation.current) return { status: 'superseded' };
      setLoad({
        status: 'error',
        message: 'Execution capability could not be loaded from Omnis OS.',
      });
      return { status: 'failed' };
    }
  }, []);

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

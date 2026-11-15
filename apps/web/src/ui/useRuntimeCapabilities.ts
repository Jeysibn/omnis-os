import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RuntimeCapabilitiesSchema,
  type RuntimeCapabilities,
} from '@omnis/contracts/runtime-capabilities';
import { request } from './api.js';
import type { CapabilityLoad } from './executionCapability.js';

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

  const refresh = useCallback(async (): Promise<RuntimeCapabilities | null> => {
    const mine = ++generation.current;
    try {
      const value = await request('/api/v1/runtime-capabilities', {}, (raw) =>
        RuntimeCapabilitiesSchema.parse(raw),
      );
      if (mine === generation.current) setLoad({ status: 'ready', capabilities: value });
      return value;
    } catch (cause) {
      if (expired.current(cause)) {
        generation.current++;
        setLoad({ status: 'loading' });
        return null;
      }
      if (mine === generation.current)
        setLoad({
          status: 'error',
          message: 'Execution capability could not be loaded from Omnis OS.',
        });
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      generation.current++;
      setLoad({ status: 'loading' });
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { load, refresh };
}

import { createContext, useContext, useEffect, useState } from 'react';
import type { SessionScope } from './sessionScope.js';

/**
 * Lets deeply nested owner writers capture the owner session when a request is dispatched without
 * threading a prop through every workspace. Outside the app (no provider) every scope is live.
 */
export const SessionScopeContext = createContext<(() => SessionScope) | null>(null);

const alwaysLive: SessionScope = () => true;
const standalone = () => alwaysLive;

export const useBeginSession = (): (() => SessionScope) =>
  useContext(SessionScopeContext) ?? standalone;

/**
 * A `mounted`-style ref that is true only while the component is mounted AND the owner session it
 * mounted under is still live. Unmounting alone is not a session gate: React's cleanup runs after
 * the session generation has already rotated, and a continuation can run in between. Read
 * `.current` after every await, exactly like a plain mounted ref.
 */
export function useMountedInSession(): { readonly current: boolean } {
  const beginSession = useBeginSession();
  const [state] = useState(() => ({ mounted: true, live: beginSession() }));
  useEffect(() => {
    state.mounted = true;
    return () => {
      state.mounted = false;
    };
  }, [state]);
  const [view] = useState(() => ({
    get current() {
      return state.mounted && state.live();
    },
  }));
  return view;
}

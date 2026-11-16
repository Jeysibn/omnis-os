import { createContext, useContext } from 'react';
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

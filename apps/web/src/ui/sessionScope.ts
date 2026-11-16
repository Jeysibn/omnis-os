/**
 * Owner-session validity for asynchronous work.
 *
 * `generation` is App's session counter, bumped synchronously by `rotateSession` on sign-in,
 * sign-out, expiry and boot. Capturing it when a request is dispatched and re-checking it when the
 * request settles lets every completion path (success, error, finally) tell whether its answer
 * belongs to the session that is on screen now, with no post-render effect in between.
 */
export type SessionScope = () => boolean;

export function captureSession(generation: { readonly current: number }): SessionScope {
  const captured = generation.current;
  return () => captured === generation.current;
}

/**
 * Wraps the global session-expiry handler so a handler bound to an old session is inert: a late
 * 401 (or any error) from a previous owner session reports "handled" without any side effect and
 * can never expire the session that replaced it.
 */
export function bindExpiryToSession(
  generation: { readonly current: number },
  expire: (cause: unknown) => boolean,
): (cause: unknown) => boolean {
  const live = captureSession(generation);
  return (cause) => (live() ? expire(cause) : true);
}

/** Thrown by session-scoped helpers whose answer belongs to a replaced owner session. */
export class StaleSessionError extends Error {
  constructor() {
    super('This response belonged to an earlier owner session and was ignored.');
    this.name = 'StaleSessionError';
  }
}

export const isStaleSession = (cause: unknown): cause is StaleSessionError =>
  cause instanceof StaleSessionError;

/**
 * Wraps a parent callback so a child holding a closure from an old session cannot push that
 * session's result into the replacement session's state.
 */
export function bindToSession<Args extends unknown[]>(
  generation: { readonly current: number },
  callback: (...args: Args) => void,
): (...args: Args) => void {
  const live = captureSession(generation);
  return (...args) => {
    if (live()) callback(...args);
  };
}

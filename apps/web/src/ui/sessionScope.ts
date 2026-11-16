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

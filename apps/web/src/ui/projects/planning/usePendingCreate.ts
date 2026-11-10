import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  browserStorage,
  readPending,
  removePending,
  storageWritable,
  writePending,
  type PendingEnvelope,
  type Scope,
  type UnsafeReason,
} from './pendingCreate.js';

/**
 * The pending create for one owner, project and record type, backed by sessionStorage.
 *
 * `storage` says whether a recovery record can be kept at all. `state` is what is pending:
 *  - none: nothing is pending and a create may start (only when storage is writable);
 *  - pending: a request whose outcome is unknown, with `caution: 'refused'` once a retry of it was
 *    refused (that caution is not persisted: a reload returns to plain unknown, which is safe);
 *  - blocked: something is stored for this scope that cannot be used safely. Its contents are
 *    never exposed, and creation stays locked until the owner explicitly discards it.
 */
export type PendingState =
  | { status: 'none' }
  | { status: 'pending'; envelope: PendingEnvelope; caution: 'refused' | null }
  | { status: 'blocked'; reason: UnsafeReason };

export type PendingCreateApi = {
  storage: 'ok' | 'unavailable';
  state: PendingState;
  /** Persists the request BEFORE it is sent. False: it could not be kept, so do not send it. */
  begin: (envelope: PendingEnvelope) => boolean;
  /** A confirmed answer or a refusal of the first attempt: the request is settled. */
  clear: () => boolean;
  /** Notes that a retry was refused. The request stays pending. */
  markRefused: () => void;
  /** The owner chose to discard an unresolved request. Returns whether it is verifiably gone. */
  discard: () => boolean;
  /** Reads storage again (for example after storage became available). */
  recheck: () => void;
};

function load(scope: Scope): { storage: 'ok' | 'unavailable'; state: PendingState } {
  const storage = browserStorage();
  const read = readPending(storage, scope, Date.now());
  if (read.status === 'blocked' && read.reason === 'storage-unavailable')
    return { storage: 'unavailable', state: { status: 'none' } };
  const writable = storageWritable(storage);
  const state: PendingState =
    read.status === 'found'
      ? { status: 'pending', envelope: read.envelope, caution: null }
      : read.status === 'blocked'
        ? { status: 'blocked', reason: read.reason }
        : { status: 'none' };
  return { storage: writable ? 'ok' : 'unavailable', state };
}

export function usePendingCreate(scope: Scope): PendingCreateApi {
  const { ownerId, projectId, kind } = scope;
  const stable = useMemo(() => ({ ownerId, projectId, kind }), [ownerId, projectId, kind]);
  const [loaded, setLoaded] = useState(() => load(stable));

  // A different owner, project or record type is a different pending request: read it afresh, so
  // one owner's request is never carried into another's screen.
  useEffect(() => setLoaded(load(stable)), [stable]);

  const begin = useCallback((envelope: PendingEnvelope) => {
    if (!writePending(browserStorage(), envelope)) {
      setLoaded((current) => ({ ...current, storage: 'unavailable' }));
      return false;
    }
    setLoaded({ storage: 'ok', state: { status: 'pending', envelope, caution: null } });
    return true;
  }, []);

  const clear = useCallback(() => {
    const gone = removePending(browserStorage(), stable);
    // If it could not be removed, the record stays pending in memory and on disk: a later check or
    // replay settles it. It is never reported as cleared when it is not.
    if (gone) setLoaded((current) => ({ ...current, state: { status: 'none' } }));
    return gone;
  }, [stable]);

  const markRefused = useCallback(
    () =>
      setLoaded((current) =>
        current.state.status === 'pending'
          ? { ...current, state: { ...current.state, caution: 'refused' } }
          : current,
      ),
    [],
  );

  const recheck = useCallback(() => setLoaded(load(stable)), [stable]);

  return {
    storage: loaded.storage,
    state: loaded.state,
    begin,
    clear,
    markRefused,
    discard: clear,
    recheck,
  };
}

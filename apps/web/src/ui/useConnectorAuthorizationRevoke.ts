import { useCallback, useRef, useState } from 'react';
import {
  ConnectorAuthorizationSchema,
  type ConnectorAuthorization,
} from '@omnis/contracts/connector-authorization-schema';
import { ApiRequestError, request } from './api.js';
import { canRevokeAuthorization } from './SyntheticOperationDialog.js';

const sameOperation = (a: ConnectorAuthorization, b: ConnectorAuthorization) =>
  a.id === b.id && a.requestId === b.requestId && a.promptDigest === b.promptDigest;

/**
 * Why the approval's real state is not known. Both kinds fail closed: the authorization held by
 * the UI may be stale, so Start (and a second Revoke) stay unavailable until a status read succeeds.
 *
 *  - `unknown-outcome`: the revoke request may or may not have been applied (network loss, 5xx,
 *    or a body that could not be verified).
 *  - `rejected-unverified`: the backend definitively refused the request, but a refusal does not
 *    say what the approval's state is (it may have expired or been consumed meanwhile).
 */
export type RevokeUnresolved = 'none' | 'unknown-outcome' | 'rejected-unverified';

/**
 * Owner revocation of an UNUSED synthetic approval via POST /api/v1/connector-authorizations/:id/revoke.
 *
 * Success is claimed only when the response is a schema-valid, same-operation authorization whose
 * status is `revoked`. The state is `none` only after an authoritative response (the revoke itself
 * or a later status read). Revoking an approval is not a Run stop or cancellation and never claims
 * to be.
 */
export function useConnectorAuthorizationRevoke(input: {
  authorization: ConnectorAuthorization | null;
  csrfToken: string;
  /** Another owner action is running; revocation must not overlap it. */
  blocked: boolean;
  onSessionExpired: (cause: unknown) => boolean;
  onAuthorization: (value: ConnectorAuthorization) => void;
}) {
  const { authorization, csrfToken, blocked, onSessionExpired, onAuthorization } = input;
  const [pending, setPending] = useState(false);
  const [unresolvedKind, setUnresolvedKind] = useState<RevokeUnresolved>('none');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // A ref, not state: two clicks in the same tick must not both pass the guard.
  const inFlight = useRef(false);
  // What the backend said when it refused the last revoke, kept for the status re-check message.
  const rejection = useRef('');

  const readCurrent = useCallback(async (target: ConnectorAuthorization) => {
    return request(
      `/api/v1/connector-authorizations/${encodeURIComponent(target.id)}`,
      {},
      (value) => {
        const current = ConnectorAuthorizationSchema.parse(value);
        if (!sameOperation(current, target)) {
          throw new Error('The authorization did not match the reviewed operation.');
        }
        return current;
      },
    );
  }, []);

  /** Re-read the authorization; only a successful read clears an unresolved state. */
  const recheck = useCallback(
    async (target: ConnectorAuthorization, kind: Exclude<RevokeUnresolved, 'none'>) => {
      try {
        const current = await readCurrent(target);
        onAuthorization(current);
        setUnresolvedKind('none');
        const stillActive = current.status === 'authorized' && current.consumedAt === null;
        if (current.status === 'revoked') {
          setError('');
          setNotice('Approval confirmed revoked. It can no longer be used.');
        } else if (kind === 'rejected-unverified') {
          setError(
            stillActive
              ? `The approval was not revoked. ${rejection.current} It is still active.`
              : `The approval was not revoked. ${rejection.current} Its status is now ${current.status}.`,
          );
        } else {
          setError(
            stillActive
              ? 'The revocation did not take effect. This approval is still active.'
              : `The revocation was not confirmed. The approval is now ${current.status}.`,
          );
        }
      } catch (cause) {
        if (onSessionExpired(cause)) return;
        setUnresolvedKind(kind); // still unknown: stay closed
        setError(
          kind === 'rejected-unverified'
            ? `Omnis OS rejected the revoke request, but this approval's current status could not be confirmed. ${rejection.current} Do not rely on the approval shown; check approval status before taking another action.`
            : 'The revoke result is unknown and its status could not be re-checked. Do not assume the approval was revoked. Check approval status again before taking another action.',
        );
      }
    },
    [onAuthorization, onSessionExpired, readCurrent],
  );

  const revoke = useCallback(async () => {
    const target = authorization;
    if (!target || inFlight.current || blocked || !canRevokeAuthorization(target)) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const revoked = await request(
        `/api/v1/connector-authorizations/${encodeURIComponent(target.id)}/revoke`,
        { method: 'POST', headers: { 'x-omnis-csrf': csrfToken } },
        (value) => {
          const result = ConnectorAuthorizationSchema.parse(value);
          if (
            !sameOperation(result, target) ||
            result.status !== 'revoked' ||
            result.revokedBy !== 'owner' ||
            result.revokedAt === null
          ) {
            throw new Error('The response did not confirm this approval was revoked.');
          }
          return result;
        },
      );
      setUnresolvedKind('none');
      onAuthorization(revoked);
      setNotice('Approval revoked. It can no longer be used, and no Run was started from it.');
    } catch (cause) {
      if (onSessionExpired(cause)) return;
      const rejected = cause instanceof ApiRequestError && cause.outcome === 'rejected';
      rejection.current = rejected ? cause.message : '';
      // Fail closed BEFORE the status read: whatever it returns (or fails to), the authorization
      // held by the UI can no longer be trusted until a read succeeds.
      const kind = rejected ? 'rejected-unverified' : 'unknown-outcome';
      setUnresolvedKind(kind);
      setError(
        rejected
          ? `Omnis OS rejected the revoke request. ${cause.message} Re-checking the approval's status…`
          : 'The revoke result is unknown. Omnis OS has not confirmed that this approval was revoked, so it is still treated as active. Re-checking its status…',
      );
      await recheck(target, kind);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [authorization, blocked, csrfToken, onAuthorization, onSessionExpired, recheck]);

  const refreshStatus = useCallback(async () => {
    const target = authorization;
    if (!target || inFlight.current || blocked || unresolvedKind === 'none') return;
    inFlight.current = true;
    setPending(true);
    try {
      await recheck(target, unresolvedKind);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [authorization, blocked, recheck, unresolvedKind]);

  const clearMessages = useCallback(() => {
    setError('');
    setNotice('');
  }, []);

  return {
    pending,
    unresolved: unresolvedKind !== 'none',
    unresolvedKind,
    error,
    notice,
    revoke,
    refreshStatus,
    clearMessages,
  };
}

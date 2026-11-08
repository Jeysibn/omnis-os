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
 * Owner revocation of an UNUSED synthetic approval via POST /api/v1/connector-authorizations/:id/revoke.
 *
 * Success is claimed only when the response is a schema-valid, same-operation authorization whose
 * status is `revoked`. Anything else (network loss, 5xx, an unverifiable body) is reported as an
 * unresolved outcome and blocks further actions until the authorization has been re-read.
 * Revoking an approval is not a Run stop or cancellation and never claims to be.
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
  const [unresolved, setUnresolved] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // A ref, not state: two clicks in the same tick must not both pass the guard.
  const inFlight = useRef(false);

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

  const recheck = useCallback(
    async (target: ConnectorAuthorization, afterUncertainRevoke: boolean) => {
      try {
        const current = await readCurrent(target);
        onAuthorization(current);
        setUnresolved(false);
        if (current.status === 'revoked') {
          setError('');
          setNotice('Approval confirmed revoked. It can no longer be used.');
        } else if (afterUncertainRevoke) {
          setError(
            current.status === 'authorized' && current.consumedAt === null
              ? 'The revocation did not take effect. This approval is still active.'
              : `The revocation was not confirmed. The approval is now ${current.status}.`,
          );
        }
      } catch (cause) {
        if (onSessionExpired(cause)) return;
        if (afterUncertainRevoke) {
          setUnresolved(true);
          setError(
            'The revoke result is unknown and its status could not be re-checked. Do not assume the approval was revoked. Check approval status again before taking another action.',
          );
        }
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
      setUnresolved(false);
      onAuthorization(revoked);
      setNotice('Approval revoked. It can no longer be used, and no Run was started from it.');
    } catch (cause) {
      if (onSessionExpired(cause)) return;
      const rejected = cause instanceof ApiRequestError && cause.outcome === 'rejected';
      if (rejected) {
        setUnresolved(false);
        setError(`The approval was not revoked. ${cause.message}`);
      } else {
        setUnresolved(true);
        setError(
          'The revoke result is unknown. Omnis OS has not confirmed that this approval was revoked, so it is still treated as active. Re-checking its status…',
        );
      }
      await recheck(target, !rejected);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [authorization, blocked, csrfToken, onAuthorization, onSessionExpired, recheck]);

  const refreshStatus = useCallback(async () => {
    const target = authorization;
    if (!target || inFlight.current || blocked) return;
    inFlight.current = true;
    setPending(true);
    try {
      await recheck(target, true);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [authorization, blocked, recheck]);

  const clearMessages = useCallback(() => {
    setError('');
    setNotice('');
  }, []);

  return { pending, unresolved, error, notice, revoke, refreshStatus, clearMessages };
}

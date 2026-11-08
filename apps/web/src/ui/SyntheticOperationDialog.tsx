import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ConnectorAuthorization } from '@omnis/contracts/connector-authorization-schema';
import { formatManilaWithZone } from './manilaTime.js';

/**
 * Revocation applies only to an approval that was granted but never used. A consumed approval has
 * already produced a Run; stopping or cancelling a Run is a separate action and is never offered here.
 * The server remains authoritative: it rejects revocation of an approval that expired in the meantime.
 */
export function canRevokeAuthorization(authorization: ConnectorAuthorization, now = Date.now()) {
  return (
    authorization.status === 'authorized' &&
    authorization.consumedAt === null &&
    Date.parse(authorization.expiresAt) > now
  );
}

export function SyntheticOperationDialog({
  dialogRef,
  authorization,
  renderedRequest,
  busy,
  error,
  notice,
  revokeUnresolved,
  onApprove,
  onStart,
  onRevoke,
  onRefreshStatus,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  authorization: ConnectorAuthorization;
  renderedRequest: string;
  busy: boolean;
  error: string;
  notice: string;
  /** A revoke request finished with an unknown result and has not been re-checked yet. */
  revokeUnresolved: boolean;
  onApprove: () => void;
  onStart: () => void;
  onRevoke: () => Promise<void>;
  onRefreshStatus: () => void;
  onClose: () => void;
}) {
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const revokeButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const confirmSubmitted = useRef(false);
  const revocable = canRevokeAuthorization(authorization);

  useEffect(() => {
    if (confirmingRevoke) {
      keepButton.current?.focus();
    } else if (wasConfirming.current) {
      // Restore focus to whatever remains of the revoke controls; the dialog itself stays open.
      (revokeButton.current ?? refreshButton.current ?? closeButton.current)?.focus();
    }
    wasConfirming.current = confirmingRevoke;
  }, [confirmingRevoke]);

  async function confirmRevoke() {
    // A second activation before React re-renders the disabled state must neither start another
    // revocation nor settle early and dismiss the confirmation while the first request is running.
    if (confirmSubmitted.current) return;
    confirmSubmitted.current = true;
    try {
      await onRevoke();
    } finally {
      confirmSubmitted.current = false;
      setConfirmingRevoke(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="nx-dialog synthetic-operation-dialog"
      aria-labelledby="synthetic-operation-title"
      onCancel={(event) => {
        event.preventDefault();
        if (confirmingRevoke) {
          if (!busy) setConfirmingRevoke(false);
          return;
        }
        onClose();
      }}
    >
      <div className="nx-dialog__body">
        <h2 id="synthetic-operation-title">Review synthetic operation</h2>
        <p>This is a local deterministic fixture. It cannot contact a real provider.</p>
        <dl className="metadata-list">
          <div>
            <dt>Execution type</dt>
            <dd>Synthetic test fixture</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>mock</dd>
          </div>
          <div>
            <dt>Provider / model</dt>
            <dd>
              {authorization.providerId} / {authorization.modelId}
            </dd>
          </div>
          <div>
            <dt>Operation</dt>
            <dd>{authorization.operation}</dd>
          </div>
          <div>
            <dt>Capabilities</dt>
            <dd>
              {authorization.capabilities.length
                ? authorization.capabilities.join(', ')
                : 'None (text only)'}
            </dd>
          </div>
          <div>
            <dt>Limits</dt>
            <dd>
              {authorization.limits.maxInputTokens} input tokens;{' '}
              {authorization.limits.maxOutputTokens} output tokens;{' '}
              {authorization.limits.maxDurationSeconds}s; {authorization.limits.maxCostMicrousd}{' '}
              micro-USD ceiling
            </dd>
          </div>
          <div>
            <dt>Request digest</dt>
            <dd>
              <code>{authorization.promptDigest}</code>
            </dd>
          </div>
          <div>
            <dt>Approval expires</dt>
            <dd>
              <time dateTime={authorization.expiresAt}>
                {formatManilaWithZone(authorization.expiresAt)}
              </time>
            </dd>
          </div>
        </dl>
        <label htmlFor="synthetic-rendered-request">Exact rendered request</label>
        <pre id="synthetic-rendered-request" className="synthetic-request-preview">
          {renderedRequest}
        </pre>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="error-note">
            {error}
          </p>
        )}
        {confirmingRevoke && (
          <section className="synthetic-revoke-confirm" aria-labelledby="synthetic-revoke-title">
            <h3 id="synthetic-revoke-title">Revoke this approval?</h3>
            <p>
              The approval will no longer be usable and no Run will start from it. This does not
              stop, cancel or change any Run that has already started.
            </p>
            <div className="nx-dialog__actions">
              <button
                ref={keepButton}
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setConfirmingRevoke(false)}
              >
                Keep approval
              </button>
              <button type="button" disabled={busy} onClick={() => void confirmRevoke()}>
                {busy ? 'Revoking approval…' : 'Confirm revoke'}
              </button>
            </div>
          </section>
        )}
        <div className="nx-dialog__actions">
          <button
            ref={closeButton}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            Close
          </button>
          {authorization.status === 'pending' && (
            <button type="button" disabled={busy} onClick={onApprove}>
              Approve exact operation
            </button>
          )}
          {revokeUnresolved && (
            <button
              ref={refreshButton}
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={onRefreshStatus}
            >
              Check approval status
            </button>
          )}
          {revocable && !confirmingRevoke && !revokeUnresolved && (
            <button
              ref={revokeButton}
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setConfirmingRevoke(true)}
            >
              Revoke approval
            </button>
          )}
          {authorization.status === 'authorized' && authorization.consumedAt === null && (
            <button type="button" disabled={busy || revokeUnresolved} onClick={onStart}>
              Start authorized synthetic Run
            </button>
          )}
          {authorization.consumedAt !== null && (
            <p role="status">This authorization was already consumed. Inspect its Run history.</p>
          )}
          {authorization.status === 'revoked' && authorization.consumedAt === null && (
            <p role="status">
              This approval was revoked and can no longer be used. No Run was started from it. Close
              this review to prepare a new operation.
            </p>
          )}
          {authorization.status !== 'pending' &&
            authorization.status !== 'authorized' &&
            authorization.status !== 'revoked' && (
              <p role="status">
                This authorization is {authorization.status}; create a new operation to continue.
              </p>
            )}
        </div>
      </div>
    </dialog>
  );
}

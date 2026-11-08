import type { RefObject } from 'react';
import type { ConnectorAuthorization } from '@omnis/contracts/connector-authorization-schema';

export function SyntheticOperationDialog({
  dialogRef,
  authorization,
  renderedRequest,
  busy,
  error,
  onApprove,
  onStart,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  authorization: ConnectorAuthorization;
  renderedRequest: string;
  busy: boolean;
  error: string;
  onApprove: () => void;
  onStart: () => void;
  onClose: () => void;
}) {
  return (
    <dialog
      ref={dialogRef}
      className="nx-dialog synthetic-operation-dialog"
      aria-labelledby="synthetic-operation-title"
      onCancel={(event) => {
        event.preventDefault();
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
            <dd>{new Date(authorization.expiresAt).toLocaleString()}</dd>
          </div>
        </dl>
        <label htmlFor="synthetic-rendered-request">Exact rendered request</label>
        <pre id="synthetic-rendered-request" className="synthetic-request-preview">
          {renderedRequest}
        </pre>
        {error && (
          <p role="alert" className="error-note">
            {error}
          </p>
        )}
        <div className="nx-dialog__actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Close
          </button>
          {authorization.status === 'pending' && (
            <button type="button" disabled={busy} onClick={onApprove}>
              Approve exact operation
            </button>
          )}
          {authorization.status === 'authorized' && authorization.consumedAt === null && (
            <button type="button" disabled={busy} onClick={onStart}>
              Start authorized synthetic Run
            </button>
          )}
          {authorization.consumedAt !== null && (
            <p role="status">This authorization was already consumed. Inspect its Run history.</p>
          )}
          {authorization.status !== 'pending' && authorization.status !== 'authorized' && (
            <p role="status">
              This authorization is {authorization.status}; create a new operation to continue.
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}

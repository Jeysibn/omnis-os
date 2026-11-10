import { NxButton } from '../../design/index.js';
import { recoveryActionLabel, type RecoveryAction, type RecoveryCopy } from './recoveryCopy.js';

/**
 * The unresolved-create notice: what happened, what is known, what is not verified, and why
 * another create is unavailable, followed by the actions that are safe now. It is announced as an
 * alert when it appears or changes.
 */
export function RecoveryNotice({
  copy,
  view,
  busy,
  onAction,
}: {
  copy: RecoveryCopy;
  view: string;
  busy: boolean;
  onAction: (action: RecoveryAction) => void;
}) {
  return (
    <div
      className="pw-notice pw-recovery"
      data-tone={copy.tone}
      data-recovery-view={view}
      role="alert"
    >
      <p className="pw-recovery-head">{copy.headline}</p>
      <p>{copy.what}</p>
      <dl className="pw-recovery-facts">
        {copy.known.length > 0 && (
          <>
            <dt>What is known</dt>
            <dd>
              <ul>
                {copy.known.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {copy.unverified.length > 0 && (
          <>
            <dt>What is not verified</dt>
            <dd>
              <ul>
                {copy.unverified.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Why creating another is unavailable</dt>
        <dd>{copy.why}</dd>
      </dl>
      <div className="pw-actions">
        {copy.actions.map((action) => (
          <NxButton
            key={action}
            variant={action === 'discardConfirm' ? 'danger' : 'secondary'}
            disabled={busy}
            onClick={() => onAction(action)}
          >
            {recoveryActionLabel(action, view !== 'storage-unavailable')}
          </NxButton>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { NxButton } from './Controls.js';
import './design.css';

/** Loading. Announced politely; the spinner is decorative and the text carries the meaning. */
export function LoadingState({ label }: { label: string }) {
  return (
    <div className="nx-state" role="status">
      <span className="nx-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Nothing to show. Say why, and what the operator can do, never a bare blank area. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="nx-state" data-kind="empty">
      <p className="nx-state__title">{title}</p>
      {description && <p className="nx-muted">{description}</p>}
      {action}
    </div>
  );
}

/** A failure the operator can read and retry. Announced immediately. */
export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel = 'Retry',
}: {
  title: string;
  description?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** Name the retry button after what it retries when several can appear on one screen. */
  retryLabel?: string;
}) {
  return (
    <div className="nx-state" data-kind="error" role="alert">
      <p className="nx-state__title">{title}</p>
      {description && <p className="nx-muted">{description}</p>}
      {onRetry && <NxButton onClick={onRetry}>{retryLabel}</NxButton>}
    </div>
  );
}

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Use for destructive or hard-to-reverse actions. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A modal confirmation built on the native <dialog>: the browser provides the focus trap, inert
 * background and Escape handling, and returns focus to the control that opened it.
 * Cancel receives initial focus, so the safe action is the default.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="nx-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        // Escape: let React state own the close so the open prop and the DOM never disagree.
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="nx-dialog__body">
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-description`} className="nx-muted">
          {description}
        </p>
        <div className="nx-dialog__actions">
          <NxButton autoFocus onClick={onCancel}>
            {cancelLabel}
          </NxButton>
          <NxButton variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </NxButton>
        </div>
      </div>
    </dialog>
  );
}

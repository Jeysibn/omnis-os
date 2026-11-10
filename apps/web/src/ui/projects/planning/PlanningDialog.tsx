import { useEffect, useId, useRef, type ReactNode } from 'react';

type Props = {
  open: boolean;
  title: string;
  /** Escape or the backdrop-less Cancel path. The owner of `open` decides whether to close. */
  onCancel: () => void;
  children: ReactNode;
};

/**
 * A modal form shell on the native <dialog>: the browser provides the focus trap, the inert page and
 * Escape, and returns focus to the control that opened it when the dialog closes. The body scrolls
 * inside the dialog, so a form is never taller than a laptop display.
 */
export function PlanningDialog({ open, title, onCancel, children }: Props) {
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
      className="nx-dialog pw-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        // Escape: state owns the close, so `open` and the DOM never disagree.
        event.preventDefault();
        onCancel();
      }}
    >
      {open && (
        <div className="nx-dialog__body">
          <h2 id={`${id}-title`}>{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

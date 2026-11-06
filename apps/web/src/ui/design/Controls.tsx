import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import './design.css';

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  variant?: 'secondary' | 'primary' | 'ghost' | 'danger';
  /** Shows progress. The button stays focusable and ignores clicks, so a double submit is impossible. */
  busy?: boolean;
};

/** A native button. Defaults to type="button" so it never submits a form by accident. */
export function NxButton({
  variant = 'secondary',
  busy = false,
  type = 'button',
  onClick,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className="nx-button"
      data-variant={variant}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={busy ? (event) => event.preventDefault() : onClick}
    >
      {busy && <span className="nx-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

type FieldProps = {
  label: string;
  hint?: string | undefined;
  /** Validation message. Shown in text, linked with aria-describedby, and sets aria-invalid. */
  error?: string | undefined;
  /** Receives the props the control must spread so label, hint and error stay connected. */
  children: (control: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
  }) => ReactNode;
};

/** Label, hint and error wiring for any control. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="nx-field">
      <label className="nx-field__label" htmlFor={id}>
        {label}
      </label>
      {hint && (
        <p id={hintId} className="nx-field__hint">
          {hint}
        </p>
      )}
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {error && (
        <p id={errorId} className="nx-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A text input styled for NEXUS. Use it inside `Field` and spread the control props onto it. */
export function NxInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return <input {...props} className="nx-input" />;
}

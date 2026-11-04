import { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { validateDepartmentInput } from './data.js';
import type { MessageKey } from './messages.js';

export type Problem = {
  /** Catalog key for server-derived messages; null for client-side checks. */
  key: MessageKey | null;
  text: string;
  field?: 'name' | 'slug';
};
export type ProblemSet = {
  items: Problem[];
  /** Changes every time a new set arrives so the summary takes focus again. */
  nonce: number;
  focus: 'summary' | 'slug';
};
export const noProblems: ProblemSet = { items: [], nonce: 0, focus: 'summary' };

type Props = {
  mode: 'create' | 'rename';
  heading: string;
  initial: { name: string; slug: string };
  pending: boolean;
  /** True while an unresolved outcome means this form must not be submitted (spec 7.4). */
  locked: boolean;
  problems: ProblemSet;
  submitLabel: string;
  note?: string;
  autoFocus: boolean;
  onSubmit: (value: { name: string; slug: string }) => void;
  onCancel: () => void;
};

const slugHelp =
  'Lowercase letters, numbers and single hyphens, up to 80 characters. Used as a stable short name. Can be changed later, but is never reusable once taken, even by an archived department.';

export function DepartmentForm(props: Props) {
  const { mode, pending, locked, problems } = props;
  const ids = {
    name: useId(),
    slug: useId(),
    nameHelp: useId(),
    slugHelp: useId(),
    nameError: useId(),
    slugError: useId(),
  };
  const [name, setName] = useState(props.initial.name);
  const [slug, setSlug] = useState(props.initial.slug);
  const [shown, setShown] = useState<Problem[]>(problems.items);
  const [focusTick, setFocusTick] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const focusTarget = useRef<'summary' | 'slug'>('summary');

  useEffect(() => {
    if (props.autoFocus) nameRef.current?.focus();
    // Only on mount: focus moves to Name when the form opens.
  }, []);

  useEffect(() => {
    if (problems.nonce === 0) return;
    setShown(problems.items);
    focusTarget.current = problems.focus;
    setFocusTick((value) => value + 1);
  }, [problems]);

  useEffect(() => {
    if (focusTick === 0) return;
    if (focusTarget.current === 'slug' && slugRef.current) slugRef.current.focus();
    else summaryRef.current?.focus();
  }, [focusTick]);

  const errorFor = (field: 'name' | 'slug') => shown.find((item) => item.field === field);
  const clear = (field: 'name' | 'slug') =>
    setShown((current) => current.filter((item) => item.field !== field));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || locked) return;
    const { errors, value } = validateDepartmentInput({ name, slug });
    if (!value) {
      const items: Problem[] = [];
      if (errors.name) items.push({ key: null, field: 'name', text: errors.name });
      if (errors.slug) items.push({ key: null, field: 'slug', text: errors.slug });
      setShown(items);
      focusTarget.current = 'summary';
      setFocusTick((tick) => tick + 1);
      return;
    }
    if (
      mode === 'rename' &&
      value.name === props.initial.name &&
      value.slug === props.initial.slug
    ) {
      setShown([{ key: null, text: 'No changes to save.' }]);
      focusTarget.current = 'summary';
      setFocusTick((tick) => tick + 1);
      return;
    }
    setShown([]);
    props.onSubmit(value);
  };

  const field = (
    which: 'name' | 'slug',
    label: string,
    help: string,
    value: string,
    set: (value: string) => void,
    ref: React.RefObject<HTMLInputElement | null>,
  ) => {
    const error = errorFor(which);
    const helpId = which === 'name' ? ids.nameHelp : ids.slugHelp;
    const errorId = which === 'name' ? ids.nameError : ids.slugError;
    return (
      <div className="dept-field">
        <label htmlFor={ids[which]}>
          {label} <span className="dept-required">(required)</span>
        </label>
        <input
          ref={ref}
          id={ids[which]}
          type="text"
          value={value}
          readOnly={pending}
          autoComplete="off"
          spellCheck={which === 'name'}
          autoCapitalize="off"
          inputMode={which === 'slug' ? 'text' : undefined}
          dir="auto"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${helpId} ${errorId}` : helpId}
          onChange={(event) => {
            set(event.target.value);
            clear(which);
          }}
        />
        <span id={helpId} className="agents-help">
          {help}
        </span>
        {error && (
          <span
            id={errorId}
            className="dept-field-error"
            {...(error.key ? { 'data-message-key': error.key } : {})}
          >
            <CircleAlert size={14} aria-hidden="true" />
            <span>{error.text}</span>
          </span>
        )}
      </div>
    );
  };

  return (
    <form className="dept-form" onSubmit={submit} noValidate aria-labelledby={`${ids.name}-title`}>
      <h3 id={`${ids.name}-title`}>{props.heading}</h3>
      {props.note && <p className="dept-note">{props.note}</p>}
      {shown.length > 0 && (
        <div ref={summaryRef} className="dept-summary" role="alert" tabIndex={-1}>
          <strong>There is a problem</strong>
          <ul>
            {shown.map((item, index) => (
              <li key={`${item.key ?? 'client'}-${index}`}>
                {item.field ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => (item.field === 'name' ? nameRef : slugRef).current?.focus()}
                  >
                    <span {...(item.key ? { 'data-message-key': item.key } : {})}>
                      {item.field === 'name' ? 'Name' : 'Slug'}: {item.text}
                    </span>
                  </button>
                ) : (
                  <span {...(item.key ? { 'data-message-key': item.key } : {})}>{item.text}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="dept-fields">
        {field('name', 'Name', '1-120 characters.', name, setName, nameRef)}
        {field('slug', 'Slug', slugHelp, slug, setSlug, slugRef)}
      </div>
      <div className="dept-form-actions">
        <button type="submit" className="primary-button" disabled={pending || locked}>
          {pending ? (mode === 'create' ? 'Creating…' : 'Saving…') : props.submitLabel}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={props.onCancel}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

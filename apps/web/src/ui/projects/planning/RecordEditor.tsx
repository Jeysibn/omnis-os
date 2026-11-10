import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CreateEpicSchema,
  CreateMilestoneSchema,
  UpdateEpicSchema,
  UpdateMilestoneSchema,
  type Epic,
  type Milestone,
} from '@omnis/contracts';
import { ApiRequestError } from '../../api.js';
import { Field, NxButton, NxInput, NxSelect, NxTextarea } from '../../design/index.js';
import { Notice } from '../parts.js';
import { judgeEdit, type Observation } from './recovery.js';
import { useWriter } from './write.js';
import { PlanningDialog } from './PlanningDialog.js';

type Record_ = Epic | Milestone;
type Kind = 'epic' | 'milestone';

/** The editable fields, as text. The API's own schemas decide what is valid. */
type Values = { title: string; description: string; status: string; targetDate: string };

type EditableStatus = 'planned' | 'in_progress' | 'completed';
type Changes = {
  title?: string;
  description?: string | null;
  status?: EditableStatus;
  targetDate?: string | null;
};
type FieldErrors = Partial<Record<keyof Values | 'form', string | undefined>>;

const empty: Values = { title: '', description: '', status: 'planned', targetDate: '' };
const fromRecord = (record: Record_): Values => ({
  title: record.title,
  description: record.description ?? '',
  status: record.status === 'archived' ? 'planned' : record.status,
  targetDate: 'targetDate' in record ? (record.targetDate ?? '') : '',
});

type Problem = {
  tone: 'error' | 'warning';
  text: string;
  actions: ('retry' | 'check' | 'loadLatest' | 'keepEdits' | 'closeAndReload' | 'close')[];
  /** The record read after a conflict or a check, offered to Load latest / Keep my edits. */
  latest?: Record_;
};

type Props<T extends Record_> = {
  kind: Kind;
  open: boolean;
  /** null creates a record. */
  record: T | null;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
  create: (input: Changes, key: string, csrfToken: string) => Promise<T>;
  update: (record: T, changes: Changes, key: string, csrfToken: string) => Promise<T>;
  read: (id: string) => Promise<T>;
  onSaved: (record: T, mode: 'created' | 'updated') => void;
  /** `reload` asks the list to be read again, for example after an unknown create. */
  onClose: (reload: boolean) => void;
};

const noun = (kind: Kind) => (kind === 'epic' ? 'epic' : 'milestone');

/**
 * Create or edit one epic or milestone. It sends only what changed, with the revision the owner
 * was looking at, and never claims a save the server did not confirm:
 *
 *  - saved: the response is a valid record matching the request;
 *  - rejected (definitive): the message says what the server said, and the form stays open;
 *  - conflict (409): the latest record is read, and the owner chooses to load it or keep their
 *    edits on top of it;
 *  - unknown (network, 5xx, unverifiable): nothing is shown as saved, and the same request can be
 *    sent again with the same Idempotency-Key so it cannot be applied twice.
 */
export function RecordEditor<T extends Record_>({
  kind,
  open,
  record,
  csrfToken,
  refreshCsrf,
  onUnauthorized,
  create,
  update,
  read,
  onSaved,
  onClose,
}: Props<T>) {
  const creating = record === null;
  const [baseline, setBaseline] = useState<T | null>(record);
  const [values, setValues] = useState<Values>(record ? fromRecord(record) : empty);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [checking, setChecking] = useState(false);
  const writer = useWriter({ csrfToken, refreshCsrf, onUnauthorized });
  const statusRef = useRef<HTMLDivElement | null>(null);
  const lastRequest = useRef<Changes | null>(null);

  // A fresh form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setBaseline(record);
    setValues(record ? fromRecord(record) : empty);
    setErrors({});
    setProblem(null);
    lastRequest.current = null;
    // Only opening resets the form; a re-render with the same record must not discard typing.
  }, [open]);

  const set = (field: keyof Values) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, form: undefined }));
  };

  /** What the owner changed, as the API's input. Null when nothing changed. */
  function changesFrom(): Changes | null {
    const text = values.description.trim();
    if (creating)
      return {
        title: values.title.trim(),
        ...(text ? { description: text } : {}),
        ...(kind === 'milestone' && values.targetDate ? { targetDate: values.targetDate } : {}),
      };
    const before = fromRecord(baseline as T);
    const changes: Changes = {};
    if (values.title.trim() !== before.title) changes.title = values.title.trim();
    if (text !== before.description.trim()) changes.description = text === '' ? null : text;
    if (values.status !== before.status) changes.status = values.status as EditableStatus;
    if (kind === 'milestone' && values.targetDate !== before.targetDate)
      changes.targetDate = values.targetDate === '' ? null : values.targetDate;
    return Object.keys(changes).length === 0 ? null : changes;
  }

  /** Field problems from the API's own schema, so the form and the server cannot disagree. */
  function validate(changes: Changes | null): Changes | null {
    if (changes === null) {
      setErrors({ form: 'There is nothing to save. Change a field first.' });
      return null;
    }
    const probe = creating
      ? (kind === 'epic' ? CreateEpicSchema : CreateMilestoneSchema).safeParse(changes)
      : (kind === 'epic' ? UpdateEpicSchema : UpdateMilestoneSchema).safeParse({
          ...changes,
          expectedRevision: (baseline as T).revision,
        });
    if (probe.success) return changes;
    const next: FieldErrors = {};
    for (const issue of probe.error.issues) {
      const field = issue.path[0];
      if (field === 'title') next.title ??= 'Enter a title of 1 to 120 characters.';
      else if (field === 'description')
        next.description ??= 'Keep the description to 2000 characters, without control characters.';
      else if (field === 'targetDate') next.targetDate ??= 'Use a real calendar date.';
      else next.form ??= 'These values are not valid.';
    }
    setErrors(next);
    return null;
  }

  async function send(changes: Changes) {
    lastRequest.current = changes;
    setProblem(null);
    const signature = JSON.stringify({
      id: baseline?.id ?? null,
      rev: baseline?.revision,
      changes,
    });
    const outcome = await writer.run(signature, (key, csrf) =>
      creating ? create(changes, key, csrf) : update(baseline as T, changes, key, csrf),
    );
    switch (outcome.kind) {
      case 'saved':
        onSaved(outcome.value, creating ? 'created' : 'updated');
        return;
      case 'busy':
      case 'unauthorized':
        return;
      case 'unknown':
        setProblem({
          tone: 'warning',
          text: `Omnis OS did not get a confirmed result, so this ${noun(kind)} is not shown as saved and the change may or may not have been applied. ${creating ? 'Sending the same request again is safe: it cannot create it twice.' : 'Check the current state, or send the same request again, which cannot apply it twice.'}`,
          actions: creating ? ['retry', 'closeAndReload'] : ['retry', 'check', 'close'],
        });
        return;
      case 'rejected':
        await explainRejection(outcome.status, outcome.code, outcome.message);
    }
  }

  async function readLatest(): Promise<Observation<T>> {
    if (!baseline) return { kind: 'failed' };
    try {
      return { kind: 'record', value: await read(baseline.id) };
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        onUnauthorized(cause);
        return { kind: 'failed' };
      }
      return cause instanceof ApiRequestError && cause.status === 404
        ? { kind: 'absent' }
        : { kind: 'failed' };
    }
  }

  const matchesRequest = (value: Record_): boolean => {
    const changes = lastRequest.current;
    if (!changes) return false;
    return (
      (changes.title === undefined || value.title === changes.title) &&
      (changes.description === undefined || value.description === changes.description) &&
      (changes.status === undefined || value.status === changes.status) &&
      (changes.targetDate === undefined ||
        ('targetDate' in value && value.targetDate === changes.targetDate))
    );
  };

  /** Describe a read-back for an unknown outcome or a 409, using only what it shows. */
  async function inspect(afterConflict: boolean) {
    if (!baseline) return;
    setChecking(true);
    const observation = await readLatest();
    setChecking(false);
    const verdict = judgeEdit(baseline.revision, observation, matchesRequest);
    const latest = observation.kind === 'record' ? observation.value : undefined;
    if (verdict === 'applied' && latest) {
      // The record shows the requested values at the next revision. That is observed state, and
      // another session could have made the identical change, so the message does not claim more.
      onSaved(latest, 'updated');
      return;
    }
    const base = { tone: 'warning' as const, ...(latest ? { latest } : {}) };
    if (verdict === 'not-applied')
      setProblem({
        ...base,
        text: afterConflict
          ? `The server reported a conflict, but this ${noun(kind)} is still at the revision you opened. Nothing was changed. Review your values and save again.`
          : `This ${noun(kind)} is still at the revision you opened, so the change was not applied. You can save again.`,
        actions: ['retry', 'check'],
      });
    else if (verdict === 'changed' || verdict === 'archived')
      setProblem({
        ...base,
        text:
          verdict === 'archived'
            ? `This ${noun(kind)} was archived elsewhere and can no longer be edited. Load the latest version to see it.`
            : `This ${noun(kind)} was changed elsewhere (it is now at revision ${latest?.revision}). Load the latest version, or keep your edits and apply them to it.`,
        actions:
          verdict === 'archived' ? ['loadLatest', 'close'] : ['loadLatest', 'keepEdits', 'check'],
      });
    else if (verdict === 'absent')
      setProblem({
        tone: 'error',
        text: `This ${noun(kind)} no longer exists. Close this form; the list will be refreshed.`,
        actions: ['closeAndReload'],
      });
    else
      setProblem({
        tone: 'warning',
        text: `The current state could not be read, so Omnis OS cannot tell whether the change was applied. Check again before saving anything else.`,
        actions: ['check', 'close'],
      });
  }

  async function explainRejection(status: number, code: string, message: string) {
    if (status === 403)
      return setProblem({
        tone: 'error',
        text: 'Your secure session needed refreshing. Nothing was changed. Try again.',
        actions: [],
      });
    if (status === 422)
      return setProblem({
        tone: 'error',
        text: 'The server rejected these values. Check them, and remove anything that looks like a credential or secret.',
        actions: [],
      });
    if (status === 503)
      return setProblem({
        tone: 'error',
        text: `The limit for this project's ${noun(kind)}s was reached, so nothing was created or changed.`,
        actions: [],
      });
    if (status === 404)
      return setProblem({
        tone: 'error',
        text: `This ${noun(kind)} or its project was not found. Close this form; the list will be refreshed.`,
        actions: ['closeAndReload'],
      });
    // 409: `conflict` covers a stale revision and a duplicate; `invalid_transition` an unsupported change.
    if (creating)
      return setProblem({
        tone: 'error',
        text: `The server reported a conflict, so the ${noun(kind)} was not created. ${message}`,
        actions: ['closeAndReload'],
      });
    if (code === 'invalid_transition') {
      await inspect(true);
      setProblem((current) =>
        current && current.tone === 'warning'
          ? current
          : { tone: 'error', text: message, actions: ['check'] },
      );
      return;
    }
    await inspect(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (writer.busy || checking) return;
    const changes = validate(changesFrom());
    if (changes) await send(changes);
  }

  function applyLatest(keepEdits: boolean) {
    const latest = problem?.latest as T | undefined;
    if (!latest) return;
    // What the owner changed, measured against the version they opened, before it is replaced.
    const mine = keepEdits ? changesFrom() : null;
    writer.settle();
    setBaseline(latest);
    const next = fromRecord(latest);
    // Keep only the fields the owner changed; every other field takes the latest value, so an edit
    // made elsewhere is never silently overwritten with what the owner last saw.
    if (mine) {
      if (mine.title !== undefined) next.title = mine.title;
      if (mine.description !== undefined) next.description = mine.description ?? '';
      if (mine.status !== undefined) next.status = mine.status;
      if (mine.targetDate !== undefined) next.targetDate = mine.targetDate ?? '';
    }
    setValues(next);
    setProblem(null);
    setErrors({});
  }

  const act = (action: Problem['actions'][number]) => {
    if (action === 'retry') {
      if (lastRequest.current) void send(lastRequest.current);
    } else if (action === 'check') void inspect(false);
    else if (action === 'loadLatest') applyLatest(false);
    else if (action === 'keepEdits') applyLatest(true);
    else if (action === 'closeAndReload') onClose(true);
    else onClose(false);
  };
  const label: Record<Problem['actions'][number], string> = {
    retry: 'Send the same request again',
    check: 'Check current state',
    loadLatest: 'Load latest version',
    keepEdits: 'Keep my edits',
    closeAndReload: 'Close and refresh the list',
    close: 'Close',
  };

  const busy = writer.busy || checking;
  return (
    <PlanningDialog
      open={open}
      title={creating ? `New ${noun(kind)}` : `Edit ${noun(kind)}`}
      onCancel={() => !busy && onClose(problem?.actions.includes('closeAndReload') ?? false)}
    >
      <form className="pw-form pw-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        {!creating && baseline && (
          <p className="nx-muted pw-revision">
            Editing revision {baseline.revision}. Changes are saved only if it has not changed
            since.
          </p>
        )}
        <Field label="Title" error={errors.title}>
          {(control) => (
            <NxInput
              {...control}
              value={values.title}
              maxLength={120}
              autoFocus
              autoComplete="off"
              onChange={(event) => set('title')(event.target.value)}
            />
          )}
        </Field>
        <Field label="Description (optional)" error={errors.description}>
          {(control) => (
            <NxTextarea
              {...control}
              rows={3}
              value={values.description}
              onChange={(event) => set('description')(event.target.value)}
            />
          )}
        </Field>
        {!creating && (
          <Field
            label="Status"
            hint="Archiving is a separate action and cannot be undone."
            error={errors.status}
          >
            {(control) => (
              <NxSelect
                {...control}
                value={values.status}
                onChange={(event) => set('status')(event.target.value)}
              >
                <option value="planned">Planned</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
              </NxSelect>
            )}
          </Field>
        )}
        {kind === 'milestone' && (
          <Field
            label="Target date (optional)"
            hint="A calendar date. Clear it to remove the target."
            error={errors.targetDate}
          >
            {(control) => (
              <NxInput
                {...control}
                type="date"
                value={values.targetDate}
                onChange={(event) => set('targetDate')(event.target.value)}
              />
            )}
          </Field>
        )}
        <div ref={statusRef} aria-live="polite">
          {errors.form && <Notice tone="error">{errors.form}</Notice>}
          {busy && (
            <Notice tone="progress">{checking ? 'Checking the latest state…' : 'Saving…'}</Notice>
          )}
        </div>
        {problem && (
          <Notice
            tone={problem.tone}
            actions={problem.actions.map((action) => (
              <NxButton key={action} type="button" disabled={busy} onClick={() => act(action)}>
                {label[action]}
              </NxButton>
            ))}
          >
            {problem.text}
          </Notice>
        )}
        <div className="nx-dialog__actions">
          <NxButton
            type="button"
            disabled={busy}
            onClick={() => onClose(problem?.actions.includes('closeAndReload') ?? false)}
          >
            Cancel
          </NxButton>
          <NxButton type="submit" variant="primary" busy={writer.busy} disabled={busy}>
            {creating ? `Create ${noun(kind)}` : 'Save changes'}
          </NxButton>
        </div>
      </form>
    </PlanningDialog>
  );
}

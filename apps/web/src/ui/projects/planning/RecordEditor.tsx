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
import { isValidStatusStep, nextStatuses, statusLabel, type EditableStatus } from './lifecycle.js';
import { judgeEdit, type Observation } from './recovery.js';
import type { PendingCreate, ScanResult } from './unresolved.js';
import { useWriter } from './write.js';
import { PlanningDialog } from './PlanningDialog.js';

type Record_ = Epic | Milestone;
type Kind = 'epic' | 'milestone';

/** The editable fields, as text. The API's own schemas decide what is valid. */
type Values = { title: string; description: string; status: string; targetDate: string };

export type Changes = {
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
const fromChanges = (changes: Changes): Values => ({
  title: changes.title ?? '',
  description: changes.description ?? '',
  status: 'planned',
  targetDate: changes.targetDate ?? '',
});

type Action =
  'retry' | 'check' | 'checkCreate' | 'loadLatest' | 'keepEdits' | 'closeAndReload' | 'close';
type Problem = {
  tone: 'error' | 'warning';
  text: string;
  actions: Action[];
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
  /** A create whose outcome is unknown, owned by the list so it survives closing this dialog. */
  pending: PendingCreate<Changes> | null;
  onPending: (pending: PendingCreate<Changes> | null) => void;
  /** Ids already known, recorded with a create so a later list read can tell what is new. */
  knownIds: () => string[];
  /** Reads every page of the list looking for the record an unknown create may have made. */
  scan: (pending: PendingCreate<Changes>) => Promise<ScanResult<T>>;
  onSaved: (record: T, mode: 'created' | 'updated') => void;
  /** The server shows a record that fits an unknown create: reported as observed, not as saved. */
  onObserved: (record: T) => void;
  /** `reload` asks the list to be read again. */
  onClose: (reload: boolean) => void;
};

const noun = (kind: Kind) => (kind === 'epic' ? 'epic' : 'milestone');

/**
 * Create or edit one epic or milestone. It sends only what changed, with the revision the owner
 * was looking at, and never claims a save the server did not confirm:
 *
 *  - saved: the response is a valid record matching the request;
 *  - rejected (definitive): the message says what the server said, and the form stays open;
 *  - conflict (409 `conflict`): the latest record is read, and the owner chooses to load it or keep
 *    their edits on top of it;
 *  - invalid transition (409 `invalid_transition`): a definitive refusal, never retried and never
 *    presented as a stale revision;
 *  - unknown (network, 5xx, unverifiable): nothing is shown as saved. An unknown CREATE locks the
 *    form to that exact request: it can only be sent again with the same Idempotency-Key, or
 *    reconciled by reading the list, so editing and resubmitting can never create a second record.
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
  pending,
  onPending,
  knownIds,
  scan,
  onSaved,
  onObserved,
  onClose,
}: Props<T>) {
  const creating = record === null;
  const locked = creating && pending !== null;
  const [baseline, setBaseline] = useState<T | null>(record);
  const [values, setValues] = useState<Values>(record ? fromRecord(record) : empty);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [checking, setChecking] = useState(false);
  const writer = useWriter({ csrfToken, refreshCsrf, onUnauthorized });
  const lastRequest = useRef<Changes | null>(null);

  const unresolved: Problem = {
    tone: 'warning',
    text: `Omnis OS did not get a confirmed result for this create request, so the ${noun(kind)} is not shown as created and may or may not exist. To avoid creating a duplicate, this form is locked to this exact request. Send the same request again (it cannot create it twice), or check the current list.`,
    actions: ['retry', 'checkCreate', 'close'],
  };

  // A fresh form each time the dialog opens, except that an unresolved create reopens locked to
  // the request that was sent.
  useEffect(() => {
    if (!open) return;
    setBaseline(record);
    setErrors({});
    if (creating && pending) {
      setValues(fromChanges(pending.changes));
      lastRequest.current = pending.changes;
      setProblem(unresolved);
    } else {
      setValues(record ? fromRecord(record) : empty);
      lastRequest.current = null;
      setProblem(null);
    }
    // Only opening resets the form; a re-render with the same record must not discard typing.
  }, [open]);

  const set = (field: keyof Values) => (value: string) => {
    if (locked) return;
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
    // A create is remembered BEFORE it is sent, so that closing the dialog or losing the response
    // cannot make the next attempt look like a different request.
    if (creating && !pending) onPending({ changes, startedAt: Date.now(), knownIds: knownIds() });
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
        if (creating) onPending(null);
        onSaved(outcome.value, creating ? 'created' : 'updated');
        return;
      case 'busy':
        return;
      case 'unauthorized':
        if (creating) onPending(null);
        return;
      case 'unknown':
        if (creating) setProblem(unresolved);
        else
          setProblem({
            tone: 'warning',
            text: `Omnis OS did not get a confirmed result, so this ${noun(kind)} is not shown as saved and the change may or may not have been applied. Check the current state, or send the same request again, which cannot apply it twice.`,
            actions: ['retry', 'check', 'close'],
          });
        return;
      case 'rejected':
        // A definitive answer: the request was not applied, so the form is free again.
        if (creating) onPending(null);
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

  /** Describe a read-back for an unknown edit or a stale-revision 409, using only what it shows. */
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

  /**
   * 409 `invalid_transition`: the server refused the change itself (a backward status step, or an
   * archived record or project). That is not a stale revision and repeating it cannot succeed, so
   * no retry is offered. The latest record is read only to say if it also changed elsewhere.
   */
  async function explainInvalidTransition() {
    const refusal = `The server does not allow this change. A ${noun(kind)} only moves forward (planned, in progress, completed) and an archived ${noun(kind)} cannot be changed. Nothing was changed.`;
    setProblem({ tone: 'error', text: refusal, actions: [] });
    if (!baseline) return;
    setChecking(true);
    const observation = await readLatest();
    setChecking(false);
    if (observation.kind !== 'record') return;
    const latest = observation.value;
    if (latest.status === 'archived')
      setProblem({
        tone: 'error',
        latest,
        text: `This ${noun(kind)} was archived elsewhere and can no longer be edited. Load the latest version to see it.`,
        actions: ['loadLatest', 'close'],
      });
    else if (latest.revision !== baseline.revision)
      setProblem({
        tone: 'error',
        latest,
        text: `${refusal} It was also changed elsewhere: it is now ${statusLabel(latest.status).toLowerCase()} at revision ${latest.revision}.`,
        actions: ['loadLatest'],
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
    // 409: `conflict` is a stale revision or a duplicate; `invalid_transition` is a refused change.
    if (code === 'invalid_transition') {
      if (creating)
        return setProblem({
          tone: 'error',
          text: `The server does not allow creating a ${noun(kind)} in this project's current state (for example, it is archived), so nothing was created. ${message}`,
          actions: ['closeAndReload'],
        });
      return explainInvalidTransition();
    }
    if (creating)
      return setProblem({
        tone: 'error',
        text: `The server reported a conflict, so the ${noun(kind)} was not created. ${message}`,
        actions: ['closeAndReload'],
      });
    await inspect(true);
  }

  /** Read every page of the list for the record an unknown create may have made. */
  async function checkCreate() {
    if (!pending) return;
    setChecking(true);
    const result = await scan(pending);
    setChecking(false);
    if (result.kind === 'found') {
      onPending(null);
      onObserved(result.record);
      return;
    }
    const text =
      result.kind === 'ambiguous'
        ? `${result.count} records in the list fit this request, so Omnis OS cannot tell which one, if any, it created. Nothing was assumed. This form stays locked to the request.`
        : result.kind === 'absent'
          ? `The complete list was read and no new ${noun(kind)} with these values was found. That is an observation, not proof: the request may still be in progress. To avoid a duplicate, this form stays locked to this request. Send the same request again to settle it.`
          : `The list could not be read completely, so nothing can be concluded about whether the ${noun(kind)} exists. This form stays locked to the request. Check again, or send the same request again.`;
    setProblem({ tone: 'warning', text, actions: ['retry', 'checkCreate', 'close'] });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || writer.busy || checking) return;
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
    let dropped = false;
    // Keep only the fields the owner changed; every other field takes the latest value, so an edit
    // made elsewhere is never silently overwritten with what the owner last saw.
    if (mine) {
      if (mine.title !== undefined) next.title = mine.title;
      if (mine.description !== undefined) next.description = mine.description ?? '';
      if (mine.status !== undefined) {
        // A status step that is no longer a valid step forward from the latest status is dropped.
        if (isValidStatusStep(latest.status, mine.status)) next.status = mine.status;
        else dropped = true;
      }
      if (mine.targetDate !== undefined) next.targetDate = mine.targetDate ?? '';
    }
    setValues(next);
    setErrors({});
    setProblem(
      dropped
        ? {
            tone: 'warning',
            text: `Your status change was not kept: this ${noun(kind)} is now ${statusLabel(latest.status).toLowerCase()}, and a ${noun(kind)} only moves forward. Your other edits were kept.`,
            actions: [],
          }
        : null,
    );
  }

  const act = (action: Action) => {
    if (action === 'retry') {
      const request = creating ? (pending?.changes ?? lastRequest.current) : lastRequest.current;
      if (request) void send(request);
    } else if (action === 'check') void inspect(false);
    else if (action === 'checkCreate') void checkCreate();
    else if (action === 'loadLatest') applyLatest(false);
    else if (action === 'keepEdits') applyLatest(true);
    else if (action === 'closeAndReload') onClose(true);
    else onClose(false);
  };
  const label: Record<Action, string> = {
    retry: 'Send the same request again',
    check: 'Check current state',
    checkCreate: 'Check the current list',
    loadLatest: 'Load latest version',
    keepEdits: 'Keep my edits',
    closeAndReload: 'Close and refresh the list',
    close: locked ? 'Close (the request stays unresolved)' : 'Close',
  };

  const busy = writer.busy || checking;
  const statuses = baseline ? nextStatuses(baseline.status) : [];
  const closeForm = () =>
    onClose(!locked && (problem?.actions.includes('closeAndReload') ?? false));
  return (
    <PlanningDialog
      open={open}
      title={creating ? `New ${noun(kind)}` : `Edit ${noun(kind)}`}
      onCancel={() => !busy && closeForm()}
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
              disabled={locked}
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
              disabled={locked}
              onChange={(event) => set('description')(event.target.value)}
            />
          )}
        </Field>
        {!creating && (
          <Field
            label="Status"
            hint="A status only moves forward. Archiving is a separate action and cannot be undone."
            error={errors.status}
          >
            {(control) => (
              <NxSelect
                {...control}
                value={values.status}
                onChange={(event) => set('status')(event.target.value)}
              >
                {statuses.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(status)}
                  </option>
                ))}
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
                disabled={locked}
                onChange={(event) => set('targetDate')(event.target.value)}
              />
            )}
          </Field>
        )}
        <div aria-live="polite">
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
          <NxButton type="button" disabled={busy} onClick={closeForm}>
            {locked ? 'Close' : 'Cancel'}
          </NxButton>
          {!locked && (
            <NxButton type="submit" variant="primary" busy={writer.busy} disabled={busy}>
              {creating ? `Create ${noun(kind)}` : 'Save changes'}
            </NxButton>
          )}
        </div>
      </form>
    </PlanningDialog>
  );
}

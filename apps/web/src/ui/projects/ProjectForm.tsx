import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CreateProjectSchema, type Project } from '@omnis/contracts';
import {
  Field,
  NxButton,
  NxInput,
  NxSelect,
  NxTextarea,
  Panel,
  TelemetryLabel,
} from '../design/index.js';
import {
  classifyMutationFailure,
  createProject,
  fetchProject,
  fetchProjects,
  updateProject,
} from './data.js';
import { IdempotentIntent } from './intent.js';
import { type Msg } from './messages.js';
import { Message, Notice, priorityLabel, priorityOptions } from './parts.js';
import {
  analyse,
  type Conclusion,
  type Observation,
  type Op,
  type RecoveryAction,
} from './recovery.js';
import { projectHash } from './route.js';
import { ApiRequestError } from '../api.js';

type Values = { key: string; name: string; objective: string; priority: Project['priority'] };
type FieldErrors = Partial<Record<'key' | 'name' | 'objective', string>>;

type Props = {
  /** `edit` carries the project as last read; its revision is the `expectedRevision` sent. */
  project: Project | null;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
  /** Called only with a server-confirmed (or server-observed) project. */
  onSaved: (project: Project, message: Msg) => void;
  onCancel: () => void;
  autoFocus: boolean;
};

type Recovery = { op: Op; mode: 'unknown' | 'conflict'; conclusion: Conclusion };

const NUL = String.fromCharCode(0);

/** Convenience checks. The shared schema is the gate; the server stays authoritative. */
export function validateValues(raw: Values, creating: boolean) {
  const errors: FieldErrors = {};
  const key = raw.key.trim();
  const name = raw.name.trim();
  const objective = raw.objective.trim();
  if (creating) {
    if (key.length === 0) errors.key = 'Enter a key.';
    else if (key.length < 2) errors.key = 'Use at least 2 characters.';
    else if (key.length > 32) errors.key = 'Use 32 characters or fewer.';
    else if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(key))
      errors.key =
        'Start with a capital letter. Use capital letters and numbers, with single hyphens between parts, for example AO-105.';
    else if (key.includes(NUL)) errors.key = 'This text contains an unsupported character.';
  }
  if (name.length === 0) errors.name = 'Enter a name.';
  else if (name.length > 120) errors.name = 'Use 120 characters or fewer.';
  else if (name.includes(NUL)) errors.name = 'This text contains an unsupported character.';
  if (objective.length === 0) errors.objective = 'Enter an objective.';
  else if (objective.length > 4000) errors.objective = 'Use 4000 characters or fewer.';
  else if (objective.includes(NUL))
    errors.objective = 'This text contains an unsupported character.';
  return { errors, trimmed: { key, name, objective, priority: raw.priority } };
}

export function ProjectForm({
  project,
  csrfToken,
  refreshCsrf,
  onUnauthorized,
  onSaved,
  onCancel,
  autoFocus,
}: Props) {
  const creating = project === null;
  const [base, setBase] = useState<Project | null>(project);
  const [values, setValues] = useState<Values>({
    key: '',
    name: project?.name ?? '',
    objective: project?.objective ?? '',
    priority: project?.priority ?? 'normal',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [keyTaken, setKeyTaken] = useState(false);
  const [busy, setBusy] = useState<'submit' | 'check' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; msg: Msg } | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const formRef = useRef<HTMLFormElement | null>(null);
  const intent = useRef(new IdempotentIntent());
  const inflight = useRef(false);
  const mounted = useRef(true);
  const csrfRef = useRef(csrfToken);
  csrfRef.current = csrfToken;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // After a failed validation, move focus to the first invalid control once it is rendered.
  useEffect(() => {
    if (focusTick === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  const blocking = recovery?.conclusion.blocking ?? false;
  const set = (field: keyof Values, value: string) => {
    setValues((current) => ({ ...current, [field]: value }) as Values);
    setErrors((current) => ({ ...current, [field]: undefined }));
    if (field === 'key') setKeyTaken(false);
  };

  const buildOp = (trimmed: Values): Op | null => {
    if (!base) return { kind: 'create', ...trimmed };
    const changes: { name?: string; objective?: string; priority?: Project['priority'] } = {};
    if (trimmed.name !== base.name) changes.name = trimmed.name;
    if (trimmed.objective !== base.objective) changes.objective = trimmed.objective;
    if (trimmed.priority !== base.priority) changes.priority = trimmed.priority;
    if (Object.keys(changes).length === 0) return null;
    return { kind: 'edit', id: base.id, expectedRevision: base.revision, changes };
  };

  async function observe(op: Op): Promise<Observation | 'unauthorized'> {
    try {
      if (op.kind === 'create') return { kind: 'list', list: await fetchProjects() };
      return { kind: 'project', project: await fetchProject(op.id) };
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        if (cause.status === 401) {
          unauthorizedRef.current(cause);
          return 'unauthorized';
        }
        if (cause.status === 404 && op.kind !== 'create') return { kind: 'absent' };
      }
      return { kind: 'failed' };
    }
  }

  /** One read-only recheck. In `conflict` mode the server definitively rejected the edit. */
  async function recheck(op: Op, mode: 'unknown' | 'conflict') {
    setBusy('check');
    const observation = await observe(op);
    if (!mounted.current || observation === 'unauthorized') return;
    let conclusion: Conclusion;
    if (mode === 'conflict' && op.kind === 'edit') {
      const project = observation.kind === 'project' ? observation.project : null;
      if (observation.kind !== 'project')
        conclusion = {
          message: { key: 'rejected.readbackFailed' },
          actions: ['checkAgain'],
          blocking: true,
          settled: false,
          project: null,
          keyProblem: false,
          openProjectId: null,
        };
      else if (project?.status === 'archived')
        conclusion = {
          message: { key: 'rejected.archived' },
          actions: [],
          blocking: true,
          settled: false,
          project,
          keyProblem: false,
          openProjectId: null,
        };
      else
        conclusion = {
          message: { key: 'rejected.edit.stale' },
          actions: ['loadLatest', 'keepEdits'],
          blocking: true,
          settled: false,
          project,
          keyProblem: false,
          openProjectId: null,
        };
    } else conclusion = analyse(op, observation);
    setRecovery({ op, mode, conclusion });
    setBusy(null);
    if (conclusion.settled && conclusion.project) {
      intent.current.settle();
      onSaved(conclusion.project, conclusion.message);
    } else if (conclusion.keyProblem) setKeyTaken(true);
  }

  async function run(op: Op) {
    if (inflight.current) return; // synchronous guard: a second activation cannot send a request
    inflight.current = true;
    setBusy('submit');
    setNotice(null);
    setRecovery(null);
    const idempotencyKey = intent.current.keyFor(JSON.stringify(op));
    try {
      const saved =
        op.kind === 'create'
          ? await createProject(
              { key: op.key, name: op.name, objective: op.objective, priority: op.priority },
              idempotencyKey,
              csrfRef.current,
            )
          : op.kind === 'edit'
            ? await updateProject(
                op.id,
                { expectedRevision: op.expectedRevision, ...op.changes },
                idempotencyKey,
                csrfRef.current,
              )
            : null;
      if (!saved) return;
      intent.current.settle();
      if (mounted.current)
        onSaved(
          saved,
          op.kind === 'create'
            ? { key: 'confirmed.create', params: { key: saved.key, name: saved.name } }
            : { key: 'confirmed.edit', params: { revision: saved.revision } },
        );
    } catch (cause) {
      await fail(op, cause);
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy((current) => (current === 'submit' ? null : current));
    }
  }

  async function fail(op: Op, cause: unknown) {
    const failure = classifyMutationFailure(cause);
    if (failure.evidence === 'unauthorized') {
      unauthorizedRef.current(cause);
      return;
    }
    if (failure.evidence === 'unknown') {
      // The request may have been applied. Keep the key so an identical retry is safe, and read
      // the authoritative state before offering anything.
      intent.current.markUncertain();
      if (mounted.current) await recheck(op, 'unknown');
      return;
    }
    intent.current.settle();
    if (!mounted.current) return;
    const error = (msg: Msg) => setNotice({ tone: 'error', msg });
    if (failure.status === 403) {
      try {
        csrfRef.current = await refreshCsrf();
      } catch {
        // The notice still tells the owner to retry; the next attempt will surface a new failure.
      }
      error({ key: 'rejected.csrf' });
    } else if (failure.status === 404) error({ key: 'rejected.notFound' });
    else if (failure.status === 422) error({ key: 'rejected.invalidInput' });
    else if (failure.status === 503) error({ key: 'rejected.create.limit' });
    else if (op.kind === 'create') {
      setKeyTaken(true);
      setFocusTick((tick) => tick + 1);
    } else await recheck(op, 'conflict'); // edit: stale revision or archived; read why
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (inflight.current || blocking) return;
    const { errors: found, trimmed } = validateValues(values, creating);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setNotice(null);
      setFocusTick((tick) => tick + 1);
      return;
    }
    if (creating && !CreateProjectSchema.safeParse(trimmed).success) return;
    const op = buildOp(trimmed);
    if (!op) {
      setNotice({ tone: 'error', msg: { key: 'edit.noChanges' } });
      return;
    }
    void run(op);
  };

  const act = (action: RecoveryAction) => {
    if (!recovery || busy) return;
    const { op, mode, conclusion } = recovery;
    if (action === 'checkAgain') void recheck(op, mode);
    else if (action === 'tryAgain') void run(op);
    else if (action === 'editValues' || action === 'close') setRecovery(null);
    else if (action === 'openProject' && conclusion.openProjectId)
      window.location.hash = projectHash(conclusion.openProjectId);
    else if ((action === 'loadLatest' || action === 'keepEdits') && conclusion.project) {
      const latest = conclusion.project;
      if (action === 'loadLatest')
        setValues({
          key: '',
          name: latest.name,
          objective: latest.objective,
          priority: latest.priority,
        });
      else
        // Keep every field the owner changed; untouched fields take the latest server value.
        setValues((current) => ({
          key: '',
          name: current.name === base?.name ? latest.name : current.name,
          objective: current.objective === base?.objective ? latest.objective : current.objective,
          priority: current.priority === base?.priority ? latest.priority : current.priority,
        }));
      setBase(latest);
      intent.current.settle();
      setRecovery(null);
      setNotice({
        tone: 'success',
        msg: {
          key: action === 'loadLatest' ? 'edit.loaded' : 'edit.kept',
          params: { revision: latest.revision },
        },
      });
    }
  };

  const actionLabel = (action: RecoveryAction): string =>
    ({
      checkAgain: 'Check again',
      tryAgain: 'Try again',
      editValues: 'Edit values',
      openProject: 'Open project',
      loadLatest: 'Load latest values (discard my edits)',
      keepEdits: 'Keep my edits on the latest version',
      close: 'Close',
    })[action];

  const title = creating ? 'New project' : 'Edit project';
  return (
    <Panel title={title} label={creating ? undefined : base?.key}>
      <form ref={formRef} className="pw-form" onSubmit={onSubmit} noValidate>
        {creating ? (
          <Field
            label="Key"
            hint="Capital letters, numbers and single hyphens, for example AO-105. It cannot be changed later."
            error={keyTaken ? 'This key is already used by another project.' : errors.key}
          >
            {(control) => (
              <NxInput
                {...control}
                value={values.key}
                autoComplete="off"
                spellCheck={false}
                autoFocus={autoFocus}
                onChange={(event) => set('key', event.target.value)}
              />
            )}
          </Field>
        ) : (
          <p className="pw-readonly">
            <TelemetryLabel>Key</TelemetryLabel> <span className="nx-mono">{base?.key}</span>{' '}
            <span className="nx-muted">The key cannot be changed.</span>
          </p>
        )}
        <Field label="Name" error={errors.name}>
          {(control) => (
            <NxInput
              {...control}
              value={values.name}
              autoFocus={autoFocus && !creating}
              onChange={(event) => set('name', event.target.value)}
            />
          )}
        </Field>
        <Field
          label="Objective"
          hint="What this project is meant to achieve."
          error={errors.objective}
        >
          {(control) => (
            <NxTextarea
              {...control}
              rows={5}
              value={values.objective}
              onChange={(event) => set('objective', event.target.value)}
            />
          )}
        </Field>
        <Field label="Priority">
          {(control) => (
            <NxSelect
              {...control}
              value={values.priority}
              onChange={(event) => set('priority', event.target.value)}
            >
              {priorityOptions.map((option) => (
                <option key={option} value={option}>
                  {priorityLabel(option)}
                </option>
              ))}
            </NxSelect>
          )}
        </Field>

        <div aria-live="polite" className="pw-live">
          {busy === 'submit' && (
            <Notice tone="progress">
              <Message msg={{ key: creating ? 'inflight.create' : 'inflight.edit' }} />
            </Notice>
          )}
          {busy === 'check' && (
            <Notice tone="progress">
              <Message msg={{ key: 'inflight.check' }} />
            </Notice>
          )}
        </div>
        {notice && (
          <Notice tone={notice.tone}>
            <Message msg={notice.msg} />
          </Notice>
        )}
        {recovery && (
          <Notice
            tone="warning"
            actions={recovery.conclusion.actions.map((action) => (
              <NxButton
                key={action}
                variant={action === 'tryAgain' || action === 'loadLatest' ? 'primary' : 'secondary'}
                busy={busy === 'check' && action === 'checkAgain'}
                disabled={busy === 'submit'}
                onClick={() => act(action)}
              >
                {actionLabel(action)}
              </NxButton>
            ))}
          >
            <Message msg={recovery.conclusion.message} />
          </Notice>
        )}

        <div className="pw-actions">
          <NxButton type="submit" variant="primary" busy={busy === 'submit'} disabled={blocking}>
            {creating ? 'Create project' : 'Save changes'}
          </NxButton>
          <NxButton onClick={onCancel}>Cancel</NxButton>
        </div>
        {blocking && (
          <p className="nx-muted">
            Saving is paused until the result above is resolved, so nothing is sent twice.
          </p>
        )}
      </form>
    </Panel>
  );
}

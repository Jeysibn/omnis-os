import { useEffect, useRef, useState } from 'react';
import { Archive, Plus } from 'lucide-react';
import type { Department } from '@omnis/contracts';
import { Failure, Loading, Notice, Text, formatManila } from '../agents/shared.js';
import { DepartmentForm, noProblems, type Problem, type ProblemSet } from './DepartmentForm.js';
import {
  classifyMutationFailure,
  createDepartment,
  fetchDepartments,
  renameDepartment,
  useDepartmentList,
} from './data.js';
import { messageText, type MessageKey, type Msg } from './messages.js';
import {
  analyse,
  type Conclusion,
  type Op,
  type RecoveryAction,
  type RecoveryMode,
} from './recovery.js';
import { departmentsHash, parseDepartmentsHash, type DepartmentsRoute } from './route.js';

type Props = {
  onUnauthorized: (cause: unknown) => void;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  /** True when the user got here by in-app navigation; a direct load never moves focus. */
  arrivedByNavigation: boolean;
};

type FormState = {
  mode: 'create' | 'rename';
  id?: string;
  seed: { name: string; slug: string };
  nonce: number;
  autoFocus: boolean;
};

type Recovery = {
  op: Op;
  mode: RecoveryMode;
  checking: boolean;
  conclusion: Conclusion;
};

type FocusRequest =
  | { kind: 'row'; id: string }
  | { kind: 'rename'; id: string }
  | { kind: 'new' }
  | { kind: 'heading' };

const malformed: DepartmentsRoute = { kind: 'malformed' };
const currentRoute = () => parseDepartmentsHash(window.location.hash) ?? malformed;

const actionLabel = (action: RecoveryAction, op: Op, first: boolean) => {
  switch (action) {
    case 'checkAgain':
      return first ? 'Check departments' : 'Check again';
    case 'close':
      return 'Close';
    case 'tryAgain':
      return op.kind === 'create' ? 'Try creating again' : 'Try again';
    case 'editCurrent':
      return 'Edit current values';
    case 'editValues':
      return 'Edit values instead';
  }
};

/** Renders one catalogued message. The key is exposed so tests assert identity, not wording. */
function Message({ message }: { message: Msg }) {
  return (
    <p dir="auto" data-message-key={message.key}>
      {messageText(message)}
    </p>
  );
}

export function DepartmentsWorkspace({
  onUnauthorized,
  csrfToken,
  refreshCsrf,
  arrivedByNavigation,
}: Props) {
  const [route, setRoute] = useState<DepartmentsRoute>(currentRoute);
  const [navigation, setNavigation] = useState(0);
  const [archived, setArchived] = useState(route.kind === 'list' && route.archived);
  const [announcement, setAnnouncement] = useState('');
  const [list, reload] = useDepartmentList(archived, route.kind === 'list', onUnauthorized);

  const [form, setForm] = useState<FormState | null>(null);
  const [problems, setProblems] = useState<ProblemSet>(noProblems);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState<'create' | 'rename' | 'check' | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);

  const busyRef = useRef(false);
  const mounted = useRef(true);
  const csrfRef = useRef(csrfToken);
  csrfRef.current = csrfToken;
  const moveFocus = useRef(arrivedByNavigation);
  const focusRequest = useRef<FocusRequest | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const rowHeadings = useRef(new Map<string, HTMLElement>());
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const nonce = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const next = currentRoute();
      moveFocus.current = true;
      setRoute(next);
      setNavigation((value) => value + 1);
      if (next.kind === 'list') setArchived(next.archived);
      setAnnouncement(next.kind === 'list' ? 'Department directory' : "This link isn't valid");
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (route.kind === 'list' && route.trailingSlash)
      window.history.replaceState(window.history.state, '', departmentsHash(route.archived));
  }, [route]);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, [navigation]);

  // After a confirmed mutation: the confirmation is kept; rows only change once the re-read lands.
  useEffect(() => {
    if (list.status === 'ready') {
      setAwaitingRefresh(false);
      setAnnouncement(
        `${list.data.total} ${list.data.total === 1 ? 'department' : 'departments'} shown`,
      );
      const request = focusRequest.current;
      if (request) {
        focusRequest.current = null;
        window.requestAnimationFrame(() => {
          const target =
            request.kind === 'row'
              ? rowHeadings.current.get(request.id)
              : request.kind === 'rename'
                ? (renameButtons.current.get(request.id) ?? rowHeadings.current.get(request.id))
                : request.kind === 'heading'
                  ? headingRef.current
                  : newButtonRef.current;
          (target ?? newButtonRef.current ?? headingRef.current)?.focus();
        });
      }
    }
  }, [list]);

  const toggleArchived = (value: boolean) => {
    setArchived(value);
    window.history.replaceState(window.history.state, '', departmentsHash(value));
  };

  const newProblems = (items: Problem[], focus: ProblemSet['focus'] = 'summary') => {
    nonce.current += 1;
    setProblems({ items, nonce: nonce.current, focus });
  };

  const openForm = (next: Omit<FormState, 'nonce'>) => {
    nonce.current += 1;
    setProblems(noProblems);
    setForm({ ...next, nonce: nonce.current });
  };

  const refreshAfter = (request: FocusRequest | null) => {
    focusRequest.current = request;
    reload();
  };

  const confirmed = (department: Department, op: Op) => {
    const params = { name: department.name, slug: department.slug };
    setMessages([{ key: op.kind === 'create' ? 'confirmed.create' : 'confirmed.rename', params }]);
    setForm(null);
    setProblems(noProblems);
    setRecovery(null);
    setAwaitingRefresh(true);
    refreshAfter(
      op.kind === 'create'
        ? { kind: 'row', id: department.id }
        : { kind: 'rename', id: department.id },
    );
  };

  /** The form that belongs to this operation: the open one if it matches, else one seeded from the operation. */
  const formForOp = (op: Op, current: FormState | null): FormState =>
    current && current.mode === op.kind && (op.kind === 'create' || current.id === op.id)
      ? current
      : {
          mode: op.kind,
          ...(op.kind === 'rename' ? { id: op.id } : {}),
          seed: { name: op.name, slug: op.slug },
          nonce: ++nonce.current,
          autoFocus: false,
        };

  /** Applies one analysis to the screen: field error, form lifecycle, banner and focus. */
  const applyConclusion = (op: Op, mode: RecoveryMode, conclusion: Conclusion) => {
    setMessages(conclusion.slugProblem ? [] : conclusion.messages);
    if (conclusion.closeForm) {
      setForm(null);
      refreshAfter(op.kind === 'rename' ? { kind: 'rename', id: op.id } : { kind: 'new' });
    }
    if (conclusion.slugProblem) {
      // The observation lives in the form, next to the field. Reopen the form if the user closed it.
      setForm((current) => formForOp(op, current));
      newProblems(
        [
          {
            key: conclusion.slugProblem.key,
            field: 'slug',
            text: messageText(conclusion.slugProblem),
          },
        ],
        'slug',
      );
    }
    const needsBanner = conclusion.actions.length > 0 || conclusion.blocking;
    setRecovery(needsBanner ? { op, mode, checking: false, conclusion } : null);
    if (needsBanner && !conclusion.slugProblem) {
      // Bring the form back for outcomes that let the user try again with their own input.
      if (conclusion.actions.includes('tryAgain')) setForm((current) => formForOp(op, current));
    }
  };

  const recheck = async (op: Op, mode: RecoveryMode) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('check');
    setRecovery({
      op,
      mode,
      checking: true,
      conclusion: {
        messages: [{ key: 'inflight.check' }],
        actions: [],
        blocking: true,
        closeForm: false,
        slugProblem: null,
        current: null,
        settled: false,
      },
    });
    let departments: readonly Department[] | null = null;
    try {
      departments = (await fetchDepartments(true)).departments;
    } catch (cause) {
      if (classifyMutationFailure(cause).evidence === 'unauthorized') {
        onUnauthorized(cause);
        busyRef.current = false;
        if (mounted.current) {
          setBusy(null);
          setRecovery(null);
        }
        return;
      }
    }
    busyRef.current = false;
    if (!mounted.current) return;
    setBusy(null);
    applyConclusion(op, mode, analyse(op, mode, departments));
  };

  const submit = async (op: Op) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(op.kind);
    setRecovery(null);
    setProblems(noProblems);
    setMessages([{ key: op.kind === 'create' ? 'inflight.create' : 'inflight.rename' }]);
    try {
      const department =
        op.kind === 'create'
          ? await createDepartment({ slug: op.slug, name: op.name }, csrfRef.current)
          : await renameDepartment(op.id, { slug: op.slug, name: op.name }, csrfRef.current);
      busyRef.current = false;
      if (!mounted.current) return;
      setBusy(null);
      confirmed(department, op);
    } catch (cause) {
      const failure = classifyMutationFailure(cause);
      if (failure.evidence === 'unauthorized') {
        busyRef.current = false;
        onUnauthorized(cause);
        if (mounted.current) {
          setBusy(null);
          setMessages([]);
        }
        return;
      }
      if (failure.evidence === 'rejected') {
        if (failure.status === 403) {
          // The CSRF check runs before any write, so nothing was applied. Refresh the token only.
          try {
            csrfRef.current = await refreshCsrf();
          } catch {
            /* the shell reports a token failure; the user can still try again */
          }
          busyRef.current = false;
          if (!mounted.current) return;
          setBusy(null);
          setMessages([]);
          const key: MessageKey =
            op.kind === 'create' ? 'rejected.create.csrf' : 'rejected.rename.csrf';
          newProblems([{ key, text: messageText({ key }) }]);
          return;
        }
        if (failure.status === 404 && op.kind === 'rename') {
          busyRef.current = false;
          if (!mounted.current) return;
          setBusy(null);
          setForm(null);
          setProblems(noProblems);
          setMessages([{ key: 'rejected.rename.notFound' }]);
          refreshAfter({ kind: 'heading' });
          return;
        }
        if (failure.status === 409 && op.kind === 'create') {
          busyRef.current = false;
          if (!mounted.current) return;
          setBusy(null);
          setMessages([]);
          newProblems(
            [
              {
                key: 'rejected.create.slugTaken',
                field: 'slug',
                text: messageText({ key: 'rejected.create.slugTaken' }),
              },
            ],
            'slug',
          );
          return;
        }
        if (failure.status === 409 && op.kind === 'rename') {
          // The two possible causes are not distinguishable from the response: read state back.
          busyRef.current = false;
          if (!mounted.current) return;
          setBusy(null);
          setMessages([]);
          await recheck(op, 'conflict');
          return;
        }
        if (failure.status === 422) {
          busyRef.current = false;
          if (!mounted.current) return;
          setBusy(null);
          setMessages([]);
          const key: MessageKey =
            op.kind === 'create' && failure.code === 'limit'
              ? 'rejected.create.limit'
              : op.kind === 'create'
                ? 'rejected.create.invalidInput'
                : 'rejected.rename.invalidInput';
          newProblems([{ key, text: messageText({ key }) }]);
          return;
        }
      }
      // Unknown outcome: no success or failure claim, no retry, only a read-only recheck.
      busyRef.current = false;
      if (!mounted.current) return;
      setBusy(null);
      setMessages([]);
      setRecovery({
        op,
        mode: 'unknown',
        checking: false,
        conclusion: {
          messages: [
            { key: op.kind === 'create' ? 'unknown.create.outcome' : 'unknown.rename.outcome' },
          ],
          actions: ['checkAgain'],
          blocking: true,
          closeForm: false,
          slugProblem: null,
          current: null,
          settled: false,
        },
      });
    }
  };

  const runAction = (action: RecoveryAction) => {
    if (!recovery) return;
    const { op, mode, conclusion } = recovery;
    if (action === 'checkAgain') return void recheck(op, mode);
    if (action === 'tryAgain') return void submit(op);
    if (action === 'close') {
      setMessages(conclusion.messages);
      setRecovery(null);
      setForm(null);
      refreshAfter({ kind: 'new' });
      return;
    }
    if (action === 'editValues') {
      // An explicit transition: the visible values become a NEW request. The earlier outcome stays unknown.
      setMessages([
        { key: op.kind === 'create' ? 'unknown.create.newRequest' : 'unknown.rename.newRequest' },
      ]);
      setRecovery(null);
      setForm((current) => ({ ...formForOp(op, current), autoFocus: false }));
      window.requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>('.dept-form input')?.focus(),
      );
      return;
    }
    if (action === 'editCurrent' && conclusion.current && op.kind === 'rename') {
      setMessages([]);
      setRecovery(null);
      openForm({ mode: 'rename', id: op.id, seed: conclusion.current, autoFocus: true });
    }
  };

  // While a saved operation can still be retried, its form is frozen: the visible values ARE the
  // operation that "Try again" sends. Changing them requires the explicit "Edit values instead".
  const blocking = recovery?.conclusion.blocking === true;
  const frozen = blocking || recovery?.conclusion.actions.includes('tryAgain') === true;
  const blockedCreate = blocking && recovery?.op.kind === 'create';
  const frozenCreate = frozen && recovery?.op.kind === 'create';
  const blockedRenameId = blocking && recovery?.op.kind === 'rename' ? recovery.op.id : null;
  const frozenRenameId = frozen && recovery?.op.kind === 'rename' ? recovery.op.id : null;
  const idle = busy === null;
  const status = recovery ? recovery.conclusion.messages : messages;
  const target =
    recovery?.op.kind === 'rename'
      ? `Department: ${recovery.op.previous.name}`
      : recovery
        ? `New department: ${recovery.op.name}`
        : null;

  const closeForm = () => {
    const request: FocusRequest =
      form?.mode === 'rename' && form.id ? { kind: 'rename', id: form.id } : { kind: 'new' };
    setForm(null);
    setProblems(noProblems);
    window.requestAnimationFrame(() => {
      (request.kind === 'rename'
        ? (renameButtons.current.get(request.id) ?? newButtonRef.current)
        : newButtonRef.current
      )?.focus();
    });
  };

  const rows = list.status === 'ready' ? list.data.departments : [];
  const names = new Map<string, number>();
  for (const item of rows) names.set(item.name, (names.get(item.name) ?? 0) + 1);
  const onlyArchived = rows.length > 0 && rows.every((item) => item.archivedAt !== null);
  const ready = list.status === 'ready';

  return (
    <div className="agents-workspace dept-workspace">
      <div className="dept-status" role="status">
        <span className="sr-only">{announcement}</span>
        {status.map((message) => (
          <Message key={message.key} message={message} />
        ))}
        {target && recovery && !recovery.checking && (
          <p className="dept-target">
            <Text>{target}</Text>
          </p>
        )}
      </div>
      {recovery && !recovery.checking && recovery.conclusion.actions.length > 0 && (
        <div className="dept-recovery">
          {recovery.conclusion.actions.includes('tryAgain') && (
            <p className="dept-target">
              <Text>{`${recovery.op.kind === 'create' ? 'Try creating again' : 'Try again'} will send: name ${recovery.op.name}, slug ${recovery.op.slug}.`}</Text>
            </p>
          )}
          {recovery.conclusion.actions.map((action) => (
            <button
              key={action}
              type="button"
              className={action === 'tryAgain' ? 'primary-button' : 'secondary-button'}
              disabled={!idle}
              onClick={() => runAction(action)}
            >
              {actionLabel(
                action,
                recovery.op,
                recovery.mode === 'unknown' &&
                  recovery.conclusion.messages.some((m) => m.key.endsWith('.outcome')),
              )}
            </button>
          ))}
        </div>
      )}

      {route.kind === 'malformed' ? (
        <>
          <h2 ref={headingRef} tabIndex={-1}>
            This link isn't valid
          </h2>
          <Notice title="This link isn't valid">
            <p>
              <a href="#departments">Back to the department directory</a>
            </p>
          </Notice>
        </>
      ) : (
        <div className="agents-directory">
          <a className="agents-back" href="#agents">
            <span aria-hidden="true">←</span>
            <span className="agents-back-label">Back to Agents</span>
          </a>
          <h2 ref={headingRef} tabIndex={-1}>
            Department directory
          </h2>
          <div className="agents-toolbar">
            <div className="agents-check">
              <input
                id="dept-show-archived"
                type="checkbox"
                checked={archived}
                onChange={(event) => toggleArchived(event.target.checked)}
              />
              <label htmlFor="dept-show-archived">Show archived</label>
            </div>
            {ready && (
              <button
                ref={newButtonRef}
                type="button"
                className="primary-button"
                disabled={!idle || blockedCreate}
                aria-expanded={form?.mode === 'create'}
                onClick={() =>
                  form?.mode === 'create'
                    ? closeForm()
                    : openForm({ mode: 'create', seed: { name: '', slug: '' }, autoFocus: true })
                }
              >
                <Plus size={15} aria-hidden="true" /> New department
              </button>
            )}
          </div>
          <p className="agents-legend">
            Departments group agents. Archived departments can't be changed or reused, and an
            archived department keeps its slug.
          </p>

          {form?.mode === 'create' && (
            <DepartmentForm
              key={form.nonce}
              mode="create"
              heading="New department"
              initial={form.seed}
              pending={busy === 'create'}
              locked={!idle || frozenCreate}
              problems={problems}
              submitLabel={
                problems.items.some((item) => item.key === 'rejected.create.csrf')
                  ? 'Try again'
                  : 'Create department'
              }
              autoFocus={form.autoFocus}
              onSubmit={(value) => void submit({ kind: 'create', ...value })}
              onCancel={closeForm}
            />
          )}

          {list.status === 'loading' && <Loading resource="departments" />}
          {list.status === 'error' && awaitingRefresh && (
            <div className="resource-failure" role="alert">
              <div>
                <p data-message-key="confirmed.listStale">
                  {messageText({ key: 'confirmed.listStale' })}
                </p>
              </div>
              <button type="button" className="secondary-button" onClick={reload}>
                Refresh list
              </button>
            </div>
          )}
          {list.status === 'error' && !awaitingRefresh && list.error.kind === 'forbidden' && (
            <Notice title="You don't have access to departments." />
          )}
          {list.status === 'error' && !awaitingRefresh && list.error.kind !== 'forbidden' && (
            <Failure resource="Departments" message={list.error.message} onRetry={reload} />
          )}
          {ready && (
            <>
              <p className="agents-count">
                {list.data.total} {list.data.total === 1 ? 'department' : 'departments'}
                {archived ? ' (including archived)' : ''}
              </p>
              {rows.length === 0 ? (
                <div className="agents-notice">
                  <strong>
                    {archived
                      ? 'No departments yet.'
                      : 'No active departments. Turn on Show archived to check for archived departments.'}
                  </strong>
                </div>
              ) : (
                <>
                  {onlyArchived && (
                    <Notice
                      title="No active departments."
                      detail="All departments shown here are archived."
                    />
                  )}
                  <ul className="dept-list" aria-label="Departments">
                    {rows.map((item) => (
                      <li key={item.id} className="dept-row">
                        {form?.mode === 'rename' && form.id === item.id ? (
                          <DepartmentForm
                            key={form.nonce}
                            mode="rename"
                            heading="Rename department"
                            initial={form.seed}
                            pending={busy === 'rename'}
                            locked={!idle || frozenRenameId === item.id}
                            problems={problems}
                            submitLabel={
                              problems.items.some((p) => p.key === 'rejected.rename.csrf')
                                ? 'Try again'
                                : 'Save changes'
                            }
                            note="Edits are saved as typed. If this department was changed elsewhere, your change replaces it."
                            autoFocus={form.autoFocus}
                            onSubmit={(value) =>
                              void submit({
                                kind: 'rename',
                                id: item.id,
                                previous: { slug: item.slug, name: item.name },
                                ...value,
                              })
                            }
                            onCancel={closeForm}
                          />
                        ) : (
                          <DepartmentRow
                            department={item}
                            duplicateName={(names.get(item.name) ?? 0) > 1}
                            disabled={!idle || blockedRenameId === item.id}
                            registerHeading={(el) =>
                              el
                                ? rowHeadings.current.set(item.id, el)
                                : rowHeadings.current.delete(item.id)
                            }
                            registerRename={(el) =>
                              el
                                ? renameButtons.current.set(item.id, el)
                                : renameButtons.current.delete(item.id)
                            }
                            onRename={() =>
                              openForm({
                                mode: 'rename',
                                id: item.id,
                                seed: { name: item.name, slug: item.slug },
                                autoFocus: true,
                              })
                            }
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DepartmentRow({
  department,
  duplicateName,
  disabled,
  registerHeading,
  registerRename,
  onRename,
}: {
  department: Department;
  duplicateName: boolean;
  disabled: boolean;
  registerHeading: (element: HTMLElement | null) => void;
  registerRename: (element: HTMLButtonElement | null) => void;
  onRename: () => void;
}) {
  const isArchived = department.archivedAt !== null;
  return (
    <>
      <div className="dept-main">
        <h3 ref={registerHeading} tabIndex={-1}>
          <Text>{department.name}</Text>
        </h3>
        <p className="dept-slug">
          <span className="dept-label">Slug</span>{' '}
          <span className="agents-mono">
            <Text>{department.slug}</Text>
          </span>
          {duplicateName && (
            <span className="sr-only"> (another department has the same name)</span>
          )}
        </p>
        {department.archivedAt && (
          <p className="dept-archived">
            <span className="agents-badge agents-badge-archived">
              <Archive size={13} aria-hidden="true" /> Archived
            </span>{' '}
            <span className="agents-muted">{formatManila(department.archivedAt)}</span>
          </p>
        )}
        <p className="dept-times agents-muted">
          Created {formatManila(department.createdAt)} · Updated{' '}
          {formatManila(department.updatedAt)}
        </p>
      </div>
      {isArchived ? (
        <p className="dept-fixed agents-muted">Archived departments can't be changed.</p>
      ) : (
        <div className="dept-actions">
          <button
            ref={registerRename}
            type="button"
            className="secondary-button"
            disabled={disabled}
            aria-label={
              duplicateName
                ? `Rename ${department.name}, slug ${department.slug}`
                : `Rename ${department.name}`
            }
            onClick={onRename}
          >
            Rename
          </button>
        </div>
      )}
    </>
  );
}

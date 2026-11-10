import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Epic, TaskEpicAssociation, TaskEpicResponse } from '@omnis/contracts';
import { ApiRequestError } from '../../api.js';
import { Field, NxButton, NxSelect } from '../../design/index.js';
import { Notice } from '../parts.js';
import { fetchEpics, fetchTaskEpic, setTaskEpic } from './data.js';
import { PlanningDialog } from './PlanningDialog.js';
import { judgeAssociation, type Observation } from './recovery.js';
import { usePagedList } from './usePagedList.js';
import { useWriter } from './write.js';
import type { EpicTaskRef } from './EpicTasks.js';

type Action = 'retry' | 'check' | 'useLatest' | 'close';
type Problem = {
  tone: 'error' | 'warning';
  text: string;
  actions: Action[];
  latest?: TaskEpicResponse;
};

type Props = {
  task: EpicTaskRef | null;
  projectId: string;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
  /** `epic` is the epic the task is now in, or null when it was cleared. */
  onSaved: (task: EpicTaskRef, epic: Epic | null, association: TaskEpicAssociation) => void;
  onClose: () => void;
};

/**
 * Set or clear the epic of one task. The task's current epic and association revision are read
 * fresh when the dialog opens, and the write is conditional on that revision, so a stale screen
 * can never overwrite a newer assignment. Moving a task between epics is one write.
 */
export function TaskEpicDialog({
  task,
  projectId,
  csrfToken,
  refreshCsrf,
  onUnauthorized,
  onSaved,
  onClose,
}: Props) {
  const open = task !== null;
  const [current, setCurrent] = useState<
    | { status: 'loading' }
    | { status: 'ready'; value: TaskEpicResponse }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [choice, setChoice] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const target = useRef<string | null>(null);
  const writer = useWriter({ csrfToken, refreshCsrf, onUnauthorized });
  const epics = usePagedList<Epic>(
    `task-epics:${projectId}`,
    open,
    (cursor, signal) =>
      fetchEpics(projectId, cursor, signal).then((result) => ({
        items: result.epics,
        page: result.page,
      })),
    onUnauthorized,
  );

  useEffect(() => {
    if (!task) return undefined;
    const abort = new AbortController();
    setCurrent({ status: 'loading' });
    setProblem(null);
    fetchTaskEpic(task.id, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        if (value.projectId !== projectId) {
          setCurrent({ status: 'error', message: 'This task does not belong to this project.' });
          return;
        }
        setCurrent({ status: 'ready', value });
        setChoice(value.epic?.id ?? '');
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 401) return onUnauthorized(cause);
        setCurrent({
          status: 'error',
          message:
            cause instanceof ApiRequestError && cause.status === 404
              ? 'This task was not found.'
              : 'The task’s current epic could not be loaded.',
        });
      });
    return () => abort.abort();
    // Opening a different task, or retrying, reads again.
  }, [task?.id, attempt]);

  const rev = current.status === 'ready' ? current.value.associationRevision : 0;
  const currentEpic = current.status === 'ready' ? current.value.epic : null;

  const options = epics.state.items.filter(
    (epic) => epic.status !== 'archived' || epic.id === currentEpic?.id,
  );

  async function readLatest(): Promise<Observation<TaskEpicResponse>> {
    if (!task) return { kind: 'failed' };
    try {
      return { kind: 'record', value: await fetchTaskEpic(task.id) };
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) onUnauthorized(cause);
      return cause instanceof ApiRequestError && cause.status === 404
        ? { kind: 'absent' }
        : { kind: 'failed' };
    }
  }

  const epicTitle = (id: string | null) =>
    id === null ? null : (options.find((epic) => epic.id === id) ?? null);

  async function inspect(afterConflict: boolean) {
    if (!task || current.status !== 'ready') return;
    setChecking(true);
    const observation = await readLatest();
    setChecking(false);
    const verdict = judgeAssociation(rev, target.current, observation);
    const latest = observation.kind === 'record' ? observation.value : undefined;
    if (verdict === 'applied' && latest) {
      // The task now shows the requested epic at the next revision: observed state, which another
      // session could have produced, so it is reported as what the server shows.
      onSaved(task, latest.epic, {
        taskId: latest.taskId,
        projectId: latest.projectId,
        epicId: latest.epic?.id ?? null,
        associationRevision: latest.associationRevision,
      });
      return;
    }
    if (verdict === 'not-applied')
      setProblem({
        tone: 'warning',
        text: afterConflict
          ? 'The server reported a conflict, but this task is still at the revision you opened. Nothing was changed. You can save again.'
          : 'This task is still at the revision you opened, so the change was not applied. You can save again.',
        actions: ['retry', 'check', 'close'],
      });
    else if (verdict === 'changed' && latest)
      setProblem({
        tone: 'warning',
        latest,
        text: `This task’s epic was changed elsewhere. It is now ${latest.epic ? `in “${latest.epic.title}”` : 'not in any epic'} (revision ${latest.associationRevision}). Use the latest assignment, then choose again.`,
        actions: ['useLatest', 'close'],
      });
    else if (verdict === 'absent')
      setProblem({ tone: 'error', text: 'This task no longer exists.', actions: ['close'] });
    else
      setProblem({
        tone: 'warning',
        text: 'The current assignment could not be read, so Omnis OS cannot tell whether the change was applied. Check again before saving anything else.',
        actions: ['check', 'close'],
      });
  }

  async function save(epicId: string | null) {
    if (!task || current.status !== 'ready') return;
    target.current = epicId;
    setProblem(null);
    const outcome = await writer.run(JSON.stringify({ task: task.id, rev, epicId }), (key, csrf) =>
      setTaskEpic(task.id, rev, epicId, key, csrf),
    );
    if (outcome.kind === 'saved')
      return onSaved(task, epicId === null ? null : (epicTitle(epicId) ?? null), outcome.value);
    if (outcome.kind === 'busy' || outcome.kind === 'unauthorized') return;
    if (outcome.kind === 'unknown')
      return setProblem({
        tone: 'warning',
        text: 'Omnis OS did not get a confirmed result, so the assignment is not shown as changed and may or may not have been applied. Check the current state, or send the same request again, which cannot apply it twice.',
        actions: ['retry', 'check', 'close'],
      });
    if (outcome.status === 409) return inspect(true);
    setProblem({
      tone: 'error',
      text:
        outcome.status === 403
          ? 'Your secure session needed refreshing. Nothing was changed. Try again.'
          : outcome.status === 404
            ? 'This task or epic was not found, so nothing was changed.'
            : 'The server rejected this change, so nothing was changed.',
      actions: [],
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (writer.busy || checking || current.status !== 'ready') return;
    const epicId = choice === '' ? null : choice;
    if (epicId === (currentEpic?.id ?? null)) {
      setProblem({
        tone: 'error',
        text: currentEpic ? 'The task is already in that epic.' : 'The task is not in any epic.',
        actions: [],
      });
      return;
    }
    void save(epicId);
  }

  const busy = writer.busy || checking;
  const act = (action: Action) => {
    if (action === 'retry') void save(target.current);
    else if (action === 'check') void inspect(false);
    else if (action === 'useLatest' && problem?.latest) {
      writer.settle();
      setCurrent({ status: 'ready', value: problem.latest });
      setChoice(problem.latest.epic?.id ?? '');
      setProblem(null);
    } else onClose();
  };
  const label: Record<Action, string> = {
    retry: 'Send the same request again',
    check: 'Check current state',
    useLatest: 'Use latest assignment',
    close: 'Close',
  };

  return (
    <PlanningDialog open={open} title="Set the epic for a task" onCancel={() => !busy && onClose()}>
      {task && (
        <form className="pw-form pw-dialog-form" onSubmit={submit} noValidate>
          <p>
            <span className="pw-title">{task.title}</span>
          </p>
          {current.status === 'loading' && (
            <Notice tone="progress">Loading the task’s current epic…</Notice>
          )}
          {current.status === 'error' && (
            <Notice
              tone="error"
              actions={
                <NxButton onClick={() => setAttempt((value) => value + 1)}>Try again</NxButton>
              }
            >
              {current.message}
            </Notice>
          )}
          {current.status === 'ready' && (
            <>
              <p className="nx-muted pw-revision">
                {currentEpic ? `Currently in “${currentEpic.title}”.` : 'Not in any epic.'} Changes
                are saved only if this assignment has not changed since (revision {rev}).
              </p>
              <Field label="Epic">
                {(control) => (
                  <NxSelect
                    {...control}
                    value={choice}
                    onChange={(event) => {
                      setChoice(event.target.value);
                      setProblem(null);
                    }}
                  >
                    <option value="">No epic</option>
                    {options.map((epic) => (
                      <option key={epic.id} value={epic.id}>
                        {epic.title}
                        {epic.status === 'archived' ? ' (archived)' : ''}
                      </option>
                    ))}
                  </NxSelect>
                )}
              </Field>
              {epics.state.first.status === 'error' && (
                <Notice
                  tone="error"
                  actions={<NxButton onClick={epics.reload}>Reload epics</NxButton>}
                >
                  The epics could not be loaded, so only “No epic” and the current epic are offered.
                </Notice>
              )}
              {epics.state.page && !epics.state.page.complete && (
                <Notice
                  tone="static"
                  actions={
                    <NxButton busy={epics.state.loadingMore} onClick={epics.loadMore}>
                      Load more epics
                    </NxButton>
                  }
                >
                  Only the first {epics.state.items.length} of {epics.state.page.observedTotal}{' '}
                  epics are listed.
                </Notice>
              )}
            </>
          )}
          <div aria-live="polite">
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
            <NxButton type="button" disabled={busy} onClick={onClose}>
              Cancel
            </NxButton>
            <NxButton
              type="submit"
              variant="primary"
              busy={writer.busy}
              disabled={busy || current.status !== 'ready'}
            >
              Save epic
            </NxButton>
          </div>
        </form>
      )}
    </PlanningDialog>
  );
}

import { useEffect, useState } from 'react';
import type { Epic, Milestone } from '@omnis/contracts';
import { ApiRequestError } from '../../api.js';
import { NxButton } from '../../design/index.js';
import { Notice } from '../parts.js';
import { PlanningDialog } from './PlanningDialog.js';
import { judgeEdit, type Observation } from './recovery.js';
import { useWriter } from './write.js';

type Rec = Epic | Milestone;
type Action = 'retry' | 'check' | 'show' | 'closeAndReload' | 'close';
type Problem = { tone: 'error' | 'warning'; text: string; actions: Action[]; latest?: Rec };

type Props<T extends Rec> = {
  noun: 'epic' | 'milestone';
  /** The record to archive; null keeps the dialog closed. */
  record: T | null;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
  archive: (record: T, key: string, csrfToken: string) => Promise<T>;
  read: (id: string) => Promise<T>;
  /** The record is archived: confirmed by the server, or observed that way. */
  onArchived: (record: T) => void;
  /** A newer copy was read and should replace the one shown. */
  onLatest: (record: T) => void;
  onClose: (reload: boolean) => void;
};

/**
 * Archiving is permanent: there is no restore action in the API. The record stays readable.
 * Failures keep the dialog open and say only what the evidence shows.
 */
export function ArchiveDialog<T extends Rec>({
  noun,
  record,
  csrfToken,
  refreshCsrf,
  onUnauthorized,
  archive,
  read,
  onArchived,
  onLatest,
  onClose,
}: Props<T>) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [checking, setChecking] = useState(false);
  const writer = useWriter({ csrfToken, refreshCsrf, onUnauthorized });
  useEffect(() => setProblem(null), [record?.id, record?.revision]);

  async function readLatest(target: T): Promise<Observation<T>> {
    try {
      return { kind: 'record', value: await read(target.id) };
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) onUnauthorized(cause);
      return cause instanceof ApiRequestError && cause.status === 404
        ? { kind: 'absent' }
        : { kind: 'failed' };
    }
  }

  async function inspect(target: T) {
    setChecking(true);
    const observation = await readLatest(target);
    setChecking(false);
    const verdict = judgeEdit(target.revision, observation, (value) => value.status === 'archived');
    const latest = observation.kind === 'record' ? observation.value : undefined;
    if ((verdict === 'applied' || verdict === 'archived') && latest?.status === 'archived') {
      onArchived(latest);
      return;
    }
    if (verdict === 'not-applied')
      setProblem({
        tone: 'warning',
        text: `This ${noun} is still at the revision you opened and is not archived, so nothing was archived. You can try again.`,
        actions: ['retry', 'check', 'close'],
      });
    else if (verdict === 'changed' && latest)
      setProblem({
        tone: 'warning',
        latest,
        text: `This ${noun} was changed elsewhere (it is now at revision ${latest.revision}) and is not archived. Show the latest version and review it before archiving.`,
        actions: ['show', 'close'],
      });
    else if (verdict === 'absent')
      setProblem({
        tone: 'error',
        text: `This ${noun} no longer exists. The list will be refreshed.`,
        actions: ['closeAndReload'],
      });
    else
      setProblem({
        tone: 'warning',
        text: 'The current state could not be read, so Omnis OS cannot tell whether it was archived. Check again before doing anything else.',
        actions: ['check', 'close'],
      });
  }

  async function run(target: T) {
    setProblem(null);
    const outcome = await writer.run(
      JSON.stringify({ archive: target.id, rev: target.revision }),
      (key, csrf) => archive(target, key, csrf),
    );
    if (outcome.kind === 'saved') return onArchived(outcome.value);
    if (outcome.kind === 'busy' || outcome.kind === 'unauthorized') return;
    if (outcome.kind === 'unknown')
      return setProblem({
        tone: 'warning',
        text: `Omnis OS did not get a confirmed result, so this ${noun} is not shown as archived and the change may or may not have been applied. Check the current state, or send the same request again, which cannot apply it twice.`,
        actions: ['retry', 'check', 'close'],
      });
    if (outcome.status === 409) return inspect(target);
    if (outcome.status === 404)
      return setProblem({
        tone: 'error',
        text: `This ${noun} or its project was not found. The list will be refreshed.`,
        actions: ['closeAndReload'],
      });
    setProblem({
      tone: 'error',
      text:
        outcome.status === 403
          ? 'Your secure session needed refreshing. Nothing was changed. Try again.'
          : 'The server rejected this request, so nothing was archived.',
      actions: ['close'],
    });
  }

  const busy = writer.busy || checking;
  const target = record;
  const act = (action: Action) => {
    if (!target) return;
    if (action === 'retry') void run(target);
    else if (action === 'check') void inspect(target);
    else if (action === 'show' && problem?.latest) onLatest(problem.latest as T);
    else onClose(action === 'closeAndReload');
  };
  const label: Record<Action, string> = {
    retry: 'Send the same request again',
    check: 'Check current state',
    show: 'Show latest version',
    closeAndReload: 'Close and refresh the list',
    close: 'Close',
  };

  return (
    <PlanningDialog
      open={target !== null}
      title={`Archive this ${noun}?`}
      onCancel={() => !busy && onClose(false)}
    >
      {target && (
        <>
          <p className="nx-muted">
            Archiving “{target.title}” cannot be undone. There is no restore action. It stays
            readable, but it can no longer be edited.
            {noun === 'epic' && ' Tasks already assigned to it keep their assignment.'}
          </p>
          {busy && (
            <Notice tone="progress">
              {checking ? 'Checking the latest state…' : 'Archiving…'}
            </Notice>
          )}
          {problem && (
            <Notice
              tone={problem.tone}
              actions={problem.actions.map((action) => (
                <NxButton key={action} disabled={busy} onClick={() => act(action)}>
                  {label[action]}
                </NxButton>
              ))}
            >
              {problem.text}
            </Notice>
          )}
          <div className="nx-dialog__actions">
            <NxButton autoFocus disabled={busy} onClick={() => onClose(false)}>
              Cancel
            </NxButton>
            <NxButton
              variant="danger"
              busy={writer.busy}
              disabled={busy || problem !== null}
              onClick={() => void run(target)}
            >
              Archive {noun}
            </NxButton>
          </div>
        </>
      )}
    </PlanningDialog>
  );
}

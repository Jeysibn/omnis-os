import { useEffect, useId, useRef, useState } from 'react';
import { BadgeCheck, Check, Hourglass } from 'lucide-react';
import type { Run, Task } from '@omnis/contracts';
import {
  acceptanceAttempts,
  acceptanceViewFor,
  acceptTaskResult,
  classifyAcceptanceFailure,
} from './acceptResult.js';
import { formatManilaWithZone } from './manilaTime.js';

type Problem = { kind: 'conflict' | 'uncertain' | 'rejected'; message: string };

/**
 * Owner review of a finished synthetic run. Accepting is deliberate (two steps), shows progress,
 * and reports success only from the server's own response. Nothing here is automatic: a completed
 * run never accepts itself.
 */
export function AcceptResultAction({
  ownerId,
  task,
  run,
  runs,
  csrfToken,
  onAccepted,
  onSessionExpired,
  onStale,
}: {
  ownerId: string;
  task: Task | null | undefined;
  run: Run;
  runs: readonly Run[];
  csrfToken: string;
  /** The server's task (status `completed` with its receipt). */
  onAccepted: (task: Task) => void;
  onSessionExpired: (cause: unknown) => boolean;
  /** A 409: refresh tasks and runs before anything else is offered. */
  onStale: () => void;
}) {
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const view = acceptanceViewFor(task, run, runs);
  const eligible = view.kind === 'eligible' && task;
  const open = confirming && Boolean(eligible);

  // Safe default focus, as in the run-approval dialog: Cancel, never the consequential action.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  // The trigger is replaced by the confirmation while it is open, so focus returns to it once it
  // is back; otherwise a keyboard user would be dropped at the top of the page.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // A different run or task starts from a clean state.
  useEffect(() => {
    setConfirming(false);
    setProblem(null);
  }, [run.id, task?.id]);

  async function submit() {
    if (!task || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const key = acceptanceAttempts.keyFor(ownerId, task.id, run.id);
    try {
      const result = await acceptTaskResult({ task, run, csrfToken, idempotencyKey: key });
      acceptanceAttempts.settle(ownerId, task.id, run.id);
      setConfirming(false);
      onAccepted(result.task);
    } catch (cause) {
      const failure = classifyAcceptanceFailure(cause);
      if (failure.kind === 'unauthorized') {
        // Keep the key: after signing in again the same owner may safely retry the same attempt.
        onSessionExpired(cause);
      } else if (failure.kind === 'uncertain') {
        setProblem({ kind: 'uncertain', message: failure.message });
      } else {
        acceptanceAttempts.settle(ownerId, task.id, run.id);
        setConfirming(false);
        setProblem({ kind: failure.kind, message: failure.message });
        if (failure.kind === 'conflict') onStale();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function cancel() {
    if (busy) return;
    restoreFocus.current = true;
    setConfirming(false);
  }

  if (view.kind === 'none' && !problem) return null;

  return (
    <section className="accept-result" aria-labelledby={headingId}>
      <h3 id={headingId} className="accept-result-title">
        Owner review
      </h3>

      {view.kind === 'eligible' && (
        <>
          <div className="accept-result-pending">
            <Hourglass size={15} aria-hidden="true" />
            <p>
              Awaiting your review. This run finished, but its synthetic output is not accepted and{' '}
              <strong>the task is not completed</strong> until you accept it.
            </p>
          </div>
          {!open && (
            <button
              ref={triggerRef}
              type="button"
              className="primary-button accept-result-button"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              <BadgeCheck size={15} aria-hidden="true" />
              Accept Result
            </button>
          )}
          {open && task && (
            <div
              className="accept-result-confirm"
              role="group"
              aria-label="Confirm result acceptance"
              onKeyDown={(event) => {
                if (event.key === 'Escape') cancel();
              }}
            >
              <p>
                Accept the synthetic result of run <strong>{run.id}</strong> for task{' '}
                <strong>{task.title}</strong>? This marks the task completed and records an owner
                receipt. It cannot be undone.
              </p>
              <div className="accept-result-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void submit()}
                  disabled={busy}
                  aria-busy={busy}
                >
                  <Check size={15} aria-hidden="true" />
                  {busy
                    ? 'Accepting…'
                    : problem?.kind === 'uncertain'
                      ? 'Retry acceptance'
                      : 'Confirm acceptance'}
                </button>
                <button
                  ref={cancelRef}
                  type="button"
                  className="secondary-button"
                  onClick={cancel}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {view.kind === 'accepted' && (
        <div className="accept-result-receipt" role="status">
          <BadgeCheck size={15} aria-hidden="true" />
          <div>
            <p>
              <strong>Result accepted by owner.</strong> The task is completed.
            </p>
            <dl className="metadata-list accept-result-meta">
              <div>
                <dt>Accepted</dt>
                <dd>{formatManilaWithZone(view.acceptance.acceptedAt)}</dd>
              </div>
              <div>
                <dt>Accepted run</dt>
                <dd>{view.acceptance.runId}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      {view.kind === 'historical' && (
        <p className="accept-result-note">
          This task was completed before owner acceptance was recorded, so there is no acceptance
          receipt for this run.
        </p>
      )}

      {view.kind === 'superseded' && (
        <p className="accept-result-note">
          A newer run exists for this task. This earlier result cannot be accepted.
        </p>
      )}

      {busy && (
        <p className="sr-only" role="status">
          Accepting result. Waiting for Omnis OS to confirm.
        </p>
      )}

      {problem && (
        <div className="error-note accept-result-problem" role="alert">
          <p>
            {problem.kind === 'conflict'
              ? `${problem.message} The task and runs were refreshed; review the current state before trying again.`
              : problem.kind === 'uncertain'
                ? `${problem.message} The result may or may not have been accepted. Retrying uses the same request and cannot accept it twice.`
                : problem.message}
          </p>
        </div>
      )}
    </section>
  );
}

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
  gate,
  onConflict,
  onReload,
  getSessionGeneration,
}: {
  ownerId: string;
  task: Task | null | undefined;
  run: Run;
  runs: readonly Run[];
  csrfToken: string;
  /** The server's task (status `completed` with its receipt). */
  onAccepted: (task: Task) => void;
  onSessionExpired: (cause: unknown) => boolean;
  /**
   * Freshness gate, owned by the app (not by this component) so changing the selected task or run
   * cannot clear it. While `refreshing` or `failed`, nothing may be submitted from loaded data.
   */
  gate: { phase: 'idle' | 'refreshing' | 'failed' | 'done'; runId: string | null };
  /** A 409: start the authoritative task+run re-read. */
  onConflict: (runId: string) => void;
  /** Explicit reload after a failed re-read. */
  onReload: (runId: string) => void;
  /** Identifies the login session; differs between sessions even for the same owner. */
  getSessionGeneration: () => number;
}) {
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const receiptRef = useRef<HTMLHeadingElement | null>(null);
  const focusReceipt = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const view = acceptanceViewFor(task, run, runs);
  const blocked = gate.phase === 'refreshing' || gate.phase === 'failed';
  const eligible = view.kind === 'eligible' && !blocked && task;
  const open = confirming && Boolean(eligible);

  // Move focus to the receipt only after the server confirmed and the receipt is on screen.
  useEffect(() => {
    if (view.kind === 'accepted' && focusReceipt.current) {
      focusReceipt.current = false;
      receiptRef.current?.focus();
    }
  }, [view.kind]);

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
    if (!task || inFlight.current || blocked) return;
    inFlight.current = true;
    focusReceipt.current = false;
    setBusy(true);
    setProblem(null);
    // The session this request belongs to. Every outcome is checked against it BEFORE any effect.
    const generation = getSessionGeneration();
    const current = () => mounted.current && generation === getSessionGeneration();
    const key = acceptanceAttempts.keyFor(ownerId, task.id, run.id);
    try {
      const result = await acceptTaskResult({ task, run, csrfToken, idempotencyKey: key });
      // A response for a replaced session is never applied here; the new session reads the server.
      if (!current()) return;
      acceptanceAttempts.settle(ownerId, task.id, run.id);
      setConfirming(false);
      focusReceipt.current = true;
      onAccepted(result.task);
    } catch (cause) {
      if (!current()) return; // a late 401 must not expire the session that replaced this one
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
        if (failure.kind === 'conflict') onConflict(run.id);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
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

      {view.kind === 'eligible' && !blocked && (
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
            <h4 ref={receiptRef} tabIndex={-1} className="accept-result-receipt-title">
              Result accepted by owner.
            </h4>
            <p>The task is completed.</p>
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

      {view.kind !== 'none' && gate.phase === 'refreshing' && (
        <p className="accept-result-note" role="status">
          Refreshing the task and runs from the server. Accept Result is unavailable until this
          finishes.
        </p>
      )}
      {view.kind !== 'none' && gate.phase === 'done' && gate.runId === run.id && (
        <p className="accept-result-note" role="status">
          The task and runs were refreshed from the server. Review the current state before trying
          again.
        </p>
      )}
      {view.kind !== 'none' && gate.phase === 'failed' && (
        <div className="accept-result-note" role="alert">
          <p>
            The task and runs could not be refreshed, so Accept Result stays unavailable until
            current data is loaded.
          </p>
          <button type="button" className="secondary-button" onClick={() => onReload(run.id)}>
            Reload task and runs
          </button>
        </div>
      )}

      {problem && (
        <div className="error-note accept-result-problem" role="alert">
          <p>
            {problem.kind === 'conflict'
              ? problem.message
              : problem.kind === 'uncertain'
                ? `${problem.message} The result may or may not have been accepted. Retrying uses the same request and cannot accept it twice.`
                : problem.message}
          </p>
        </div>
      )}
    </section>
  );
}

import {
  TaskResultAcceptanceResponseSchema,
  type Run,
  type Task,
  type TaskResultAcceptance,
  type TaskResultAcceptanceResponse,
} from '@omnis/contracts';
import { ApiRequestError, request } from './api.js';

/**
 * Owner acceptance of a synthetic result (R1). The backend is the only authority: this module
 * decides what to OFFER, never what is true. Eligibility here is a best-effort mirror of the
 * server rules that the Run/Task payloads expose; the server re-checks everything and answers 409
 * when the offer was stale.
 */

/** The task's latest run: newest `createdAt`, ties broken by id so the choice is deterministic. */
export function latestRunForTask(runs: readonly Run[], taskId: string): Run | null {
  let latest: Run | null = null;
  for (const run of runs) {
    if (run.taskId !== taskId) continue;
    if (
      !latest ||
      run.createdAt > latest.createdAt ||
      (run.createdAt === latest.createdAt && run.id > latest.id)
    )
      latest = run;
  }
  return latest;
}

export type AcceptanceView =
  /** Nothing to say about acceptance for this run. */
  | { kind: 'none' }
  /** The owner may accept this run's result. */
  | { kind: 'eligible' }
  /** A completed run that is not the task's current result; it can never be accepted. */
  | { kind: 'superseded' }
  /** The owner accepted exactly this run's result. */
  | { kind: 'accepted'; acceptance: TaskResultAcceptance }
  /** Task is `completed` but has no receipt for this run (history from before R1). */
  | { kind: 'historical' };

export function acceptanceViewFor(
  task: Task | null | undefined,
  run: Run,
  runs: readonly Run[],
): AcceptanceView {
  if (!task || task.id !== run.taskId) return { kind: 'none' };
  const latest = latestRunForTask(runs, task.id);
  const isLatest = latest?.id === run.id;
  if (run.status !== 'completed') return { kind: 'none' };
  if (!isLatest) return { kind: 'superseded' };
  if (task.status === 'in_review') return { kind: 'eligible' };
  if (task.status === 'completed') {
    // The receipt is shown only for the run it belongs to, never inferred from `run.completed`.
    return task.resultAcceptance && task.resultAcceptance.runId === run.id
      ? { kind: 'accepted', acceptance: task.resultAcceptance }
      : { kind: 'historical' };
  }
  return { kind: 'none' };
}

/**
 * An acceptance attempt keeps one Idempotency-Key for the submission and every retry after an
 * uncertain outcome. The key is dropped only when the outcome is settled (success or a definitive
 * rejection), so a new deliberate attempt never reuses a rejected key.
 */
const attempts = new Map<string, string>();
const attemptId = (ownerId: string, taskId: string, runId: string) =>
  `${ownerId}\u0000${taskId}\u0000${runId}`;

export const acceptanceAttempts = {
  keyFor(ownerId: string, taskId: string, runId: string): string {
    const id = attemptId(ownerId, taskId, runId);
    let key = attempts.get(id);
    if (!key) {
      key = crypto.randomUUID();
      attempts.set(id, key);
    }
    return key;
  },
  settle(ownerId: string, taskId: string, runId: string) {
    attempts.delete(attemptId(ownerId, taskId, runId));
  },
  has(ownerId: string, taskId: string, runId: string) {
    return attempts.has(attemptId(ownerId, taskId, runId));
  },
  clear() {
    attempts.clear();
  },
};

export type AcceptanceFailure =
  | { kind: 'unauthorized' }
  /** Run is stale or not eligible: refresh the task and runs before offering anything again. */
  | { kind: 'conflict'; message: string }
  /** The outcome is unknown; the same key may be retried. */
  | { kind: 'uncertain'; message: string }
  | { kind: 'rejected'; message: string };

export function classifyAcceptanceFailure(cause: unknown): AcceptanceFailure {
  if (!(cause instanceof ApiRequestError))
    return { kind: 'uncertain', message: 'Omnis OS could not confirm the acceptance.' };
  if (cause.status === 401) return { kind: 'unauthorized' };
  if (cause.status === 409) return { kind: 'conflict', message: cause.message };
  // 503 concurrency_limit, other 5xx, network loss and unverifiable responses may have applied.
  if (cause.outcome === 'uncertain' || cause.outcome === 'invalid-response')
    return { kind: 'uncertain', message: cause.message };
  return { kind: 'rejected', message: cause.message };
}

export function acceptTaskResult(input: {
  task: Task;
  run: Run;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<TaskResultAcceptanceResponse> {
  const { task, run, csrfToken, idempotencyKey } = input;
  return request(
    `/api/v1/tasks/${encodeURIComponent(task.id)}/accept-result`,
    {
      method: 'POST',
      headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ runId: run.id }),
    },
    (value) => {
      const parsed = TaskResultAcceptanceResponseSchema.parse(value);
      // A response about another task/run is not confirmation of this acceptance.
      if (parsed.task.id !== task.id || parsed.acceptance.runId !== run.id)
        throw new Error('Acceptance response does not match the request.');
      if (parsed.task.status !== 'completed') throw new Error('Task was not completed.');
      return parsed;
    },
  );
}

# Phase 1 Backend to Frontend Handoff

**Status:** Current backend contract for Claude's frontend implementation.
**Scope:** PostgreSQL-backed task and Run lifecycle, owner result acceptance, and reconciliation.

## Task and Run states

Task state is one of:

- `open`: ready for work.
- `in_progress`: work is underway.
- `in_review`: the latest Run completed and its result awaits owner acceptance.
- `completed`: the Task is complete. New completions follow owner acceptance; preserved legacy completed Tasks may have no acceptance receipt.

Run state is one of:

- `queued`: durably admitted and waiting for a worker.
- `running`: a worker owns an active execution lease.
- `stopping`: stop was requested; terminal outcome is pending.
- `completed`, `cancelled`, `failed`, or `interrupted`: terminal outcomes.
- `unknown`: the outcome could not be verified; it remains unresolved and must not be shown as completed or failed.

Runs in this Phase 1 API are explicitly `runtimeKind: "mock"` and `synthetic: true`. A completed Run is not an accepted Task.

## Result acceptance

An acceptance can be created only by the authenticated owner through the API and authorizer boundary. The requested Run must be the Task's latest Run and must be completed, synthetic mock work with persisted output and no active lease. Failed, cancelled, stale, or unresolved Runs are not eligible.

The database stores one immutable receipt per accepted Task/Run pair. It records `runId`, `acceptedBy: "owner"`, `acceptedAt`, and the original UUID `requestId`. Repeating a request returns `created: false`; it does not replace or duplicate the receipt. A later Run can have its own receipt while earlier receipts remain immutable. Preserved legacy completed Tasks can have `resultAcceptance: null`; show a receipt only when one is returned.

If the same accepted Run is still the latest eligible result and a permitted runtime transition has left its Task in `in_review`, an owner-authorized acceptance replay reconciles the Task to `completed`. It emits a new owner `task.status_changed` event for that real transition, leaves the original receipt unchanged, and returns `created: false`. Replaying an older receipt never completes a Task whose latest Run is newer. Direct runtime completion remains denied.

## API contract

`POST /api/v1/tasks/:taskId/accept-result`

- Headers: owner session, CSRF token, and `Idempotency-Key` containing a UUID.
- Body: `{ "runId": "<run id>" }`.
- Success: HTTP 200 with `{ "task": Task, "acceptance": TaskResultAcceptance, "created": boolean }`.
- The returned `acceptance` is the receipt requested. `task.resultAcceptance` is the receipt for the Task's current latest Run, or `null` if that Run has no receipt.
- A newly accepted result returns `created: true`. Exact or safe replay returns `created: false`, including reconciliation.

Expected errors:

| HTTP | `error.code`                      | Meaning                                                                                                                                       |
| ---- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid_input`                   | Invalid Task ID, Run ID, UUID idempotency key, or body.                                                                                       |
| 401  | `unauthorized`                    | No valid owner session or invalid internal API-to-authorizer authentication.                                                                  |
| 403  | `csrf_rejected`                   | Owner mutation lacks valid CSRF protection.                                                                                                   |
| 404  | `not_found`                       | Task does not exist.                                                                                                                          |
| 409  | `conflict`                        | Task is not awaiting acceptance, the Run is stale/ineligible, or the idempotency identity conflicts.                                          |
| 503  | `concurrency_limit`               | Bounded Mission Lane writer admission is busy; retry the same owner request.                                                                  |
| 503  | `task_acceptance_outcome_unknown` | The authorizer response was lost or invalid and acceptance may have committed; read Task state before retrying with the same idempotency key. |
| 503  | `authorizer_unavailable`          | The authorizer or its database is unavailable; read Task state before deciding whether to retry.                                              |

The frontend should not infer success from Run status or a timed-out request. It should read the returned Task on success and refresh task/run state after an ambiguous 503 before retrying with the same idempotency key.

## Refresh and reconciliation guidance for Claude

- Treat PostgreSQL-backed API responses as canonical after refresh, route navigation, or stream reconnect.
- Display a receipt by its `runId`; do not infer acceptance from `Run.status === "completed"`.
- If a Task is `in_review` while its latest Run already has `resultAcceptance`, present the receipt as existing. Offer an explicit owner reconciliation action that calls the acceptance endpoint for that same `runId`; do not create another receipt or mark the Task complete locally.
- Replace local Task state with `response.task` after acceptance/reconciliation. Then refresh the latest Run and event history so the owner transition appears in order.
- Preserve the distinction between `unknown` and terminal success/failure. Never make synthetic Run activity look like provider activity.

Frontend implementation and browser tests remain Claude's responsibility. This backend change does not modify frontend-owned files or add an API route or response field.

# Phase 1 R1 — Owner-Verified Task Result Acceptance

**Baseline:** `2a3524ee308d3aba3f5a613af8879f43f7d73de5`
**Status:** Backend implementation on `codex/r1-owner-acceptance`; independent review and CI pending.
**Scope:** Mock-only task result acceptance. This does not authorize real-provider execution, Phase A experiments, live Stage 1 integration, physical fixture release, or deployment.

## Approved lifecycle

A successful synthetic run now leaves its task in `in_review`. The worker records a successful run and output but does not mark the task completed. An authenticated owner explicitly accepts the current eligible run. Acceptance changes the task to `completed` and records an immutable receipt with `runId`, `acceptedBy: "owner"`, server-generated `acceptedAt`, and the request idempotency key. The receipt table retains one row per task/run; `task.resultAcceptance` exposes a receipt only when it belongs to the latest run.

A run is eligible only when all of these are true:

- The task is in `in_review`.
- The requested run is the task's latest run.
- The run status is `completed`, `runtimeKind` is `mock`, and `synthetic` is true.
- A result output exists and the run has no active lease.

A later run moves the task back to `in_progress` and makes the earlier result stale. Failed, cancelled, interrupted, unknown, and superseded results cannot be accepted. No automatic acceptance exists. Existing historical `completed` task rows are unchanged; their `resultAcceptance` is null because the migration does not backfill prior history.

## API contract for Claude #2

`POST /api/v1/tasks/:taskId/accept-result`

Required headers: authenticated owner session cookie, `Origin` matching the configured application origin, `x-omnis-csrf` matching the session token, and a UUID `Idempotency-Key`. Keep the same key when retrying after an uncertain response.

Request:

```json
{ "runId": "run-0001" }
```

Success (`200`):

```json
{
  "task": {
    "id": "task-0001",
    "title": "Example",
    "detail": "...",
    "status": "completed",
    "createdAt": "2026-11-12T00:00:00.000Z",
    "projectId": null,
    "associationRevision": 1,
    "agentId": null,
    "profileVersion": null,
    "runtimeId": null,
    "assignmentRevision": 1,
    "resultAcceptance": {
      "runId": "run-0001",
      "acceptedBy": "owner",
      "acceptedAt": "2026-11-12T00:00:00.000Z",
      "requestId": "00000000-0000-4000-8000-000000000000"
    }
  },
  "acceptance": {
    "runId": "run-0001",
    "acceptedBy": "owner",
    "acceptedAt": "2026-11-12T00:00:00.000Z",
    "requestId": "00000000-0000-4000-8000-000000000000"
  },
  "created": true
}
```

A replay for the already accepted same run returns the original receipt with `created: false`, including when retried with a different request key. A task can be re-run under the existing standard mock admission path; the new run has its own receipt and prior receipts remain immutable. An unaccepted stale run or a different run that is not the current eligible result conflicts.

Errors use the existing `{ "error": { "code", "message" } }` response envelope:

- `400 invalid_input`: malformed task ID, body, or idempotency key.
- `401 unauthorized`: no valid owner session.
- `403 csrf`: invalid origin or CSRF token.
- `404 not_found`: task does not exist.
- `409 conflict`: task is not awaiting review, run is not the latest eligible result, or another result has already been accepted.
- `503 concurrency_limit`: Mission Lane writer admission timed out or is full; retry with the same key.

## UI behavior

Render `in_review` as an explicit pending-owner-review state. Show the associated synthetic run result and provide an explicit confirmation step before accepting. While submitting, disable repeated actions and show progress. On success, use the returned task state. On `409`, refresh the task and current run before offering another action. Never infer acceptance from `run.completed` or automatically call the acceptance endpoint.

Mission Lane reuses the existing `task.status_changed` event. The acceptance event has payload `{ "from": "in_review", "to": "completed", "runId": "run-0001" }`, actor `owner`, origin `api`, and `synthetic: false`. It is appended in the same D5-serialized transaction as the acceptance row and task transition. Run SSE remains run-scoped and closes on `run.completed`; task/API refresh exposes the acceptance receipt. R1 adds no global Mission Lane history API.

## Persistence and compatibility

Migration `0031_owner_verified_task_results.sql` adds `in_review`, an immutable `task_result_acceptances` table, a composite task/run reference, and the acceptance event projection. Acceptance, task transition, and D5 event projection share one transaction. The existing single-owner API session is the authorization authority; the persisted actor is `owner`, matching the current Mission Lane actor contract. Historical task state and existing Mission Lane history are not rewritten.

The change preserves the existing mock-only worker, owner session + CSRF boundary, internal worker authentication, Mission Lane writer lock order, and append-only event rules. The worker never writes an owner acceptance event.

## Verification and remaining gates

The repository test command passed. Focused results: contracts 54/54, API 87/87, worker 67/67, and database boundary suite 39 passed with the role-separated PostgreSQL run-store integration suite skipped because its test database URLs were unavailable. Full formatting and lint passed. Workspace typecheck found only the expected frontend integration gap: `apps/web/src/ui/command-center/status.tsx`, `apps/web/src/ui/projects/parts.tsx`, and `apps/web/src/ui/projects/planning/summary.ts` need explicit `in_review` handling. Those frontend-owned files were not changed. `pnpm check` therefore remains blocked until Claude #2 updates these mappings. The database migration and D5 integration cases still require hosted PostgreSQL CI execution.

No local Docker, host service, privileged WSL2, real agent, or fixture operation was performed. Before merge, require exact-head hosted CI and an independent read-only backend/security review. Frontend integration is owned by Claude #2. Merge remains subject to repository review and CI gates.

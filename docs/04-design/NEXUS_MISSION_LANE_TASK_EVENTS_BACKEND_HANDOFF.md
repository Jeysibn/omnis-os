# AO — Mission Lane Task Event Persistence and Read/Replay Contract

Status: **proposal for independent backend planning. Not implemented. Not authorized.**
Author: Claude #2 (frontend). Audience: Codex #1 (backend/security) and the project owner.
Evidence base: `origin/main` @ `5a027be` (inspected read-only, 2026-11-05).
Driver: `docs/04-design/OMNIS_NEXUS_UI_UX_SPEC_V2.md` §10 requires the bottom Mission Lane to show
"an ordered sequence of real run **and task** events", with persisted history, live updates,
replay, no duplicates after reconnect. The owner decided to **keep the full requirement**.
Nothing here is presented as existing unless it cites a file below. Everything under
"Proposed" is a design for Codex #1 to challenge, not a decision.

## A. Verified current state

### A1. What exists for run events (the only event stream today)

| Item                 | Fact                                                                                                                                                                                                                                                   | Where                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Storage              | `omnis.run_events(id, run_id, sequence, event_type, at, source='mock', synthetic=true, message, source_event_id)`, `UNIQUE(run_id, sequence)`, dedup index on `(run_id, source_event_id)`                                                              | `packages/db/migrations/0001_initial.sql`                                                                    |
| Event types          | `run.queued, run.started, run.output, run.stop_requested, run.completed, run.cancelled, run.failed, run.interrupted`                                                                                                                                   | same; `RunEventTypeSchema` in `packages/contracts/src/index.ts`                                              |
| Read API             | `GET /api/v1/runs/:runId/events` (SSE). Owner session required (`requireOwner`). Replays persisted events after the `Last-Event-ID` header (default 0), then streams live; checks `runId` and strictly increasing `sequence`; 15 s keep-alive upstream | `apps/api/src/server.ts`; worker `GET /internal/v1/runs/:runId/events?after=` in `apps/worker/src/server.ts` |
| Cursor               | **Per run** integer `sequence`. The API accepts the cursor only via `Last-Event-ID` (no `?after=` on the public route)                                                                                                                                 | same                                                                                                         |
| Ordering across runs | **None.** Only `at` (`timestamptz DEFAULT now()`), which is not a total order                                                                                                                                                                          | `run_events.at`                                                                                              |
| Retention            | No retention or pagination rule found; the whole history is replayed on every connect                                                                                                                                                                  | same                                                                                                         |

### A2. What is persisted about tasks today

| Persisted fact                                                                                                                                                                                                                                                                           | Is history kept?                                                                          | Readable by an owner API?                                                                                 | Where                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tasks(id, title, detail, status, created_at)` plus `project_id`, `association_revision`. `status ∈ open, in_progress, completed`                                                                                                                                                        | **No.** `status` is overwritten in place                                                  | Current row only: `GET /api/v1/tasks`, project task list (`/projects/:id/tasks`, no events)               | `0001_initial.sql`, `0017_task_project_admission.sql`, `apps/api/src/task-routes.ts`    |
| Status transitions: `open→in_progress` when a run is admitted; back to `open` on cancel/fail/interrupt paths; `→completed` when a run completes                                                                                                                                          | **No** (only the latest value survives)                                                   | No                                                                                                        | `packages/db/src/run-store.ts` (`UPDATE omnis.tasks SET status …`)                      |
| `runtime_authorizations` (requested → authorized/denied/revoked, `decided_at/by`, `expires_at`, `consumed_at`, `consumed_run_id`)                                                                                                                                                        | Current state only (single row, timestamps for the decision)                              | `GET /api/v1/authorizations/:id` (one authorization, no audit list)                                       | `0005_durable_authorization.sql`, `apps/api/src/server.ts`                              |
| `authorization_audit(id, authorization_id, task_id, run_id, event_type, actor_id, outcome, reason_code, occurred_at, …)` with types `authorization.requested/approved/denied/revoked/expired/consumed/enforcement_denied` and `operation.started/completed/failed/cancelled/interrupted` | **Yes, append-style, carries `task_id` and `run_id`**                                     | **No route exposes it.** `AuthorizationStore.getAudit(id)` exists in the store but no owner API serves it | `0005_durable_authorization.sql`, `packages/db/src/authorization-store.ts` (`getAudit`) |
| `task_project_management_audit` (`created_assigned, assigned, unassigned, reassigned`), immutable by trigger                                                                                                                                                                             | Yes, immutable                                                                            | **No read route found**                                                                                   | `0017_task_project_admission.sql`                                                       |
| Task creation                                                                                                                                                                                                                                                                            | Only `tasks.created_at` (an audit row exists only when a project is assigned at creation) | Via the task row                                                                                          | `0001_initial.sql`, `0017_…`                                                            |

### A3. What is missing (conclusion)

1. **No authoritative task-event record or API.** No table stores "task created / task status changed" as events, and `tasks.status` history is lost on each overwrite.
2. **Task-adjacent audit rows exist but are not readable** by the owner session and are keyed by authorization, not by a task timeline.
3. **No cross-stream ordering.** Run events are ordered per run only; task-side rows are ordered by `occurred_at`.
4. **No resumable global/ task feed**, no pagination, no truncation indicator, no retention policy for events.
5. Existing tasks/runs have **no recoverable task history** before any new mechanism ships (status changes were never recorded).

The frontend therefore cannot show task events without fabricating them (for example from `createdAt`/status snapshots). It does not, and Nexus labels the lane "run events only".

## B. Required task-event model (Proposed)

Only transitions the system really performs, each emitted in the **same transaction** as the state change that causes it:

| Proposed type                                                                      | Source of truth today                                                   | Notes                                                                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `task.created`                                                                     | task insert (`task-routes` → worker `POST /internal/v1/tasks`)          | include `projectId` if assigned at creation                                                                                 |
| `task.project_assigned` / `task.project_unassigned` / `task.project_reassigned`    | already audited in `task_project_management_audit`                      | map the audit row, do not duplicate                                                                                         |
| `task.authorization_requested` / `_approved` / `_denied` / `_revoked` / `_expired` | `authorization_audit`                                                   | the owner's start decision. `…_consumed` is the admission link to a run                                                     |
| `task.run_admitted`                                                                | run admission transaction (`run-store.ts`, `consume_run_authorization`) | carries `runId`; this is the task↔run correlation point                                                                     |
| `task.status_changed`                                                              | the `UPDATE omnis.tasks SET status` statements in `run-store.ts`        | carries `from`, `to`, and the causing `runId`. Only record what the code actually does (`open`, `in_progress`, `completed`) |

Do **not** invent: task cancellation (there is no task-level cancel; stop is a **run** action → `run.stop_requested`), scheduling/dispatch events beyond what is persisted, or task failure (task status has no failed state). Run lifecycle events stay `run.*` and must not be re-labelled as task events.

## C. Event identity and ordering (Proposed; decisions for Codex #1)

- **Identity:** stable `id` (text, unique), `taskId` (always), `runId` (nullable, set where applicable), `type`, `at` (server time of commit), `actor` (`owner` or `system`), a bounded `message`/structured `detail` (no secrets, no task `detail` text).
- **Cross-stream order is not available today.** To render task and run events together truthfully a **single monotonic cursor** is required. Recommended: one append-only table (for example `omnis.mission_events`) with an identity column `seq bigint`, written in the same transaction as each task change **and** as each run event (or referencing `run_events` by `(run_id, sequence)` with a `seq` assigned at insert). `seq` is the total order and the replay cursor.
  - Alternative considered and **not recommended**: merging by `(at, id)` at read time. `at` ties and commit-order skew make it non-authoritative; replay across a reconnect can reorder.
- **Duplicates:** unique on `id`; client de-duplicates by `seq`. Concurrent transactions: assign `seq` at commit-visible order (sequence + visibility rule, or a serialized writer) so a reader never sees `seq` N+1 before N is committed (no gaps visible to a resuming cursor). Codex #1 must specify the mechanism.
- **Retention:** define a floor (rows kept N days or M rows) and expose it; never silently drop.
- **Backfill:** history before deployment cannot be reconstructed for status changes. State that explicitly through a `historyStartsAtSeq` / `truncated` indicator rather than synthesizing events.

## D. Read and replay API (Proposed — none of these routes exist)

Follow existing conventions (`/api/v1`, owner session, Zod schemas in `@omnis/contracts`, API → worker/DB internal read, signed cursors like `PROJECT_WORKSPACE_API_V1.md`).

1. `GET /api/v1/mission-events?limit=&cursor=&taskId=&runId=` → `{ events: MissionEvent[], nextCursor, complete, historyStartsAtSeq, truncated }`. Bounded `limit` (1–100), cursor bound to the filter, `422 invalid_cursor` on tamper.
2. `GET /api/v1/mission-events/stream` (SSE): `id: <seq>`, `event: <type>`, `data: <MissionEvent JSON>`. Resume with `Last-Event-ID`; the server replays from the cursor then streams live; 15 s keep-alive like the run stream. A cursor older than retention returns an explicit truncation event/response, never a silent gap.
3. Server-enforced **connection cap per owner session** and clean teardown on abort (mirror `reply.raw.on('close', abort)` in the run route).
4. Keep `GET /api/v1/runs/:runId/events` unchanged; the new stream may carry run events too (so one connection can replace the current ≤4 per-run streams), but run payloads stay schema-compatible (`RunEventSchema`).

Why a global/task stream matters for the UI: the current lane follows at most 4 runs because browsers limit concurrent connections per origin and each run needs its own stream.

## E. Authorization and security

- Owner-session authentication via `requireOwner`; 401 on expiry (the frontend only treats a real 401 from a normal request as expiry).
- Same visibility as `GET /api/v1/tasks` / project reads (single-owner product today). Archived projects remain readable, consistent with `PROJECT_WORKSPACE_API_V1.md`.
- Reads are GET: no CSRF. Any new mutation must keep `requireMutationProtection`.
- Validate every payload with a shared Zod schema server-side before sending and client-side on receipt; reject unknown types.
- Data minimization: no task `detail`, no authorization secrets/ capabilities, no credentials, no worker internals (lease data, job ids).
- Audit: reading events does not mutate audit state; define whether stream opens are logged.
- Database roles: do not widen `omnis_runtime` write authority; writes to the new table belong in the same functions/roles that already perform each state change (note the existing authorizer/runtime privilege split in migrations 0003–0011).

## F. Persistence and recovery

- Durable in Postgres, written in the same transaction as the change (the pg-boss admission transaction in `run-store.ts` is the model).
- No in-memory-only events; restart recovery by replay from `seq`.
- Immutable rows (reuse the `reject_*_mutation` trigger pattern used by the audit tables).
- Idempotent writers (a retried request must not append a second event; reuse the existing idempotency keys).
- Defined retention, truncation reporting, and a documented backfill stance (see C).

## G. Backend integration acceptance tests

1. Each supported task transition appends exactly one event, in the same transaction (rollback leaves none).
2. Persisted history returns in `seq` order; pagination covers all events without gap or duplicate under concurrent writes.
3. Live delivery: a change after the stream opens arrives once, in order.
4. Replay: disconnect and reconnect with `Last-Event-ID` returns exactly the missed events; a server replaying from the start (no header) is correct and de-duplicable.
5. Duplicate handling: a retried mutation does not duplicate events.
6. Cross-stream order: task event for run admission precedes that run's `run.queued` consistently; concurrent task and run writes never expose a gap.
7. Authorization: no session → 401; expired session → 401; invalid/foreign cursor → 422; the session is re-checked, not only at connect.
8. Restart recovery: restart API/worker/DB connection mid-stream; resume continues without loss or duplicates.
9. Task↔run correlation: `runId` on events matches the run; unknown task/run → 404.
10. Resource limits: per-session connection cap enforced, closed on abort, bounded history page size, large histories do not exhaust memory.
11. Truncation: a cursor below `historyStartsAtSeq` is reported, never silently skipped.
12. Contract tests: server output parses with the shared Zod schema; extra fields rejected.

## H. Frontend consumption contract (what Claude #2 needs)

Minimum per event: `seq` (total order and cursor), `id`, `type`, `at`, `taskId`, `runId | null`, `actor`, `message` (bounded), and for `task.status_changed` the `from`/`to`. Per response: `nextCursor`/`complete` for history, `historyStartsAtSeq`/`truncated`. The UI will: order by `seq` only, de-duplicate by `seq`, show task and run events distinctly labelled, never infer causality except through `runId` on the event, keep loaded history during disconnects, and surface truncation. Event copy must be a closed enum mapped to labels (no free-form HTML). Until this ships the lane stays labelled "run events only".

## I. Recommended delivery boundary

A narrow backend PR, independent of PR #31 (no UI change required to merge it):

1. Migration adding the append-only `mission_events` table (identity `seq`, immutability trigger, indexes on `(task_id, seq)` and `(run_id, seq)`), grants least-privilege.
2. Emit points: task creation, project association (map existing audit), authorization decisions, run admission (task↔run link), task status updates, optionally mirror run events.
3. Shared schemas in `@omnis/contracts` and API routes D1 and D2 with connection cap.
4. Tests G1–G12; documentation in `docs/02-architecture/API_CONTRACT.md` and a new module doc.

Dependencies: owner authorization for backend work; decision on retention and on mirroring run events; confirmation of the concurrency/visibility mechanism for `seq`.
Risks: write-path changes in the authorization and run-admission transactions (high-security area); no backfill for existing tasks; connection limits; ordering under concurrency.
Acceptance: all of G pass in CI; the web fixture swap requires no new contract.

**Stop here.** Codex #1 implementation requires separate owner authorization.

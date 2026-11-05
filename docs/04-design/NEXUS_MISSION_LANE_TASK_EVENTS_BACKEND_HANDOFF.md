# OMNIS NEXUS Mission Lane V2 — Backend Event Contract

**Status:** Architecture finalized for planning; backend implementation is not authorized by this document.

**Reviewed repository baseline:** `origin/main` at `28981f900f95a9673db35aeff5ceaff62f4fffe6`.

**Frontend proposal:** PR #31, head `0aaa19c6699a7e38ecf4a07747ad2e47d75df99c` (open, Draft, unmerged at review).

**UI authority:** `OMNIS_NEXUS_UI_UX_SPEC_V2.md`, PR #31 head, section 10.

**Owner decisions:** D1–D7 below were explicitly approved on 2026-11-06.
**Scope:** Design and backend implementation planning only. No task-event API, migration, or backend code is implemented here.

## 1. Goal and boundary

Mission Lane V2 must present an ordered sequence of **real task lifecycle events and real persisted run lifecycle events**. It must preserve history during disconnects, replay without duplicates, distinguish synthetic mock run activity, and make the absence of pre-cutover task history visible. UI animation is never the event source.

This contract does not add task or run mutations, runtime capabilities, authorization-audit presentation, provider execution, or frontend implementation. The existing per-run event API remains available and unchanged. The new aggregate feed is a read projection over task/run changes that already occur.

## 2. Verified baseline on current `main`

PR #31's handoff and V2 design document are on its supplied head, not on the reviewed `main` baseline. The handoff previously cited `5a027be`; that evidence baseline is stale. The current source facts below were rechecked at `28981f900f95a9673db35aeff5ceaff62f4fffe6`.

### Existing task and run state

- `omnis.tasks` stores current status (`open`, `in_progress`, `completed`) and project association; status history is overwritten rather than retained. Relevant source: `packages/db/migrations/0001_initial.sql`, `0017_task_project_admission.sql`, and `packages/db/src/run-store.ts`.
- Task creation is performed by the worker-backed `create_task` path. Project association changes are handled by `set_task_project`; immutable records in `task_project_management_audit` preserve those changes.
- Epic association is stored separately in `task_epic_associations`; immutable `task_epic_management_audit` records preserve assignment, reassignment, and unlinking. Relevant source: `packages/db/migrations/0020_epic_task_association.sql`.
- Run admission sets a task to `in_progress`. Successful run completion sets it to `completed`; cancellation, failure, and interruption paths set it to `open`. These writes are transactional with the corresponding run state/event updates in `packages/db/src/run-store.ts`.
- `omnis.runs.task_id` is the authoritative run-to-task relationship. Task project association cannot be changed after run or authorization history exists. Project-aware run admission is enforced at the database boundary.
- Authorization decisions and operation audit records are persisted separately in `authorization_audit`. They are not a task-event feed and are excluded from the initial Mission Lane V2 backend scope by D2.

### Existing event delivery

- `omnis.run_events` stores durable events with a per-run integer sequence, source `mock`, and `synthetic=true`. Run event types include queued, started, output, stop requested, completed, cancelled, failed, and interrupted.
- `GET /api/v1/runs/:runId/events` is owner-authenticated SSE. The API forwards the per-run cursor to the worker. The worker subscribes before reading persisted events, then drains PostgreSQL to fill the cursor; reconnect/restart recovery is based on persisted rows. This ordering is per run only.
- Existing run history has no automatic retention or pagination limit. `run.output` rows may contain arbitrary output and stay available through the run inspector API; the Mission Lane projection must not copy that text.
- Existing `LocalSessionStore` sessions are memory-backed, expire after eight hours, and can be destroyed on logout. The current run SSE checks the owner session at connection setup; it does not revalidate that session for the lifetime of the open stream.
- Project Workspace provides task summaries and latest-run state, not task-event history. There is no authoritative task-event table, task-event API, or cross-run/task cursor.

### Consequence

The backend cannot currently provide real task lifecycle history. It must record future task events at the same transaction boundary as their source changes. Previous task status transitions cannot be reconstructed from current rows or audit tables.

## 3. Approved decisions D1–D7

| Decision | Approved direction | Implementation note |
|---|---|---|
| **D1 — Historical backfill** | Cutover-only. Do not backfill old run events into an invented global order; do not synthesize task history. Preserve existing per-run run-event history. | Mission Lane history begins at the new projection's recorded cutover. Consumers must show that earlier task history is unavailable. |
| **D2 — Authorization events** | Exclude authorization audit events from the initial Mission Lane V2 backend scope. | No approvals, revocations, capabilities, reason codes, or authorization metadata in this feed. Any later presentation needs separate security review and owner decision. |
| **D3 — Feed scope** | Support owner-global and project-filtered feeds. | Define event-time project scope, historical association filtering, legacy unassigned behavior, and task/run consistency as specified below. |
| **D4 — Retention** | No automatic pruning initially. | Bound pages and payloads; expose history start and truncation; monitor storage growth and document an operational storage budget before deployment. |
| **D5 — Ordering** | Conditionally approve a serialized transactional counter row. | It is acceptable only if the implementation and exact-head tests establish commit-visible order, atomic rollback, lock order, bounded waits, no duplicate/gap replay, and acceptable contention. Do not substitute a PostgreSQL identity/sequence alone. If the counter fails criteria, stop and request owner approval for an outbox sequencer. |
| **D6 — Event types** | Real task lifecycle events plus safe persisted run lifecycle events. | Emit only from actual committed changes; never copy raw output or fabricate states. The exact closed type set is in section 4. |
| **D7 — SSE security and limits** | Revalidate session, close on logout/expiry, clean up aborts, cap streams, authorize reconnects. | Starting caps are four streams per session and sixteen globally; revalidation is no slower than 15 seconds. These values are provisional pending load and deployment-topology verification. |

## 4. Event model and schema

### Event types

Task events:

- `task.created`
- `task.project_assigned`, `task.project_unassigned`, `task.project_reassigned`
- `task.epic_assigned`, `task.epic_unassigned`, `task.epic_reassigned`
- `task.status_changed`

Run lifecycle events projected from persisted `run_events`:

- `run.queued`, `run.started`, `run.stop_requested`
- `run.completed`, `run.cancelled`, `run.failed`, `run.interrupted`

`run.output` remains available through the existing run-event API and run inspector, but is excluded from the Mission Lane projection because it carries arbitrary content and can be high volume. Do not derive a lifecycle event from a run snapshot or from elapsed time. No task-level `failed` or `cancelled` state exists in the current task model, so do not invent one.

### Proposed strict discriminated event schema

```ts
type MissionEventType =
  | 'task.created'
  | 'task.project_assigned' | 'task.project_unassigned' | 'task.project_reassigned'
  | 'task.epic_assigned' | 'task.epic_unassigned' | 'task.epic_reassigned'
  | 'task.status_changed'
  | 'run.queued' | 'run.started' | 'run.stop_requested'
  | 'run.completed' | 'run.cancelled' | 'run.failed' | 'run.interrupted';

type MissionEventBase = {
  id: string;                 // Stable opaque ID, unique across the feed.
  seq: string;                // Positive decimal bigint string; authoritative total order.
  occurredAt: string;         // UTC database timestamp; presentation only, not ordering.
  taskId: string;             // Always derived from the persisted task/run relationship.
  projectId: string | null;   // Task's project scope at event time.
};

type TaskEvent = MissionEventBase & {
  origin: { kind: 'task_state'; synthetic: false };
} & (
  | { type: 'task.created'; runId: null; actor: 'owner'; payload: Record<string, never> }
  | {
      type: 'task.project_assigned';
      runId: null;
      previousProjectId: null;
      actor: 'owner';
      projectId: string;
      payload: Record<string, never>;
    }
  | {
      type: 'task.project_unassigned';
      runId: null;
      previousProjectId: string;
      actor: 'owner';
      projectId: null;
      payload: Record<string, never>;
    }
  | {
      type: 'task.project_reassigned';
      runId: null;
      previousProjectId: string;
      actor: 'owner';
      projectId: string;
      payload: Record<string, never>;
    }
  | {
      type: 'task.epic_assigned';
      runId: null;
      actor: 'owner';
      payload: { previousEpicId: null; epicId: string };
    }
  | {
      type: 'task.epic_unassigned';
      runId: null;
      actor: 'owner';
      payload: { previousEpicId: string; epicId: null };
    }
  | {
      type: 'task.epic_reassigned';
      runId: null;
      actor: 'owner';
      payload: { previousEpicId: string; epicId: string };
    }
  | {
      type: 'task.status_changed';
      runId: string;
      actor: 'system';
      payload: { fromStatus: TaskStatus; toStatus: TaskStatus };
    }
);

type RunLifecycleEvent = MissionEventBase & {
  type:
    | 'run.queued' | 'run.started' | 'run.stop_requested'
    | 'run.completed' | 'run.cancelled' | 'run.failed' | 'run.interrupted';
  runId: string;
  actor: 'system';
  origin: { kind: 'run_event'; source: 'mock'; synthetic: true };
  payload: Record<string, never>;
};

type MissionEvent = TaskEvent | RunLifecycleEvent;
```

Event scope is stored explicitly at event time. Association event fields preserve the prior project in `previousProjectId`; for assignment, unassignment, and reassignment, a project-filtered query matches `projectId` or `previousProjectId`. The event type determines whether `previousProjectId` is present. All other task and run events carry the task's project at the time of the source transition.

The concrete TypeScript/Zod definitions must implement the discriminated variants above as strict objects and validate UTC timestamps and positive decimal `seq` values. `id` may reuse an opaque source-event identity when one exists; otherwise generate it once inside the transaction. `seq` is a decimal string so browser code never rounds PostgreSQL `bigint` values. The client compares it as `BigInt`, never lexically or by timestamp.

Payloads contain no free-form message, task `detail`, raw run output, credentials, authorization data, lease fields, queue/job IDs, or internal SQL/service metadata. Event labels and copy are frontend mappings from the closed event type. Run events retain their `origin` marker so mock activity cannot be presented as provider activity.


### Project/task/run scoping

- Owner-global feed includes all owner-visible tasks, including legacy tasks with `projectId: null`.
- A project filter matches events whose `projectId` or `previousProjectId` is the requested project. Thus assignment, unassignment, and reassignment appear in the relevant old and new project histories without rewriting the event.
- Other events carry the task's project ID as observed in the same transaction. Archived projects remain readable under the existing project read behavior.
- A run event's `taskId` and event-time `projectId` are derived by joining the persisted run to its task. A task/run filter pair must match `runs.task_id`; a mismatch returns the same safe not-found behavior as an unknown scoped resource.
- Project filters exclude legacy unassigned tasks. Global history still includes them.

## 5. Persistence, atomicity, and privileges

### Proposed storage

Add an append-only `omnis.mission_events` projection and a singleton transactional cursor row, for example `omnis.mission_event_clock(singleton, last_seq)`. Suggested event columns:

- `seq bigint PRIMARY KEY`, assigned only by the transactional counter protocol.
- `id text NOT NULL UNIQUE`, a stable opaque event ID, plus a unique source identity where available for idempotency. `seq` is the sole primary key; the schema must not declare a second primary key.
- `event_type`, `actor`, `origin`, bounded validated payload, and `occurred_at`.
- `task_id NOT NULL`, nullable `run_id`, `project_id`, nullable `previous_project_id`, all with appropriate restrictive foreign keys and indexes.

The schema is a proposal, not an applied migration. Add indexes for global sequence traversal and scoped `(project_id, seq)`, `(previous_project_id, seq)`, `(task_id, seq)`, and `(run_id, seq)` access. Use constraints to restrict types/payload shapes and preserve task/run/project referential integrity. Historical rows are immutable. No authorization audit rows are copied.

### Event-producing transactions

1. Begin the existing state-changing transaction.
2. Acquire the Mission Lane clock row lock before any other lock in an event-producing transaction. Then preserve the established per-operation lock order (idempotency/admission, authorization, project/task/run as applicable). All event-producing paths use the same ordering.
3. Apply the actual state transition and existing audit/idempotency/run-event writes.
4. Stage one projection row for each actual transition. At the end of the transaction, advance `last_seq` by the staged row count and insert the batch in its explicitly documented source-operation order, all transactionally.
5. Commit state, source event/audit, projection event, and counter together. Publish/notify only after commit; notifications are wake-ups, never the record of truth.

At transaction start, lock the single clock row with `SELECT ... FOR UPDATE` but do not increment it yet. After all source state and source audit/run-event writes are complete, update the counter by the number of staged Mission Lane events, assign that contiguous range, insert the projection rows in source-operation order, and then commit. The lock remains held until commit. A later event writer cannot allocate a higher visible cursor and commit before an earlier writer. A rollback restores the counter update and removes projection rows, so it does not leave an allocated cursor hole. Filtered feeds can naturally skip sequence values belonging to other scopes; clients must not demand `seq + 1` continuity.

Acquire the counter lock at the beginning of each event-producing transaction to avoid a transaction holding domain rows while waiting for the counter and another holding the counter while waiting for those rows. Define and test one lock order across task create/project/Epic association, run admission, and run lifecycle transitions. After appending Mission Lane events, the transaction must not acquire additional domain locks. Apply a bounded `lock_timeout`; on timeout, roll back the entire source mutation and surface a retryable conflict/unavailable response consistent with existing API error conventions. An HTTP retry must retain its original idempotency key.

This protocol serializes event-producing transactions. It is considered feasible because the lane excludes output chunks and records only bounded lifecycle events, but it is not assumed performant without measurement. Section 9 contains mandatory criteria. If the row lock causes unacceptable contention or cannot be integrated without deadlocks, stop and present the outbox-sequencer alternative for owner approval; do not silently switch.

### Write isolation

- `omnis_runtime` receives no direct `INSERT`, `UPDATE`, or `DELETE` privileges on `mission_events` or the counter row.
- Do not grant broad table writes to `omnis_runtime` or `omnis_authorizer`. Use narrowly scoped trusted functions/triggers tied to the existing state mutation paths, fixed safe search paths, minimal `EXECUTE`, and source-row validation.
- Replace the existing direct runtime `UPDATE(tasks.status)` grant with a narrow `SECURITY DEFINER` task-transition function. It locks and reads the task, verifies the run/task relationship and allowed source state, updates only status, derives `fromStatus` from the locked row, and stages the matching task event atomically. Route every current admission, completion, cancellation, failure, and interruption status write through it; leave no direct status-update path that can commit without an event.
- Replace direct runtime `INSERT` on `run_events` with a narrow append function. It validates event type and mock provenance, derives `taskId` and event-time project scope by joining the persisted run/task, preserves per-run sequence, and stages exactly one Mission Lane projection for each safe lifecycle event. `run.output` remains stored for the run inspector but creates no Mission Lane projection. A unique source key ties each projected lifecycle row to its persisted `run_events` row. No caller-supplied task ID, source, synthetic marker, or project scope is trusted.
- Task creation and project/Epic association functions or audit triggers likewise stage one event from persisted source rows, using stable source IDs. Idempotency replay returns the stored result without staging another event.
- All writer paths use one trusted Mission Lane append routine with a fixed safe search path, minimal `EXECUTE`, source-row validation, and no arbitrary caller-provided event payload. The transaction wrapper acquires the counter lock before any domain lock; writer functions use that same transaction lock and append only after validating source state. Revoke the corresponding direct status/run-event table privileges; do not add general projection table grants.
- Backups and restores must preserve the new table, counter, trigger/function ownership, ACLs, and append-only protection.

### Migration and rollback

Use the next migration number after inspecting the implementation branch's actual migration chain. The migration is additive and must preserve current tasks, run histories, audits, and roles. Record a migration cutover timestamp/epoch and `historyStartSeq`; do not backfill run or task events. A failed migration should roll back transactionally where PostgreSQL permits. After an applied migration, recover through a corrective forward migration or restore; do not drop event history as a rollback shortcut. Feature-disable the new read endpoint/stream while retaining written events if application rollout is reverted.

## 6. History, cursor, and pagination contract

### Proposed history endpoint

`GET /api/v1/mission-events?limit=40&before=<opaque>&projectId=<id>&taskId=<id>&runId=<id>`

All filters are optional. Omitting `projectId` requests the owner-global feed. `limit` defaults to 40 and is restricted to 1–100. Unknown query fields are rejected. Authentication is checked before revealing resource or cursor information. With no `before` cursor, return the **latest** matching page, not the oldest page. Return events in ascending `seq` order for display. A signed `olderCursor` retrieves the preceding page; `hasOlder` indicates whether an older matching event existed at the query snapshot.

Response shape:

```json
{
  "events": [],
  "page": {
    "olderCursor": "<signed-before-cursor-or-null>",
    "hasOlder": false,
    "streamCursor": "<signed-after-cursor-or-null>",
    "observedThroughSeq": "184",
    "historyStartedAt": "2026-11-06T00:00:00.000Z",
    "historyStartSeq": "1",
    "preCutoverHistoryAvailable": false,
    "truncated": false
  }
}
```

The initial query returns the most recent matching events, ordered oldest-to-newest within that page. The implementation must obtain the latest page, `hasOlder`, global high-water sequence, and history-floor metadata from one PostgreSQL statement (for example, a CTE statement with page selection and scalar metadata subqueries). PostgreSQL gives a single statement one MVCC snapshot; do not assemble these values from separate default-isolation statements. Read global high-water from the singleton clock row's committed `last_seq`, not `MAX(seq)` over retained event rows, because an approved future retention policy may have pruned the highest/older rows. The signed `streamCursor` represents the committed high-water visible to that statement, including for an empty feed. Events committed after the statement snapshot receive higher sequences because event writers serialize allocation through commit. The client opens SSE from that checkpoint and will receive later commits without a gap.

`olderCursor` is bound to the normalized filters and the oldest returned sequence; the next history request uses it as `before` and returns rows with lower sequences. `hasOlder=false` means no older matching event was visible at that statement's snapshot. New events may arrive immediately afterward. `streamCursor` is returned only for the initial latest-page request (null for `before` requests). History pages are not a multi-page snapshot; each subsequent page evaluates against its own statement snapshot. The frontend retains the initial stream checkpoint while paging backward.

### Cursor format and errors

- `olderCursor` and stream cursors are distinct signed cursor purposes. Their payloads contain format version, feed epoch, position (`before` or `after`), `seq`, normalized filter digest, and required scope identifiers. Sign with a domain-separated HKDF/HMAC key or a dedicated cursor key; do not use the worker bearer token directly. Cursors are integrity-protected positions, not authorization grants.
- History and stream cursors are bound to exactly the same normalized filters. Changing project/task/run filters or using an `olderCursor` as an SSE cursor returns `422 invalid_cursor`.
- Malformed, tampered, or future-position cursors return `422 invalid_cursor` with a generic message. A correctly signed cursor from a retired feed epoch returns explicit `410 history_truncated` metadata.
- Unknown project/task/run or a mismatched task/run pair returns `404 not_found` with no cross-scope details.
- Before pruning exists, valid cursors from the active feed epoch do not encounter retention truncation. The response always states `preCutoverHistoryAvailable=false`; do not represent absent pre-cutover task history as retained or complete.
- If a future approved retention policy removes rows, expose the earliest retained sequence as `historyStartSeq` and its UTC timestamp as `historyStartedAt`. History requests whose cursor predates that floor return `410 history_truncated` with a strict body containing `error: { code: "history_truncated", message: "Requested history is no longer retained." }` and `history: { historyStartSeq, historyStartedAt, resetCursor }`. An already-open stream whose next required sequence is below the floor emits `event: mission.history_truncated` with the same `history` object, sets the SSE `id` to `resetCursor`, and closes.

  `resetCursor` is a newly signed **after** cursor in the current feed epoch, bound to the original filters, positioned at `historyStartSeq - 1` (or sequence `0` if the floor is `1`). It means “resume replay from the first retained sequence”; it is not the floor itself or a current high-water mark. On truncation, the client keeps already loaded rows, marks earlier history incomplete, reloads the retained history from the latest page backward until it reaches `historyStartSeq`, then reconnects with the returned `resetCursor`. SSE replay may repeat events already obtained through history; the client merges by stable event ID/sequence. Replaying from the reset cursor catches events committed while the bounded history pages were loading. If the floor advances again during recovery, the client repeats the truncation procedure with the newer floor/cursor. The stream cursor must not be replaced by the latest-page checkpoint during this recovery, because that could skip retained events not yet loaded.

## 7. Live SSE and replay

### Proposed endpoint

`GET /api/v1/mission-events/stream?after=<signed-cursor>&projectId=<id>&taskId=<id>&runId=<id>`

The API requires an active owner session and validates all filters/cursor before sending SSE headers. The initial `after` cursor is normally the history response's `streamCursor`. On browser reconnect, `Last-Event-ID` takes precedence and is validated against the same filter binding. Each message is:

```text
id: <signed cursor after this event>
event: task.status_changed
data: {<strict MissionEvent JSON>}

```

Heartbeat comments carry no event ID and do not imply work is executing.

`auth.expired` and `mission.history_truncated` are control events, not persisted `MissionEventType` values. `auth.expired` has no event ID or task data; the server closes immediately afterward. `mission.history_truncated` carries only the `history` object defined above and uses the exact reset procedure defined in section 6.

### Subscribe/replay algorithm

1. Validate owner session, filter scope, cursor, and stream capacity.
2. Register the database/in-process wake-up subscription **before** reading history.
3. Query persisted `mission_events` with `seq > cursor` and matching filters, ordered by `seq`, in bounded batches.
4. Send each event once in ascending sequence. Advance the cursor only after writing the event.
5. On notification, poll, or reconnect, query PostgreSQL again from the last cursor. Notifications only wake this loop; a missed notification cannot lose a committed event.
6. Bound the pending batch and response queue. If the client cannot keep up, close the stream at the last sent cursor; reconnection replays remaining persisted rows.
7. After worker/API restart, the socket closes. The browser reconnects with its last event ID, owner authorization is checked again, and persisted replay resumes without resubmitting task/run operations.

`seq` is the sole ordering source; timestamps are display data. Stable event IDs let the frontend deduplicate defensively. The backend must not resend an event with `seq <= cursor` on a single stream. Because project/task filters omit unrelated events, the frontend must not interpret missing integer values as a replay gap.

## 8. Session security, stream caps, and resource behavior

- Public history and SSE use the existing `requireOwner` session model. GET requires no CSRF token. Worker-facing internal routes remain protected by the existing internal token; the browser never contacts the worker or database.
- The current API session is memory-backed and logout destroys it. The Mission Lane SSE handler must revalidate that the same session remains active at intervals no longer than 15 seconds and enforce the session's absolute expiry. Logout should close that session's open stream registry immediately where practical; periodic validation is the fallback. After headers are sent, emit a minimal `auth.expired` control event if possible, then close. Do not expose event data after detecting expiry.
- An unauthorized reconnect receives an ordinary `401` before SSE begins. The frontend treats a generic EventSource error as transport failure and uses a normal authenticated request to establish actual session expiry.
- Provisional starting caps: four concurrent Mission Lane streams per session, sixteen across the API service. Exceeding the cap returns `429 stream_limit` before streaming begins, with a bounded retry hint. Releasing the stream on abort, close, auth expiry, error, and process shutdown is mandatory.
- These caps are process-wide only in today's single API service deployment. If API replicas or multiple processes are introduced, a shared/distributed cap mechanism is required before claiming a service-global limit.
- Bound page size, event payload (maximum 4 KiB serialized), in-memory batch/queue (maximum 256 events or 1 MiB, whichever comes first), heartbeat interval, and per-client write buffering. No arbitrary run output enters this feed.
- No automatic pruning initially. Record daily row count, `pg_total_relation_size` for the event table/indexes, and growth rate. Define an operational database storage budget and alert threshold before deployment; until then, the design is not approved for production operation. Do not silently delete rows to meet a disk threshold.

## 9. Acceptance and measurable verification plan

All checks below belong to a future implementation PR and disposable PostgreSQL/CI environment. This planning task did not run them.

### Source transition and atomicity

1. For task creation (assigned and unassigned), project assignment/unassignment/reassignment, Epic assignment/unassignment/reassignment, and every actual task status transition, assert exactly one corresponding projection event.
2. Assert no event for no-op status or association writes, duplicate idempotency replay, failed validation, or denied transition.
3. Force a transaction rollback after source state/event insertion and assert neither the state, mission row, nor counter increment remains.
4. Verify status transitions caused by admission, completion, cancellation, failure, and interruption include the correct `runId` and actual `fromStatus`/`toStatus`.
5. Assert persisted run lifecycle events are projected once, with matching task/run IDs and `source=mock`, `synthetic=true`; assert output text and authorization metadata are absent.

### Counter correctness, contention, and deadlocks

1. Use at least two PostgreSQL sessions: transaction A obtains the cursor lock and pauses before commit; transaction B attempts an event write and must block. A third reader must not observe B's event or a higher committed cursor before A commits. After A commits, B may receive the next cursor and commit.
2. Roll back A and verify B receives the next committed value without an unreplayable hole. Roll back after state mutation and verify all source effects roll back too.
3. Run 32 concurrent short event-producing transactions. Require zero deadlocks, zero lock-timeout failures, exact one-to-one event/source counts, monotonic commit-visible order, p95 counter-lock wait ≤500 ms, maximum wait ≤3 s, and full completion ≤10 s in the pinned CI database profile. Record the database/container digest and workload. Also compare event-producing mutation p95 with the same no-projection baseline; target ≤10% added p95 under this workload.
4. If the measured limits fail on the pinned CI profile or the intended host profile, do not tune away correctness or change to an outbox without owner approval. Report the evidence and request an outbox-sequencer decision.
5. Exercise the documented lock order across admission, task status, project/Epic association, and terminal run writes under concurrency; assert bounded lock timeout rolls back all state/events and returns the documented retryable error.

### Read, cursor, and replay

1. Verify stable `seq` ordering and stable event IDs across history and SSE. Test page sizes 1 and 100, empty feeds, latest-page selection, exact page boundaries, backward `before` pagination, `streamCursor` only on the latest page, and concurrent appends during page traversal.
2. Verify global, project, task, and run filters; project association events appear for both prior and new project scopes; legacy unassigned tasks appear globally and never under an arbitrary project; mismatched task/run filters return safe not-found.
3. Tamper with cursor bytes/signature, epoch, and normalized filters; each is rejected before data is returned. Check bigint values beyond JavaScript safe integer range round-trip exactly as strings.
4. Open a stream while events are being committed between subscription setup and the initial drain. Each committed matching event must arrive once or remain available by replay; missed notifications must be recovered by persisted polling.
5. Disconnect/reconnect with `Last-Event-ID`, restart worker and API independently, and resume. Assert no duplicate delivery by cursor and no event loss. Verify terminal run projection and task state events survive restart.
6. Simulate a future history floor and assert HTTP history and live SSE report truncation explicitly. Verify no-pruning V1 reports `preCutoverHistoryAvailable=false`, `truncated=false` for valid post-cutover cursors, and the exact UTC cutover metadata.

### Authentication, isolation, and operations

1. No session, expired session, logout during an open stream, invalid owner session on reconnect, and session rotation all stop delivery within 15 seconds (logout should close earlier when registry notification works).
2. At four streams for one session and sixteen total, the next connection gets `429`; all counters are released on client abort, error, session expiry, and shutdown. Test more than one API process if the supported deployment has more than one.
3. Assert runtime/authorizer cannot directly mutate projection or clock tables; only reviewed trusted source operations can create matching events. Verify functions have fixed search paths, minimal execute grants, and source-derived identity/scope.
4. Verify no task detail, raw run output, authorization fields, credentials, internal IDs, or arbitrary HTML appears in API/SSE payloads or logs.
5. Verify migration on clean install and current legacy upgrade; backup/restore retains rows, counter position, function/trigger ownership, and ACLs.
6. Verify monitoring exports event row count, table/index bytes, and daily growth; test configured budget alert. Deployment readiness requires a documented storage budget/alert threshold.

## 10. Frontend integration contract for Claude #2

PR #31 currently presents a run-event-only lane and says output lines stay in the run inspector. After the backend contract is implemented and reviewed, the frontend can consume one global or project-filtered stream:

1. Load the latest history page with `limit=40` and the selected project filter when applicable. Keep `streamCursor` from this first response and open SSE from it. Fetch older pages via `before=olderCursor`; never replace the stream checkpoint with a checkpoint from an older-page response.
2. Render only schema-validated MissionEvent values. Map the closed event enum to localized labels; do not render payload strings as HTML.
3. Order using decimal `seq` as `BigInt`; use `id` for defensive deduplication. Never order by `occurredAt` or infer causality from adjacent events.
4. Correlate with task/run via the event's IDs. Only select/open a run when `runId` is non-null. Task-only events remain selectable task context.
5. Keep existing loaded events visible while disconnected. On reconnect use `Last-Event-ID`; on browser-managed reconnect the URL filters must remain unchanged.
6. Show `historyStartedAt` and explain that earlier task history does not exist. Show `truncated` if a future retention floor removes rows; do not label a partial history complete.
7. Treat `origin.kind='run_event'`, `source='mock'`, `synthetic=true` as mock run activity. Task state events are real persisted Omnis state changes, not provider execution.
8. On `auth.expired`, stop the stream and perform an ordinary API request to establish whether the session ended. Do not clear sign-in state for a generic network error.
9. Keep the existing per-run inspector stream/history contract intact. The combined feed is additional and authoritative for Mission Lane ordering.

This is a contract handoff only. It does not assign new frontend implementation work or change the approved V2 design.

## 11. Future backend implementation PR boundary

The smallest coherent backend PR should include:

1. An additive migration for the projection, transactional clock, immutability, scoped indexes, and least-privilege writer path.
2. Atomic source hooks for task creation, project and Epic association, every actual task status transition, and safe run lifecycle events. Preserve existing per-run event storage and API.
3. Shared strict contract schemas, owner-authenticated paginated history and SSE routes, signed filter-bound cursor, session revocation/expiry handling, and provisional stream caps.
4. PostgreSQL integration, concurrency, role, migration, recovery, backup/restore, SSE replay/session, and API schema tests from section 9.
5. Focused module/API documentation and exact-head CI evidence.

Expected sensitive areas: `packages/db/migrations/`, task/project/Epic mutation functions, `packages/db/src/run-store.ts`, `apps/worker/src/server.ts`, `apps/api/src/server.ts`, `apps/api/src/session-store.ts`, `apps/api/src/worker-client.ts`, and `packages/contracts/src/index.ts`. No frontend file is required for the backend PR.

Implementation dependencies:

- Separate owner authorization to implement. This document itself is not that authorization.
- Independent architecture review of the concrete migration/functions/lock protocol before privileged database changes, followed by independent exact-head implementation review.
- CI measurement of the serialized counter on the pinned PostgreSQL profile and, before deployment, on the intended target profile.
- Operational owner decision for the event-store storage budget and alert threshold before deployment.
- If counter criteria fail, a separate owner decision to adopt an outbox sequencer.

## 12. Independent review and current blockers

The first independent review of this refreshed architecture returned **CHANGES REQUIRED**. After the corrections below, independent reviewer subagent `/root/mission_lane_v2_final_arch_review` completed a targeted read-only re-review against baseline `28981f900f95a9673db35aeff5ceaff62f4fffe6` and returned **PASS**. It confirmed each prior finding closed and found no new contradiction with D1–D7 or the baseline. This is approval of the planning contract, not approval of an implementation, migration, deployment, or real runtime.

| Finding | Severity | Required correction | Status |
|---|---|---|---|
| Latest-page history and backward pagination needed a distinct live-stream checkpoint. | High | Define latest-page selection, backward `before` pagination, and an initial-page-only `streamCursor`; preserve that checkpoint while paging older history. | Closed; confirmed by targeted independent review. |
| Direct task status writes could bypass projection emission. | Medium | Revoke direct runtime `UPDATE(tasks.status)` and route every actual status transition through a constrained trusted function that emits atomically. | Closed in proposed design; implementation verification remains required. |
| Direct run-event writes could bypass the projection. | Medium | Replace direct `run_events` insertion with a constrained append function and unique source identity for each projected lifecycle event. | Closed in proposed design; implementation verification remains required. |
| Project association fields were duplicated in top-level fields and payload. | Medium | Keep prior/current project scope only in top-level event fields; project-association payload is empty. | Closed; confirmed by targeted independent review. |
| Truncation recovery did not define the reset position or avoid replay gaps. | Medium | Define reset cursor as after floor minus one; reload retained pages to the floor, then replay from that cursor and deduplicate. | Closed; confirmed by targeted independent review. |
| Page and stream checkpoint snapshot consistency was underspecified. | Medium | Obtain page, `hasOlder`, high-water cursor, and floor metadata from one PostgreSQL statement/MVCC snapshot. | Closed; confirmed by targeted independent review. |
| Table key declaration appeared to contain two primary keys. | Low | Make `seq` the only primary key and `id` unique. | Closed; confirmed by targeted independent review. |

Known implementation-validation conditions that remain:

- Transactional counter correctness and the stated performance thresholds are design assertions until tested against PostgreSQL under concurrency.
- The provisional SSE caps and 15-second revalidation period need load and lifecycle tests. Current deployment appears to use one API service process; a future multi-process deployment needs shared accounting.
- A numeric storage budget/alert threshold is not set. No-pruning is acceptable for initial development only; deployment remains blocked on an operational limit.
- Existing task transition sources and database role changes must be exhaustively reviewed during implementation; this document does not prove trigger/function behavior.
- Historical task status and globally ordered pre-cutover run activity are unavailable by D1. The old per-run run-event history remains readable through its existing API.

No real provider, authorization-audit event, task state, or run event is fabricated by this design. G4-3 remains **Partially Fixed** and R1-G5 remains **Partially Complete**. Runtime remains mock-only.

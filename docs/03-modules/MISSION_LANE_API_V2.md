# Mission Lane V2 Backend API and Integration Contract

**Status:** Draft implementation contract. This document describes the backend branch implementation and its unverified PostgreSQL/CI gates; it is not merge or deployment approval.

**Architecture:** D1–D7 in [the independently reviewed backend handoff](../04-design/NEXUS_MISSION_LANE_TASK_EVENTS_BACKEND_HANDOFF.md), preserved unchanged at commit `a09ce98096fe70220a8d7a4a526f9de10e2fbf25`.

## Scope

Mission Lane V2 is an additive, owner-readable projection of persisted task and run lifecycle changes. Existing task/run mutations, the per-run event history API, and the mock-only worker remain authoritative. No provider or authorization audit activity is added.

The feed starts at the migration cutover. No earlier task transitions or globally ordered pre-cutover run events are synthesized. The existing run inspector retains its per-run history, including output lines.

## Persisted events

The closed event types and strict Zod envelope are in `packages/contracts/src/index.ts` (`MissionEventSchema`). `seq` is a decimal PostgreSQL bigint string and the only total-order field; `id` is an opaque stable event identity. The database rejects oversized payloads and invalid type/origin/actor combinations.

The projection includes:

- `task.created` and project/Epic assignment, reassignment, or unlink events from persisted task management source rows.
- `task.status_changed` only when a constrained run-backed transition changes task status.
- `run.queued`, `run.started`, `run.stop_requested`, `run.completed`, `run.cancelled`, `run.failed`, and `run.interrupted` from persisted mock `run_events` rows.

Run events carry `origin: { kind: "run_event", source: "mock", synthetic: true }`. They contain no output, task detail, authorization fields, leases, queue IDs, or free-form payload. `run.output` remains exclusively in the existing run inspector.

Project scope is stored at event time. Project filters match current `projectId` or `previousProjectId` on association changes. Legacy unassigned tasks appear in the global feed and not in arbitrary project feeds. Combined task/run/project filters must describe a persisted relationship; mismatches return generic `404 not_found`.

## Persistence and ordering

Migration `0021_mission_lane_events.sql` adds an append-only event table and a singleton transactional clock with a feed epoch and cutover metadata. Event-producing application transactions acquire the clock row first; a fixed-search-path trigger/function path also acquires the real row lock unconditionally before assigning a cursor. The lock remains held through commit. A cursor and its source transition commit or roll back together. `pg_notify` is only a wake-up; replay reads persisted rows.

The branch appends each source event from its database trigger while the transaction holds the cursor lock, rather than physically staging a batch for a final flush. Event ordering is the deterministic source-operation order inside that transaction. The reader cannot see any event until the transaction commits. A custom transaction-local setting is not trusted as proof of lock ownership. All first-party event-producing entry points lock before domain rows; the trigger's unconditional lock is defense in depth for trigger-backed paths.

The PostgreSQL integration test schedules 64 simultaneous task event writes, checks contiguous committed global cursors plus rollback behavior, and records end-to-end mutation latency/throughput. It compares p95 latency against the same runtime task function with only the event projection trigger disabled, while preserving the cursor lock in both cases; the projected p95 may add at most 10% on the pinned CI database. It also holds the cursor row deliberately, observes a runtime task writer waiting in `pg_stat_activity`, then records the wait-plus-commit upper bound. Acceptance thresholds are zero failed writes/deadlocks/timeouts, projected p95 mutation latency at most 500 ms, p99 at most 3 seconds, full 64-write completion at most 10 seconds, and the controlled cursor-wait upper bound at most 500 ms. These checks measure task writes; mixed task/run lifecycle workload remains a separate CI evidence requirement. **The PostgreSQL workload, baseline comparison, and controlled wait measurement have not yet run in this environment; D5 performance acceptance remains unverified.**

`omnis_runtime` has no direct projection-table access. Direct runtime status updates and `run_events` inserts are revoked, including the existing column-level `run_events` insert grant. Task status changes use a narrow run-linked function. Run lifecycle events are trigger-generated from persisted run state. The authorizer reads through narrowly granted functions and does not receive clock-table access. Restore ACL normalization covers the new function grants.

## History API

### `GET /api/v1/mission-events`

Owner-authenticated. Query parameters are strict:

- `limit`: integer 1–100, default 40.
- `projectId`, `taskId`, `runId`: optional canonical identifiers. `runId` requires `taskId`.
- `before`: optional signed older-page cursor.

The first page is the latest matching page, returned oldest-to-newest. The page, `hasOlder`, high-water cursor, and cutover metadata come from one PostgreSQL statement snapshot. Subsequent `before` pages each use their own snapshot; retain the first page's `streamCursor` as the live checkpoint.

Response:

```json
{
  "events": [],
  "page": {
    "olderCursor": null,
    "hasOlder": false,
    "streamCursor": "<signed-after-cursor>",
    "observedThroughSeq": "0",
    "historyStartedAt": "2026-11-06T00:00:00.000Z",
    "historyStartSeq": "1",
    "preCutoverHistoryAvailable": false,
    "truncated": false
  }
}
```

Cursor signatures use an HKDF-derived, domain-separated key and are bound to purpose, feed epoch, and normalized filters. They are positions, not authorization grants. Malformed, tampered, wrong-purpose, future, or filter-mismatched cursors return generic `422 invalid_cursor`; a retired feed epoch or unavailable history returns `410 history_truncated`. Unknown or inconsistent scoped resources return `404 not_found`. No pruning exists in V1, so valid active-epoch cursors report `truncated: false`.

## SSE and session lifecycle

### `GET /api/v1/mission-events/stream`

Owner-authenticated. Accepts the same optional filters and an `after` cursor. On reconnect, a valid `Last-Event-ID` takes precedence over the query cursor. The browser receives strict event JSON with a signed cursor after each delivered event:

```text
id: <signed-after-cursor>
event: task.status_changed
data: { ...MissionEvent }
```

The authorizer has one shared PostgreSQL `LISTEN omnis_mission_events` connection. It registers the notification waiter before draining the persisted feed. Notifications wake a bounded persisted query; they never carry event content or determine truth. Each API long poll is limited to one second so session state is rechecked at least once per second, below the approved 15-second maximum. Reconnect performs full owner and cursor validation. API logout and session rotation abort that session's local streams; expiry closes on the next revalidation. Event writes to a backpressured client have a one-second timeout; timeout aborts the stream and releases its slot so a stalled socket cannot defer session revalidation indefinitely. Invalid cursor/resource errors on the initial pre-stream request retain their ordinary safe `4xx` response; after SSE headers are sent, unrecoverable errors close the stream and require reconnect. `auth.expired` is a minimal non-persisted control event, followed by stream closure.

The implementation enforces four streams per session and sixteen per API process. The current supported systemd unit starts one API process; these caps are therefore service-wide only while that single-process topology is maintained. Multi-process/replica deployments require shared accounting and revocation before the same guarantee can be claimed. Each stream has one bounded page (up to 100 events), a one-second long poll, and a 15-second heartbeat. Slow clients are backpressured; connection abort releases the cap and cancels the authorizer wait.

## Retention and storage operations

No automatic pruning is implemented. The internal authorizer endpoint `/internal/v1/mission-events/storage-metrics` reports row count, relation/index bytes, and the clock sequence. The recovery metrics/backup snapshot also records the event count and cursor state. No production monitoring or alert rule is configured by this PR.

Proposed initial operational budget for owner review: warning at 256 MiB and critical/stop-and-review at 768 MiB, with a 1 GiB hard operational budget for `mission_events` plus indexes. Sample daily and alert on both absolute size and seven-day growth. These are proposals only; deployment remains blocked until an owner-approved budget and alert path are configured. Rows are not deleted automatically to stay under budget.

## Claude #2 frontend handoff

1. Fetch latest history with `limit=40`; retain its initial `streamCursor` while fetching older pages with `before=olderCursor`.
2. Open the SSE endpoint with the same normalized filters and that checkpoint. Keep filters fixed across reconnects; use `Last-Event-ID` for replay.
3. Validate the closed event schema, order by `BigInt(seq)`, and deduplicate by `id`. Do not infer ordering from timestamps or gaps in a filtered sequence.
4. Correlate via `taskId` and optional `runId`; only run lifecycle records are explicitly labeled synthetic mock activity.
5. Show `historyStartedAt` and the absence of pre-cutover task history. Preserve loaded history during disconnects. Treat `auth.expired` as session lifecycle, not a transport error.
6. Keep raw output in the existing run inspector. Do not render payloads as HTML.

No frontend files or PR #31 were changed by this backend branch.

## Verification still required

The local environment could not access the Docker daemon and has no PostgreSQL client, so migration, ACL, transaction, recovery, backup/restore, and cursor contention checks remain unverified locally. Exact-head CI must run the full PostgreSQL integration, recovery, legacy upgrade, backup/restore, host-security, and `frontend-browser` gates before review can be complete. Local API tests cover authenticated history validation, initial cursor-error propagation, `Last-Event-ID` precedence, active-session expiry closure, and process/session caps, but do not replace database replay tests. D5's lock-wait and no-projection comparison also remain explicit review gates.

G4-3 remains **Partially Fixed**, R1-G5 remains **Partially Complete**, and runtime execution remains synthetic mock-only.

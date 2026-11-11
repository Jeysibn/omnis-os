# Phase 1 Mission Lane Transactional Projection

**Status:** Draft PR #90 implementation with migration 0030 admission control.
The owner approved a PR-specific temporary four-writer pooled request p95
threshold of ≤35 ms; the ≤25 ms long-term target and other incomplete
performance gates remain deferred or inconclusive. Exact-head CI and independent
security review remain required before merge consideration.

## Cutover and scope

Migration `0029_mission_lane_events.sql` creates a new feed epoch at migration
cutover. It does not backfill Task or Run history. Existing per-Run event history
and the PR #87 session-bound SSE lifecycle remain unchanged. This migration
does not add Mission Lane read APIs, global SSE routes, or frontend wiring.

The projected event set is limited to Task creation, project and Epic
association changes, Task status changes, and the approved Run lifecycle
events. `run.outcome_unknown` is included only from its persisted per-Run source
event. Authorization and connector audit records, provider-submission requests,
Run output, credentials, and arbitrary output text are excluded.

Task and Run identities and event-time project context are derived by database
triggers from committed source rows. Association changes retain the previous
project ID. Event payloads are closed, bounded structures; Task titles and Run
output are not copied into the feed.

## Cursor and transaction boundary

Every event-producing transaction acquires the fixed internal Mission Lane
advisory lock before authorization, Task, Run, project, or Epic locks. The
projection triggers verify that the lock is already held and never wait for it
while a source-row lock is held. The application exposes no lock-only endpoint.

The source mutation, per-Run event or Task lifecycle source, Mission Lane event,
and transactional clock increment commit or roll back together. The clock row
increments once per newly projected source identity. Duplicate identities are
idempotent only when their persisted contents match; conflicting reuse fails.
The clock update is transactional, so rollback does not consume a committed
sequence. Run lifecycle events are appended through a constrained database
writer that checks the Run's persisted status and rejects direct runtime
inserts into `run_events`.

Migration `0030_mission_lane_admission.sql` adds global admission for
participating event writers: at most four active transactions and four pending
requests, including one pending slot reserved for critical Run recovery and
cancellation work. The database advisory-lock protocol coordinates API, worker,
and background connections across processes. A per-process no-wait gate runs
before database-pool checkout. The ordering is pending slot, admission
turnstile, transaction-scoped active permit, D5 cursor, then source/domain
locks. The D5 cursor remains held through commit. Overload is rejected before
source mutation; worker reconciliation defers retryable work without changing
Run authority or replaying uncertain execution.

This migration does not close the already documented N-8 limitation: the
trusted `omnis_runtime` service credential can directly update approved Run
lifecycle columns. The ledger mirrors committed source rows and is not a new
database-enforced authorization boundary against compromise of the trusted API
or worker credential. It does not claim that all Run transitions are enforced
inside PostgreSQL; N-8 remains open for its separately reviewed remediation.

## Retention and operations

The ledger is append-only and is not pruned automatically. The event payload is
limited to 2 KiB. Backup/restore metrics include the feed epoch, cutover floor,
last sequence, event count, and ledger fingerprint. Operations must monitor
ledger row count and storage growth before any retention policy is proposed.

The five-repetition, 10,000-operation-per-cell migration 0028 / 0029 / bounded
admission comparison is recorded in
[`PHASE1_MISSION_LANE_PERFORMANCE_ADR.md`](PHASE1_MISSION_LANE_PERFORMANCE_ADR.md).
The old ≤10% relative p95 overhead gate remains failed. Earlier source revisions
also missed proposed absolute p95 limits. A later targeted correction to
migration 0030 removes a reproduced duplicate queue-slot unlock without
changing admission ordering or D5. The owner has temporarily accepted
four-writer pooled request p95 ≤35 ms for PR #90 only; corrected measurements
are 25.71 ms for creation, 29.87 ms for assignment, and 30.43 ms for
reassignment. Run-level variability, relative overhead, cursor wait/max,
sustained overload, starvation, and fairness remain deferred or inconclusive.
These results and limitations are recorded in
[`PR #90 unlock correction evidence`](evidence/pr90/unlock-correction-2026-11-11.md).
PR #90 remains Draft pending exact-head CI and independent backend/security
review. The waiver does not apply to correctness or security invariants.

## Synthetic runtime boundary

All existing owner-facing production execution remains mock-only. Synthetic
broker execution remains selected only by its existing test-mode path. The
ledger is a lifecycle projection and does not activate provider execution,
authorize submissions, resolve uncertain outcomes without evidence, or
resubmit uncertain work.

The provisional TypeScript `MissionEventSchema` is available for UI planning.
Frontend wiring must wait for an approved history API, pagination, authorization,
and session-bound SSE contract.

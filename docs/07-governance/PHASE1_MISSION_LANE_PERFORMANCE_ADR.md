# Phase 1 Mission Lane Performance Decision

**Status:** Owner-approved direction; performance acceptance failed; PR #90 remains Draft.
**Date:** 2026-11-10
**Scope:** Phase 1 Mission Lane transactional projection only.

## Decision

Retain D5's serialized transactional global cursor for Phase 1. Add globally
coordinated admission control, provisionally allowing at most four active
event-producing transactions and four pending admission requests. The normal
queue uses three pending slots; one slot is reserved for critical Run recovery
and cancellation work.

This is an implementation direction, not a performance acceptance. The former
relative gate of at most 10% p95 overhead failed on migration 0029 and remains a
recorded failure. It is not waived by admission control. The owner approved
provisional absolute limits for validation:

| Gate, at 1–4 active writers                               |   Proposed limit |
| --------------------------------------------------------- | ---------------: |
| Task create, project assignment, reassignment p95         |           ≤25 ms |
| Same operations p99                                       |           ≤50 ms |
| Sustained successful throughput per operation profile     |       ≥180 ops/s |
| D5 cursor wait p95 / maximum                              | ≤15 ms / ≤100 ms |
| Correctness failures, deadlocks, unexpected lock timeouts |                0 |

The measured result below is **FAIL**. The targets remain unchanged.

## Admission and transaction lifecycle

Migration `0030_mission_lane_admission.sql` uses PostgreSQL advisory locks to
coordinate participating API, worker, and background writer connections across
processes sharing the database. Transaction-scoped permits cap active writers;
bounded session-scoped slots cap pending requests. A turnstile coordinates
promotion without making current permit holders wait on it. The database
enforces the global envelope; each application process also has a local
no-wait gate before checking out a database connection.

Lock order is:

1. Reserve a bounded pending slot (critical work may use its reserved slot).
2. Acquire the admission turnstile and a transaction-scoped active permit.
3. Release session-scoped queue/turnstile locks.
4. Acquire the D5 cursor lock.
5. Acquire authorization, Task, Run, project, and Epic locks.
6. Commit or roll back source state, source events, projection rows, and cursor
   atomically; the transaction-scoped permit is then released.

The cursor remains held through commit, preserving committed global ordering.
Connection loss and process termination release PostgreSQL session and
transaction locks; rollback releases the active permit without committing
source or ledger state. Capacity exhaustion is rejected before source mutation,
with retryable overload classification. Unknown execution is not retried or
converted to success by admission handling. Worker reconciliation treats
admission overload as deferred work and preserves durable recovery state.

The implementation supports the current single-owner, single-API-process
deployment assumptions. PostgreSQL accounting is global across participating
processes, but each deployment must route every event-producing writer through
the constrained writer path. Multiple API instances, writer credentials, or
new maintenance processes require explicit inventory and load validation before
use. The reserved pending slot protects some critical paths; it does not prove
fair scheduling under every sustained workload.

## Benchmark method and evidence

The benchmark compared three isolated disposable databases and code states:

- **0028 baseline:** `be9e734f134e5a9442bc1eaed989473efd1ac7a6`, migration 0028.
- **0029 unbounded:** `8e8d6a57c330e4d35b804ad2abc8cc789933c594`, migration 0029.
- **Admission candidate:** the same PR #90 code plus migration 0030 and the
  working-tree admission changes measured before this ADR; migration 0030.

The harness recorded each base commit SHA, working-tree dirty flag, and
migration head. The 0028 and 0029 trees were clean. The 0030 admission candidate
was dirty on base commit `8e8d6a57c330e4d35b804ad2abc8cc789933c594`; the harness
did not fingerprint or archive the full dirty tree. The admission helper ACL
was narrowed after the measured run. The 0030 candidate values are therefore
useful failure evidence, but are not a reproducible exact-final-tree acceptance
run. The exact 0029 unbounded comparison is clean and identified.

The mixed profile measured 2,000 Task mutations and ten Run outcomes per
repetition (200 Task mutations per Run outcome) across ten fixture batches; it
did not match the previously requested 31:1 Task/Run ratio.

PostgreSQL was 17.6 (`170006`) using
`postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`,
with a 2 CPU, 2 GiB memory container. PostgreSQL settings were
`shared_buffers=512MB`, `effective_cache_size=1GB`, `work_mem=16MB`, and
`max_connections=200`. The container did not record new CPU throttling during
the measured matrix; the maximum recorded cgroup memory peak was 651.48 MiB.
The host had no intentional competing benchmark workload, but host-level
utilization was not captured as an artifact. No live owner database or real
provider was used. The inspected container configuration is recorded in
[`benchmark-environment.md`](evidence/pr90/benchmark-environment.md).

Each operation/version/concurrency cell had five alternating-order measured
repetitions of 2,000 operations (10,000 total), with a 200-operation warmup
(100 for mixed Run profiles). Task creation, project assignment, project
reassignment, and mixed Task plus mock Run completion, cancellation, or expiry
reconciliation ran at concurrency 1 and 4. The displayed p50/p95/p99 values are
pooled per-operation samples; throughput is the median of the five run-level
measurements, with the minimum included to show variation. API-store request
latency and database mutation query latency were recorded separately; p95 gates
below use the store request samples. All measured batches reported ledger/source
integrity valid.

### Task and project mutation results

All latency values are milliseconds. `0029+0030` is the bounded-admission
candidate. Throughput is ops/s (median; minimum in parentheses).

| Operation        | Writers | 0028 p95 | 0029 p95 | 0029+0030 p95 | Overhead vs 0028 | Candidate p99 | Candidate throughput | Gate                    |
| ---------------- | ------: | -------: | -------: | ------------: | ---------------: | ------------: | -------------------: | ----------------------- |
| Task create      |       1 |     5.65 |     6.96 |          6.75 |           +19.4% |         10.42 |        208.1 (190.2) | Pass absolute           |
| Task create      |       4 |     9.00 |    21.54 |         21.56 |          +139.6% |         26.32 |        248.4 (239.3) | Pass absolute           |
| Project assign   |       1 |     6.72 |     9.02 |         10.50 |           +56.2% |         14.77 |        183.9 (114.9) | Inconsistent throughput |
| Project assign   |       4 |    11.52 |    33.00 |         36.61 |          +217.8% |         70.06 |        177.9 (127.2) | **Fail**                |
| Project reassign |       1 |     7.36 |    11.81 |          9.68 |           +31.5% |         15.14 |        171.8 (143.3) | **Fail throughput**     |
| Project reassign |       4 |    10.18 |    25.57 |         25.62 |          +151.8% |         32.23 |        215.9 (199.9) | **Fail p95**            |

The old ≤10% relative overhead gate remains failed in every listed
0028-to-admission comparison. At four writers, project
assignment p95 rose from 11.52 ms on 0028 to 36.61 ms on the admission
candidate; project reassignment rose from 10.18 ms to 25.62 ms. Admission
control did not remove the serialized cursor cost. Candidate project assignment
at four writers also missed both the absolute p95, p99, and throughput gates.

### Mixed Task and Run observations

No absolute acceptance threshold was approved for mixed workloads. Results are
provided as observations, not a pass/fail gate. At four writers, candidate Task
mutation p95 / median throughput were: completion `32.28 ms / 169.4 ops/s`,
cancellation `37.57 ms / 151.9 ops/s`, and expiry `22.72 ms / 236.1 ops/s`.
Each repetition measured only ten Run outcomes. The reported
`runOutcomeP95Ms` is therefore the maximum of those ten outcomes; the median of
per-repetition maxima was respectively `62.2 ms`, `147.2 ms`, and `38.3 ms`.
These are small-sample maxima, not reliable p95 estimates. Raw Run-outcome
samples were not retained. Every repetition completed the expected mock Run
transitions and passed event-integrity checks. This confirms those paths
executed, but does not establish Run-outcome tail latency under a 31:1 mix.

### Cursor wait profile

A separate profiling-only candidate Task-create run at four writers used
`log_lock_waits=on` and `deadlock_timeout=1ms`; these settings were then reset.
The profile captured 2,197 D5 cursor lock waits above the 1 ms reporting
threshold: p50 `17.182 ms`, p95 `24.513 ms`, maximum `556.288 ms`. Per-wait
values are preserved in
[`cursor-lock-waits-c4-create.csv`](evidence/pr90/cursor-lock-waits-c4-create.csv)
(SHA-256 `ece0d70d639b7965f2ad5918acdb6d4953d27314752bbe679053c2dcf67bab02`).
The file contains parsed milliseconds from PostgreSQL log lines for
`pg_advisory_xact_lock(70463909136525)`; the parser selected `acquired
ExclusiveLock` records for the candidate database's D5 key. PostgreSQL emitted
these records for waits above the configured 1 ms `deadlock_timeout`. This
exceeds the proposed p95 and maximum gates. Lock logging changes instrumentation
cost, so these are profiling observations, not acceptance latency measurements.
The profile does not independently measure lock-hold time. The 1–4 writer
latency matrix was run with lock logging off.

The 8, 16, and 32 attempted-writer integration cases verify bounded admission,
overflow rejection, and no partial source or event writes while capacity is
held. They are correctness pressure tests, not sustained throughput benchmarks;
queue duration, rejection-rate, and service-throughput behavior under sustained
overload remain unmeasured.

## Consequences and limits

- D5 atomicity, commit-visible ordering, deduplication, ACLs, cutover-only
  history, and unknown-outcome rules remain in place.
- The provisional four-active/four-pending envelope is implemented, but its
  absolute performance gates are not met. PR #90 is not ready for owner merge
  consideration on performance grounds.
- The current data does not justify expanding the concurrency envelope. A
  future request above four active writers, repeated overload, another API
  process, or a failed critical-operation latency objective triggers renewed
  D5 and admission design review.
- The bounded fourth pending slot is reserved for critical callers, but the
  shared `omnis_runtime` database identity can request critical admission.
  Priority is a trusted-caller scheduling convention, not a separate
  authorization boundary. A distinct database identity is needed if code
  under that role ceases to be trusted.
- Any future sequencing alternative, including an outbox or partitioned
  cursors, requires explicit owner reapproval of D5 and review of event
  visibility, replay, ordering, and recovery semantics. No performance benefit
  is assumed without new measurements.
- This decision does not approve deployment architecture or real-provider
  execution. Production execution remains mock-only.

## Current PR state

PR #90 remains Draft. Exact-head CI run
[`42686107681`](https://github.com/Jeysibn/omnis-os/actions/runs/42686107681)
on `5d30894486039dafeba14a61bc15348ba78cac93` failed in two places: the
critical-slot concurrency test reached its three-second bounded lock timeout,
and the disposable queue-startup guard fixture inserted a Task without taking
the new admission and cursor locks. The other CI jobs passed. The test now
observes all four pending slots in one bounded wait, and the fixture creates
its Task through the runtime store. Exact-head CI rerun is pending.

The exact-head backend/security review found no blocking lock-order, writer
coverage, ACL/restore, or state-integrity defect. Its verdict was REQUEST
CHANGES because performance acceptance failed and the earlier candidate was
not fingerprinted; it also recorded that the shared runtime database identity
can request the critical slot, making that reservation a trusted-caller
scheduling convention. The separate methodology review confirmed the CSV
cursor-wait statistics, while the full raw run bundle and original PostgreSQL
log lines remain unavailable in this repository. Exact final-tree performance
measurement and CI rerun remain required.

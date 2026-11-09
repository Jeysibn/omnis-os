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
- **Exact admission candidate:** `7713fd1856b64d918f5b271bac0d8016d5ec92af`,
  clean source tree, migration 0030. This is the pushed implementation and
  test-fix commit reviewed by CI and the independent backend/security reviewer.

The initial working-tree candidate run is superseded. The final candidate-only
rerun reported the exact source SHA, `sourceDirty=false`, PostgreSQL 17.6, and
migration head 0030 for every cell. Before measurement, the disposable
candidate database's admission-helper grants were aligned with migration 0030's
final ACL (runtime only; authorizer, launcher, and PUBLIC revoked). Source and
ledger integrity passed in every run. Per-run summaries are in
[`mission-lane-exact-head-runs.csv`](evidence/pr90/mission-lane-exact-head-runs.csv).
Full per-operation sample arrays remain on the benchmark host under
`/tmp/pr90-benchmark-results-final/`, so the pooled aggregates cannot be
recomputed from this repository alone.

Each version's six workload profiles were measured at concurrency 1 and 4,
with five repetitions of 2,000 Task mutations (10,000 per profile/concurrency)
and warmups of 200 operations (100 for mixed profiles). The 0028 and 0029 runs
were alternated as originally recorded. The exact final candidate follow-up was
run as its own 60-cell matrix rather than interleaved with the earlier two
versions; absolute candidate measurements are tied to the exact clean SHA, but
the relative comparison is more sensitive to time-varying host load. Host-level
CPU utilization was not captured. Mixed runs measured 2,000 Task mutations and
ten Run outcomes per repetition (200:1, not the previously requested 31:1).

PostgreSQL was 17.6 (`170006`) using
`postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`,
with a 2 CPU, 2 GiB memory container. PostgreSQL settings were
`shared_buffers=512MB`, `effective_cache_size=1GB`, `work_mem=16MB`, and
`max_connections=200`. During the exact final candidate matrix, cgroup
`nr_throttled` remained 15 and `throttled_usec` remained 6,329,838; maximum
recorded memory peak was 766,959,616 bytes (731.5 MiB). Host-level utilization
was not captured as an artifact. The host had no intentional competing
benchmark workload. No live owner database or real provider was used. The
container configuration is recorded in
[`benchmark-environment.md`](evidence/pr90/benchmark-environment.md).

The exact final candidate ran Task creation, project assignment, project
reassignment, and mixed Task plus mock Run completion, cancellation, or expiry
reconciliation at concurrency 1 and 4. Candidate p50/p95/p99 values below are
pooled per-operation request samples; throughput is the median of five
run-level measurements, with the minimum in parentheses. API-store request
latency and database mutation query latency were recorded separately; proposed
gates use store request latency. The full sample arrays are not packaged, but
the per-run summary table records each repetition and integrity result.

### Task and project mutation results

All latency values are milliseconds. Throughput is ops/s (median; minimum in
parentheses). The relative-overhead column uses the clean 0028 p95 baseline.

| Operation        | Writers | 0028 p95 | 0029 p95 | 0030 p50 | 0030 p95 | 0030 p99 | Overhead vs 0028 | 0030 throughput | Gate                          |
| ---------------- | ------: | -------: | -------: | -------: | -------: | -------: | ---------------: | --------------: | ----------------------------- |
| Task create      |       1 |     5.65 |     6.96 |     4.17 |     6.40 |    10.01 |           +13.3% | 226.79 (200.27) | **Fail old relative gate**    |
| Task create      |       4 |     9.00 |    21.54 |    23.74 |    31.58 |    39.32 |          +250.9% | 162.56 (159.87) | **Fail p95 and throughput**   |
| Project assign   |       1 |     6.72 |     9.02 |     5.06 |     8.75 |    11.78 |           +30.1% | 178.27 (152.32) | **Fail throughput**           |
| Project assign   |       4 |    11.52 |    33.00 |    16.45 |    24.16 |    29.11 |          +109.7% | 230.01 (201.41) | Pass absolute; old gate fails |
| Project reassign |       1 |     7.36 |    11.81 |     5.02 |     8.56 |    11.60 |           +16.4% | 180.76 (157.05) | Pass absolute; old gate fails |
| Project reassign |       4 |    10.18 |    25.57 |    16.93 |    23.83 |    29.40 |          +134.0% | 222.59 (213.22) | Pass absolute; old gate fails |

The former ≤10% relative overhead gate remains failed in all six exact
0028-to-0030 comparisons and has not been waived. Under the owner-approved
absolute limits, Task creation at four writers fails p95 and throughput, and
project assignment at one writer misses the 180 ops/s median-throughput target.
The candidate therefore fails the Phase 1 performance gate even though the
other four absolute operation/concurrency cells pass.

### Mixed Task and Run observations

No absolute acceptance threshold was approved for mixed workloads. At four
writers, pooled Task request p95 / median throughput were: completion
`30.81 ms / 159.34 ops/s`, cancellation `22.75 ms / 240.87 ops/s`, and expiry
`22.97 ms / 233.83 ops/s`. At one writer they were respectively
`5.98 ms / 218.80 ops/s`, `6.14 ms / 232.36 ops/s`, and
`7.11 ms / 198.53 ops/s`. Each repetition measured only ten Run outcomes. The
reported per-repetition Run p95 is the maximum of those ten outcomes; the
median of those maxima at four writers was `54.79 ms` for completion,
`88.48 ms` for cancellation, and `39.46 ms` for expiry (observed min–max
`42.67–58.57`, `72.75–141.85`, and `34.88–50.73 ms`). These are small-sample
maxima, not reliable p95 estimates. Raw Run-outcome samples were not retained.
Every repetition completed the expected mock Run transitions and passed
event-integrity checks. This does not establish Run-outcome tail latency under
the requested 31:1 mix.

### Cursor wait profile

A separate profiling-only run of the earlier working-tree 0030 candidate at
four writers used `log_lock_waits=on` and `deadlock_timeout=1ms`; these settings
were then reset. This was before the final helper-ACL correction and was not
rerun on exact source SHA `7713fd1`.
The profile captured 2,197 D5 cursor lock waits above the 1 ms reporting
threshold: p50 `17.182 ms`, p95 `24.513 ms`, maximum `556.288 ms`. Per-wait
values are preserved in
[`cursor-lock-waits-c4-create.csv`](evidence/pr90/cursor-lock-waits-c4-create.csv)
(SHA-256 `ece0d70d639b7965f2ad5918acdb6d4953d27314752bbe679053c2dcf67bab02`).
The file contains parsed milliseconds from PostgreSQL log lines for
`pg_advisory_xact_lock(70463909136525)`; the parser selected `acquired
ExclusiveLock` records for the candidate database's D5 key. PostgreSQL emitted
these records for waits above the configured 1 ms `deadlock_timeout`. The
profile exceeds the proposed p95 and maximum gates, but is historical directional
evidence rather than a final-head cursor-wait acceptance measurement. Lock
logging changes instrumentation cost. The profile does not independently
measure lock-hold time. The exact-head 1–4 writer latency matrix ran with lock
logging off.

The exact-head tests cover 5, 8, 16, and 32 attempted writers, bounded admission,
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
[`42689976519`](https://github.com/Jeysibn/omnis-os/actions/runs/42689976519)
passed all eight jobs on `7713fd1856b64d918f5b271bac0d8016d5ec92af`. The prior
head `5d308944…` had a timed concurrency-test failure and an integration
fixture that bypassed admission; both were corrected and the exact-head rerun
passed. The independent backend/security reviewer found no blocking writer
coverage, lock-order, ACL/restore, or state-integrity defect on `7713fd1`; the
overall verdict remains REQUEST CHANGES because performance acceptance failed.
The reviewer also noted that the shared runtime database identity can request
the critical slot, so priority remains a trusted-caller convention.

The exact candidate-only performance matrix is tied to clean source SHA `7713fd1`
and every cell passed integrity checks. The old ≤10% relative-overhead gate
still fails, and the approved absolute limits fail on Task creation at four
writers and project assignment at one writer. The full raw samples and original
PostgreSQL lock log lines are not packaged; per-run summaries and the parsed
historical cursor-wait CSV are included, while raw arrays remain local to the
benchmark host.

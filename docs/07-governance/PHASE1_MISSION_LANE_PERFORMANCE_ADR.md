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

## 2026-11-10 remediation investigation addendum

**Status:** Performance acceptance remains **FAIL**. PR #90 remains Draft.
This addendum supersedes earlier statements that the reserved critical queue
slot provides sufficient critical-operation protection. It does not.

### Candidate and benchmark provenance

The reported four-writer Task-creation result (p95 `31.58 ms`, throughput
`162.56 ops/s`) was produced with migration head
`0030_mission_lane_admission`, not with migration 0029 alone. The database
schema-migration ledger was checked by the runner before each run. Thus it
exercised the full candidate, including global admission and D5 projection.
However, the checked-in benchmark runner at PR head `b0a3be0` had a candidate
source-SHA expectation inconsistent with the recorded source SHA; the archived
output could not be reproduced unchanged with that runner. The runner now
requires an explicit exact candidate SHA, rejects dirty source trees, and
verifies the database migration head. It records request, mutation query, read
query, pool checkout, and Run-outcome samples separately. This fixes benchmark
identity checking; it does not change database behavior.

The remediation comparison used clean `b0a3be0` source with migration 0030 for
the original side and the same migration plus a temporary wrapper shortcut for
the experimental side. The shortcut made the outer admission wrapper call the
private mutation core directly instead of nesting through the renamed 0029
wrapper (which attempted to reacquire the same transaction advisory lock). It
was reverted and is not part of this PR. The remediation run used five
repetitions of 10,000 measured operations per cell (50,000 samples pooled),
whereas the earlier exact-candidate matrix used five repetitions of 2,000
operations (10,000 samples pooled). The fixture reset cadence also differed.
The run is therefore diagnostic and is not a strict reproduction of the
earlier exact-candidate result. The raw per-operation arrays and run summaries
are packaged under
[`evidence/pr90/remediation`](evidence/pr90/remediation/).

| Operation        | Writers | Original 0030 p95 | Shortcut p95 | Shortcut p99 | Throughput median, original → shortcut (minimum shortcut) |
| ---------------- | ------: | ----------------: | -----------: | -----------: | --------------------------------------------------------: |
| Task create      |       1 |           6.85 ms |      6.52 ms |      9.96 ms |                            224.30 → 235.82 (208.79) ops/s |
| Task create      |       4 |          21.19 ms |     26.13 ms |     32.83 ms |                            248.68 → 248.86 (182.44) ops/s |
| Project assign   |       1 |           8.14 ms |      7.95 ms |     11.29 ms |                            185.43 → 189.97 (176.04) ops/s |
| Project assign   |       4 |          30.80 ms |     36.47 ms |     56.85 ms |                            207.91 → 209.08 (125.01) ops/s |
| Project reassign |       1 |           9.02 ms |      8.79 ms |     13.84 ms |                            163.40 → 173.48 (144.01) ops/s |
| Project reassign |       4 |          25.42 ms |     26.47 ms |     37.26 ms |                            193.79 → 190.96 (183.69) ops/s |

The wrapper change did not reliably reduce p95 latency or improve throughput.
In this diagnostic matrix, original 0030 four-writer Task creation passed the
absolute limits (p95 `21.19 ms`, p99 `25.78 ms`, median throughput
`248.68 ops/s`), while the earlier exact-candidate measurement failed (p95
`31.58 ms`, throughput `162.56 ops/s`). This is a material conflict, not a
pass. The original four-writer project-assignment p95 failed at `30.80 ms`;
single-writer reassignment throughput was `163.40 ops/s`, below target. The
temporary shortcut arm failed four-writer create and assignment p95 and did
not represent PR code. Several repeated runs varied substantially, including
paired assignment runs with p95 values of `39.58 ms` and `54.36 ms`. The
container lifetime recorded CPU throttling, but those
counters covered setup, tests, and benchmarks together and cannot be attributed
to these cells. Consequently this comparison is diagnostic, not a clean
acceptance rerun; host CPU utilization and benchmark-only cgroup deltas were
not captured.

The archived interleaved request/mutation arrays do not include pool-checkout
or read-query arrays. The earlier summary recorded those values, but its
percentile helper was applied to unsorted checkout/read arrays. Those summary
percentiles are not valid and must not be used as evidence. The benchmark
runner now sorts all recorded timing arrays before calculating quantiles and
includes the checkout/read/Run arrays in new raw output. No new full matrix has
yet been run with that correction.

### Lock, transaction, and pool profile

Separate profiling-only runs used temporary database wrappers that emitted
`RAISE LOG` timings. They are diagnostic and were not used for acceptance
latency because per-operation logging can add overhead. For 2,000 four-writer
Task creates, the original wrapper showed pool-checkout p95 `0.014 ms`,
admission wait p95 `0.128 ms`, D5 cursor acquisition wait p95 `15.161 ms`,
mutation-function p95 `0.850 ms`, and cursor hold through commit p95
`4.334 ms`. The shortcut profile showed create cursor acquisition p95
`19.363 ms` and hold-through-commit p95 `6.17 ms`; assignment showed
`18.017 ms` and `7.89 ms`. These directional samples show pool checkout and
the nested function call are not the dominant observed contributors. Time
waiting for the globally serialized D5 cursor and waiting behind a preceding
transaction dominate the tail; the wrapper shortcut did not reduce that wait.

The cursor profile has a time-correlation limitation: it used client-side
timestamps aligned to server logs, and the separate runs were not simultaneous.
It supports the conclusion that the D5 wait is a material latency contributor,
but does not provide final exact-head acceptance values for cursor wait or lock
hold. Those two gates remain **BLOCKED / unmeasured** on the final unmodified
candidate.

### Sustained overload and critical progress

A 30-second uninstrumented disposable load used four independent writer
processes with eight writer loops each (32 attempted writers), a critical
admission probe every 250 ms, and a 50 ms PostgreSQL lock-table sampler. It
observed 195 committed Task operations, 13,590 retryable overload rejections,
zero unexpected operation errors, maximum four active permits, maximum four
pending slots, and `Pool.waitingCount` maximum zero. Before the final probe,
Task rows, ledger events, and clock sequence all equaled 195; a post-load write
succeeded and advanced all three to 196. The uninstrumented successful-request
latency was p50 `889.76 ms`, p95 `3,095.75 ms`, max `3,682.75 ms`. These
measurements include waiting and execution and are not the normal-load latency
acceptance profile.

All 13 uninstrumented critical admission probes completed, with wait p50
`2,010.22 ms`, p95/max `3,042.29 ms`; this exceeds the owner-selected
three-second total deadline. A previous instrumented run had four of nine
critical probes time out and five successes with p50 `4.151 s`, p95/max
`4.948 s`; its successful workload request p50/p95/max was `2.178/5.987/6.701
s`, admission wait reached `4.70 s`, and cursor wait reached p95 `2.80 s`, max
`2.97 s`. SQL logging may have affected those timeouts, so the uninstrumented
run is the latency evidence. The two runs together show that the current
mechanism does not enforce a three-second total deadline. PostgreSQL's existing
three-second `lock_timeout` is per lock wait; multiple waits can accumulate.

The reserved fourth pending slot reserves a slot; it does not prioritize
critical work when normal callers are ahead at admission or when permits are
handed out. The 13 successful uninstrumented probes do not prove starvation
freedom or a latency bound. The independent read-only reviewer returned
**REQUEST CHANGES** for the current scheduler semantics. It proposed a
priority-aware scheduler and single deadline while retaining the same 4/4
caps and D5. After the owner selected a three-second total admission-to-D5
deadline, the reviewer marked that proposed design **BLOCKED pending
reassessment and PostgreSQL race/cleanup tests**. A strict completion bound
would also require bounded transaction execution time. No scheduler correction
has been implemented; the existing mechanism must not be described as
starvation-free.

Required follow-up evidence before performance acceptance:

- Independent approval of the revised scheduler design and the owner-selected
  three-second admission-to-D5 deadline, including critical overload/timeout
  retry semantics.
- An uninstrumented sustained-overload run with latency, throughput, rejection
  counts, queue duration, starvation, pool waiters, and observed maximum active
  and pending counts.
- A separate instrumented run for admission, pool checkout, D5 acquisition,
  cursor hold, mutation, and commit timing, with benchmark-only CPU/memory
  deltas.
- Repeated exact-candidate 1- and 4-writer profiles against matched migration
  0028 fixtures before claiming any absolute gate passes.

Until then the gate results are: Task-create p95 and throughput at four writers
**INCONCLUSIVE** because the exact-candidate run and the new non-equivalent
remediation run conflict; four-writer project-assignment p95 **FAIL** on the
new original-0030 profile; single-writer project-assignment throughput
**INCONCLUSIVE** across reported repetitions; single-writer reassignment
throughput **INCONCLUSIVE** across reported repetitions; exact-head cursor-wait
and hold limits **BLOCKED / unmeasured**; the three-second admission deadline
**FAIL** in the uninstrumented overload sample. The independent reviewer
requires a fresh scheduler review, so scheduler acceptance remains **BLOCKED**.
The former ≤10% relative-overhead gate remains a documented historical failure
and is not waived. Do not change D5 from these results alone. Complete a
matched candidate/0028 rerun and resolve scheduler fairness first; if the
absolute gates still fail, return to the owner for an explicit architecture
decision.

## 2026-11-10 owner-approved admission implementation and exact-candidate retest

**Status:** The owner-approved four-active/four-pending admission design is
implemented locally and its correctness checks pass. Performance acceptance is
**FAIL**. PR #90 remains Draft and its remote head is unchanged while the exact
code review is pending.

### Baseline and candidate identity

- Latest fetched `main`: `4a27bc3718d4960ad9b132b0f53cdc938da57b54`.
- Remote PR #90 head: `b0a3be0d19eebae2d9f2c400fe6bcd39e85bb976` (Draft).
- Local candidate: `0213e8c6c5f06b2a0d0041e036c79c96e121c922`, based on current
  main, with migration 0030. It has not been pushed.
- The reviewer approved the priority-aware scheduler design before
  implementation. Exact-diff code review of this candidate is pending; the
  prior review of `7713fd1` is not approval of this code.

The owner selected a single three-second admission-to-D5 deadline. The
implementation passes the remaining deadline through pool checkout, bounded
queue/turnstile promotion, permit acquisition, and the cursor wait. It retains
four transaction-scoped permits, four globally reserved pending slots (three
normal and one reserved for critical work), D5 serialization, and atomic
source/event/cursor commits. API pool waiters are capped locally before
checkout, while PostgreSQL advisory locks enforce the global bound across
processes.

### Candidate benchmark results

Five sequential repetitions of 10,000 measured Task operations were run at
concurrency one and four on PostgreSQL 17.6 with a 2 CPU / 2 GiB container.
The tree was clean at the candidate SHA for each cell. Project profiles seeded
10,000 assigned fixture Tasks per repetition outside the measured mutation
window. Pooled results below include 50,000 request samples per cell. Raw
arrays and per-run summaries are in
[`admission-candidate-0213-results.json`](evidence/pr90/remediation/admission-candidate-0213-results.json)
and [`admission-candidate-0213-raw-samples.tar.gz`](evidence/pr90/remediation/admission-candidate-0213-raw-samples.tar.gz).

| Operation            | Writers | Request p95 | Request p99 | Throughput, median (minimum) | Gate                                                        |
| -------------------- | ------: | ----------: | ----------: | ---------------------------: | ----------------------------------------------------------- |
| Task create          |       1 |     6.98 ms |    10.38 ms |        219.19 (183.71) ops/s | PASS                                                        |
| Task create          |       4 |    23.59 ms |    29.78 ms |        243.21 (218.78) ops/s | INCONCLUSIVE: conflicts with earlier 2k exact-candidate run |
| Project assignment   |       1 |     7.84 ms |    11.06 ms |        188.14 (180.55) ops/s | PASS, narrow throughput margin                              |
| Project assignment   |       4 |    25.23 ms |    32.10 ms |        221.03 (201.23) ops/s | FAIL, p95                                                   |
| Project reassignment |       1 |     8.42 ms |    11.43 ms |        179.65 (175.88) ops/s | FAIL, throughput                                            |
| Project reassignment |       4 |    25.36 ms |    34.82 ms |        216.24 (206.33) ops/s | FAIL, p95                                                   |

Two of five individual four-writer project-assignment runs exceeded 25 ms
at p95; two of five reassignment runs exceeded the same limit. Reassignment
throughput at one writer had a median below 180 ops/s. The 10% relative
overhead gate remains a historical failure and was not re-evaluated by this
candidate-only matrix. This run does not replace a matched migration-0028
comparison.

The database mutation query accounts for nearly all measured project mutation
latency: pooled query p95 was 24.39 ms for assignment and 24.55 ms for
reassignment. The separate task readback p95 was below 1 ms, and pool checkout
p95 was below 0.02 ms. In a filtered 10,000-operation diagnostic run, 5 ms
PostgreSQL lock sampling observed admission lock-wait p95 `8.02 ms`, D5 cursor
wait p95 `4.18 ms` (maximum `29.59 ms`), and sampled cursor-hold p95 about
`8 ms` (maximum about `30 ms`). Hold times are approximate to the sampling
interval. These values pass the proposed wait gates in that diagnostic run;
they do not override the operation p95 failures or constitute a five-run lock
profile. The old unfiltered sample that included fixture setup is excluded.

The profile points to database mutation and projection work under serialized
cursor access as the remaining cost. It does not establish that the cursor wait
alone causes the p95 misses. Removing the post-mutation readback may improve
throughput slightly, but it can change the current response behavior on
idempotent replay and was not included in this candidate. No further runtime
optimization is authorized without an independent review of those semantics.

### Overload, priority, and recovery evidence

An uninstrumented 30-second run used four independent Node processes, eight
writer loops per process, and a critical admission probe every 250 ms. It
observed 7,024 successful Task writes, 76,938 retryable overload responses,
zero unexpected errors, maximum four pending slots, and maximum two active
permits observed. Four active is a global upper bound; the turnstile scheduler
usually presents at most one cursor holder and one cursor waiter at a time.
No pool checkout waiters accumulated. Successful request p95, including
admission and execution, was 21.93 ms; rejected response p95 was 1.07 ms.
All 115 critical probes succeeded, with admission p95 `9.60 ms` and maximum
`200.01 ms`. The ledger contained exactly 7,024 events with contiguous
sequences `1..7024`; a post-load write advanced Task, event, and clock counts
to 7,025. Detailed raw evidence is in
[`admission-candidate-0213-overload-raw.json`](evidence/pr90/remediation/admission-candidate-0213-overload-raw.json).

This shows critical progress for the tested workload, not a proof of fairness
for all deployments. The overload run is independent of the normal-load
latency gate. A mixed warmup profile with four Task writers and a simultaneous
critical Run mutation hit the designed bounded overflow response; the
benchmark harness did not retry that response with the same request identity,
so it is not counted as a mixed-workload performance result. The database
correctness suite separately covers Run completion, cancellation, expiry,
recovery, and transactional projection under the same migration.

### Validation and decision

The full repository pre-commit check passed before the current-main sync:
format, lint, all workspace typechecks, unit tests, and repository policy
tests. Focused PostgreSQL tests against disposable PostgreSQL 17.6 passed
137/137, including admission bounds, cancellation cleanup, timeout rollback,
ACL isolation, recovery, and event-sequence integrity. Worker coordinator
tests passed 37/37. The current-main merge and this candidate have not been
submitted to GitHub Actions; no exact-head CI result is claimed for `0213e8c`.

The proposed absolute gates therefore remain **FAIL** for four-writer project
assignment p95, one-writer project reassignment throughput, and four-writer
project reassignment p95. Four-writer Task creation is **INCONCLUSIVE** across
the historical 2k and current 10k candidate-only runs. The independent
read-only review of the complete `0213e8c` diff returned **REQUEST CHANGES** for
a medium-severity priority race: a normal queued writer can hold the turnstile
while waiting for an active permit, allowing a critical request that registers
after the normal marker check to wait behind it. The reviewer also flagged the
runtime role's direct execution grant on the lock-only helper as an availability
risk if runtime SQL access is outside the trusted-process boundary. No
benchmark evidence authorizes deployment or real-provider execution.

The same reviewer found a candidate micro-optimization in project association:
the store performs a post-mutation `getTask` despite the SQL mutator returning
the idempotency receipt. Returning that receipt could remove one query, but it
changes replay responses from current Task state to the original operation
snapshot. Do not apply it until the receipt contract is tested and documented,
and benchmark the change independently. Do not modify D5 or relax the gates.

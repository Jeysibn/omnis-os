# PR #90 queue-slot unlock correction evidence

**Scope:** Focused correction and four-writer performance comparison for
migration 0030. This evidence does not establish full PR merge readiness.

## Source provenance

- PR base source: `30037abc00b38872b42cc86d016717aa123d76e4`.
- Main at task start and final pre-push fetch:
  `af5904abf70fd2ca4b87a5376c11950b54a519ac`.
- Before migration SHA-256:
  `f622b80f957aac40738f8693df467bef5d7dcaac67f0a7b77dc420f06471c8ac`.
- Corrected migration SHA-256:
  `ff0e69090627f72a43a72a6f0db361509b54a6b308f97be81c47fabb89ed4760`.
- The benchmark source was the base commit plus a diagnostic worktree patch;
  no commit existed for the measured correction. The final tracked diff is
  independently reviewed before merge consideration.

## Cause and correction

For queued callers, the function acquires a queue-slot advisory lock and sets
`v_has_queue_slot`. On successful active-permit promotion, the guarded release
already unlocks that queue slot and clears the flag. There is no queue-slot
reacquisition before success cleanup. A later unconditional unlock therefore
attempted a second release of a session lock the backend no longer owned.

The correction removes only that unconditional unlock and its redundant flag
assignment. The earlier guarded release and guarded exception cleanup remain.
The turnstile, critical marker, transaction-scoped active permit, D5 cursor,
lock order, admission priority and commit boundary are unchanged.

## Method

Two separately labeled disposable PostgreSQL 17.6 instances used the pinned
image
`postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`.
Each had 2 CPU and 2 GiB RAM, with identical settings: 512 MB
`shared_buffers`, 1 GB `effective_cache_size`, 16 MB `work_mem`, and 200
`max_connections`. Server timing and lock-wait logging were off. Request,
mutation-query and pool-checkout metrics came from the existing client harness.

The comparison covered Task creation, project assignment, and reassignment at
four writers: five matched repetitions per operation and side, 2,000 measured
operations per repetition, 200 warmups, and 1,000-operation fixture batches.
Before/after order alternated between repetitions. Logs were exported after
each measured window and counted by window, excluding fixture and warmup work.
This is a focused correction comparison, not the complete 0028/0029/0030
matrix. No instrumented lock-log percentile is used as acceptance evidence.

## Results

Latency is milliseconds; throughput is operations per second. Percentiles pool
10,000 measured requests per side and operation. Throughput is the median of
five run-level measurements; minima expose repetition variance.

| Operation    | Side      |   p50 |   p95 |   p99 |    Max | Mutation query p95 | Throughput median (min) | Duplicate-unlock warnings | Integrity |
| ------------ | --------- | ----: | ----: | ----: | -----: | -----------------: | ----------------------: | ------------------------: | --------: |
| Create       | Before    | 16.77 | 26.97 | 38.72 | 282.86 |              26.77 |         224.07 (179.67) |                     9,989 |      Pass |
| Create       | Corrected | 16.00 | 25.71 | 33.24 | 278.03 |              25.53 |         235.28 (191.81) |                         0 |      Pass |
| Assignment   | Before    | 19.71 | 31.72 | 39.28 | 368.86 |              31.48 |         190.20 (148.85) |                     9,989 |      Pass |
| Assignment   | Corrected | 18.29 | 29.87 | 37.55 | 294.31 |              29.68 |         210.90 (147.34) |                         0 |      Pass |
| Reassignment | Before    | 19.52 | 31.94 | 38.81 | 451.40 |              31.69 |         191.02 (141.08) |                     9,990 |      Pass |
| Reassignment | Corrected | 18.17 | 30.43 | 37.22 |  88.75 |              30.23 |         220.58 (150.73) |                         0 |      Pass |

Across 30,000 measured before-correction mutations there were 29,968
duplicate-unlock warnings. Across 30,000 corrected mutations there were zero.
All cells passed source/event/sequence integrity. Run-level corrected p95 values
were create `21.32, 23.09, 32.00, 23.10, 21.47` ms; assignment `23.87, 24.05,
35.86, 24.15, 24.78` ms; reassignment `22.95, 23.56, 35.13, 30.81, 24.20`
ms.

The owner-approved PR-specific temporary threshold is four-writer **pooled
request p95 ≤35 ms**. All three corrected pooled p95s meet it. Median throughput
exceeds 180 ops/s for all three; some individual throughput runs fall below
180 ops/s. The original ≤25 ms target, relative overhead versus 0028,
cursor-wait p95 and maximum, sustained overload, starvation, and fairness are
not claimed as passes. Relative overhead and cursor distributions are
inconclusive for this corrected source.

## Regression and review evidence

On the unchanged source, the queued-admission regression failed because the
backend emitted an unowned-lock unlock notice. With the correction, the complete
PostgreSQL run-store suite passed **101/101**, and focused queued-admission and
deadline checks passed **2/2**. TypeScript, ESLint, Prettier, and whitespace
checks passed. A separate read-only backend/security review of the correction
found no queue ownership, release-path, priority, capacity, lock-order, or D5
regression. This earlier review must be followed by review on the exact final PR
head.

The full diagnostic manifest, raw samples, logs, container IDs and disposable
resource metadata were retained at `/tmp/pr90-unlock-evidence/` on the
benchmark host. The disposable containers, networks, volumes, and temporary
credentials were verified and removed after the runs. This repository report
retains the summary needed to interpret the waiver; raw samples are not
committed.

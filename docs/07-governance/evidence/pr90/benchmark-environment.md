# PR #90 benchmark environment record

Recorded for the disposable 180-cell comparison on 2026-11-10.

- PostgreSQL: 17.6, `server_version_num=170006`.
- Image: `postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`.
- Container limits: `NanoCpus=2000000000` (2 CPUs), memory `2147483648` bytes
  (2 GiB), memory swap `2147483648` bytes.
- PostgreSQL settings: `shared_buffers=512MB`,
  `effective_cache_size=1GB`, `work_mem=16MB`, `max_connections=200`.
- Benchmark matrix: 180 runs; cgroup `nr_throttled` remained 4 and
  `throttled_usec` remained 1,364,811 across recorded before/after samples.
- Maximum cgroup `memoryPeakBytes` in the run records:
  `683126784` bytes (`651.48 MiB`).
- The three databases were disposable `omnis_baseline`, `omnis_unbounded`, and
  `omnis_candidate`; no persistent owner database was used.

Container settings were read from `docker inspect`; PostgreSQL settings were
read from the candidate connection. Per-run cgroup counters are in
`/tmp/pr90-benchmark-results-v2/runs.jsonl` on the benchmark host. Host-level
CPU utilization and a system-wide concurrent-workload monitor were not saved,
so the absence of unrelated host workload is an operator observation rather
than a captured metric.

The 180-run raw result bundle and original PostgreSQL log lines were not
included in this repository. The summarized measurements and parsed cursor
wait values are preserved in the ADR and linked CSV, but a remote reviewer
cannot independently reproduce every aggregate or the PostgreSQL-log parsing
step from this checkout alone. The run bundle remains local to the benchmark
host at `/tmp/pr90-benchmark-results-v2/`.

## Exact-head admission candidate follow-up

After the implementation and CI corrections were committed, the bounded
admission candidate was rerun as a clean 60-cell candidate-only matrix at
`7713fd1856b64d918f5b271bac0d8016d5ec92af`, migration
`0030_mission_lane_admission`, with `sourceDirty=false`. It used the same
PostgreSQL image, container resource limits, and PostgreSQL settings above.
Each of the six operation profiles at concurrency 1 and 4 had five 2,000-task
repetitions, plus warmups; every matrix cell passed its source/event integrity
checks. This follow-up was candidate-only rather than interleaved with the
earlier 0028/0029 measurements, so relative comparisons are more sensitive to
time-varying host load than the original alternating matrix.

For this final candidate run, cgroup `nr_throttled` remained 15 and
`throttled_usec` remained 6,329,838 across recorded samples. Maximum recorded
memory peak was 766,959,616 bytes (731.5 MiB). The per-run summaries are in
[`mission-lane-exact-head-runs.csv`](mission-lane-exact-head-runs.csv). Full
per-operation arrays remain local at
`/tmp/pr90-benchmark-results-final/`; host-level CPU utilization and the raw
PostgreSQL cursor-lock log were not captured for this final matrix.

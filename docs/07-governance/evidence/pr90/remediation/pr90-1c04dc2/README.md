# PR #90 candidate 1c04dc2 evidence

Candidate: `1c04dc2f142f4aca79c98891cbbad7a791bbf9d8`  
Base main: `4a27bc3718d4960ad9b132b0f53cdc938da57b54`  
Database: PostgreSQL 17.6, migration `0030_mission_lane_admission`, disposable database only.  
Container: pinned PostgreSQL 17.6 image, 2 CPU and 2 GiB memory.

Files:

- `admission-candidate-1c04dc2-results.json` — five-run, 10,000-operation request latency matrix at 1 and 4 writers, including every run summary and pooled samples.
- `admission-candidate-1c04dc2-raw-samples.tar.gz` — raw per-operation latency arrays for all 30 matrix runs.
- `admission-candidate-1c04dc2-lock-profile.json` — D5 lock wait log sample, separate sampled wait/hold profiles, and measurement caveats.
- `admission-candidate-1c04dc2-mixed.json` — one 10,000-Task run each for completion, cancellation, and expiry reconciliation, using stable-key bounded retries.
- `admission-candidate-1c04dc2-overload.json` — 30-second, 32-writer overload run across two independent pools, with ledger integrity results.

`SHA256SUMS` verifies each artifact. Lock profiling was performed separately from the uninstrumented latency matrix. Its maximum wait/hold values are not acceptance-quality measurements because logging and observer gaps materially perturb the tail.

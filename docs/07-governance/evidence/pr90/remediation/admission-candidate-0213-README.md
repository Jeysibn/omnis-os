# PR #90 candidate 0213 benchmark evidence

Candidate source: `0213e8c6c5f06b2a0d0041e036c79c96e121c922`  
Base `main`: `4a27bc3718d4960ad9b132b0f53cdc938da57b54`  
Database migration head: `0030_mission_lane_admission`

`admission-candidate-0213-results.json` contains the pooled distributions and
per-run summaries. `admission-candidate-0213-raw-samples.tar.gz` contains the
30 original request-latency arrays named by operation, concurrency, and
repetition (`create-c4-r3.json`, for example). Each run contains 10,000
measured operations after 200 warmups. The archive does not include fixture
setup runs or the separate lock sampler.

`admission-candidate-0213-lock-sample.json` contains one filtered PostgreSQL
lock-table sampling run for 10,000 project-assignment operations at four
writers. The sampler interval was 5 ms; cursor hold durations are estimates
bounded by that sampling interval and are not a five-repetition acceptance
profile.

`admission-candidate-0213-overload-raw.json` contains the 30-second overload
run using four independent processes and 32 attempted writer loops. It
records request outcomes, critical probes, and ledger sequence verification.
Successful and rejected request rates are reported separately.

The candidate-only profile is not a migration-0028 comparison. It does not
resolve the former ≤10% relative-overhead failure. The earlier 2,000-operation
four-writer Task-create result conflicts with this 10,000-operation result;
that gate remains inconclusive pending a matched rerun. Project assignment and
reassignment failures remain failures against the approved absolute limits.

SHA-256 checksums for this evidence set are in `SHA256SUMS` in this directory.

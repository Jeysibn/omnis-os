# Current state and baseline evidence

## What exists at reviewed main 32901cf

`scripts/mission9d/controller/{schema,admission,journal,worker}.ts` and `SECURITY_CONTRACT.md` implement Stage 1 journal validation and atomic per-path reservation only. The contract binds reservations to run, generation, path, attempt ID and manifest digest; reserves at most three per path; uses a persistent private journal, stable `flock`, `/proc/locks` checks, atomic replacement/fsync and boot-bound `CLOCK_BOOTTIME` values. One controller session owns the run. Restarted controllers cannot resume it. Stage 1 does not launch fixtures or authorize release. The production clock adapter and target WSL2 semantics remain unverified.

PR #97 docs and research Compose describe A–E dependencies and blocked Docker-only WSL2 research. ADR-0012 ingress provenance is blocked. The Phase A manifest is preparation only. Existing `omnis-sandbox-launcher.service` is a restricted mock launcher with Docker-group authority; it is not the approved Mission 9D independent supervisor and cannot be reused as if it were one.

## What is only designed

Phase A designs A–E, a protected release channel, independent cgroup supervisor/finalizer, Windows Job/profile boundary, metadata observation, and outage quarantine are documentation. No Stage 2 release ledger, release IPC, inert gate, startup interlock, target-host evidence, or recovery implementation exists.

## Stage 1 validation interface boundary

Stage 2 may not read files in the Stage 1 directory itself. Proposed extension: Stage 1 controller exposes `validateReservation(request)` through its existing trusted worker/storage boundary. It accepts only `{schemaVersion, runId, generation, manifestSha256, sessionId, attemptId, path, requestDigest, receiptId}`. Stage 1 validates the exact shape; authenticates the Stage 2 authority by trusted peer credentials and executable/unit identity; acquires the same stable lock using existing storage code; verifies held lock descriptor, pathname, `/proc/locks`, directory identity, journal consistency and original boot ID/BOOTTIME deadline; then returns a bounded signed-or-channel-authenticated snapshot:

`{schemaVersion, result: valid|denied, runId, generation, manifestSha256, sessionId, attemptId, path, ordinal, requestDigest, reservationBootTimeNs, bootId, deadlineBootTimeNs, controllerPid, controllerStartTimeTicks, journalSequenceDigest}`.

No journal body, arbitrary event data, receipt-minting, mutation, session revival or reservation extension is returned. Errors are enumerated: malformed_request, peer_denied, lock_busy, lock_lost, journal_invalid, poisoned_session, terminal_session, boot_mismatch, expired, stale_generation, reservation_missing, reservation_conflict, controller_not_live, storage_unavailable. Any error means deny. Stage 1 keeps its lock only for the snapshot transaction; V3 does not permit Stage 2 to use this snapshot for live authorization: the validate-to-consume liveness race remains unresolved. The interface is a design candidate only. No Stage 1 lock is held while calling release authority, and holding it across Stage 2 commit is not accepted as proof of controller liveness.

Lock order is Stage 2 release-ledger lock → short Stage 1 read-only validation lock → release-ledger recheck/commit; Stage 1 never calls Stage 2. No reverse lock acquisition is allowed. Concurrent reservation serializes inside Stage 1; if it changes journal consistency, validation returns the resulting exact reservation snapshot or denies. Lock loss/ambiguous read poisons release attempt. This requires a Stage 1 contract extension and separate Codex #1 approval before implementation; no source modification is authorized here.

Remote main advanced after the requested baseline. Its commit is frontend-only by GitHub commit metadata and has parent 32901cf; no claim is made that current source at `af5904ab` was inspected from local git objects. Security conclusions here are explicitly pinned to 32901cf pending reviewer direction.


V3 status: live use of the proposed interface remains disabled until a separately reviewed Stage 1 lease amendment defines an acceptable linearization semantic. The original frozen Stage 1 contract is not modified.

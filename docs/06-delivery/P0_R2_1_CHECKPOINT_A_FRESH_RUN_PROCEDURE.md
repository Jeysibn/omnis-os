# P0-R2.1 Checkpoint A — Fresh-Run Evidence Procedure (Proposed)

**Status:** Design only — NOT AUTHORIZED / NOT EXECUTED.
**Applies to:** Any future Checkpoint A rerun. It does not cure or replace the prior INCONCLUSIVE run.
**Target boundary:** Existing owner-designated Ubuntu WSL2 only. No Docker daemon API, PostgreSQL, Windows, service, resource, ingress, or provider operations.

## Evidence review finding

The existing record includes Issue #142's authenticated approval timestamp and the owner's later report of eight comparisons with SR=0. It contains no reliable contemporaneous execution start/end evidence, exact per-command invocation record, or independently verifiable command/SR pairing. Issue #142 has no comments carrying execution evidence. The raw-output sharing deviation remains historical and is not erased by a fresh run.

## Proposed evidence method

Before any future run, freeze and independently review an exact source bundle containing the ordered command IDs, literal commands, accepted expectations, redaction/classifier rules, and status wrapper. Publish its SHA-256 and the separate owner-decision SHA-256 in a new authenticated approval record. The approval record must include a future validity window and be published before its start.

For the authorized run, use a reviewed local evidence runner that:

1. Verifies its own frozen source hash and target/operator preconditions before starting; mismatch exits without running a check.
2. Records a start event, then for each command records its ID, source hash, start/end timestamp, exact exit status, and the immediately following SR status as separate structured fields.
3. Keeps command stdout in process memory and classifies it against the preapproved expectation locally. It emits only allowlisted redacted classifications and status fields; it never writes raw stdout/stderr, terminal transcripts, screenshots, environment values, PIDs, namespace identifiers, or numeric ownership data to shared or durable evidence.
4. Stops on the first nonzero status, missing/mismatched SR, classifier uncertainty, unexpected value, timeout, clock anomaly, target mismatch, or output-channel failure. It records the stop reason and final timestamp, then performs no later command.
5. Emits a final summary with run ID, command-source hash, decision reference, start/end timestamps, ordered command IDs/status pairs, redacted classifications, and stop/complete state. The owner retains that summary privately; only the preapproved redacted summary may be shared.

The current source-only prototype is `scripts/platform/checkpoint-a-evidence.mjs`. It contains no process spawning, host inspection, Docker access, or file output; it accepts an injected streaming executor/status reporter/classifier and is exercised only with synthetic adapters. It retains at most 16 KiB of copied stdout in chunks of at most 4 KiB; concatenation can temporarily require a second 16 KiB buffer. The executor and stream implementation must also enforce bounded upstream buffering and the supplied timeout/abort contract; the prototype does not supply that executor. It aborts on overflow and waits for executor completion before asking for the immediately paired status report. It records wall-clock and monotonic ticks, command/runner hashes, ordered event-chain hashes, and a record checksum on complete and partial results. `verifyCheckpointEvidence` detects mutation against the recorded checksum; the checksum is not a signature or proof of who produced the record, so a digest must be anchored through a separately trusted channel before use as evidence. These hashes identify the frozen bytes only when compared with an independently retained source bundle; self-reported hashes are not an independent trust anchor. The runner stops without automatic retry inside one invocation, but has no durable cross-invocation replay guard. Re-invocation must remain prohibited until a trusted, single-use authorization/fencing design is reviewed. The runner has no production command manifest or executor. Do not connect it to a target executor until the exact adapter, clock source, command source and independent trust anchor receive review and separate owner authorization.

The runner's clock source, timestamp resolution, clock synchronization, output isolation, parser, failure paths, and command resolution must be reviewed and tested with synthetic fixtures before the package is frozen. A host-generated timestamp is contemporaneous evidence, not an independent trusted timestamp. Bind it to the authenticated approval publication time and private owner-controlled evidence custody; do not claim cryptographic or external timestamp attestation unless separately provided.

## Evidence and retention boundary

Raw command output must remain transient in the private execution process and must not be copied into ChatGPT, GitHub, repository files, CI artifacts, shell history, logs, screenshots, or durable evidence. The private redacted summary is retained only in the owner-designated protected location for the approved retention period. Shared records contain its approved classifications and statuses only. If the runner cannot guarantee this boundary, do not execute it.

## Required independent review and owner package

An independent read-only platform/security reviewer must review the exact runner and command-source hashes, classifier allowlist, private-output behavior, status sequencing, clock handling, and synthetic failure tests. A separate owner grant must bind those exact hashes; target/operator; accepted expectations; publication and execution window; evidence custody/retention; recovery contact; and stop conditions. A reviewer approval is not execution authorization.

The prior raw-output handling deviation remains recorded in the Checkpoint A reconciliation regardless of any future owner risk acceptance. No prior observation is backdated, reauthorized, or upgraded by this procedure.

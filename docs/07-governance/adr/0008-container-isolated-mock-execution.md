# ADR-0008: Container-isolated mock execution

**Status:** Accepted for the local mock-only gate; not an authorization for real runtimes
**Date:** 2026-11-02

## Context

R1-G1's mock adapter executed in the trusted worker process. Process separation did not constrain filesystem access, credentials, network access, or resource consumption at the operating-system boundary. R1-G2 requires a verifiable restricted execution context while retaining PostgreSQL as the source of truth and the existing worker lifecycle.

## Decision

The worker launches the fixed deterministic mock program in a short-lived Docker container using the exact Node image digest committed in `apps/worker/src/docker-sandbox.ts`. The container receives only JSON task-title input and a unique per-run temporary workspace. It uses `--network=none`, a read-only root, the host worker's non-root UID/GID, `--cap-drop=ALL`, `no-new-privileges`, Docker's default seccomp profile, PID/memory/CPU/ulimit caps, and a small `/tmp` tmpfs. No Docker socket, home directory, database mount, credential file, or inherited worker environment is passed to the workload. Container output and execution time are bounded. API/worker events continue through the existing PostgreSQL-backed coordinator.

The worker scopes its containers with a non-secret label derived from the configured database endpoint. On startup and reconciliation, it enumerates only Omnis sandbox containers in that scope, queries PostgreSQL for current unexpired leases among those candidate run IDs, and removes containers without an active run lease. This database check occurs after container enumeration to avoid acting on a stale run snapshot.

Lease heartbeat renewal is allowed only while the recorded lease has not expired. A worker whose lease expires cannot revive ownership while a replacement worker is reconciling the run and its container.

An explicitly authorized network extension may be added later only through a separately reviewed network-layer allowlist. Application prompts or runtime capability declarations are not an egress control. R1-G2 does not enable this extension.

## Consequences

- The API cannot execute task text as shell code; the worker calls a constrained executor and the production adapter uses a fixed Node program.
- PostgreSQL remains authoritative. The sandbox does not connect to the database or write lifecycle events.
- A lost worker can leave a bounded container until a replacement worker reconciles it after the run lease expires. The container's own timeout is 30 seconds maximum, its resources and output are capped, and its network is disabled.
- On the verified WSL2 host, Docker is rootful, rootless/user-namespace remapping was unavailable, and AppArmor was unavailable. Docker seccomp was available. This is a useful local containment boundary but not equivalent to a separately isolated VM or a production-grade multi-tenant sandbox.
- The trusted worker, host kernel, Docker daemon, and account with Docker group access remain trusted. Docker group membership is effectively root access.
- Container escape, daemon compromise, malicious trusted launcher changes, kernel vulnerabilities, host resource exhaustion outside enforced limits, and vulnerabilities in the Node image remain residual risks.

## Verification

Actual-container negative tests and end-to-end local checks are recorded in [R1-G2 sandbox security evidence](../evidence/R1_G2_SANDBOX_SECURITY.md). They establish behavior only on the recorded WSL2/Docker versions, not every host or remote deployment. Real Hermes, Codex, and Claude integrations remain disabled.

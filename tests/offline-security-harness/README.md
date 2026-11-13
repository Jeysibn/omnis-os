# Stage A Offline Security Harness

This directory contains test-only, deterministic fixtures for the proposed P0-R2.1 runtime contract. It does not implement a Gateway, Authorizer, Docker client, terminator, durable journal, or provider connector. Its fixtures use in-memory state and synthetic identities, IDs, payloads, signatures, and responses.

**Source baseline:** `b67aa2a4b49cf47e1cbaa9d985b0c270fa9ed965` (merged PR #112). The existing runtime-protocol code is consumed unchanged by this harness.

Run with:

```bash
node --experimental-strip-types --test tests/offline-security-harness/*.test.mjs
```

The harness imports pure functions from `packages/runtime-protocol`. It does not import `node:net`, HTTP/TLS clients, Docker libraries, `node:child_process`, `node:fs`, or environment/credential loaders. The fake Engine recorder only validates and stores a JavaScript request object. The synthetic capability verifier accepts one fixed test key ID and an all-zero fixture signature; it is not cryptographic verification and must not be reused by application code.

## Evidence matrix

| Fixture / tests                                              | What a pass demonstrates                                                                                                                                                                                                                                                  | What it does not demonstrate                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current runtime protocol request parser and `evaluatePolicy` | At this source revision, pure protocol code rejects malformed/duplicate-key JSON, unsupported operations, invalid frames, peer mismatch, expiry, and mismatched run/generation claims for the supplied synthetic context.                                                 | Live peer credentials, a trusted clock, signature-key custody, production authorization, durable replay protection, or Gateway enforcement.                                                                                               |
| `FakeAuthorizationAuthority`                                 | The proposed per-step ticket fields can be represented in a deterministic in-memory model; exact payload digest/length, reservation ordering, revisions, issuer/audience/peer, expiry, revocation, lease loss, and one-use checks produce the expected fixture decisions. | A database transaction, cross-process race safety, durable one-use consumption, signed tickets, real Worker identity, or atomicity with a Docker request. `Promise.all` cases exercise the model's synchronous compare-and-set rule only. |
| `FakeDockerEngineRecorder`                                   | A fixed synthetic create request is recorded only when identity, command, namespace, mount, privilege, capability, resource, logging, and output fields match the fixture allowlist.                                                                                      | Validity against a real Docker API version, daemon acceptance, rootless isolation, effective limits, egress denial, storage quotas, or container confinement.                                                                             |
| `parseEngineResponse` and `parseEngineLogs`                  | The fixture parser rejects bad content types, malformed/oversized/truncated/duplicated frames, invalid classifications, mismatched request/run identity, and malformed log framing; unknown outcomes remain unknown.                                                      | Runtime Gateway parser behavior or arbitrary Docker daemon/proxy behavior. The helper is test code, not production parsing code.                                                                                                          |
| `OfflineOutcomeLedger`                                       | The listed mutation states can reach `outcome_unknown` after lost acknowledgement, and the model disallows another dispatch after an attempted mutation. Exact matching synthetic reconciliation evidence can classify a result terminally.                               | Process-crash, kernel-crash, power-loss, filesystem `fsync`, database recovery, daemon recovery, or durable no-replay guarantees.                                                                                                         |
| `MockMonotonicAnchor`                                        | A local record behind an independently retained fixture high-water is rejected; fixture unavailability fails closed. A whole-state restore of both values remains indistinguishable.                                                                                      | An actual independent anchor, rollback resistance, hypervisor/TPM semantics, cryptographic receipts, or protection from restoring the entire environment. This does not resolve M-3 or choose an anchor.                                  |
| `MockTerminationAuthority`                                   | Synthetic wrong-run, stale-generation, substituted-cgroup, missing-evidence, and uncertain-stop requests do not produce a confirmed status. A fixture confirmation requires empty-cgroup and empty-process evidence.                                                      | A signed stop capability, trusted cgroup registration, process/shim/helper discovery, service-manager authority, or real process termination. This does not resolve M-4.                                                                  |

No PASS from these tests should be reported as Docker isolation, network security, authorization enforcement, rollback protection, process termination, or deployment verification.

## Stage B prerequisites

Stage B is outside this PR and remains blocked pending separate explicit owner authorization. The limited Stage B subset may test real rootless Engine setup and direct kernel/socket controls without the integrated Gateway or terminator; it must not imply those controls are ready.

Before any Stage B VM is created or modified, its request must name and approve:

- A disposable Linux VM provider/hypervisor, exact OS image and kernel, rootless Docker version/configuration, and immutable source/fixture hashes.
- Guest-root operations, dedicated users and subordinate ID ranges, systemd/cgroup-v2 changes, data roots, disk/resource limits, network attachment, and any host permissions.
- Allowed Stage B test IDs only; synthetic data/credentials; no provider access; no owner data; and no access to the active WSL2 or Docker installation.
- Independent cleanup/destruction authority, exact resource IDs, evidence paths/retention, stop conditions, and post-test evidence that the VM and its workloads are gone.
- Required Codex #1 and Claude review status and explicit owner authorization for that exact VM and privilege envelope.

Stage B evidence must inspect the real daemon's effective configuration, service identity/socket and UID maps, separate storage, cgroup-v2 controllers and limits, and applicable direct local-IPC/network enforcement points. An unreachable destination is not proof of a deny rule. Per-run termination, rollback-anchor behavior, Gateway enforcement, integrated egress and recovery remain Stage C requirements; M-3 and M-4 remain unresolved design/owner gates. WSL2 remains Stage D and requires applicable Linux VM evidence plus separate authorization.

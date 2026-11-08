# Phase 1 PR C — platform implementation status

Status: **PR #46 MERGED — SYNTHETIC-ONLY BROKER BOUNDARY; PRODUCTION REMAINS MOCK-ONLY.** GitHub records merge commit `d3adf7e9f5aaf2d95901eff76717a3e7eaca669e` on November 8, 2026. All eight checks on [CI run 42482891023](https://github.com/Jeysibn/omnis-os/actions/runs/42482891023) passed, including core checks, frontend browser, full-stack browser integration, both PostgreSQL jobs, backup/restore, and container images.

PR #46 adds a synthetic broker and deterministic fake-provider path, versioned authorizer IPC, signed authorization-envelope validation, durable attempt generation/lease fencing, duplicate-event protection, recovery after restart, and disposable Compose egress and process-boundary checks. The end-to-end path is gated by synthetic test mode; the normal owner-facing worker still selects `SandboxedMockRuntimeAdapter`. No real provider is connected, and no real-provider credentials or inference are enabled.

These CI results establish the listed behavior in disposable test environments. They do not establish owner-host UID/GID and socket behavior, host systemd egress enforcement, credential custody against the rootful Docker launcher, independent security approval, or production readiness. Real-provider execution remains **BLOCKED** pending those security, policy, and owner-approval gates.

## Pre-merge candidate history (archived)

The following candidate notes are retained for incident and verification history. They describe pre-merge candidates and are superseded as current status by the merged-head result above.

> Status: **SYNTHETIC REMEDIATION IMPLEMENTED — VERIFICATION AND INDEPENDENT REVIEW REQUIRED**. See [late authoritative Run projection](PHASE1_PR46_LATE_RECONCILIATION.md) for the focused repair, permitted transitions, and regression contract. PR #46 remains a test-only synthetic broker boundary; production stays mock-only. Current main is `c03df9309db5038cdbfeda34c2388c4d4915001f`, including merged owner UI work through PR #83. Reviewed candidate `6e7321bb495bca9db6db42b5a211c5d48373a563` had exact-head CI [42447017590](https://github.com/Jeysibn/omnis-os/actions/runs/42447017590). That run passed core checks, both PostgreSQL migration jobs, backup/restore, and container images. Full-stack passed ordinary completion and reached cancellation recovery, but timed out with attempt `completed` and Run `unknown` instead of attempt `interrupted` and Run `cancelled`. Candidate `04e9b8f` changed the cancellation fake fixture to remain accepted until confirmed interruption, but the Compose test map made it the global default and suppressed ordinary completion. Candidate `513401a` scoped the fixture to a dedicated cancellation Run request ID; its `completed` default restores completion but may let the accepted-state restart observer miss its short window. Current local changes use existing `delayed-events` as the default, preserving eventual completion while holding the accepted attempt observable for broker interruption. This branch adds durable broker generation/lease fencing, recovery claims, stale-writer rejection, and duplicate-event replay protection to the existing attempt row and authorizer path. The lost-ack case requires unknown outcome, unknown usage, one attempt, and same-Run idempotent replay. Exact-head run [42447937343](https://github.com/Jeysibn/omnis-os/actions/runs/42447937343) passed core checks, both PostgreSQL jobs, backup/restore, container-image checks, and the full owner browser journey, including broker restart recovery for accepted, cancellation, and lost-ack cases. It failed afterward because `queue-startup-guard` ran after the browser smoke left legitimate executable work in the disposable database. Current local changes run that empty-database guard before the browser journey and use `delayed-events` as the default fixture so accepted state remains observable during broker restart. The implementation head `2894075d71961cdd8d3f6563172b721b02583bee` passed full-stack browser/PostgreSQL, checks-core, both database jobs, backup/restore, and container-image CI in [42448493917](https://github.com/Jeysibn/omnis-os/actions/runs/42448493917); `frontend-browser` was cancelled when a docs-only commit superseded it. The subsequent documentation head `6fd13b9c3e35f3188021fe840c8e970ef6e853ac` passed all eight jobs, including frontend-browser, in [42448746469](https://github.com/Jeysibn/omnis-os/actions/runs/42448746469). With pinned Node 24/pnpm, local `pnpm check` (commit hook) and `pnpm build` passed; `pnpm integration:browser-smoke` passed its 14 support tests, then stopped before the DB-backed queue guard because `OMNIS_TEST_DATABASE_URL` is not configured in this workspace. No local disposable database/browser result is claimed. No production broker wiring, owner-host validation, provider credential custody, or real inference is claimed.

> Candidate history: the previous candidate at `127d4dcd18027d14879099f2fcc1d6649f02560d` passed all eight CI jobs in [42438008779](https://github.com/Jeysibn/omnis-os/actions/runs/42438008779), but predates current-main synchronization and fencing changes. Run [42445298450](https://github.com/Jeysibn/omnis-os/actions/runs/42445298450) passed checks-core, both PostgreSQL migration jobs, backup/restore, and container images; full-stack failed on the 202-versus-200 idempotent replay assertion. Run [42445747554](https://github.com/Jeysibn/omnis-os/actions/runs/42445747554) was superseded/cancelled. Run [42446043520](https://github.com/Jeysibn/omnis-os/actions/runs/42446043520) reached lost-ack acceptance, then failed at cancellation admission with 503 because the active unknown Run correctly occupied the one allowed concurrent slot. Run [42447017590](https://github.com/Jeysibn/omnis-os/actions/runs/42447017590) passed supporting checks but full-stack showed a cancellation/completion race: attempt completed, Run unknown. Candidate `04e9b8f` then scoped the accepted-until-interruption fixture incorrectly as the global default. Candidate `513401a` scoped it to cancellation but used immediate completion as the default, which risks missing the accepted observation window. Current local change uses `delayed-events` as the completion default and maps cancellation/lost-ack fixtures only to their request IDs. Independent correctness review classifies the late projection gap as P2 and the standards review as P1; both required remediation; see the focused late-projection design and final PR verification evidence. Target-host systemd egress enforcement, owner-host recovery/backup, and production wiring remain open.

## Trust boundary

```text
Worker identity
  | worker-facing UDS; SO_PEERCRED UID/GID + route check
  v
Broker ingress gateway (non-root; injects broker caller token)
  | private UDS
  v
Synthetic broker (non-root; Node Permission Model; no DB, Docker or signing key)
  | fixed 172.29.87.10:8787; systemd IPAddressAllow/Deny
  v
Deterministic fake provider (synthetic-only; non-root)

Synthetic broker
  | broker-only UDS + distinct service token; SO_PEERCRED UID/GID check
  v
Authorizer peer gateway (non-root; route allowlist)
  | private UDS
  v
Trusted authorizer -> PostgreSQL durable grant/attempt/audit lifecycle
```

The existing rootful Docker launcher remains host-root-equivalent. This does not establish safe real credential custody against that launcher or host-root compromise.

## Process and IPC contract

Systemd units define dedicated identities for `omnis-synthetic-broker`, `omnis-broker-ingress-gateway`, and `omnis-broker-gateway`. The broker receives synthetic caller, authorizer, and fake-provider tokens plus public trust anchors; it has no database credential or authorizer signing private key. This is not a real-provider credential broker or approved credential-release design.

The Linux UDS gateways check kernel `SO_PEERCRED` UID and primary GID for each connection. They forward only allowlisted configured POST paths, bound request/response sizes and concurrency, reject unsupported HTTP forms, and remove sockets on stop. The worker-facing gateway strips caller-supplied identity/authentication headers and injects its broker token after the peer check. Host UID/GID mapping and socket behavior on the owner's deployment remain to be validated.

The broker uses PR #47's versioned operations: admission, begin-submission, provider-event, and recovery-list. It verifies the authorizer Ed25519 envelope against pinned public anchors, audience/key validity/expiry, attempt/request/authorization/run identity, rendered-request digest, correlation, connector/provider/model/operation, binding revisions, exact limits, and empty capabilities. The authorizer remains the only approval and durable lifecycle source. The broker has no DB access or competing approval store. Caller, authorizer, gateway, and fake-provider tokens are loaded from separate root-managed files; the broker environment contains only file paths and public trust anchors.

`apps/api` and `apps/worker` construct the broker coordinator only when synthetic task-run test mode is enabled; ordinary production worker execution still uses the mock runtime. The full-stack browser test opts into test mode and starts the broker and fake provider with Compose. This is owner-authorized synthetic test coverage, not production broker activation.

## Fake provider and egress

The adapter uses only `http://omnis-synthetic-provider:8787`, connects to fixed IPv4 `172.29.87.10`, and sends the documented Host header. There is no caller URL, DNS, proxy, or redirect path. The fake validates the signed envelope with configured public anchors, attempt/digest binding, and a synthetic-only token; attempt ID is its idempotency key.

The broker systemd unit sets `IPAddressDeny=any` with only `IPAddressAllow=172.29.87.10/32` and restricts address families. The disposable Compose topology uses an internal network, disables masquerading, fixes the fake address, and attaches no other service to the broker probe network. A healthy private-service canary sits on a separate internal network. CI probes the fake as a positive control and public IP, metadata, host gateway, isolated private service, external DNS, and alternate DNS as denials. The probe uses the broker image, non-root UID, read-only root, dropped capabilities, no-new-privileges, resource caps, and restricted Node Permission Model.

This Compose test is network evidence for that disposable topology. It does not exercise the broker's real authorizer-to-provider path or test host systemd BPF egress enforcement. Both remain acceptance gates.

## Lifecycle and process effects

The broker calls the authorizer for admission, begin-submission, provider events, recovery listing, and recovery claims. Beginning submission persists a broker generation and lease before provider I/O; event writes are fenced by instance and generation. Expired uncertain submissions without an acknowledged provider ID become unknown and are not resubmitted. Duplicate event fingerprints are idempotent, and recovery tests cover broker restart, late authoritative outcomes, cancellation, and lost acknowledgements. The merged-head PostgreSQL and full-stack CI jobs passed these regression suites. These guarantees are verified for the synthetic broker and fake provider; they do not establish a real provider's idempotency or cancellation behavior.

### Pre-merge recovery candidate history (archived)

> Fixtures cover completion, rejection, delayed response, timeout, pre-acceptance failure, lost acknowledgement, repeated/conflicting event identity, and requested/confirmed/delayed cancellation. The owner-authorized browser path exercises the synthetic broker and fake provider through PostgreSQL. The request-ID correction aligns fake fixture selection, Run admission/replay, and attempt recovery lookup on the Run idempotency key, with a separate authorization key. Run `42447017590` reached cancellation recovery but its completion event raced owner cancellation, producing attempt `completed` and Run `unknown`. Candidate `04e9b8f` fixed cancellation fixture events but accidentally applied that fixture globally. Candidate `513401a` scoped it but restored immediate completion as the default, risking the accepted-state restart observation. Current local changes map a dedicated cancellation Run request ID to `delayed-cancel-confirmed-events`, use `delayed-events` by default to preserve an observable accepted state with eventual completion, and keep lost-ack separately keyed. The focused fake-provider unit suite verifies accepted then correlated interruption. Browser order is cancellation/restart before lost-ack, preserving `maxConcurrentRuns=1`, and the recovery cutoff is captured before browser startup. The lost-ack helper still checks no provider ID, unknown usage, one attempt, and stable Run replay. Independent security review found no new issue. Correctness review classified this late-result projection gap as P2; standards review classified it as P1. Both reviews required remediation before merge; the current implementation is pending final verification and independent review. Target-host egress and production API/worker integration remain unverified.

The broker starts Node 24 with the Permission Model, denies child-process/worker/WASI/addon/inspector permissions, and scopes filesystem access to application/contracts and its runtime socket directory. It has no shell, MCP, or general-purpose tool implementation. These application controls do not provide a boundary against a Node/runtime exploit.

Systemd bounds CPU, memory, tasks/PIDs, descriptors and stop time. Docker tests use non-root identities, read-only roots, all capabilities dropped, no devices, Docker socket or broad host mounts, and bounded CPU/memory/PIDs/tmpfs. Container and systemd controls need separate evidence.

## Merged-head evidence and remaining gates

| Area                                | Merged-head evidence                                                                                                                                                                                                                                                  | Remaining gate                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authorizer IPC and caller identity  | Broker service token, service identity, schema-validated operations, and peer-gateway route/identity checks have unit or process-boundary coverage (`apps/authorizer/src/broker-ipc-app.test.ts`, `scripts/platform/test-broker-peer-proxy.py`).                      | Verify UID/GID and socket mapping on the intended host; do not infer it from container identities.                                                                 |
| Authorization and attempt lifecycle | Signed authorization bindings, database-persisted generation/lease fencing, event fingerprint replay protection, and recovery claim behavior have database and synthetic process tests (`packages/db/src/index.test.ts`, `apps/synthetic-broker/src/server.test.ts`). | Keep the approved test-mode gate; independently review lifecycle semantics before production routing.                                                              |
| Fake provider and egress            | Fixed fake-provider destination, redirect rejection, bounded HTTP, positive/negative Compose probes, and canary checks are covered by PR #46 CI (`apps/synthetic-broker/src/fake-provider-client.ts`, `infra/compose/synthetic-egress.yml`).                          | Compose evidence does not prove owner-host systemd BPF policy or a real provider's behavior.                                                                       |
| Service/container isolation         | Disposable CI checks packaged images, service identities, process boundaries, and constrained containers (`scripts/host-security/verify-disposable-systemd-deployment.sh`, `scripts/container-images/verify-built-images.mjs`).                                       | Validate the actual host socket ownership, systemd policy, Docker mapping, and restart behavior. The rootful launcher remains a trusted, root-equivalent boundary. |
| Credential custody and usage        | Synthetic tokens and canary values are used in tests; the fake provider labels synthetic usage and the worker does not claim billable provider measurements.                                                                                                          | No real-provider credential broker/release path or owner-host credential custody is established. Real credentials and inference remain blocked.                    |
| Owner-facing execution path         | Full-stack synthetic test mode exercises API, worker, authorizer, broker, fake provider, PostgreSQL persistence, restart recovery, cancellation, and lost-ack cases. All eight merged-head CI checks passed.                                                          | The normal execution path remains the mock runtime. Synthetic test-mode integration is not production broker routing.                                              |
| Auditability and operations         | Persisted authorization/attempt events, event fingerprints, bounded recovery, output history, and canary log checks have automated coverage.                                                                                                                          | Operational metrics, retention/alerting/runbooks, host operations, and real-provider usage reconciliation remain unverified.                                       |

## Target prerequisites and WSL2/Docker risks

- Linux systemd and cgroup BPF support for `IPAddressAllow`/`IPAddressDeny`; unsupported filtering must fail verification.
- Provisioned service users/groups and reviewed socket directories. Measure target UIDs/GIDs rather than inferring them from container IDs.
- Synthetic Ed25519 private key owned by authorizer with mode `0600`; matching public anchor only in broker config.
- Fake endpoint on `172.29.87.10:8787`; check subnet collisions before starting a disposable stack.
- Compose PostgreSQL is published on loopback. Whether WSL2 systemd host processes and the selected Docker Engine share the `127.0.0.1` path is unverified.
- systemd recreates `RuntimeDirectory` paths after restarts. Clients connect by path per request, but replacement/reconnect behavior has not been tested across the actual service processes.
- Docker user-namespace/remapping changes UIDs/GIDs visible through `SO_PEERCRED` for host/container socket peers. GitHub CI without the owner's Docker Desktop/WSL mapping cannot prove that mapping or bind-mounted UDS behavior.
- A compromised rootful Docker launcher remains able to defeat same-host custody. Use only synthetic material until a separate protected VM/host or separately reviewed removal of root-equivalent launcher authority.

## Ownership and gates

PR #47 provides the authorizer lifecycle IPC and broker-specific authentication contract used by PR #46. PR #46 adds the synthetic broker path and test-mode API/worker coordination; the default production runtime remains the sandboxed mock adapter.

Backend integration beyond the explicit synthetic test-mode gate requires an approved contract and independent backend/security review. Durable cancellation, revocation ordering, and late-result projection must remain fail-closed; no source change in this documentation task enables production routing.

Merged-head evidence: GitHub Actions run 42482891023 passed all eight checks at merge commit `d3adf7e9f5aaf2d95901eff76717a3e7eaca669e`, including full-stack browser, PostgreSQL legacy-upgrade/recovery, backup/restore, and container-image jobs. This documentation update did not rerun application or database tests.

GitHub reports PR #46 merged; its current review data does not record a latest independent review. Do not interpret merge or passing CI as independent security approval. Host systemd egress, socket identity/permissions, rootful Docker trust, intended-host recovery, credential custody, and production API/worker routing remain open gates. PR #46 delivered the synthetic-only broker boundary; it did not authorize real-provider use.

G4-3: **Partially Fixed**. R1-G5: **Partially Complete**. AO-107/AO-113: **BLOCKED**. Production: **Mock-only**. Real-runtime activation: **BLOCKED**.

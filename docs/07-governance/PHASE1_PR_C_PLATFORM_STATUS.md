# Phase 1 PR C — platform implementation status

Status: **CONDITIONAL / NOT ELIGIBLE FOR MERGE OR RUNTIME ACTIVATION**. PR #46 remains a test-only synthetic broker boundary; production stays mock-only. Current main is `c03df9309db5038cdbfeda34c2388c4d4915001f`, including merged owner UI work through PR #83. This branch adds a durable broker generation and lease fence, shared recovery claims, stale-writer rejection, and exact duplicate-event replay protection to the existing attempt row and authorizer path. Local `pnpm check` and `pnpm build` pass. PostgreSQL-backed migration tests and the full browser/Compose flow were not run because no disposable test database URLs were configured. Exact-head CI and independent review for the new implementation are pending. No production broker wiring, owner-host validation, provider credential custody, or real inference is claimed.

Candidate history: the previous candidate at `127d4dcd18027d14879099f2fcc1d6649f02560d` passed all eight CI jobs in [42438008779](https://github.com/Jeysibn/omnis-os/actions/runs/42438008779). That run predates the current-main sync and fencing changes. Lost-ack process reconciliation is now implemented as a durable unknown transition on expired-lease recovery, but its PostgreSQL-backed process restart regression has not been executed in this environment. Target-host systemd egress enforcement, owner-host recovery/backup, and production wiring remain open.

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

Proposed service identities are `omnis-synthetic-broker`, `omnis-broker-ingress-gateway`, and `omnis-broker-gateway`; none belongs to Docker. The broker receives only a broker caller token, broker authorizer token, pinned public trust anchors, and a fake-provider token. It receives no authorizer signing private key, DB credential, API-authorizer token, or launcher credential.

The Linux UDS gateway checks kernel `SO_PEERCRED` UID and primary GID for each connection. It forwards only exact configured POST paths, bounds HTTP header/body/response sizes, rejects chunked/upgrade/pipelined requests, bounds concurrent handlers, and removes its socket on stop. The worker-facing gateway strips caller Authorization/service-identity headers and injects its broker caller token only after the OS peer check. The authorizer-facing gateway forwards the broker's PR #47 token and service identity. File modes supplement these checks; they do not authorize the request by themselves.

The broker uses PR #47's versioned operations: admission, begin-submission, provider-event, and recovery-list. It verifies the authorizer Ed25519 envelope against pinned public anchors, audience/key validity/expiry, attempt/request/authorization/run identity, rendered-request digest, correlation, connector/provider/model/operation, binding revisions, exact limits, and empty capabilities. The authorizer remains the only approval and durable lifecycle source. The broker has no DB access or competing approval store. Caller, authorizer, gateway, and fake-provider tokens are loaded from separate root-managed files; the broker environment contains only file paths and public trust anchors.

The worker-facing socket/gateway is packaged. Current `apps/worker` has a broker client only in synthetic test mode; the owner-facing production journey still uses the mock runtime and does not pass through this isolated broker or these gateways. The full-stack browser smoke opts into an owner-authorized process test mode and starts the broker and fake provider with Compose. No production synthetic-broker execution flow is claimed.

## Fake provider and egress

The adapter uses only `http://omnis-synthetic-provider:8787`, connects to fixed IPv4 `172.29.87.10`, and sends the documented Host header. There is no caller URL, DNS, proxy, or redirect path. The fake validates the signed envelope with configured public anchors, attempt/digest binding, and a synthetic-only token; attempt ID is its idempotency key.

The broker systemd unit sets `IPAddressDeny=any` with only `IPAddressAllow=172.29.87.10/32` and restricts address families. The disposable Compose topology uses an internal network, disables masquerading, fixes the fake address, and attaches no other service to the broker probe network. A healthy private-service canary sits on a separate internal network. CI probes the fake as a positive control and public IP, metadata, host gateway, isolated private service, external DNS, and alternate DNS as denials. The probe uses the broker image, non-root UID, read-only root, dropped capabilities, no-new-privileges, resource caps, and restricted Node Permission Model.

This Compose test is network evidence for that disposable topology. It does not exercise the broker's real authorizer-to-provider path or test host systemd BPF egress enforcement. Both remain acceptance gates.

## Lifecycle and process effects

The broker calls the authorizer's admission, begin-submission, provider-event, recovery-list, and recovery-claim operations. Beginning submission increments the persisted broker generation and sets a 30-second lease before provider I/O. Every event write is fenced by broker instance and generation; another broker cannot claim an unexpired lease. The worker keeps its bounded broker recovery window at 45 seconds, long enough for that lease and the fake provider's delayed event fixture, so an accepted attempt can reconcile into the same durable Run after broker restart. Once a submitting lease expires, recovery persists `unknown`, clears the lease when no provider ID was durably acknowledged, and cannot resubmit. A known provider ID permits read-only event polling; only a correlated interruption confirms cancellation. Exact duplicates are checked against the persisted event fingerprint and attempt binding before lease checks, so identical delivery is a no-op even after terminal state. PostgreSQL tests were added for expired-lease takeover, stale broker rejection, and duplicate completion, but need execution against a disposable test database. A separate direct task/API cancellation operation is not in the merged authorizer contract.

Fixtures cover completion, rejection, delayed response, timeout, pre-acceptance failure, lost acknowledgement, repeated/conflicting event identity, and requested/confirmed/delayed cancellation. Existing process/browser integration exercises the owner-authorized synthetic broker/provider path through PostgreSQL and tests accepted-attempt restart and cancellation recovery. The current environment ran unit/contract/process-boundary tests, but the full-stack browser/Compose command stopped before migrations because `OMNIS_TEST_DATABASE_URL` was unset. Lost-ack restart recovery and DB duplicate-event assertions therefore remain unverified on this exact head. Target-host egress and production API/worker integration remain unverified.

The broker starts Node 24 with the Permission Model, no child-process/worker/WASI/addon/inspector permission, and filesystem access scoped to application/contracts and the runtime socket directory. It has no shell, MCP, or tool implementation. This limits application effects; it is not a security boundary against a Node/runtime exploit. Native Codex/Hermes execution has a wider tool surface and requires a separately reviewed execution boundary.

Systemd bounds CPU, memory, tasks/PIDs, descriptors and stop time. Docker tests use non-root identities, read-only roots, all capabilities dropped, no devices, Docker socket or broad host mounts, and bounded CPU/memory/PIDs/tmpfs. Container and systemd controls need separate evidence.

## Positive/negative security matrix

| Area              | Positive control                                                  | Denial control                                                            | Current evidence                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authorizer IPC    | Broker reaches versioned PR #47 operations with broker token      | Wrong UID/GID/token/identity, route confusion, unavailable store          | Linux proxy test verifies peer UID/GID, route allowlist, modes and cleanup; authorizer-to-DB process E2E pending                                                                                                                                                               |
| Broker ingress    | Worker peer can reach submit route through gateway                | Wrong UID/GID, spoofed auth headers, non-allowlisted route                | Linux proxy test verifies UID/GID and route denial; production worker client not integrated (test-mode support only)                                                                                                                                                           |
| Authorization     | Persisted approved grant produces one attempt                     | Forged/expired/revoked/wrong scope/digest/audience/replay rejected        | Backend tests exist; broker process integration pending                                                                                                                                                                                                                        |
| Provider          | Fixed fake endpoint receives one submission                       | Caller destination/redirect/changed digest/duplicate attempt denied       | Adapter/provider source present; durable E2E pending                                                                                                                                                                                                                           |
| Network           | Fake endpoint reachable from bounded probe                        | Public, metadata, host, private service and DNS probes denied             | Run 42262045598's probe passed all positive/negative traffic checks; its post-run Docker peer-count assertion failed because Compose detached stopped containers. Harness now permits the expected empty post-run peer list and still rejects unexpected peers; rerun pending. |
| Secrets           | Synthetic canary stays in approved fields                         | No argv/log/socket/error/DB/image/adjacent leak                           | Prior candidate exact-head CI scanned API, worker, authorizer, launcher, fake broker, and Compose broker/fake-provider logs with disposable values; intended-host logging and credential custody remain unverified.                                                            |
| Recovery/cancel   | Accepted result and confirmed cancellation survive broker restart | Lost-ack reconciliation never resubmits; duplicate/replay remains bounded | Prior candidate CI exercised accepted completion and cancellation across broker restart; lost-ack process reconciliation and target-host service restart evidence remain pending.                                                                                              |
| Runtime isolation | UID/GID, groups, caps, devices, mounts and network inspected      | No Docker socket/group, privileged mode or extra mounts                   | Prior candidate exact-head CI passed disposable container and systemd identity checks; owner-host enforcement remains unverified.                                                                                                                                              |
| Host systemd      | Effective identities, socket metadata and BPF policy inspected    | Missing BPF enforcement causes test failure                               | Unit files present; disposable systemd test missing                                                                                                                                                                                                                            |

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

PR #47 resolves the old handoff's authorizer lifecycle IPC, broker-specific authentication, and fake-provider contract gaps. This platform branch reuses those operations; the current recovery fix reads persisted response output on idempotent admission replay but does not change migrations, database semantics, or signing logic.

Codex #1/backend follow-up is needed if direct task/API cancellation must be durable independently of revocation. Production API/worker-to-broker execution remains a backend integration dependency; existing worker test-mode support is not evidence of production integration. No API or worker source was changed here.

Local evidence on the current implementation: Node 24.22.2 / pnpm 12.16.1 `pnpm check` and `pnpm build` passed; focused synthetic-broker and authorizer tests passed. `pnpm integration:browser-smoke` ran the disposable process-boundary unit tests (14/14), then stopped before database setup because `OMNIS_TEST_DATABASE_URL` was unset. PostgreSQL attempt lifecycle, Docker Compose full-stack browser, and exact-head GitHub Actions results are pending. No host provisioning, provider authentication, real credentials, inference or deployment was performed.

Independent review of the prior code head `127d4dc` does not apply to the new fencing changes. Independent security and integration review of the current exact head is pending. PR #46 must remain Draft and unmerged until that review, disposable PostgreSQL and full-stack tests, and exact-head CI complete. Target-host socket and egress evidence remains a separate host gate.

G4-3: **Partially Fixed**. R1-G5: **Partially Complete**. AO-107/AO-113: **BLOCKED**. Production: **Mock-only**. Real-runtime activation: **BLOCKED**.

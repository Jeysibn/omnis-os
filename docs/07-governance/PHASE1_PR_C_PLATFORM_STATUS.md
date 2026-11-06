# Phase 1 PR C — platform implementation status

Status: **CONDITIONAL / NOT ELIGIBLE FOR MERGE**. This branch contains a synthetic broker executable, fake-provider process, Linux peer-credential gateways, a systemd egress policy, and disposable CI probes. End-to-end authorization-to-durable-result behavior, owner-host enforcement, and independent implementation approval are not yet evidenced. Production remains mock-only.

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

The worker-facing socket/gateway is packaged, but `apps/worker` does not call it. No owner-facing API/task/worker execution flow is claimed.

## Fake provider and egress

The adapter uses only `http://omnis-synthetic-provider:8787`, connects to fixed IPv4 `172.29.87.10`, and sends the documented Host header. There is no caller URL, DNS, proxy, or redirect path. The fake validates the signed envelope with configured public anchors, attempt/digest binding, and a synthetic-only token; attempt ID is its idempotency key.

The broker systemd unit sets `IPAddressDeny=any` with only `IPAddressAllow=172.29.87.10/32` and restricts address families. The disposable Compose topology uses an internal network, disables masquerading, fixes the fake address, and attaches no other service to the broker probe network. A healthy private-service canary sits on a separate internal network. CI probes the fake as a positive control and public IP, metadata, host gateway, isolated private service, external DNS, and alternate DNS as denials. The probe uses the broker image, non-root UID, read-only root, dropped capabilities, no-new-privileges, resource caps, and restricted Node Permission Model.

This Compose test is network evidence for that disposable topology. It does not exercise the broker's real authorizer-to-provider path or test host systemd BPF egress enforcement. Both remain acceptance gates.

## Lifecycle and process effects

The broker calls PR #47 admission, verifies the result, commits `submitting` before provider I/O, and records events through the authorizer. Any potentially transmitted request without a trustworthy response becomes `unknown` and is never retried. Startup/periodic recovery marks orphaned `submitting` attempts unknown. Revocation-created `cancelRequestedAt` attempts with a provider ID use the fake cancellation endpoint; only a correlated `interrupted` event confirms cancellation. A separate direct task/API cancellation operation is not in the merged authorizer contract.

Fixtures cover completion, rejection, delayed response, timeout, pre-acceptance failure, lost acknowledgement, repeated/conflicting event identity, and requested/confirmed/delayed cancellation. The fixture paths do not yet have a broker-to-PostgreSQL executable matrix proving final durable state.

The broker starts Node 24 with the Permission Model, no child-process/worker/WASI/addon/inspector permission, and filesystem access scoped to application/contracts and the runtime socket directory. It has no shell, MCP, or tool implementation. This limits application effects; it is not a security boundary against a Node/runtime exploit. Native Codex/Hermes execution has a wider tool surface and requires a separately reviewed execution boundary.

Systemd bounds CPU, memory, tasks/PIDs, descriptors and stop time. Docker tests use non-root identities, read-only roots, all capabilities dropped, no devices, Docker socket or broad host mounts, and bounded CPU/memory/PIDs/tmpfs. Container and systemd controls need separate evidence.

## Positive/negative security matrix

| Area              | Positive control                                               | Denial control                                                      | Current evidence                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authorizer IPC    | Broker reaches versioned PR #47 operations with broker token   | Wrong UID/GID/token/identity, route confusion, unavailable store    | Linux proxy test verifies peer UID/GID, route allowlist, modes and cleanup; authorizer-to-DB process E2E pending                                                                                                                                                               |
| Broker ingress    | Worker peer can reach submit route through gateway             | Wrong UID/GID, spoofed auth headers, non-allowlisted route          | Linux proxy test verifies UID/GID and route denial; worker client not integrated                                                                                                                                                                                               |
| Authorization     | Persisted approved grant produces one attempt                  | Forged/expired/revoked/wrong scope/digest/audience/replay rejected  | Backend tests exist; broker process integration pending                                                                                                                                                                                                                        |
| Provider          | Fixed fake endpoint receives one submission                    | Caller destination/redirect/changed digest/duplicate attempt denied | Adapter/provider source present; durable E2E pending                                                                                                                                                                                                                           |
| Network           | Fake endpoint reachable from bounded probe                     | Public, metadata, host, private service and DNS probes denied       | Run 42262045598's probe passed all positive/negative traffic checks; its post-run Docker peer-count assertion failed because Compose detached stopped containers. Harness now permits the expected empty post-run peer list and still rejects unexpected peers; rerun pending. |
| Secrets           | Synthetic canary stays in approved fields                      | No argv/log/socket/error/DB/image/adjacent leak                     | Token-file packaging is present; full cross-process/database canary suite pending                                                                                                                                                                                              |
| Recovery/cancel   | Orphaned submission unknown; confirmed interruption recorded   | No replay; lost ack unknown; requested cancellation not confirmed   | Source present; durable restart tests pending                                                                                                                                                                                                                                  |
| Runtime isolation | UID/GID, groups, caps, devices, mounts and network inspected   | No Docker socket/group, privileged mode or extra mounts             | CI checks added; candidate-head result pending                                                                                                                                                                                                                                 |
| Host systemd      | Effective identities, socket metadata and BPF policy inspected | Missing BPF enforcement causes test failure                         | Unit files present; disposable systemd test missing                                                                                                                                                                                                                            |

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

PR #47 resolves the old handoff's authorizer lifecycle IPC, broker-specific authentication, and fake-provider contract gaps. This platform branch reuses those operations and does not change authorization stores, migrations, database semantics, or signing logic.

Codex #1/backend follow-up is needed if direct task/API cancellation must be durable independently of revocation. API/worker-to-broker execution remains a backend integration dependency owned by Codex #1. No API or worker source was changed here.

Local evidence from the implementation checkout: `npx --yes pnpm@12.16.1 check` passed; broker package typecheck and two config tests passed; the Linux SO_PEERCRED proxy test passed; shell syntax, Python compilation, ESLint, Prettier, and `git diff --check` passed. The local Docker daemon is unavailable, so disposable Compose networking was validated only in GitHub Actions. Exact-head run [42262045598](https://github.com/Jeysibn/omnis-os/actions/runs/42262045598) failed after its network positive/negative probes passed: the post-run inspect expected two active Docker network peers, but Compose had detached the stopped containers. The assertion now checks that all peers, if any remain, are only the two approved services; a new exact-head run is pending. Container-image build, disposable systemd/peer-gateway checks, PostgreSQL legacy/recovery integration, backup/restore, and browser/full-stack suites passed in run 42262045598. Complete broker/authorizer/PostgreSQL/fake E2E tests and cross-process/database canary coverage are absent. No host provisioning, provider authentication, real credentials, inference or deployment was performed.

Independent read-only review of exact head `3a984fb790b8c4ab13ffcb403203098ab546605f`: **Platform security/correctness: BLOCK; synthetic-only merge eligibility: NOT ELIGIBLE; real-runtime activation: BLOCK.** Findings: no executable broker-to-authorizer/PostgreSQL/provider lifecycle test; no systemd `IPAddressAllow`/`IPAddressDeny` enforcement test at the broker boundary; no required cross-surface credential-canary suite; and cancellation is only revocation-triggered because PR #47 has no direct user cancellation operation. The reviewer did not modify files or run tests. The network probes in run 42262045598 passed, but its post-run Docker metadata assertion failed; the harness fix is awaiting exact-head CI and review.

G4-3: **Partially Fixed**. R1-G5: **Partially Complete**. AO-107/AO-113: **BLOCKED**. Production: **Mock-only**. Real-runtime activation: **BLOCKED**.

# Minimal-network Docker-only WSL2 threat model

**Status:** Research candidate; ingress provenance BLOCKED. **Date:** 2026-11-10.

Companion to [ADR-0012](../07-governance/adr/0012-docker-only-wsl2-control-plane.md) and the [existing threat model](THREAT_MODEL.md). This supersedes the prior mutable bridge/watchdog candidate, preserving its review history. Owner-reported VIABLE FOR SECURITY DESIGN REFINEMENT is not approval of this revision or implementation.

## Assets, adversaries and trusted authorities

Protect owner decisions, credentials, DB contents, Task/Run/audit identity, workspaces, rootful daemon authority and backup/decryption material. Assume compromised web/API/worker/agent/dependency/gateway, unauthorized LAN clients and untrusted CI code. Kernel, Docker administrators/daemon, launcher and immutable bootstrap are trusted authorities. Launcher Docker access remains host-root-equivalent. API owner attribution remains a residual trusted-API limitation.

## Proposed structural boundaries

Only HTTPS gateway has IP access. Web/API/worker/authorizer/launcher/PostgreSQL each have separate network-none namespaces and narrowly mounted filesystem UDS. API receives no DB socket or credentials; it uses existing worker/authorizer contracts. PostgreSQL local access remains authenticated by existing separate roles. Launcher alone receives Docker UDS; agents retain fixed network-none mock execution. No generic relay is introduced.

| Boundary                   | Threat                                                         | Proposed control / residual risk                                                                  | Evidence                                                                                                |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Windows → HTTPS gateway    | LAN/container access translated into apparently local ingress  | Namespace-local deny policy with approved ingress discriminator; discriminator unidentified       | Trace NAT/proxy/WSL/Docker paths; prove local success and LAN/direct-container denial; NOT RUN, BLOCKED |
| Gateway process → IP       | Compromise initiates DNS/metadata/LAN/Internet or edits policy | Trusted bootstrap installs rules, drops privilege irreversibly, then executes fixed gateway       | Outbound/IPv4/IPv6/DNS, policy-edit and regain attempts; NOT RUN                                        |
| Gateway → web → API        | Allowed-channel relay/SSRF, forged Origin/session              | Dedicated UDS, fixed routing, no CONNECT/arbitrary upgrade; session/CSRF exact-origin checks      | Malicious peer paths and authentication/CSRF denials; NOT RUN                                           |
| API → worker               | Token bypass or damaged JSON/SSE contract                      | Retain internal token/schema and streaming semantics over proposed UDS                            | Wrong token, replay cursor, cancellation/backpressure and revocation; NOT RUN                           |
| API → authorizer           | API compromise abuses trusted owner attribution                | Existing UDS/token plus transactional grants; no independent human-intent claim                   | Identity/token/replay/expiry/revocation denials; NOT RUN                                                |
| Worker → launcher          | Arbitrary program/container or duplicate/stale launch          | Existing restricted UDS + DB admission; no launcher token claimed                                 | Lease/grant/generation/schema/duplicate denial; NOT RUN                                                 |
| Launcher → daemon/host     | Compromised launcher obtains host root                         | Exclusive trusted daemon access; fixed code contract, not daemon confinement                      | Other services denied daemon UDS; fixed image/mount/program inspection; NOT RUN                         |
| DB clients → PostgreSQL    | Role escalation/local trust fallback                           | Separate SCRAM credentials/ACLs; no TCP listener and no API DB access                             | Cross-role writes/DDL denied; pool/pg-boss recovery; NOT RUN                                            |
| Core UDS → descriptors     | SCM_RIGHTS imports live IP socket despite network-none         | Proposed recvmsg/recvmmsg/io_uring restrictions plus FD sanitation; runtime compatibility unknown | Malicious descriptor send/inheritance and runtime compatibility; NOT RUN                                |
| Agent → host/control plane | Escape through mount/device/socket/network                     | Existing fixed network-none mock controls and scoped workspace                                    | Host/UDS/device/network/resource denials; NOT RUN                                                       |
| Backup/restore             | Tampering, stolen keys, stale ACL/history                      | Authenticated encryption, separated keys/copy, fresh-volume verification                          | Wrong-key/tamper denial and ACL/event fingerprints; NOT RUN                                             |
| CI → owner infrastructure  | Untrusted PR gains persistent daemon or secrets                | Disposable synthetic CI only; no owner-host mounts/secrets                                        | Workflow permission/isolation review; candidate tests NOT RUN                                           |

## Gateway provenance and failure model

Default-deny policy must admit only demonstrably authorized HTTPS requests and their replies. Localhost publication, Host/Origin, owner authentication and trusted TLS do not by themselves distinguish Windows-local from traffic transformed by WSL/NAT/proxies. If prohibited traffic becomes indistinguishable at the selected enforcement point, reject the candidate. No discriminator is currently established; gate stays BLOCKED.

Namespace rules must remain effective after controller death because the confined gateway lacks policy-changing privileges. No watchdog timeout is accepted as a substitute for continuous prevention. Recreated namespaces require fresh immutable bootstrap; no application may run on partial setup. Malicious host-root rule removal remains outside the trust boundary. Bootstrap compromise is a TCB failure and must be reviewed accordingly.

## Descriptor, identity and relay controls

AF_UNIX-only socket creation is proposed, not sufficient to deny imported IP descriptors. Review ancillary FD receive, io_uring alternatives, inherited descriptors, `/proc`/pidfd acquisition, shared namespaces, host/VSOCK sockets and child process inheritance. Mandatory restrictions must pass pinned runtime tests; incompatibility blocks advancement instead of silently widening syscalls.

Server-owned 2750 directories, 0660 sockets, umask0007 and verified mapped UID/GID prevent unauthorized substitution; clients get only required read-only mounts. Secret/peer credentials do not travel through unrelated volumes. Socket creation ownership and restart cleanup must be tested, not assumed. Allowed UDS channels can still relay semantic requests: narrow schemas, tokens, role ACLs and proxy routing remain necessary.

## Compatibility and recovery requirements

Preserve authenticated sessions, exact Origin, secure cookies/CSRF, API-worker token, JSON schemas, SSE replay/order/cancellation/backpressure and revocation. API memory-backed sessions do not survive API restart: reauthentication is required before reading durable Task/Run/event history. Preserve pg-boss/role credentials, atomic grant consumption, lease fencing, launch reservation and unknown-outcome reconciliation; never resubmit uncertain work to obtain completion.

The ADR failure-state matrix governs cold startup, compromised gateway, controller crash, daemon outage, WSL restart, policy replacement, endpoint recreation, DNS bypass, socket/FD substitution, DB reconnect, SSE recovery and partial cleanup. **All candidate runtime tests are NOT RUN.** Require both successful permitted flows and actual prohibited-flow denial, not declaration inspection alone. No test may mutate owner data.

## Prerequisites, decisions and review

Mandatory facilities include private namespaces, namespace-local IPv4/IPv6 enforcement, irreversible capabilities/no-new-privileges, seccomp, filesystem UDS ownership and expected Docker lifecycle behavior. Landlock/LSM are evaluated where applicable, not assumed or interchangeable with network policy. Missing mandatory support blocks the gate; no host networking/default bridge/privileged fallback.

Research direction: minimal-network core plus confined gateway. Unresolved design: Windows-local ingress provenance. Future implementation: bootstrap/FD policy/fault model/kernel evidence, requiring separate approval. Host-managed enforcement or relaxed gateway networking are separate owner exceptions. Preserve TLS/CA/backup decisions and real-provider block.

Codex #1 and an independent read-only reviewer must review the new exact head, all earlier F1–F5 findings and new provenance/descriptor risks. No self-approval, deployment or implementation authority is established. PR #96 remains Draft.

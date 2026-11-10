# Omnis OS ADR-0012 independent security review packet

Prepared 2026-11-10. Implementer assessment, **not independent approval**. Reviewed main `4a27bc3718d4960ad9b132b0f53cdc938da57b54` and PR #97 `9c0648fc194f0990c2df2f987eeb22797c1c0d8c`. No target Windows host was accessed. Architecture remains proposed, production mock-only. Independent verdict: **BLOCKED — no reviewer verdict supplied**. Packet readiness: DESIGN REVIEW READY; deployment readiness: BLOCKED.

## Decision requested

Approve or reject a **specific enforceable Windows-local ingress predicate**, supported by translation-path experiments, before approving gateway bootstrap or core transport conversion. Neither a source-address allowlist nor localhost publication currently identifies the Windows principal. Authorize only credential-free research until a discriminator is demonstrated. If experiments cannot distinguish Windows-local from prohibited WSL-local traffic at a permitted enforcement point, reject source-only ingress and return an explicit threat-model decision to the owner.

Recommended architecture remains the smallest conditional ADR candidate: separate network-none core containers, narrowly mounted authenticated filesystem UDS, one confined gateway, and exclusive trusted launcher daemon authority. **No currently evidenced ingress implementation meets all requirements.** Keep it quarantined without an owner-facing listener. Do not deploy the observation fixture as ingress.

## Threat and trust contract

Protected assets: owner/session decisions, DB/Run/audit integrity, control-plane sockets and daemon authority. Untrusted: compromised gateway/web/API/worker/agent, LAN clients and unrelated containers. Trusted: kernel, rootful Docker/administrators, launcher and immutable bootstrap. Review whether hostile unprivileged WSL-local processes are in scope (current denial requirement says yes); administrators able to change Docker or impersonate identities remain trusted. API attribution of owner intent remains a residual trusted-API limitation. No real-provider credentials or calls are permitted.

Required flow: Windows → gateway → web → API → worker/authorizer; worker/authorizer/launcher → DB with separate roles; worker → restricted launcher → daemon → fixed mock. API has no DB channel. Do not replace this with a generic relay, shared namespace or daemon proxy.

## Primary-source findings versus experiments

Sources retrieved 2026-11-10; mutable vendor documentation must be rechecked for the exact target version. Paraphrases below are narrowly scoped; none is target-host proof.

| ID | Source-backed property | Engineering inference / required experiment |
| --- | --- | --- |
| S1 | [Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking) documents Windows access to Linux localhost, NAT and mirrored modes, mirrored LAN access and IPv6 support; IPv6 localhost is not supported for the documented Linux-to-Windows direction | Record direction and family independently. Do not generalize this limitation to all Windows-to-Linux paths. Mirrored mode does not itself discriminate a Windows-local client |
| S2 | [WSL localhost implementation](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/localhost.md) describes NAT relaying via wslrelay and mirrored bind interception via BPF/wslservice | Trace actual accepted tuple through relay, host and container; relay transport cannot attest original principal without a separately protected signal |
| S3 | [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) describes global settings, mirrored-only hostAddressLoopback and ignoredPorts | Record effective mode and firewall/proxy settings; config text alone does not prove active state. Do not change global WSL settings on a shared host |
| S4 | [Docker port publication](https://docs.docker.com/engine/network/port-publishing/) documents NAT mapping, direct routing/gateway modes, same-network container access, userland-proxy IPv6 mapping and the pre-28 localhost/L2 caveat | Loopback binding is a requested exposure scope, not Windows-only proof. Test direct IP, same/different bridge, host path, daemon routing/proxy modes and IPv6 separately |
| S5 | [Linux network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html) isolate devices, protocol stacks, routes, firewall and abstract UDS namespace | Separate namespaces are useful structural controls; filesystem UDS and imported live descriptors still cross boundaries. Network-none has loopback, not a blanket AF_INET syscall prohibition |
| S6 | [Linux unix sockets](https://man7.org/linux/man-pages/man7/unix.7.html) specifies filesystem permission semantics, connection-time SO_PEERCRED, and SCM_RIGHTS open-file-description transfer | Verify mapped UID/GID at connection time; do not infer executable integrity or fresh human intent. A socket opened in another namespace can carry external authority via FD transfer |
| S7 | [Linux seccomp](https://man7.org/linux/man-pages/man2/seccomp.2.html) and [kernel filter documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html) define syscall filtering and no_new_privs-based filter installation | Classic syscall argument filtering cannot inspect pointed-to ancillary buffers. A generic 'seccomp enabled' check cannot prove rejection of SCM_RIGHTS; recvmsg/recvmmsg/io_uring, pidfd/proc and inherited FD paths need explicit policy and runtime compatibility tests |
| S8 | [Linux capabilities](https://man7.org/linux/man-pages/man7/capabilities.7.html) describes bounding sets and UID fixups | ADR's ordered transition is plausible, not demonstrated. Bounding-set removal alone does not clear effective/permitted capabilities. Test every step before and after exec, saved IDs, securebits, all threads and regain attempts |
| S9 | [Docker security](https://docs.docker.com/engine/security/) documents privileged daemon authority and configuration risks | Launcher remains root-equivalent TCB. Read-only Docker UDS does not make daemon commands read-only. No claim of launcher confinement against malicious launcher/administrator |

## Ingress alternatives for reviewer disposition

| Candidate | Topology and discriminator | Enforcement / restart and failure | Compromise resistance, compatibility, privileges | Bypasses / evidence and decision |
| --- | --- | --- | --- | --- |
| A — conditional source-path gateway | Rootful Engine in WSL; one private gateway netns, core network-none; IPv4 loopback publication; candidate netns tuple/interface predicate from NAT experiment | Bootstrap installs IPv4/IPv6 default-deny, permits only proved ingress/replies; drops all privilege; guards before exec/bind. Namespace policy persists after bootstrap exit; restart repeats full setup | Fixed gateway no daemon/core secrets; final no caps, NNP, reviewed seccomp/FD policy. Initial NET_ADMIN/SETPCAP/SETGID/SETUID only. Pin Engine, WSL kernel, mode, routing/proxy configuration | NOT APPROVABLE yet. NAT relay or Docker proxy may collapse WSL and Windows to same tuple. Need all positive/negative path traces plus rejected-flow counters, startup fault and privilege-regain tests. If tuple collision occurs, reject that predicate, not just block one observed address |
| B — mirrored source-path variant | Same core/gateway; mirrored Windows interfaces and localhost paths; hypothesized interface distinction | Same immutable namespace policy; never rely only on Windows firewall or a polling controller | Requires compatible Windows 11/WSL mirrored release, IPv6/neighbor policy, Docker publication compatibility; same bootstrap privileges | No demonstrated protected Windows-only interface visible to container. Direct LAN paths, hostAddressLoopback and proxy mapping increase cases. Reject an IP-only claim absent target proof; modes are not interchangeable approvals |
| C — mTLS Windows-held client identity | Confined Docker gateway plus network-none core; client key remains in protected Windows identity store | Kernel restricts exposure; TLS verifies approved client before HTTP. Restart reloads validated leaf/client trust with no permissive mode | Can authenticate key possession against compromised containers lacking key; requires browser key custody, rotation/revocation and TLS library review, plus same egress confinement | **Changes requirement**: proves identity, not physical locality. Authorized remote use or Windows relay remains possible. New Windows credential custody/CA decisions; owner must explicitly replace locality invariant. No tokens tunneled and no provider credential involved |
| D — Windows/Hyper-V ingress enforcement | Windows-local policy/relay supplies a protected handoff to Docker gateway | OS policy must persist and fail closed through Windows/WSL/Engine restarts | Requires host-managed privileged policy/identity and protected relay/channel; more TCB | Explicit Docker-only exception. Not selected or approved; ordinary Host/Origin/X-Forwarded-For from a proxy is forgeable unless upstream channel is exclusive. Owner exception and independent review required |
| E — keep listener absent | Existing internal disposable mock CI; no owner ingress | No exposed service; no confinement bootstrap release | No new privileged infrastructure | Safe interim state only, not usable owner deployment and not acceptance. Recommended until A is proved or owner explicitly chooses another invariant |

TLS, owner login and CSRF remain required even with a valid locality predicate; none supplies the predicate. Container clients must be tested from both unrelated and same bridge networks. A Docker-authorized tester can attach fixtures for experiments, but production processes cannot receive that authority. A trusted-root adversary is excluded; an unprivileged WSL client is not.

## Current source boundary review

- `infra/compose/docker-compose.app.yml`: API/web/worker share UID10001, API bridges edge/data; authorizer and launcher use host mounts; DB base file publishes loopback TCP. This is confirmed source mismatch with the proposed topology, not a new demonstrated exploit.
- `apps/web/server.ts` and `apps/api/src/worker-client.ts`: TCP HTTP upstreams; conversion needs tested JSON/header/streaming/cancellation/replay behavior. No API DB credential may be added.
- `apps/authorizer/src/server.ts:127` and `apps/sandbox-launcher/src/server.ts`: stale-path checks require socket type and same UID, then listen/chmod. No per-bind expected GID/mode/parent mapping readiness proof or general API/launcher SO_PEERCRED check is established. Candidate 2750/0660 setgid provisioning is unimplemented.
- `scripts/platform/broker-peer-proxy.py`: actual SO_PEERCRED check exists for the **synthetic broker** channel; do not misreport it as absent globally or as protecting every UDS. It is not authorization to activate production broker.
- `apps/sandbox-launcher/src/docker-sandbox.ts`: fixed mock image/program, network-none, read-only root, explicit user, caps dropped and resource limits. Existing launch admission uses consumed grant, worker/generation and DB state. Preserve these controls; default daemon seccomp is not the proposed gateway filter.
- Existing encrypted backups, separate role ACLs and durable unknown-outcome reconciliation must survive conversion. API restart invalidates memory-backed sessions; reauthenticate before replay. No inferred outcome or uncertain submission retry.

## Independent reviewer checklist and verdict record

Reviewer must be independent of implementation and review the exact SHA, not approve this prose in isolation. No assigned reviewer or independent verdict exists. Do not use this implementer assessment as a signoff.

| Gate | Reviewer must decide | Required evidence / failure disposition |
| --- | --- | --- |
| R1 provenance | Exact permitted principal, paths, protected discriminator and enforcement point | Experiment matrix, tuple collision analysis and positive/negative counters; reject if indistinguishable |
| R2 gateway TCB | Bootstrap/loader/guard sequence, namespace rule reply association and IPv6 control traffic | Pinned binaries/policy, all privilege sets/IDs/groups before/after exec; fault injection never releases listener |
| R3 descriptor closure | Full syscall/FD acquisition policy and runtime compatibility | inherited IP FD, SCM_RIGHTS, recvmsg/recvmmsg/io_uring, proc/pidfd, VSOCK, raw sockets; rejection measured in confined process |
| R4 UDS and DB | Client membership, server-owned dirs, identity mapping, authentication, stale cleanup | Wrong UID/GID/token/role, symlink/substitution, recreation tests; no TCP/trust fallback |
| R5 lifecycle | Startup/restart admission, quarantine and restoration | Partial setup, bootstrap/controller death, daemon/WSL restart; durable launch/event evidence, never repeat unknown |
| R6 owner boundaries | Rootful daemon trust, key/CA custody, exact locality scope and operational mode | Explicit owner choices and residual risk acceptance; threat-model exceptions require amended ADR |

Verdict template: reviewer identity/independence; exact SHA and policy/image hashes; APPROVE FOR SPECIFIED EXPERIMENTS / APPROVE FOR IMPLEMENTATION / REQUEST CHANGES / REJECT; scope/exclusions; evidence references; mandatory conditions; date/signature. Experiment approval is not deployment approval. Actual verdict register: **none received**.

## Prioritized dependency plan

| Order / accountable role | Concrete next action | Verification / dependency |
| --- | --- | --- |
| 1 — owner + reviewer | Assign independent reviewer; define whether every unprivileged WSL-local client is prohibited; review this packet | Recorded R1/R6 disposition tied to exact revision; no architecture rewrite yet |
| 2 — owner / host operator | Supply dedicated disposable Windows machine or isolated Windows VM with supported WSL2, separate LAN probe and permission to terminate its distro | No production data/credentials/shared distros; versions and effective topology inventory. Mode switches require whole-host isolation because .wslconfig is global |
| 3 — test operator | Run observation package in NAT and mirrored profiles and required daemon publishing modes | [Experiment instructions](../06-delivery/WSL2_DISPOSABLE_EXPERIMENTS.md); all tuples/paths correlated; missing family/path is NOT TESTED |
| 4 — reviewer | Approve/reject candidate A/B predicate; choose C/D only with explicit owner exception | A collision rejects predicate; absence of collision in finite tests requires source-path argument plus negative evidence, not statistical confidence alone |
| 5 — implementer after approval | Minimum enforcement fixture: immutable bootstrap + final guard, fixed diagnostic TLS endpoint, namespace rules, FD filter and fault hooks; **no core sockets yet** | R1–R3 proofs on exact WSL/Engine versions; leaf key only, independent review before application attachment |
| 6 — implementer + reviewer | UDS transports, DB SCRAM local sockets, distinct identities/socket provisioning, authorizer/launcher packaging and restricted operational clients | Contract/negative tests, separate PRs, R4 review; preserve current mock/DB authorization and application behavior |
| 7 — test operator | Run 12 recovery cases, owner HTTPS journey, fresh DB backup restore and exact-head CI | Per-requirement SHA, versions, command, expected/actual, redacted artifact, risk and independent verdict; no unknown→success inference |
| 8 — independent reviewer + owner | Review complete packet and approve deployment only after every mandatory gate closes | Target deployment, isolation, network, recoverability and owner workflow evidence; owner explicit acceptance last |

Immediately safe work: evidence correction, source assessment, bounded synthetic path-observation fixture, interface tests, host runbook and reviewer decision templates. No host is needed to verify those source contracts. Target provenance, Windows CA/browser behavior, Hyper-V interaction, mode changes and WSL shutdown recovery strictly require the disposable Windows/WSL environment. Generic Linux FD/bootstrap tests can reduce implementation risk later but cannot close target compatibility gates.

Owner decisions: reviewer assignment; allowed/prohibited local principals; supported Windows/WSL/Engine/mode matrix; permission and resources for disposable hosts/LAN test; conditional experiment versus implementation approval; offline CA/leaf trust and rotation; rootful launcher trust; backup retention/RPO/RTO; and any mTLS-locality or host-managed-ingress exception. No exception is implicitly selected.

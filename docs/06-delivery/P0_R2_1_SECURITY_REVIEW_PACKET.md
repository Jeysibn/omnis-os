# P0-R2.1 Rootless WSL2 Security Review Packet

**Status:** Ready to relay for exact-revision review; required reviews and owner architecture decisions are pending. No deployment or feasibility test is approved by this packet.
**Reviewed source baseline:** `origin/main` at `9b3afd3733932d769045cd6a31d0c548986b8271`, fetched 2026-11-13.
**Related PRs:** #107 merged as `d32022091a1f7cab43acd4b1f930e61dbaae7f5e`; #109 is current `main` at the source baseline above. #107's infrastructure handoff is [a historical source snapshot](../07-governance/PHASE1_RUNTIME_INFRASTRUCTURE_HANDOFF.md), not a current-main attestation.
**Companion test package:** [P0-R2.1 disposable feasibility package](./P0_R2_1_DISPOSABLE_FEASIBILITY_PACKAGE.md).

## Purpose and scope

This packet is for Codex #1's direct security/authorization review, Claude #1's independent threat-model review, and the project owner's architecture and environment decisions. Each reviewer must inspect the exact final PR commit and identify that full SHA in their response. The PR branch's final head SHA is recorded in the PR description. A review of an earlier source SHA, this summary alone, or an AI subagent's findings is not approval of the current head.

The P0-R2.1 design document still records its historical baseline `a830aeb28f388ab7b569ce5f61c663e6e0c461c2`; the merged #107 handoff records `04e9b31b89b0034aac00bc4130ca10a1b9c90335`. This packet updates the source assessment to current main `9b3afd3733932d769045cd6a31d0c548986b8271` without rewriting either historical record or prior approval history. The owner-reported Codex #1 planning approval remains planning-only and is not a security verdict for this packet or permission to execute tests.

### Changes since the prior assessment

- **PR #107 (`d320220`)** merged the infrastructure handoff. Its source snapshot and conclusions correctly describe the hybrid deployment at `04e9b31`; merge status has changed, but the Docker-only target remains proposed. No second rootless Engine or Runtime API Policy Gateway was added by #107.
- **PR #109 (`9b3afd3`)** made runtime protocol hashing reject non-number protocol versions instead of coercing values, added acceptance replay/reconciliation behavior and tests, and added the backend/frontend handoff. The hash change is still in the pure Stage A package; it does not add a listener, live verifier, Engine gateway, or runtime authority. Acceptance reconciliation is a Mission Lane/task state transition and does not change container isolation, provider credentials, egress, or ingress provenance.
- Current-main post-merge CI run [43280547684](https://github.com/Jeysibn/omnis-os/actions/runs/43280547684) has a reported Mission Lane database lock-timeout failure in `database-integration (legacy-upgrade)`. Codex #1 owns that investigation. It is tracked separately and is not attributed to PR #110; this packet does not diagnose or modify it.

Review and approval scopes are separate:

1. **Design review:** evaluate architecture, threat model and policy. This does not authorize test infrastructure or host changes.
2. **Disposable VM test authorization:** approve an exact named VM, guest-root actions, fixture set, network/resource envelope, independent termination, evidence retention, and cleanup. This does not authorize WSL host changes.
3. **Disposable WSL2 test authorization:** approve an exact separate imported distro, Windows test profile, test modes and allowed per-distro changes. It does not authorize changing the owner's existing distro, global `.wslconfig`, Windows firewall, portproxy, Docker service, or LAN.
4. **Implementation/deployment approval:** separate future decisions. None is requested or granted here.

## Current security disposition

| Property | Evidence class | Disposition at `9b3afd3` |
|---|---|---|
| Mock container isolation | Implemented in source; existing disposable CI evidence | Fixed mock path requests network none, read-only root, non-root UID/GID, dropped capabilities, no-new-privileges, resource bounds, a private workspace and bounded output. This is not provider runtime isolation. |
| Separate service identities | Source definitions and disposable Ubuntu systemd CI evidence | API, authorizer, worker and launcher identities/socket groups exist in the transitional hybrid deployment. Target WSL2 permissions are unverified. |
| Rootless Core and Runtime Engines | Vendor-documented generic Linux mechanism; no Omnis implementation | Proposed only. Separate users, disjoint subordinate ID ranges, sockets, data roots, volume boundaries and WSL compatibility are unverified. |
| Runtime Engine API gateway | Design specification only | Absent. The sole holder of the raw Runtime Engine socket must reconstruct a narrow typed request API outside launcher control. No gateway deployment/enforcement test has run. |
| Runtime Engine egress | Mock `network=none` and synthetic CI fixtures; no external independent policy | Provider/default-deny egress enforcement is not implemented or target-verified. No public endpoints were probed. |
| Windows-local ingress provenance | ADR-0012, threat model and observation fixture | **BLOCKED.** Loopback binding, TLS, `Host`, `Origin`, and forwarded headers do not prove that an accepted request came from a Windows-local principal. No approved discriminator or independent verdict exists. |
| Runtime authorization/credentials | Pure Stage A protocol and synthetic broker only | No live issuer/store, provider secret custody, approved Codex identity/model, or real provider connection. The injected Stage A verifier is not live authentication. |
| Protocol request hashing | Pure Stage A source and tests; #109 merged | Protocol version must now be a number before hashing; this reduces coercion ambiguity in the pure function. It is not a live gateway/authentication or operation authorization control. |
| Mission Lane acceptance replay | #109 authorizer/database source and CI tests | Owner acceptance can reconcile an eligible previously accepted Run and append the owner transition. This changes task lifecycle and lock behavior, not the infrastructure trust boundaries in this packet. Current-main legacy-upgrade lock-timeout investigation belongs to Codex #1. |
| WSL2 lifecycle/recovery | Generic vendor documentation and source design | No target WSL2 test; Docker daemon loss, manager loss, distro stop/start and an independent persistent start interlock remain unverified. |
| CI evidence | Historical merged PR and disposable Ubuntu CI | Evidence is scoped to its commit and runner. It is not target WSL2, rootless dual-engine, or provider evidence. |

The source still uses the transitional host-managed launcher with rootful Docker group authority (`infra/systemd/omnis-sandbox-launcher.service` and `apps/sandbox-launcher/src/docker-sandbox.ts`). The Docker-only architecture is not current implementation. The rootful socket-container approach, privileged nested Docker recipe, direct launcher Engine socket, broad socket proxy, and AuthZ plugin as sole enforcement remain rejected.

## Decision requested from Codex #1

Review the exact PR head and provide a direct, attributable decision on:

- Whether the two-Engine trust boundary is coherent when the rootless Runtime Engine socket grants full authority over that Engine.
- Whether the gateway is sufficiently outside launcher control and whether the proposed cross-Engine policy UDS preserves peer identity, UID/GID mapping, descriptor and path boundaries.
- Whether the typed gateway API, operation-scoped capability, replay/expiry/revocation checks, request/prompt binding, one-time consume ordering and fail-closed unknown semantics are sufficient. Identify the exact authorization authority and state owner for each operation.
- Whether Docker AuthZ is correctly limited to defense-in-depth and the gateway's HTTP/Engine parser rejection surface is complete enough for a later reviewed design.
- Whether egress and aggregate resource controls are independent of launcher/gateway request flags and are testable under rootless Docker/RootlessKit.
- Whether the proposed termination/fencing and boot recovery are adequate; name the surviving authority or state that the design remains blocked.
- Which test-group fixture or permission assumptions must change before any VM test can be authorized.

## Decision requested from Claude #1

Provide an independent threat-model review of the exact same PR head. Assume full compromise of the launcher and challenge:

- Raw socket, alternate Engine context, TCP socket, containerd/runtime shim, inherited descriptor, cross-Engine volume and UID-map access paths.
- Gateway endpoint/path/body/API-version parser differences, gRPC, upgrades/hijack, streaming, malformed JSON, duplicate keys, alternate encodings, plugin/config-management operations, and fail-open on gateway/auth/store failure.
- RootlessKit network/port helpers, NAT/mirrored WSL paths, IPv4/IPv6, DNS tunneling, proxies/DoH, host/Windows access, Docker publishing/direct routing, and the positive/negative egress measurement method.
- Resource exhaustion across cgroups, disk/inodes, images, volumes, logs, processes, concurrency and cleanup; distinguish guest limits from shared WSL VM resource limits.
- Worker/launcher/gateway/daemon/systemd/WSL death after a request may have dispatched; ensure `unknown` cannot be resubmitted and cleanup cannot remove unowned resources.
- Whether any current design assumption lacks independent enforcement. Give each finding severity, affected trust boundary, source/design evidence, recommendation and disposition.

## Decisions requested from the project owner

No option is selected by this packet. Record an explicit response for each:

1. **Locality requirement:** Are all unprivileged WSL-local, LAN, same-bridge and forwarded clients prohibited, or should the requirement change to authenticated client identity? If it changes, specify which principals are authorized and how the changed threat model is accepted.
2. **Ingress candidate:** approve additional research only for candidate A (NAT/source-path predicate), B (mirrored/source-path predicate), C (Windows-held mTLS identity, which changes locality semantics), D (Windows/Hyper-V managed enforcement exception), or E (keep listener absent). A/B require a non-forgeable discriminator at the actual enforcement point; no observed tuple is selected as one. E remains the safe interim state.
3. **First feasibility environment:** approve or reject a named isolated Linux VM for rootless/API/egress/resource/recovery fixture tests. State owner/operator, hypervisor, private network mode with no uplink, vCPU/RAM/fixed-disk limits, guest-root permissions, snapshot/destruction plan, evidence location/retention, and independent termination authority.
4. **WSL stage:** separately approve or reject a named imported WSL2 distro and disposable Windows profile only after VM tests pass. State versions/modes, local test certificate trust, per-distro changes and explicit prohibition/exception for global `.wslconfig`, Windows Firewall, Hyper-V firewall, portproxy and current-distro access.
5. **Trust assumptions:** name whether host root, Windows administrators, the Runtime Engine operator, gateway binary/provisioner and kernel are trusted. Approve or reject the proposed two service identities, disjoint UID/GID ranges and separate data roots.
6. **Future real-runtime gates:** provider/model identity and entitlement review, native credential custody/rotation/revocation, backup key custody/RPO/RTO, and a separately reviewed supervision/fencing design. These are not part of P0-R2.1 execution.

## Review response format

Each reviewer response must include:

```text
Reviewer identity / role:
Independence statement:
Exact reviewed PR commit SHA:
Files/design sections reviewed:
Decision: APPROVE DESIGN ONLY | APPROVE NAMED DISPOSABLE VM TESTS | REQUEST CHANGES | REJECT
Explicitly approved scope and exclusions:
Findings: ID, severity, trust boundary, evidence, correction, disposition
Required conditions / unresolved questions:
Date:
```

Owner decisions must name the exact revision and answer each numbered decision above. “Approved for design” does not authorize a VM; a VM approval does not authorize WSL changes; no review or approval authorizes real-provider activity.

## Status register

| Required disposition | State |
|---|---|
| Codex #1 direct review of exact PR #110 head (listed in PR description) | **PENDING — no attributable exact-head verdict recorded; request packet ready.** |
| Claude independent threat-model review of exact PR #110 head (listed in PR description) | **PENDING — no attributable exact-head verdict recorded; request packet ready.** |
| Owner ingress candidate decision | **PENDING — provenance remains BLOCKED.** |
| Owner disposable Linux VM authorization | **PENDING — no VM or guest-root actions authorized by this packet.** |
| Owner separate WSL2 distro/profile authorization | **PENDING — no WSL2 host experiment authorized by this packet.** |
| Implementation, deployment, provider credentials/inference | **NOT AUTHORIZED.** |

Four supporting agent reviews were performed read-only for this PR package. They are recorded in the PR description and companion feasibility package; none is Codex #1, Claude #1, or owner approval.

### Independent design-only subagent reviews

All four reviews inspected source/design at `04e9b31b89b0034aac00bc4130ca10a1b9c90335`. They did not review the subsequent #109 diff, edit the repository, run host/runtime tests, or issue a human security approval. Their findings remain supporting historical observations and do not satisfy exact-head review of this updated PR.

| Review area | Findings and severity | Evidence / disposition |
|---|---|---|
| Linux/Docker isolation (`linux_docker`) | No confirmed defect. **P1 readiness gaps:** dual rootless engines and gateway absent; current launcher has rootful Engine authority; UID/GID, independent storage, WSL target behavior, resource enforcement and outer egress remain unverified. | Source and existing plan review. Kept the architecture marked proposed and the feasibility sequence gated; no runtime claim promoted. |
| Network/ingress (`network_security`) | No confirmed ingress/egress flaw in the proposal. **P1 evidence gap:** ADR-0012 correctly blocks provenance, but existing scenarios are gated specifications, not executable/target evidence. | ADR-0012 and WSL experiment plan review. Added explicit NAT/mirrored × IP-family ingress matrix and pass/inconclusive criteria; owner candidate choice remains pending. |
| Credential/authz (`auth_boundary_review`) | No confirmed authorization vulnerability. **P2 review-integrity/test-specificity gaps:** stale design baseline; denial matrix needed to assert zero Engine dispatch; distinguish pure Stage A protocol from live gateway auth; assert no CLI/environment credential reads or provider traffic. | P0-R2.1/P0-R2.2 review. This packet pins current source SHA, and the feasibility package includes the synthetic-key negative matrix, zero-dispatch assertion and credential/provider non-use boundary. |
| Recovery/supervision (`recovery_review_p021`) | No unsafe recovery claim confirmed. **P1 package gaps:** daemon interruption and abrupt WSL distro termination needed separate acceptance rows; stale-readiness/interlock and no-duplicate assertions; cleanup cannot pass while exact-ownership terminator is absent. | Recovery design and WSL runbook review. Added rows R1a/R1b, marked shared `wsl --shutdown` unsuitable, and made cleanup/pass explicitly blocked pending independently reviewed terminator. |

These are supporting design findings, not the mandatory exact-revision decisions requested above. The PR head SHA must be filled into the response template by each required reviewer; all their statuses remain pending unless a direct attributable response is recorded.

## Restrictions retained

**RELEASE BLOCKED — DEADLINE FENCE NOT ESTABLISHED**

**LIVE STAGE 1 INTEGRATION BLOCKED — LIVENESS ORDERING UNPROVEN**

**RELEASE BLOCKED — SUPERVISION GUARANTEE UNAVAILABLE**

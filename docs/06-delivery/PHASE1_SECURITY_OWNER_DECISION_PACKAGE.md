# Phase 1 Security Owner Decision Package

**Assessment date:** 2026-11-17
**Current-main baseline:** `5f8094cb07c2300d9d1d820e07ffee265ca18728` (PR #125; includes PR #126 at `838b40f03cc928c344031fc270370996af20cea6`)
**Status:** Decision package for owner review. No execution architecture is selected or approved. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

This package turns the open Docker-only mock-runtime gates into explicit owner decisions and implementation/acceptance criteria. It uses the prior independently approved local design assessment at `8c0fe9c0dd9f83b0fbfa91e6692d73cb77c647ac` as input; that revision remains local and unmerged. This package does not authorize Docker, database, WSL2, host, provider, mock-runtime, or deployment operations.

## 1. Decision requested

Under the current constraints—existing WSL2 Ubuntu only, Docker-managed application/workload containers, no Windows changes, no extra VM/host, no new host services or host configuration changes, no real providers—**there is no approved, verified execution-capable mock architecture**. Compose-only restricted mode is viable and already fails closed with execution disabled. It cannot itself supply an independent authority capable of mediating rootful Docker calls, fencing rollback, and proving termination.

The current hybrid host launcher can run the fixed synthetic workload in source/CI, but it is not the requested all-Docker topology and it remains trusted with rootful Docker authority. Putting that socket in a launcher/gateway container does not narrow the authority. Docker documents that control of a rootful daemon enables host filesystem access ([Docker Engine security](https://docs.docker.com/engine/security/)). A Docker AuthZ plugin can add defense in depth, but Docker documents that it does not inspect gRPC, non-JSON bodies, or the full upgraded/hijacked stream ([Docker AuthZ limitations](https://docs.docker.com/engine/extend/plugins_authorization/)).

The two-rootless-Engine design with a host-provisioned Policy Gateway and separate terminator is a conditional design candidate, not currently feasible or approved. Existing repository evidence reports rootless/user-namespace support unavailable on a tested WSL host; that record does not identify enough version detail to establish whether it is the current target. Docker rootless mode requires host prerequisites and service setup ([Docker rootless mode](https://docs.docker.com/engine/security/rootless/)); no target compatibility evidence exists. WSL NAT and mirrored networking both affect how host/guest traffic is routed, so source tuple and localhost assumptions require target evidence ([Microsoft WSL networking](https://learn.microsoft.com/windows/wsl/networking)).

**Safe present choice:** retain `OMNIS_RESTRICTED_DEVELOPMENT=true` with `OMNIS_EXECUTION_MODE=disabled`; keep no queue consumer, launcher, or provider dispatch in that profile. The smallest next step is an owner decision on whether named, narrowly scoped host control services and per-user rootless daemon configuration may be considered on the existing WSL distro, followed—only if approved—by a separate, read-only rootless/cgroup compatibility check. A positive compatibility result still does not authorize installation, activation, or runtime testing.

## 2. Architecture options and dispositions

| Option | Feasibility under current constraints | Boundary / threats | Owner decision and implementation work | Verification and acceptance | Rollback |
|---|---|---|---|---|---|
| **A. Compose-only restricted profile** | **Available now; execution-disabled only.** This is not a mock execution architecture. | API/Worker have no Authorizer/launcher endpoint or Docker socket. API/Worker mode mismatch and execution operations fail closed. No runtime process or Run is admitted. It does not meet the synthetic execution objective. | No new authority decision. Preserve the exact restricted lock and separate health from capability. No privileged operation. | Offline config truth table proves Authorizer-free startup, mode mismatch rejection, 503 for disabled Run/stop, no queue/launcher initialization, and truthful `omnis.runtime-capabilities.v3`. Target WSL2 evidence remains separate. | This is the fallback state: remove execution configuration/endpoints, preserve DB, and do not restart any previously enabled Worker without separately verified stop evidence. |
| **B. Existing host launcher + rootful Docker daemon** | **Functionally possible for fixed synthetic mock work; not Docker-only and not protected against launcher/daemon compromise.** Existing source/CI coverage is not target acceptance. | Launcher and anyone with the rootful daemon socket/group are trusted host-level principals. API/Worker must not receive the socket. Container limits constrain the fixed workload only while launcher/daemon/kernel enforce them. A compromised launcher can ask the daemon for broader host authority. | Owner must explicitly accept the host launcher and rootful daemon as trusted for the synthetic-only threat model, and accept hybrid host services. Codex #1 must preserve owner approval/revocation, immutable Run binding, one-use dispatch and UNKNOWN recovery. Codex #3 must report actual resource/network limits. No provider secrets or real providers. | Positive: fixed pinned synthetic command, network none, non-root, RO root, capabilities dropped, resource limits, no host mounts/secrets/socket; Owner journey passes CI and later separately authorized target testing. Negative: compromised API/Worker cannot reach daemon, tampered launch inputs fail, restart/revoke cannot resurrect work, egress and host access deny. Independent exact-head security and platform reviews. | Fence new admissions first; stop only exact project/run resources after separate authorization; preserve volumes/audit. Uncertain descendants remain UNKNOWN and block restart. Roll back to Option A; do not infer process death from Run status or `--rm`. |
| **C. Authenticated Policy Gateway in front of rootful Docker** | **Meaningful only as a broker boundary between untrusted API/Worker/Launcher callers and a trusted gateway. It is not an independent boundary from rootful Docker authority.** | A separately provisioned host Gateway can authenticate callers and reconstruct a tiny typed Docker API, preventing ordinary callers from exercising arbitrary daemon operations if the Gateway is correct and immutable. The Gateway itself, root/system manager, and daemon admin remain host-root-equivalent TCB; a compromised Gateway or daemon administrator bypasses policy. A generic socket proxy or AuthZ plugin does not establish the required semantic boundary. | Owner must decide whether this TCB is acceptable and whether host service/config changes are allowed. Codex #3 implements an independently owned host UDS service, exact host-peer authentication, no raw socket to app containers, fixed image/command/limits, request schema/replay controls, and service integrity. Codex #1 owns issuer, one-time grant, owner-intent, revocation, and UNKNOWN contracts. Requires root-owned service/socket provisioning; no container privileged mode, but host service installation/configuration is privileged. | Positive: only approved create/start/inspect/read/reconcile policy calls succeed. Negative: API/Worker/raw launcher, gRPC, upgrade, non-JSON, unknown paths, smuggled fields, alternate images/networks/mounts/exec/plugins all fail before daemon request. Fault tests prove unavailable Gateway fails closed. Independent reviewers must evaluate the Gateway/daemon TCB explicitly. | Fence admissions; stop/reconcile exact runs; preserve audit/DB. Gateway outage means no new starts. If daemon/gateway/termination proof is uncertain, quarantine and remain UNKNOWN; return to Option A. |
| **D. Separate Core and Runtime rootless Engines, independent host Gateway and separate terminator** | **Conditional research candidate only; current WSL target support is unknown and historical evidence is negative. Requires host changes disallowed by current scope.** | Distinct service UIDs, subordinate ID maps, sockets, data roots and runtime-only Engine reduce authority from Core/API and reduce root-equivalent launcher power. Root/systemd and kernel still control both services. Gateway must be outside Runtime Engine control and hold the sole Runtime socket. The terminator must be independent of Worker, Gateway and Engine. Rootless mode alone does not prove egress isolation, rollback resistance or descendant termination. | Owner must permit exact root/systemd service identities, `/etc/subuid`/`subgid` ranges, rootless Engine installation/config, service lifecycle and independent terminator on the existing WSL distro. First authorize read-only compatibility collection only. Codex #3 owns Engine/gateway/terminator implementation; Codex #1 owns issuer/anchor/revocation/audit. M-3 anchor and M-4 registration/termination decisions remain required. | Compatibility gate: exact Windows/WSL/kernel/Engine versions; required user namespaces, subordinate ranges, systemd, cgroup v2, storage, network helper, socket UID and resource controls supported. Disposable positive and adversarial tests: raw socket denied, gRPC/AuthZ bypass denied at gateway, no egress/host/Core reachability, UID spoof/replay denied, restart/restore fenced, terminator proves all descendants absent. Exact target WSL2 acceptance only after separate authorization. Independent exact-revision reviews before any activation. | Safe shutdown fences starts before stopping services; active registrations remain under terminator/deadline supervision. On uncertainty preserve anchor/journal/DB, do not restore ACTIVE from stale local state, and return to restricted-disabled profile. Host rollback must not remove unresolved cgroups/processes or anchor evidence. |
| **E. Single rootless Engine with gateway/workload under same Engine** | **Not sufficient for the required independent gateway boundary.** | The Engine operator can replace the Gateway, its policy or workload, so Gateway and daemon share an administrative authority. Rootless reduces impact relative to rootful but does not make the Gateway independent of that Engine's administrator. | Would require an explicit narrower threat model accepting same-daemon administration; not recommended for R1. | If reconsidered, tests must demonstrate exactly which adversary this protects against; it cannot be accepted as protection against Engine-admin compromise. | Disable execution and quarantine any active work; no automatic fallback to rootful. |
| **F. New VM or separate host** | **Out of current scope and not authorized.** | Could provide an additional boundary, but creates separate hypervisor/host/admin, ingress, key custody, connectivity and operational dependencies. | Requires an explicit scope change and separate owner authorization. | Separate security and platform review; not implied by this package. | Preserve current WSL state; no VM/host provisioning is part of this decision. |

### Recommendation

Do not select an execution-capable option yet. If the owner’s non-negotiable rule is **no WSL host changes**, the architecture decision is **Option A only**, and the mock execution objective must remain blocked. If the owner wants mock execution on the existing WSL2 host, the smallest design-scope change is to permit evaluation of host-managed security control services and rootless daemon prerequisites. Then approve a read-only compatibility assessment first. If rootless prerequisites fail, do not silently fall back to rootful; return for the explicit Option B/C trust decision or keep execution disabled.

No option in this table authorizes a runtime operation. The exact minimum host changes depend on the compatibility result and selected threat model.

## 3. Explicit owner decisions

Please record each choice; silence or approval of this document is not a choice.

1. **Host boundary:**
   - [ ] Keep “no host modifications/services” absolute; restricted execution-disabled mode is the only approved topology.
   - [ ] Permit a separately scoped, read-only compatibility assessment of the existing WSL2 distro; no install or daemon operation.
   - [ ] Permit future design of named host-managed control services/rootless daemons, subject to a new exact implementation and runtime authorization.

2. **Rootful trust:**
   - [ ] Rootful Docker daemon and launcher remain unacceptable TCB; no rootful-socket mock runtime.
   - [ ] Accept rootful daemon/Gateway as host-equivalent TCB for synthetic-only execution, with the residual compromise risk in Option B/C. This does not authorize activation.

3. **Ingress principal:**
   - [ ] Require a provable Windows-local ingress predicate; if none is demonstrated, keep owner listener absent.
   - [ ] Consider revising the invariant to authenticated owner identity independent of network source. This changes the threat model and requires separate approval; Origin, TLS and loopback are not source proof.

4. **M-3 durable fencing:**
   - [ ] Require an external monotonic anchor outside the full WSL/DB rollback domain, with fresh challenge/high-water checks, pre-fence ordering, durable receipts and quarantine on uncertainty.
   - [ ] Explicitly accept whole-environment rollback risk for synthetic-only use under a separately reviewed bounded policy (no restored in-flight Run may resume; fresh identity/keys and operator reconciliation required).
   - [ ] Neither; execution remains disabled.

5. **M-4 process registration and termination:**
   - [ ] Require an independent registration authority and terminator, with run/generation-bound stop leases and evidence of complete descendant/helper absence before `cancelled`.
   - [ ] No such authority is approved; uncertain runs remain UNKNOWN and cannot be replaced/replayed. This blocks execution admission where containment cannot be guaranteed.

6. **Target security posture:** owner chooses whether host root/systemd and the WSL kernel are trusted principals. If root is treated as adversarial, neither ordinary rootless Docker nor a local host gateway provides a complete boundary against it; select a separately reviewed protected host or remain disabled.

## 4. Security contracts all execution-capable options must satisfy

These requirements are mandatory regardless of an Option B/C/D decision.

### Identity, Authorizer and launcher

- Owner authentication, session, Origin, CSRF and ACL checks stay in the API. Authorizer does not independently prove the human identity when the current API asserts owner intent; that remains an explicit trust assumption or requires a redesigned owner-intent channel.
- API and Worker have no rootful or Runtime Engine socket, Docker group, privileged mode, host-root mount, or authority to replace the Gateway/launcher policy. The existing host Worker session fence is process-local; it is not global revocation or process termination.
- Authorizer is the policy authority and sole issuer of short-lived, audience/peer-bound capabilities. Worker peer identity comes from the protected host channel, not caller-provided `workerId`. Launcher cannot mint grants, advance ticket steps, change operation identity, or request arbitrary Docker configuration.
- Each authorization binds exact owner approval, Task/project/profile revision, Run, execution generation, Worker lease owner/revision/expiry, policy, input digest/length, operation/step, nonce, audience and expiry. One durable consumption per step; replay/conflicting identity denies. Receipt retries are status-only. Gateway records the dispatch intent and durable `DISPATCHED` outcome before one Engine mutation attempt; uncertainty becomes UNKNOWN and reconciliation is read-only.
- Gateway is a distinct trusted process, not a generic socket proxy. It validates a versioned typed request and reconstructs the Engine request itself. Deny unknown paths/methods/query fields, API versions, duplicate/ambiguous JSON, non-JSON bodies, gRPC, upgrades, streaming, build/pull, exec, plugins, host mounts, devices, ports, caller-selected image/command/network, alternate daemon/socket and unsupported content types. AuthZ plugins are defense in depth only.
- Workload remains conspicuously synthetic, fixed-image/digest, no provider secrets, no DB/API/Authorizer credential, no Docker socket, no arbitrary host mount, no network, bounded CPU/memory/PIDs/output/time, read-only root, non-root, all unnecessary capabilities dropped, `no-new-privileges`; target cgroup enforcement must be demonstrated.

### M-3 fencing, restart and UNKNOWN outcomes

- Before external-anchor contact, Authorizer persists an irreversible request fence that denies new reservation/consumption. Anchor pre-fence orders against ticket consumption. The DB commit and anchor receipt advance the same revision/intent; no timeout/retry/restore reactivates it. Missing/lost anchor state keeps execution fenced.
- If the owner chooses the external anchor, its state and key/custody must be outside the complete WSL/DB/backup rollback domain. Fresh challenge and high-water compare are required at startup/restore and every admission/consume. A local file, DB row, Docker label or process-local session is not an external anchor.
- If an execution request may have reached the Engine, no retry of create/start is permitted. Persist UNKNOWN, block replacement generation and reconcile exact operation/Run identity; missing container/process evidence is not permission to recreate.
- Restart starts quarantined. Validate Authorizer ledger, anchor high-water, pending fences, Gateway journal and registered process inventory before any admission. API/Worker disagreement, missing trust material, unavailable anchor/terminator, DB mismatch or stale event/order state fails closed.

### M-4 termination and audit

- Stop is a separate stop-only capability bound to environment, Run, generation, stop ID/deadline and reason. It cannot authorize create/start. Register exact processes/cgroup before start using a trusted registration authority that Launcher/Gateway/Engine labels cannot choose or forge.
- Independent terminator survives Worker/Gateway/Engine outage and has no general Engine socket. It enforces the deadline, kills the exact registered scope, and produces verified evidence that the full process/helper set is absent. A Docker/launcher stop acknowledgement, timeout, container removal, missing PID or Run status does not prove termination.
- Any missing or contradictory termination evidence remains UNKNOWN and fences replacement work. Preserve immutable ordered audit/event identity, grant/consume/anchor/registration/termination receipts, bounded error classes and owner-visible state; never store provider credentials or raw secret-bearing payloads.

## 5. Database bootstrap security review

### Available evidence

PR #126 merged as `838b40f03cc928c344031fc270370996af20cea6`; its CI run [43938806944](https://github.com/Jeysibn/omnis-os/actions/runs/43938806944) passed ten checks. PR #126 is a **documentation-only restricted WSL readiness plan**, not the current database bootstrap implementation. It records that the existing role/migration commands use fixed shared env files and are blocked for restricted provisioning.

Codex #3 has an uncommitted implementation proposal in `/home/jeysi/projects/omnis-os-db-bootstrap-hardening`. At first inspection its base HEAD was `838b40f03cc928c344031fc270370996af20cea6`; the live worktree changed during review. A frozen snapshot was created at `/tmp/omnis-db-bootstrap-review-838b40f` (base `838b40f...`; tracked patch SHA-256 `b0b6192806a0ed26e68cca1d5bb3b68bd71f20c97116bba2e790d53bf4abe181`; untracked files checked against a generated manifest). An independent read-only reviewer verified that snapshot and issued **REQUEST CHANGES / DO NOT AUTHORIZE DATABASE MUTATIONS**. This verdict is limited to that frozen uncommitted snapshot; it is not a review of later Codex #3 edits or a committed PR revision.

### Independent review findings

1. **HIGH — target identity does not establish project/cluster identity.** The proposal checks database name, role and superuser status (`packages/db/src/restricted-bootstrap.ts:108`), but a different loopback PostgreSQL cluster may also contain `omnis_restricted_dev`. `ALTER ROLE` and membership revocations in `packages/db/src/provision-roles.ts:109,165` are cluster-global, so the guard does not constrain effects to the intended project data volume.
2. **HIGH — mutation can precede later preflight failure and leave partial global state.** Role mutations begin at `packages/db/src/provision-roles.ts:94`; timeout and membership checks occur later (`:130,155`). Separate autocommit queries can leave partial changes after a subsequent rejection or error. Complete read-only checks before the first mutation and define transaction, failure, and safe-retry behavior.
3. **HIGH — pg-boss connection identity is unchecked.** `apps/worker/src/migrate-restricted.ts:68` checks the `pg` pool, then pg-boss opens another connection from the URL and `boss.start()` can mutate schema (`:71`) without verifying that connection's database/role/superuser identity. Existing tests assert call order and URL, not identity on the second session.
4. **MEDIUM — env-file check/read race.** `packages/db/src/restricted-bootstrap.ts:179,194` checks a path with `lstatSync` then separately reads it; replacement between calls can bypass the inspected file's properties. Open without following links, then validate metadata and read from the same descriptor, including trusted parent-path handling.

The reviewer found no confirmed secret-value leakage in the inspected proposal. Review evidence was static only: it did not run PostgreSQL, Docker, host operations, or migrations. The reviewer recommended offline tests for exact-target-before-mutation, cluster-wide effects, zero mutation on preflight failure, partial-failure/retry, pg-boss target identity, and secret redaction. **This proposal is not approved and must not be used to provision or mutate a database.** A fresh review of a committed exact revision is required after fixes; the current verdict does not transfer to later edits.

The exact frozen proposal was reviewed, and the blocking findings above remain unresolved in the reviewed snapshot. The complete follow-up review must also verify restricted-only secret input, exact target and cluster identity, role/function ACLs, error/CI redaction, disabled execution preservation, and tests that exercise actual mutation ordering rather than merely assert generated SQL.

## 6. Current R1 security completion matrix

Status is at current main `5f8094cb07c2300d9d1d820e07ffee265ca18728`, except the restricted DB proposal row, which is explicitly a separately identified uncommitted snapshot. CI-verified means only the named CI scenario; it does not mean WSL2 acceptance.

| Requirement | Status | Evidence and remaining gate |
|---|---|---|
| Owner login, session, Origin/CSRF, ACL | **CI-VERIFIED / TARGET-PENDING** | Source and regressions cover session lifecycle and request protections. Actual owner-host auth/cookie/ingress behavior is not validated. |
| Restricted Authorizer-free mode | **SOURCE AND CI-VERIFIED** | API/Worker disabled mode permits service readiness without Authorizer/launcher and fails closed on mismatched config. Target environment is unverified. |
| Mock execution mode separation | **SOURCE AND CI-VERIFIED, ACTIVATION BLOCKED** | Explicit mock selection remains distinct from restricted disabled mode. Do not activate on the owner host from this evidence. |
| Authorizer trust boundary | **PARTIAL / DESIGN DECISION REQUIRED** | Current hybrid API→Authorizer checks are implemented; API owner attribution remains a trust assumption. Independent gateway issuer and authenticated owner-intent channel are not implemented. |
| Launcher/Docker authority | **DESIGN DECISION REQUIRED** | Existing fixed mock launcher requests container restrictions, but retains rootful daemon authority. No Docker-only gateway boundary exists. Rootless candidate lacks target compatibility evidence. |
| Runtime credential custody | **BLOCKED** | No provider credentials/real provider permitted. Local service/DB secret delivery and target custody are not verified. |
| One-use grants/replay protection | **CI-VERIFIED FOR SYNTHETIC PATH; LIVE RUNTIME PARTIAL** | Synthetic authorization, immutable binding and replay regressions exist. Proposed external Gateway/Authorizer ticket consumption is not implemented as a runtime authority. |
| Worker revocation | **PARTIAL / RUNTIME-PENDING** | Durable DB lease and stale-writer checks exist. Worker session fence is process-local; it cannot kill already-running work or provide global revocation. |
| M-3 durable external-anchor fencing | **OWNER DESIGN DECISION REQUIRED** | Architecture packet defines a rollback-independent contract; no anchor, custody, key lifecycle or owner risk choice is approved. |
| Recovery and unknown execution outcome | **CI-VERIFIED SYNTHETIC; TARGET-PENDING** | Synthetic uncertain outcome/restart recovery avoids automatic resubmission. WSL/Engine/systemd/anchor restore and actual process inventory are not verified. |
| M-4 process registration/termination | **DESIGN APPROVED ONLY; IMPLEMENTATION BLOCKED** | Separate registration/terminator design remains unimplemented. No daemon response or process-local abort is termination evidence. |
| Events/SSE and owner acceptance | **CI-VERIFIED SYNTHETIC; TARGET-PENDING** | PR #124 verified the combined Task→Run→Review→Accept→Completed browser journey in disposable CI. It is not target runtime security; multi-replica session revocation remains unestablished. |
| Database role/migration boundaries | **SOURCE/CI PARTIAL; RESTRICTED BOOTSTRAP BLOCKED** | Existing role separation and restore ACL tests exist. PR #126 documents setup blockers only. Independent review of Codex #3's frozen uncommitted proposal returned REQUEST CHANGES on three HIGH and one MEDIUM findings; do not authorize its DB mutations. A fixed committed revision needs fresh exact-SHA review. |
| Windows/WSL2 ingress provenance | **BLOCKED** | No non-forgeable Windows-local request predicate has been demonstrated. Host/Origin/TLS/localhost are not sufficient proof. |
| Host resource/cgroup/network isolation | **TARGET-PENDING / DESIGN DECISION REQUIRED** | Source requests workload limits and network none. Actual WSL cgroup enforcement, rootless support, no-egress behavior, listeners, UID mappings and lifecycle remain untested. |
| Full R1 target acceptance | **BLOCKED / NOT ACCEPTED** | Requires owner-selected design, separately authorized target WSL2 evidence, independent review of final source/topology, and owner acceptance. |

PR #124’s synthetic journey remains CI evidence only. It does not close M-3/M-4, target ingress, effective DB grants, daemon authority or WSL2 acceptance.

## 7. Implementation work packages after owner decisions

### Codex #1 — backend/security

1. Keep disabled mode as default and make API/Worker capability/readiness truthful; reject any mismatched restricted/mocked settings before queue, launcher, Authorizer or DB mutation.
2. Specify and implement Authorizer owner-intent authentication, exact grant schema, one-use consume receipt, replay/idempotency and authenticated revocation channel. Preserve Origin/CSRF/ACL before forwarding.
3. Implement durable lease/authorization generation fencing and outbox/anchor state machine; no local Worker session fence called global.
4. Implement event/audit records for grant, dispatch, anchor and termination receipts; preserve ordered SSE replay/ACL and UNKNOWN semantics.
5. Implement restore/startup quarantine and deterministic offline fault/race tests; execution remains disabled until separately reviewed platform authority exists.
6. Review Codex #3 database bootstrap and migration/role implementation; require exact target/cluster identity, restricted credential sources, read-only complete preflight, safe transactional/partial-failure behavior, least privilege, no secret output and disabled-mode invariants.

### Codex #3 — platform/bootstrap

1. Complete the restricted-only config/env delivery contract without copying shared `.env.*` or passing credential values in command arguments.
2. Prove exact PostgreSQL server/cluster and fresh project/volume identity before any mutation; an exact DB name is insufficient when role statements are cluster-global.
3. Refactor role provisioning to avoid affecting shared cluster roles, or require an explicitly dedicated PostgreSQL cluster and enforce that identity. Complete all read-only checks before mutations; define transaction/partial failure/retry/rollback behavior.
4. Verify the actual migrator connection and the separate pg-boss connection before each mutating migration path; bind both to the intended cluster, database and role.
5. Enforce private file descriptor validation (no-follow, opened inode metadata, trusted directory), minimum credential exposure, generic errors, no values in logs/CI, and an exact script invocation contract.
6. Add adversarial mocked-client tests for wrong DB/server/role, global role side effects, timeout preflight rejection before any mutation, partial failure, rerun, PgBoss target, env-file swaps and credential redaction. Keep API/Worker execution disabled and Authorizer/launcher credentials absent.
7. Obtain independent exact-snapshot review before commit/PR; then normal hooks and PR CI. The reviewed code must not be run against a database without a separate owner authorization.

### Platform/security evidence before any runtime candidate

Codex #3 must supply exact service identities, Engine/socket ownership, UID ranges, cgroup/network behavior, ingress predicate, persistent registration/terminator behavior, restart/quarantine, and rollback test evidence. Codex #1 and an independent security reviewer must review the exact source and threat model. Owner separately authorizes any compatibility probe, host changes, DB provisioning/migration, mock activation, Docker operation or target acceptance run.

## 8. Acceptance and rollback gates

An execution-capable Phase 1 mock runtime is acceptable only after:

1. The owner records the host/daemon/launcher trust decision, Docker-only meaning, accepted ingress principals, M-3 choice and M-4 termination model.
2. The selected architecture passes exact-host compatibility and security tests without privileged container mode, unreviewed socket forwarding or weakened disabled mode.
3. API/Worker receive no Engine socket; Authorizer grants bind exact owner intent and are one-use, replay-safe and revocable; Gateway authenticates the true service peer and reconstructs only reviewed Engine requests.
4. Durable fence state survives anchor outage, Worker/Gateway/Engine/WSL restart and backup/restore. UNKNOWN cannot replay or admit replacement work.
5. Termination evidence covers every registered process/helper descendant. Missing evidence remains UNKNOWN and blocks another generation.
6. Effective DB cluster identity/roles/grants, owner acceptance receipt/event history, network egress/ingress, resource limits, backup/restore and all negative paths are verified on the selected target.
7. Full synthetic owner journey passes on the final topology; final exact source revision has independent security approval and all required CI checks; owner accepts residual risk. This still does not authorize any real provider.

Safe rollback always starts with denying new admissions. Preserve DB, event ledger, anchor, termination registrations, evidence and secrets. Do not delete volumes, reset roles, lower an anchor revision, kill broad process sets, or restart from local `ACTIVE` rows while an outcome is uncertain. Roll back configuration to restricted-disabled mode and keep unresolved work quarantined.

## 9. Owner response record

Record the selected options, exact scope and approver before implementation is authorized:

- Host boundary choice (Section 3): ______
- Docker/rootful trust choice (Section 3): ______
- Ingress principal invariant (Section 3): ______
- M-3 anchor choice/custodian/recovery owner: ______
- M-4 registration/terminator trust owner: ______
- Host root/kernel trusted principals: ______
- Separately authorized next operation (if any), exact target and stop conditions: ______

If no answer is recorded, remain on Option A: execution disabled. Design approval is not runtime authorization.

## Evidence sources

- Current main: `5f8094cb07c2300d9d1d820e07ffee265ca18728`; PR #125. PR #126 merged at `838b40f03cc928c344031fc270370996af20cea6`; its current source record is [restricted WSL2 readiness](./RESTRICTED_WSL2_RUNTIME_READINESS.md).
- PR #124 full synthetic acceptance journey: CI run [43933158373](https://github.com/Jeysibn/omnis-os/actions/runs/43933158373), exact PR head `63928bf9cc9ab7854df09f2a2c0e7afa092f73bb`, merge `ed5d647a35ffb80bfb579342cd25e04f31b6d83e`; ten checks passed. Synthetic disposable CI only.
- Docker official documentation: [rootless mode](https://docs.docker.com/engine/security/rootless/), [Engine security](https://docs.docker.com/engine/security/), and [AuthZ limitations](https://docs.docker.com/engine/extend/plugins_authorization/); Microsoft [WSL networking](https://learn.microsoft.com/windows/wsl/networking). Generic vendor documentation is not proof of target compatibility.
- [P0-R2.1 Security Review Packet](./P0_R2_1_SECURITY_REVIEW_PACKET.md), [runtime infrastructure handoff](../07-governance/PHASE1_RUNTIME_INFRASTRUCTURE_HANDOFF.md), [credential custody options](../07-governance/PHASE1_CREDENTIAL_CUSTODY_OPTIONS.md), [Docker-only platform readiness](./PHASE1_DOCKER_ONLY_PLATFORM_READINESS.md), [restricted WSL2 readiness](./RESTRICTED_WSL2_RUNTIME_READINESS.md).
- Static review only. No Docker, database, migrations, host changes, providers, mock activation, or target runtime probes were performed.

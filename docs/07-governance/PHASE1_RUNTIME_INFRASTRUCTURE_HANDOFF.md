# Phase 1 Runtime Infrastructure Security Handoff

**Assessment status:** Source-backed readiness handoff; Docker-only deployment and real-provider execution remain blocked.
**Source snapshot:** `origin/main` / `04e9b31b89b0034aac00bc4130ca10a1b9c90335`, fetched 2026-11-13.
**Scope:** Infrastructure, isolation, credential custody, runtime authorization, recovery, and verification evidence for a future Codex connection. This document does not grant runtime, experiment, deployment, or credential authority.

## Decision

Keep the production path mock-only. Current Compose and systemd source can run the fixed mock workload with meaningful container restrictions, and disposable CI has exercised synthetic flows. They do not implement the selected Docker-only target. ADR-0012 remains proposed, its Windows-local ingress provenance gate is blocked, and there is no Runtime API Policy Gateway or approved real Codex identity/provider connection.

The preferred feasibility candidate is two separately owned rootless Docker Engines: a core Engine and a synthetic-runtime Engine. A Runtime API Policy Gateway alone would hold the runtime Engine socket and expose a narrow private Unix-domain socket to the launcher. This candidate has not been implemented or proved on the target WSL2 host. The launcher must not receive a rootful or rootless Engine socket as a substitute for that gateway.

No OAuth, credential lookup, provider request, host provisioning, privileged experiment, gateway implementation, or authority change was performed for this assessment.

## Current architecture assessment

| Boundary | Implemented in source / evidence | Not established or blocked |
|---|---|---|
| Application deployment | Compose defines PostgreSQL, API, worker, and web. App networks are internal; only web and PostgreSQL publish loopback ports. API and worker have container identities, read-only roots, dropped capabilities, `no-new-privileges`, resource limits, health checks, and separate read-only host socket mounts. | This is a hybrid topology: authorizer and launcher remain host systemd services. It is not the final Docker-only architecture. Loopback publication is not proof that only Windows-local clients can reach the service. |
| Mock workload isolation | `apps/sandbox-launcher/src/docker-sandbox.ts` launches a fixed pinned synthetic image with `--network=none`, read-only root, non-root UID/GID, dropped capabilities, no-new-privileges, PID/CPU/memory/shm/ulimit/time bounds, private per-run workspace, bounded output, and disabled container logs. The mock container receives no host credentials or Docker socket. | These launcher controls apply to the fixed mock path. They do not create a provider runtime boundary or constrain a compromised launcher with daemon authority. Whether cgroups and limits are enforced on the target host is unverified. |
| Service identities and sockets | Systemd units name separate API, authorizer, worker, and launcher identities and private socket groups. Disposable Ubuntu systemd CI evidence reports successful identity, socket, secret, trusted-tree, and synthetic-flow checks. The synthetic broker peer proxy checks `SO_PEERCRED` on its own channel. | Target WSL2 installation and permissions are unverified. The launcher belongs to the rootful Docker group, which is effectively host-root authority. The synthetic broker peer check is not a general launcher or Runtime API Policy Gateway authorization control. |
| Credentials | Current service setup separates application/authorizer/worker/launcher environment files and DB roles. Authorizer signing-key loading rejects symlinks and requires a private regular key file. The worker is separated from authorizer credentials in the systemd deployment evidence. | No production provider credential store or custody procedure is approved or demonstrated. No provider secret may be placed in API, worker, launcher, broker, synthetic fixture, task, prompt, database, logs, or Compose environment. Host root and the current rootful launcher remain trusted with broad local authority. |
| Runtime gateway and egress | Synthetic broker test infrastructure has fixed synthetic endpoints and disposable egress probes. Mock container networking is disabled. | Runtime API Policy Gateway is absent. The synthetic egress Compose topology is not provider egress control. Default-deny provider egress, permitted destinations, DNS/TLS behavior, and enforcement outside launcher control are not implemented or target-verified. |
| WSL2 ingress | `scripts/compose/wsl2-acceptance-preflight.mjs` collects version/platform metadata and fails closed with a blocked verdict. `wsl2-provenance-probe.mjs` observes path tuples using a fixed diagnostic endpoint. | Neither tool enforces ingress. No source-backed predicate distinguishes an allowed Windows-local client from prohibited WSL-local/LAN/container paths. NAT/mirrored behavior, IPv4/IPv6, proxying, host firewall, and target exposure are not verified. |
| Lifecycle and recovery | systemd restarts mock services on process failure. The launcher performs scoped orphan cleanup before binding its socket using database-authorized active mock runs. Run/attempt fencing and uncertain-outcome preservation have synthetic test coverage. Disposable systemd CI has exercised the synthetic mock flow. | Restart policy and Compose shutdown are not independent termination guarantees. Docker-daemon interruption, WSL shutdown, manager loss, target boot ordering, and a persistent deny-start interlock are not proved. An uncertain provider operation must remain `unknown` and must not be resubmitted before authoritative reconciliation. |
| Runtime protocol | PR #103 adds pure Stage A parsing, schemas, framing, canonical request hashing, injected synthetic signature verification, deterministic policy/replay reducers, bounded response/audit values, and offline tests. | Stage A has no listener, credentials, key custody, durable issuer/consume store, peer identity mapping, provider dispatch, cancellation authority, or host isolation. Its synthetic verifier and fixtures do not authorize runtime execution. |

## Relevant merged work reviewed

- **#46 — isolated synthetic broker:** introduced a test-only broker/fake-provider path, signed synthetic authorization envelopes, dedicated IPC gateways, recovery and disposable egress/security checks. Current production execution remains mock-only; these tests do not establish provider authorization, target-host security, or operational egress.
- **#97 — Docker-only WSL2 review preparation:** added a read-only metadata preflight, acceptance/research docs, and a credential-free path-observation fixture. The fixture is not an ingress gateway or enforcement evidence. The packet still records no independent ADR-0012 verdict.
- **#99 — Mission 9D Stage 1 journal:** reserves attempts and returns journal evidence only. It does not release or launch a fixture. Target filesystem/lock semantics and production boot-time integration remain unverified.
- **#101 — inert Stage 2A foundation:** adds test-only schemas/ledger, fake Stage 1 validation, dependency/artifact exclusion checks, and preserves release restrictions. It adds no live authority or release endpoint; its deadline fence, liveness ordering, and supervision gates remain blocked.
- **#103 — pure runtime protocol Stage A:** adds offline protocol primitives only. It does not connect those primitives to a transport, authoritative policy store, provider, or production secret boundary.

The merged PR bodies, changed-file inventories, and the current source paths were reviewed. Earlier PR evidence is cited as evidence for its stated commit/environment only; it is not assumed to describe target-host behavior.

## Threat model and required architecture properties

Protected assets include owner approval and session state, task/run identity, immutable profile and prompt context, authorization records, provider credentials, audit/provenance, control-plane sockets, and daemon authority. Untrusted inputs include browser/API requests, task and prompt content, compromised web/API/worker/launcher processes, container workloads, and untrusted provider output. Host root and the kernel remain trusted only where the owner explicitly accepts them as such.

Before a Docker-only implementation can be reviewed for deployment, its source and target-host evidence must show:

1. Separate core and runtime Engine service identities, private sockets, non-overlapping subordinate UID/GID ranges, data roots, and volumes. Runtime Engine access must not grant access to core services, owner files, Windows interop files, or backup keys.
2. The Runtime API Policy Gateway is the only runtime Engine socket holder. It authenticates the launcher using the protected UDS peer identity plus an independent request credential or signed assertion; it accepts a tiny typed API and reconstructs Engine requests itself. It rejects unknown methods, paths, query parameters, content types, upgrades, streaming, arbitrary image/command/mount/network/volume/device options, and raw Engine protocol access.
3. The gateway verifies current authoritative authorization, one-time operation binding, policy identity, restrictions, generation/lease and expiry before every state-changing operation. Store, signature, peer, configuration, or policy uncertainty denies before dispatch.
4. Provider egress is denied by an enforcement point independent of launcher arguments and cannot be bypassed through another Engine, host route, DNS path, IPv6, proxy, inherited descriptor, or container network. The approved provider/model endpoints and TLS identity are explicit and testable.
5. Process and container limits are effective under the active target cgroup v2/systemd configuration. Startup, shutdown, cancellation, daemon failure, supervisor loss, WSL stop/start, and recovery preserve containment and unknown-outcome fencing.
6. Owner ingress provenance is established at an approved enforcement point. Host, Origin, forwarded headers, TLS, or loopback binding alone are not accepted as proof of Windows-local provenance.

If rootless Engines cannot satisfy these properties on the supported WSL2/kernel/Engine versions without a privileged nested daemon or rootful socket exposure, report Docker-only as infeasible for that target. Do not silently switch to a rootful socket container or treat the current hybrid arrangement as the final architecture.

## Future Codex connector contract

This is a handoff for later independently reviewed work. Every item below is absent or incomplete at the live provider boundary today.

| Concern | Required contract before a real request |
|---|---|
| Credential custody | Owner-approved native Codex authorization flow and provider policy/entitlement review. Use a dedicated secret store with documented ownership, access, rotation, revocation, backup, and incident response. Only the minimum provider-facing component may access it. Store only non-secret connection metadata elsewhere. Never read CLI caches or move subscription credentials through a third-party token tunnel. |
| Approved identity | Bind approval to an explicit provider, account/tenant, supported runtime/client version, model identifier, and capability set. Model/runtime selection must be allowlisted and checked at dispatch; do not accept prompt/profile text as authority. |
| Authorization | A durable owner decision must authorize the exact run, task, project, immutable profile revision, runtime/provider/model, operation, restrictions, expiry, and one-use identifier. Verify actor, audience, peer, generation/lease, current status, and revocation at the last trusted decision point. API-supplied owner attribution and a shared static token are insufficient for provider authority. |
| Tool-free enforcement | Enforce no tools/functions/MCP/browser/shell/file access in provider request construction and verify the provider response cannot invoke tools. Reject unexpected tool-call fields or response modes. A UI label or prompt instruction saying “no tools” is not enforcement. |
| Prompt and operation binding | Canonicalize and hash the exact prompt, immutable profile version, selected context/retrieval references, model/runtime settings, and operation arguments. Bind the approved digest to a single operation identifier and run generation. Any modification requires a new owner approval. Never log full prompts or secrets by default. |
| Session and cancellation | Create an explicit provider session mapping to the Omnis run and generation; define session persistence and deletion. Cancellation must reach the provider operation or terminate a bounded local request with evidence. A local cancel request is not proof of remote cancellation. Fence late responses and stale generations. |
| Network restrictions | Gateway owns an explicit default-deny destination policy, DNS and IP validation, redirect policy, TLS certificate verification, proxy policy, and IPv4/IPv6 behavior. Prevent DNS rebinding, private/link-local/metadata destinations, redirects to unapproved hosts, and access to local control-plane endpoints. Test positive and negative paths on the approved disposable target. |
| Output bounds | Enforce response bytes, token/output, elapsed time, concurrency, and per-run quota limits before persistence or UI delivery. Validate response schema and UTF-8/content handling. Treat provider output as untrusted; escape it at UI/render boundaries and do not execute it. |
| Audit and provenance | Persist actor/approval IDs, immutable configuration digests, provider/model/runtime identity, request/operation hash, timestamps, usage as reported or `unknown`, dispatch/result state, and bounded error classifications. Never store credentials. Keep synthetic and real-provider evidence unmistakably separate. Record enough provenance to verify result origin without retaining unbounded sensitive prompt content. |
| Fail-closed recovery | Before dispatch, authorization/store failure means no request. After dispatch may have occurred, timeout, connection loss, process death, or missing response means `unknown`, not failure or success. Never blindly retry. Reconcile the same operation through authoritative provider/local evidence; only issue a fresh operation after an explicit new decision. Cancellation and cleanup require independent termination evidence. |

## Recovery state model

```text
authorized ── verified before dispatch ──► dispatched
     │                                      │
     └── pre-dispatch failure: denied       ├── authoritative response ──► resolved
                                            └── lost response/worker/daemon ──► unknown
                                                                               │
                                                                               ├── reconcile evidence ──► resolved
                                                                               └── evidence unavailable ──► remain unknown; no resubmit
```

`systemd Restart=on-failure`, a Compose restart policy, Docker removal requests, or a launcher timeout do not alone prove that all workload descendants stopped. A later recovery implementation must identify an independent termination/fencing authority that survives gateway, launcher, manager, daemon, and WSL failure, or block release until a durable startup interlock prevents old work from resuming.

## Verification evidence and limits

### Source inspection for this assessment

- Checked out fetched `origin/main` at `04e9b31b89b0034aac00bc4130ca10a1b9c90335`; dedicated clean worktree. The original primary checkout had unrelated uncommitted backend work and was left untouched.
- Read repository `AGENTS.md`, `MASTER_PLAN.md`, `README.md`, `docs/06-delivery/PHASE_1_COMPLETION_MATRIX.md`, Docker-only WSL2 readiness and acceptance materials, ADR-0012, threat models, security review packet, credential custody options, platform/broker handoffs, and G1/G2/G3/G5 evidence.
- Inspected current Compose definitions, systemd API/authorizer/worker/launcher units, launcher source and security tests, host identity/socket scripts, synthetic broker/gateway/egress files, Stage A protocol source/tests, and the merged PR #46/#97/#99/#101/#103 descriptions and changed-file inventories.
- Static inspection only. No Docker/WSL/systemd command, target-host check, privileged experiment, provider credential access, network request, or runtime test was performed for this handoff.

### Existing reported evidence (not rerun here)

- PR #46's merged CI run `42482891023` reports all eight jobs passed for the isolated synthetic broker/fake provider and mock production path on its reviewed commit.
- R1-G5 evidence reports disposable Ubuntu 24.04 systemd install and synthetic mock execution passed on implementation SHA `a6f33442da291ac02ca8b47b6cb758bd50540c30`, CI run `41687576726`. This is not target WSL2 or production-host validation.
- PR #103 reports 11 pure protocol tests passed on its PR head. This is not gateway, transport, issuer, provider, network, or host-security evidence.
- PR #97 reports its read-only preflight/observation fixture checks on its PR head. The fixture does not enforce ingress and does not establish WSL2 provenance.

These are historical claims traced to repository documentation/PR descriptions. This branch must record its own exact-head CI separately after any code is changed; a documentation-only change cannot upgrade prior evidence to current target verification.

## Independent read-only reviews

| Review area | Finding |
|---|---|
| Container and Linux isolation | Confirmed mock container restrictions and disposable systemd evidence; current launcher retains rootful Docker group authority. Split-rootless engines and policy gateway are absent; target cgroups, sockets, egress, and WSL2 behavior are unverified. |
| Credential and authorization security | Confirmed authorizer separation, file-key checks, and pure Stage A contracts. Provider credentials, approved model identity, live tool-free enforcement, prompt binding, provider egress, provider cancellation, and production issuer/consume/replay controls remain absent or blocked. |
| Docker/WSL2 compatibility | Confirmed PR #97 only observes metadata/path tuples. ADR ingress provenance has no independent verdict. Rootless engine/cgroup/storage/networking/UID-map/lifecycle compatibility and required host/LAN path matrix remain untested; nested privileged DinD is rejected. |
| Recovery and failure handling | Confirmed mock orphan cleanup, systemd process restarts, and synthetic uncertain-outcome fencing. These do not prove a surviving kill authority; daemon/manager/WSL failure and startup interlock remain open. |

Reviews were read-only, scoped to source at `04e9b31`, and ran no privileged or target-host experiments. Their conclusions are implementation input, not owner/security approval.

## Required decisions and blockers

**Owner/security gates before any gateway or host experiment:**

1. Record exact-revision independent security reviews for ADR-0012/P0-R2.1/P0-R2.2 scopes as required by their documents; identify which review is Codex #1 and which is independent Claude #1. A review agent in this assignment is not a substitute.
2. Decide whether all unprivileged WSL-local clients are prohibited and approve an enforceable Windows-local ingress predicate or explicitly amend the locality requirement. No predicate is established now.
3. Authorize a named disposable Windows/WSL2 host and separate LAN probe, exact WSL/kernel/Engine/Compose modes, resource envelope, allowed experiments, evidence retention, stop criteria, external kill authority, and cleanup. Do not alter shared/global WSL configuration for this work.
4. Approve rootless service identities, subordinate ID maps, data roots, trust assumptions, secret-store contract, model/provider identity, and backup/RPO/RTO requirements. Decide whether host root and the launcher/gateway remain trusted principals.
5. Approve an independent persistent supervision/fencing design and startup interlock before any live runtime or provider credential is considered.

**Still blocked after those decisions:** implementation and review of the Runtime API Policy Gateway; proof that its UDS and Engine socket boundaries cannot be bypassed; default-deny provider egress and exact destination verification; actual resource-limit enforcement; target WSL2 startup/shutdown/daemon recovery; provider-specific entitlement/policy; authorized Codex credential custody; live identity, prompt/operation binding, tool-free dispatch, cancellation, output limits, audit provenance, and end-to-end failure recovery.

## Recommended next authorized step

The next step is **review-only feasibility disposition**, not gateway implementation: obtain the required independent reviews of the exact current ADR/P0-R2.1/P0-R2.2 revisions and record the owner's decision on the ingress threat model plus disposable-host authorization. If those reviewers and owner authorize a bounded compatibility experiment, run only the named credential-free WSL2 feasibility matrix in that disposable environment and record exact source commit, WSL/Windows/kernel/Engine versions, commands, observed paths, resource and kill limits, cleanup result, and reviewer verdict. Do not connect a provider or include credentials. Reconcile the result with the split-rootless candidate; only then scope a separately reviewed gateway design/implementation.

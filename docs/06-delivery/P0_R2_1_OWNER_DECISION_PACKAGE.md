# P0-R2.1 Owner Decision Package

**Source baseline:** `cc8e9b4ba1323c982a741c790fd0f7401130f2f6` (current remote `main`, verified 2026-11-18).
**Baseline review:** P0-R2.1 **CHANGES REQUIRED**. Earlier approvals apply only to their recorded commits; this documentation delta does not revise them.
**Current disposition:** Stage 1A–1C **ACCEPTED WITH EXCEPTIONS** as owner-reported; Phase 1 R1 **BLOCKED / NOT ACCEPTED**; Stages 2–4 **NOT AUTHORIZED**. Resource ownership is **UNKNOWN**. Execution remains disabled.

This package records conditional design direction and the decisions and evidence still required. It does not accept M-3, M-4, OB-0, a deployment, or any operational gate. No host, Docker, service, socket, account, credential, provider, or harness operation is authorized.

## Current design direction

- **Option B** is conditionally selected for further synthetic-only security design. The separate rootless Core Engine under OB-0 is design-only. This is not approval to create or start either Engine.
- **M-4** uses whole-Runtime-service termination as the conditional design. All active runs in that Runtime service share the stop blast radius. Actuator scope, lifecycle interlock, service registration, and enforcement remain unproven; M-4 is blocked.
- **M-3** prefers an independently administered managed conditional-append ledger. No custodian, account, service, key, outage policy, or recovery authority has been selected; M-3 is blocked.
- **Owner-to-Authorizer** uses AF_UNIX as the conditional design baseline. Peer identity, credential custody, cancellation semantics, and implementation remain open.
- **Windows-local ingress** remains blocked. No approved enforcement mechanism, WebAuthn RP ID, or origin is established.
- **Mission 9D** remains synthetic/inert. Authority provenance, first-instruction deadline enforcement, live Stage 1 ordering, and independent supervision are not accepted.

These selections supersede earlier design alternatives only for the stated conditional design direction. They do not turn historical reviews into approval of current `main`. See the [Option B security delta](./P0_R2_1_OPTION_B_SECURITY_DESIGN_DELTA.md) for contract boundaries and [restricted WSL2 acceptance gates](./RESTRICTED_WSL2_ACCEPTANCE_GATES.md) for future deployment evidence.

## Owner decision queue

| Gate | Recommended choice | Exact owner decision needed | Evidence that closes the gate |
| --- | --- | --- | --- |
| **Cancellation and key custody** | Define cancellation as `UNKNOWN` until independent whole-scope termination evidence is verified; keep admission fenced and never retry on timeout or lost acknowledgement. Keep provider credentials disabled. | Approve the state semantics; name the owner/custodian, storage and delivery method, rotation, revocation, recovery, and audit policy for each required channel/signing key. | Reviewed channel and peer-identity contract; key lifecycle and compromise/recovery review; exact-generation evidence that every process/helper in the Runtime service is absent. |
| **Windows-local ingress, RP ID, origin** | Keep owner-facing ingress absent until an enforceable Windows-side boundary is selected. Do not infer locality from loopback, TLS, Host, Origin, or forwarded headers. | Select the ingress enforcement mechanism or explicitly accept an authenticated-principal policy instead of locality; then specify the exact HTTPS origin, RP ID, certificate, and cookie policy. | Authorized IPv4/IPv6 positive Windows-local and negative LAN/WSL/container tests at the enforcement point; bypass/counter evidence; browser origin/RP-ID tests. |
| **M-3 independent anchor** | Prefer an independently administered conditional-append ledger; fail closed when freshness or availability is uncertain. | Name the independent custodian and approve signer/key custody, append/high-water semantics, outage behavior, restore/recovery procedure, and who can authorize recovery. | Evidence from outside the Core/Runtime rollback domain showing stale/replayed state is rejected, outage fails closed, and recovery requires the approved authority. Until then M-3 stays blocked. |
| **M-4 Actuator and manager interlock** | Retain whole-service stop as the synthetic-only design, with a fixed service scope and no automatic restart while termination is pending or unknown. | Approve the coarse all-runs blast radius and trusted system-manager/root assumptions; authorize a separately scoped feasibility experiment only after review. | Exact service/cgroup binding; descendant and helper coverage; Actuator cannot start, restart, reload, or replace the unit; manager interlock blocks lifecycle races; stop remains effective through Gateway/daemon/database outage; empty-scope proof precedes re-admission. |
| **Mission 9D authority provenance** | Keep live Stage 1 disabled; require a reviewed authority chain before any live integration. | Identify who may amend the Stage 1 contract and approve issuer, manifest/source provenance, signer, run/generation/deadline binding, and controller identity. | Verified source/manifest provenance and signer chain; approved contract amendment; independently reviewed deadline/first-instruction ordering, liveness linearization, and supervisor-loss behavior. |

## Integration and authorization boundary

The repository's restricted Compose profile is execution-disabled and does not implement the Option B Runtime Engine, independent terminator, external anchor, or Windows ingress enforcement. Static configuration checks and hosted CI can prove repository-level properties only; they do not establish target WSL2 identities, ownership, ingress, backup recovery, restart behavior, or runtime enforcement.

No Stage 2–4 work, provisioning, deployment, cleanup, startup, P0 harness build/install/execute, privileged operation, or real-provider access is authorized by this package. The next separately authorizable experiment is a bounded, disposable WSL2 acceptance exercise for the restricted execution-disabled profile, after an owner confirms exact resource ownership and ingress policy. It must not execute the P0 harness or enable providers.

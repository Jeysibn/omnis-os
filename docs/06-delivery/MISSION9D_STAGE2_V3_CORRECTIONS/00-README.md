# Omnis OS Mission 9D Stage 2 — Security Architecture Corrections

**Status: design proposal for direct security re-review.** This package authorizes no implementation, test execution, fixture release, or deployment.

## Baseline and immutable evidence

The original package at `/tmp/omnis-9d-stage2-design-fpd4p4uc/` was verified against its own `SHA256SUMS` before copying; it remains unchanged. Frozen references hash to:

- Stage 1 contract: `aa67d2d44bc0b807068b9e07f7e61f77bc0228d1359ac999b1a7e0df329c14ef`.
- Phase A authority manifest: `f9c6e5aacc13c79daf148e02483d4d454603ac5cf6f66ed3618959df9b18f123`.

The security baseline is reviewed main `32901cf553b6ec9dadc4338fa662615839002245` (PR #99 merged at `84f50d4f52e7e99cf8e5aeb32963f24dfe7182f2`; PR #97 merged at the baseline). Remote main has since advanced to `af5904abf70fd2ca4b87a5376c11950b54a519ac`, a child of the reviewed baseline with frontend planning changes. The local checkout is `3c0dbc04e440ca723c864c6287cdef36d656c4ff`; its untracked files were preserved. Security design conclusions remain scoped to 32901cf.

## Corrected architecture

Stage 1 remains sole owner of its journal and provides a read-only, lock-protected validation operation. A dedicated host-side authorization issuer verifies the owner's authenticated active session and issues a signed, exact-scope, expiring, boot/session-bound single-use authorization. A separately privileged release authority serializes authorization revocation and release consumption in one durable ledger. Stage 2 transmits one bounded message to a gated inert fixture bootstrap. No retry follows uncertain delivery.

The policy is strict: no application execution may begin at or after the original Stage 1 BOOTTIME deadline. Gate opening or message delivery is not execution. The required fence must atomically order the first application instruction against expiry and supervisor freeze. No such WSL2/Docker capability is established, so **RELEASE BLOCKED — DEADLINE FENCE NOT ESTABLISHED**.

A trusted manager-owned watchdog and independent finalizer must survive controller death. If system manager, WSL, or the last termination authority is unavailable, admission remains closed; transient systemd units alone do not prove survival. If supervision cannot be established: **RELEASE BLOCKED — SUPERVISION GUARANTEE UNAVAILABLE**.

The V2 Stage 1 liveness snapshot also races Stage 2 consumption: controller death after validation but before ledger commit cannot be excluded by PID/starttime or lock checks. Therefore **LIVE STAGE 1 INTEGRATION BLOCKED — LIVENESS ORDERING UNPROVEN**. A lease-style semantic change is proposed only as a separately reviewed Stage 1 contract amendment.

Stage 2A, if separately authorized, is limited to non-releasing schemas, durable ledger mechanics, synthetic state-machine tests, fake issuer/Stage 1 adapters, and disabled IPC. It excludes usable endpoints, real issuer/live Stage 1 integration, executable bootstrap, Docker/systemd integration, privileged WSL2 actions, and physical execution.

## Review package

Eight documents are retained. `02` is normative for authorization, IPC, and Stage 1 validation; `03` defines transitions; `04` defines containment; `06` is the per-test authorization matrix; `07` maps decisions, findings, and implementation gates. Other documents summarize rather than create competing protocol rules. `SHA256SUMS` covers all eight Markdown documents.

Review order: Codex #1 — Direct Security Re-review; then Separate Independent Read-Only Security Reviewer against these exact hashes; then owner decisions. No reviewers have approved this correction package yet.

No runtime code was changed, and no experiments, tests, dependency installation, service activation, fixture release, commit, push, CI, or deployment occurred. Only document checksum and consistency verification were performed.

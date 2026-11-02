# R1-G4 durable authorization foundation evidence

## Scope and disposition

- **Scope:** durable, fail-closed authorization and audit for the existing deterministic mock runtime only.
- **Original implementation base:** PR #5 reviewed head `64cd704a3463b8e0d283710a457cf4c2282631f7` on `security/restore-failure-containment`.
- **Updated main base:** PR #5 was squash-merged as `9c6281247de9a26a2944c630863ff5d2537416e9`; main CI passed in [run 41496554745](https://github.com/Jeysibn/omnis-os/actions/runs/41496554745). The feature branch is being rebased onto this main revision before publication and the final checks will be rerun.
- **Feature branch:** `security/r1g4-durable-authorization-audit`.
- **Dependency:** The work was initially developed against PR #5's reviewed head. PR #5 has now merged; this branch must be rebased onto the merge commit above and revalidated before independent review.
- **Provider status:** Hermes, Codex, Claude, all other model providers, and arbitrary tool execution remain disabled. No provider credentials were accessed.
- **Gate:** This work is not a declaration that R1-G4 is complete or real-runtime execution is authorized.

## Implementation

- Migration `0005_durable_authorization.sql` adds task-scoped, one-use mock authorizations and structured audit records. Database checks constrain the current policy to `owner`, `mock`, `execute_task`, and `mock.execute`.
- `omnis_authorizer` is a separate non-privileged login. Runtime cannot directly create, mutate, or delete authorization records; authorization consumption and active-run row locking use narrowly scoped, migrator-owned security-definer functions with pinned search paths and revoked PUBLIC execution.
- The owner-authenticated API derives the actor from its session and CSRF boundary. Caller-supplied actor/approval fields are not used. A private internal-token worker endpoint persists request, decision, and revocation.
- Run admission consumes the exact authorization in the same transaction as run/idempotency/queue admission. The worker rechecks durable authorization before execution claim and at lease/completion checkpoints. Revocation serializes against claim/completion through the authorization row lock; database lookup failure fails closed.
- Authorization and lifecycle audit entries contain identifiers, fixed capability, actor/effective identity, correlation ID, outcome, and reason code; they do not store credentials or prompts.
- Architecture details and limits are in [runtime authorization](../../02-architecture/RUNTIME_AUTHORIZATION.md) and [ADR-0009](../adr/0009-runtime-authorization-and-credential-boundaries.md). ADR-0010 remains Proposed.

## Security cases covered

The worker coordinator tests deny missing grants and fail closed when durable lookup is unavailable. PostgreSQL tests cover explicit approval, one successful concurrent decision, task-scope mismatch, runtime and authorizer DML/DDL denial, agent identity constraint rejection, one-run consumption, restart reconstruction from persisted state, audit persistence, revocation, expiry, and completion after revocation. Existing execution tests continue to cover mock task admission, lease ownership, stale generations, cancellation, and no unsafe replay.

## Verification record

Record exact results only after the final branch revision has been checked:

| Check | Result |
|---|---|
| Frozen install | `npm exec --yes --package=pnpm@12.16.1 -- pnpm install --frozen-lockfile` — passed; lockfile unchanged. |
| Formatting, ESLint, TypeScript, tests (`pnpm check`) | Passed against disposable PostgreSQL 17.6 with `OMNIS_SANDBOX_INTEGRATION=1`: format, ESLint, strict TypeScript, API 8, DB 25, worker 28, contracts 3, policy 4, runtime adapter 2, recovery/ACL/role unit tests 26; 0 failures, 0 skipped. The worker count includes 9 actual Docker sandbox tests. |
| PostgreSQL backup/restore integration | Passed twice against disposable PostgreSQL 17.6; latest run passed with `0006_authorization_revocation_lock_order.sql`, authorizer routine ACL verification, archive restore, and mock task/run post-restore checks. |
| Legacy upgrade | `pnpm integration:legacy-upgrade` passed from exact revision `708d0f5e9b6083da852e26c0643c60c0f5879f85`; preserved legacy task/run/event/idempotency/pg-boss state and ownership, upgraded migration checksums through `0006`, then restricted pg-boss/worker operations and new task/run creation succeeded. |
| PostgreSQL worker recovery / API authorization flow | `pnpm integration:recovery` passed against the disposable container with owner sign-in, request/approval/run, SSE/restart recovery, cancellation, sandbox crash cleanup, PostgreSQL outage recovery, and no duplicate execution. Final run after `0006` pending completion below. |
| Docker sandbox integration | Passed as part of final `pnpm check`: 9 actual-container tests, 0 failures, 0 skipped. Verified filesystem, credential, identity, resource, PID, CPU, memory, network, timeout, cancellation, and cleanup boundaries. |
| Production build | `npm exec --yes --package=pnpm@12.16.1 -- pnpm build` — passed. |
| GitHub Actions | Pending publication of the rebased branch. |

All database and container tests use disposable resources and synthetic records. PostgreSQL ran in a unique, loopback-only container `omnis-r1g4-authz-postgres` on port `55437`, pinned to the CI PostgreSQL 17.6 image digest and labeled for recovery-test control. Only that container was stopped/restarted. Existing MoniKey containers were inspected and left untouched; the disposable container and its volume were removed after final checks. No persistent user database or provider credential was used.

## Residual risks and approval gates

1. **High — real runtime remains unauthorized.** There is no trusted provider connector, brokered credential storage, supported provider authentication/policy approval, or connector egress policy.
2. **Medium — identity is single-owner.** The principal is derived from the existing local owner session; independent approver identities, delegated approval, and a multi-user identity provider are not implemented.
3. **Medium — audit integrity is bounded.** Normal runtime SQL cannot update/delete historical rows, but the trusted DB administrator can alter them and runtime can append rows. There is no cryptographic immutability or external anchoring.
4. **Medium — revocation is checkpoint-based.** Revocation takes effect at transaction commit and is serialized with claim/completion. It cannot undo an operation completed before that commit or interrupt an external side effect already in progress. The current mock has no external side effects.
5. **Low — expiry is derived.** PostgreSQL timestamp controls authorization; the `expired` status is derived on reads and audit is emitted when the authorizer store reads the expired row, rather than by a background expiry job.
6. **Medium — database administrator remains trusted.** Migration ownership, security-definer routines, and audit table integrity depend on the trusted PostgreSQL administrator/migrator boundary.
7. **Verification dependency.** The implementation was initially tested on PR #5's reviewed head. Rebase onto its squash merge `9c6281247de9a26a2944c630863ff5d2537416e9` and rerun applicable checks before treating branch CI as final.

## R1-G4 readiness

This foundation supports only explicit, one-run authorization for the existing synthetic mock. Before even restricted model-only execution, separately approve durable human approval policy, trusted connector identity and provenance, credential broker and revocation, provider-supported authentication/policy, bounded network egress, per-provider-operation authorization, effective in-run revocation, and trusted-connector canary checks. General-purpose tool execution and shell access remain prohibited.

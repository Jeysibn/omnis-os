# R1-G4 PostgreSQL timeout and role-setting hardening

## Scope and disposition

This evidence covers PR #9 findings G4-16 through G4-18. The work starts from PR #8's squash merge `aa75a1abac69852645695aac7e9d3ddf925ffe8a`; its `main` CI run `41628616047` succeeded.

| Finding                                                    | Disposition                              | Evidence and limit                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G4-16 — Runtime-controlled revocation/admission contention | **Partially fixed; remains open**        | Runtime and authorizer role defaults now bound normal application statements, transaction lock waits, and idle open transactions. The runtime can override its own session settings and can still retain direct database locks, so repeated bounded failures remain possible. This is not runtime-independent availability. |
| G4-17 — Heartbeat has no explicit lock timeout             | **Fixed for the heartbeat renewal path** | `renewLease` uses transaction-local `lock_timeout=3s` before run→grant locks. A `55P03` rolls back and returns a failed renewal. Real PostgreSQL tests covered both locks, unchanged lease expiry, current-owner retry, stale-owner fencing, and both heartbeat/revocation orderings.                                       |
| G4-18 — API and contention regression coverage             | **Fixed for the covered endpoints**      | The legacy-upgrade integration calls the actual worker API under real PostgreSQL contention, checks bounded `503 authorization_busy` and `503 admission_busy`, verifies no false state/audit/idempotency commit, then verifies retry success.                                                                               |

No migration was needed. Timeout defaults are version-controlled in role provisioning. ADR-0010 remains Proposed. Real provider execution remains disabled.

## Timeout policy

| Role                           |   `lock_timeout` | `statement_timeout` | `idle_in_transaction_session_timeout` | `idle_session_timeout` |
| ------------------------------ | ---------------: | ------------------: | ------------------------------------: | ---------------------- |
| `omnis_runtime`                |               3s |                 20s |                                   20s | unset                  |
| `omnis_authorizer`             |               3s |                 15s |                                   20s | unset                  |
| `omnis_migrator`               |      unset/reset |         unset/reset |                           unset/reset | unset/reset            |
| `omnis` administrator/recovery | operator-managed |    operator-managed |                      operator-managed | operator-managed       |

The three-second lock bound is consistent with admission and revocation transaction bounds and is below the worker's five-second heartbeat interval. The worker lease is thirty seconds. Runtime application SQL is short; its statement and abandoned-transaction defaults are twenty seconds. Authorizer transactions are limited to small authorization and audit operations, so their statement default is fifteen seconds. Migration and recovery operations retain headroom rather than inheriting application-role limits.

`idle_session_timeout` is deliberately not set on pooled application roles. Unexpected backend termination can churn pools, and an idle-session timeout would only clean up an abandoned idle session after a delay. It does not stop an active or periodically used malicious session. The idle-in-transaction timeout does release locks by terminating a backend abandoned inside a transaction. It does not affect a session-level advisory lock held outside a transaction.

These are defaults, not an immutable boundary. The real runtime role successfully executed `SET lock_timeout = '0'` in a disposable PostgreSQL session. PostgreSQL applies role defaults at login; session settings can override them, and role/database settings have precedence. Provisioning is idempotent and rejects applicable database-specific timeout overrides for the constrained Omnis roles across the cluster. The role-integrity query reads `pg_db_role_setting`, checks role-wide defaults, and rejects relevant database-specific overrides for constrained application roles. The integration test opens fresh runtime and authorizer pools and checks their effective `current_setting` values. Existing pools must reconnect after provisioning to receive changed defaults.

## Heartbeat and contention semantics

Heartbeat retains the existing `run row → authorization grant → lease update` order. It applies `SET LOCAL lock_timeout = '3s'` inside the transaction before acquiring either row lock. If run, grant, or update locking times out with SQLSTATE `55P03`, the transaction helper rolls back before the store returns `false`. The caller never treats that as renewed ownership. The worker stops the mock sandbox and enters the established claim-loss/interruption path; it does not replay the run automatically. A transient timeout may therefore interrupt an otherwise valid run. Other PostgreSQL errors still propagate through the persistence-failure path.

The test suite observed both run-row and grant-row lock waits through `pg_stat_activity`; each heartbeat returned false in the bounded interval and `lease_expires_at` stayed unchanged. The same connection pool remained usable after rollback. After the holder released the lock, the current generation renewed successfully and a stale owner remained rejected. One test gates revocation so revocation commits before the waiting heartbeat; another commits a heartbeat first, then revokes, and confirms no renewal succeeds afterward.

The actual worker API returned `503 authorization_busy` while a runtime session held an unconsumed grant row, and `503 admission_busy` while a runtime session held the public admission advisory key. The responses completed under five seconds. A failed revocation left the grant authorized and emitted no revoke audit. Failed admission consumed no grant and committed no run or idempotency row. Both retries succeeded after the blockers were released. These are bounded failures, not successful revocations or admissions.

## PostgreSQL and resource evidence

- PostgreSQL: pinned `postgres:17.6-alpine` disposable container; loopback-only port `15449`; synthetic credentials; unique `omnis-pr9-pg` container with milestone labels.
- Docker access: the shell lacked the supplementary `docker` group, but `sg docker` used existing group membership successfully. No membership, socket permissions, daemon settings, or WSL settings changed.
- Only the milestone-owned disposable container and its synthetic database were used. Unrelated MoniKey containers were observed but not modified.
- The idle-transaction test set a short session-local timeout, left a transaction holding an advisory transaction lock idle, observed PostgreSQL terminate the backend, and verified the Node pool replaced it. A separate idle session-level advisory-lock probe confirmed the lock remains held when `idle_session_timeout=0`.

## Verification results

All results below were observed locally on the PR #9 working tree using synthetic data:

| Check                                                                                                                   | Result                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Frozen dependency install (`npm exec --yes --package=pnpm@12.16.1 -- pnpm install --frozen-lockfile`)                   | Passed                                                                                                                   |
| `npm exec --yes --package=pnpm@12.16.1 -- pnpm check` with disposable PostgreSQL and Docker sandbox integration enabled | Passed: format, ESLint, TypeScript, and 119 tests; 0 failures, 0 skips                                                   |
| PostgreSQL database-store/authz suite                                                                                   | 43 passed, including role settings, heartbeat lock contention, revocation ordering, and pool recovery                    |
| Worker and actual Docker sandbox tests                                                                                  | 29 passed; actual sandbox resource/filesystem/process/network tests ran                                                  |
| Restore/ACL/role policy tests                                                                                           | 30 passed, including timeout defaults and unsafe database override rejection                                             |
| `npm exec --yes --package=pnpm@12.16.1 -- pnpm build`                                                                   | Passed                                                                                                                   |
| `npm exec --yes --package=pnpm@12.16.1 -- pnpm integration:legacy-upgrade`                                              | Passed from original R1 baseline; role provisioning, migration, worker, API 503/retry and legacy-run checks passed       |
| `npm exec --yes --package=pnpm@12.16.1 -- pnpm integration:recovery`                                                    | Passed: durable lifecycle, API/SSE, abrupt worker recovery, sandbox cleanup, and no duplicate execution                  |
| `npm exec --yes --package=pnpm@12.16.1 -- pnpm integration:backup-restore`                                              | Passed: real custom-format backup/restore, ACL/role verification, record and sequence checks, post-restore mock task/run |

The first combined integration shell invocation scoped environment variables to only its first command; recovery then correctly refused to run without its disposable database URL. Recovery and backup/restore were rerun with the required variables passed to each command and passed. This was a command-environment issue, not a code/test failure.

GitHub Actions run [41632671390](https://github.com/Jeysibn/omnis-os/actions/runs/41632671390) passed on implementation SHA `3d18498c4808a37ba5e1f93dc90c3093d0ee2ea7`. It executed frozen installation, restricted-role provisioning, `pnpm check`, production build, legacy upgrade, recovery, and disposable backup/restore. A documentation-only follow-up records this run; CI was rerun on that final PR head before closeout.

## Remaining security limits

1. G4-16 remains partially addressed. A credential holder with `omnis_runtime` can issue `SET` in its own session and repeatedly contend on locks. Timeouts bound cooperative Omnis calls and can clean abandoned transactions; they do not guarantee owner revocation or admission progress.
2. `idle_session_timeout` is unset, so an idle session-level advisory lock can persist. Applying a pool-wide idle-session cutoff was rejected because it can terminate healthy pooled connections and is overrideable by the runtime role.
3. Role defaults affect new sessions only. Existing pools require connection recycling after provisioning.
4. G4-3 remains a blocker for a stronger trust boundary: authorizer and runtime credentials are still present in the same worker process. A separate authorizer process, distinct secret delivery, and independent approval/revocation channel remain required before any real provider operation.
5. N-8 lifecycle-column protections and all provider/connector authorization gates remain separate work. No external provider, credential, arbitrary tool, or unrestricted network path is enabled.

PostgreSQL references: [client connection defaults](https://www.postgresql.org/docs/17/runtime-config-client.html), [`ALTER ROLE`](https://www.postgresql.org/docs/17/sql-alterrole.html), and [`pg_db_role_setting`](https://www.postgresql.org/docs/17/catalog-pg-db-role-setting.html).

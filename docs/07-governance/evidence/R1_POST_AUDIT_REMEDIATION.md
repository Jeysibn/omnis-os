# R1 Post-Audit Security Remediation Evidence

- **Review date:** 2026-11-02
- **Audited base revision:** `708d0f5e9b6083da852e26c0643c60c0f5879f85`
- **Working branch:** `security/post-audit-remediation`
- **Scope:** remediation of confirmed audit hypotheses and safe mock-only runtime foundations.
- **Data:** synthetic test fixtures only; no provider inference or provider credentials used.

## Executive result

The audit’s workspace, SSE, authentication, sandbox-test, migration, database-role, lease-fencing, and backup findings were confirmed in the current source. Their fixes were exercised against disposable PostgreSQL 17.6 and the local Docker daemon. The worker now connects only as `omnis_runtime`; a separate one-shot migration command uses `omnis_migrator`, and the database administrator credential is kept in a separate local environment file. pg-boss migrations and queue operations were verified with those roles.

Fresh migration, upgrade from the prior checksum-less R1 ledger, repeat/concurrent migration, checksum drift rejection, runtime privilege denial, two-worker claim fencing, recovery, backup rejection for queued work, backup/restore, actual sandbox namespace/security checks, synthetic canary sinks, and Firefox browser smoke all passed locally. `pnpm check`, production build, and frozen installation passed on the final implementation tree. GitHub Actions has **not yet been verified** on this branch; until remote CI passes, the milestone gate remains **Conditional**, not Passed. No real AI runtime is authorized or enabled.

## Audit finding disposition

| Finding | Independent disposition | Evidence and remaining limitation |
|---|---|---|
| M-1 workspace cleanup scope | **Confirmed; fixed and locally verified** | Workspace roots and cleanup are scoped by validated environment identity. Unit regression covers same run ID in two scopes, active leases, expired directories, malformed names, and symlink escape. Actual Docker sandbox runs passed mount and cleanup checks; the identical-run cross-scope deletion case itself is a deterministic filesystem test. |
| M-2 SSE replay/live ordering | **Confirmed; fixed and locally verified** | Deterministic stream tests cover publication during blocked replay, out-of-order notification, terminal ordering, and `Last-Event-ID` reconstruction. PostgreSQL-backed API smoke verifies contiguous live cancellation events and contiguous replay after reconnect. |
| M-3 anonymous session growth | **Confirmed; fixed and locally verified** | Unit tests cover route opt-out, capacity, expiry, and preservation of authenticated sessions. Full API tests passed. |
| M-4 password verification abuse | **Confirmed; fixed and locally verified** | Unit tests cover backoff and global derivation caps. API and Firefox browser smoke observed five invalid `401`s, then `429` with `Retry-After: 1`; a valid password also received `429` while blocked, and sign-in succeeded after the window. Client identity uses socket-derived IP with forwarded proxy trust disabled. |
| Sandbox negative-test false confidence | **Confirmed; mitigated and locally verified** | Controlled fixtures fail for extra bind mounts and exposed synthetic secrets. Actual Docker tests passed image digest, mount namespace, Docker-init mount, network, environment, workspace, seccomp, capabilities, CPU, memory, PID, timeout, cancellation, and output checks. Canary was absent from sandbox environment, host-only credential file access, stdout, and stderr. This is not arbitrary-code production isolation. |
| M-6 runtime self-authorization | **Confirmed; mock-only foundation verified** | Omnis-owned policy is checked at admission and claim; tests cover missing, revoked, expired, and insufficient grants plus adapter self-attestation. Only synthetic mock activity is admitted. Policy state remains process-local; durable approval/audit is still required for future real runtimes. |
| L-4 ordered migrations | **Confirmed; framework verified on PostgreSQL 17.6** | Fresh install, prior checksum-less R1 ledger upgrade with row preservation, repeat execution, concurrent migration lock, and modified historical checksum rejection passed. |
| M-5 database least privilege | **Confirmed; fixed and locally verified** | Separate admin, migration, and runtime identities are configured. `omnis_migrator` is non-superuser/non-createdb/non-createrole, owns the Omnis and pg-boss schemas, and has database `CREATE` only to support schema creation during migrations. `omnis_runtime` has no DDL or superuser powers and only required DML/sequence privileges. Runtime DDL and `pg_reload_conf()` were denied; task admission, pg-boss operations, migration, backup, and restore passed. |
| L-1 lease fencing | **Confirmed; fixed and database verified** | Two database connections raced for one run; exactly one claim succeeded. After ownership/generation changed, stale completion, failure, heartbeat, output, and cancellation attempts were rejected. Delayed completion/failure after cancellation also failed. Expired heartbeat and no-replay recovery passed. |
| M-7 in-flight backup safety | **Confirmed; fixed and locally verified** | Real snapshot backup succeeded for settled data and rejected a queued run without leaving an archive or manifest. Restore preserved task/run/event/idempotency fingerprints and event sequence invariants; runtime-role insert and sequence access passed in a rollback-only probe. The backup hash is not authentication or encryption. |

## Implementation details

- Workspace directories now use `<base>/<scope-id>/<private-temp-dir>`. Container cleanup remains label-filtered by the same scope and still consults PostgreSQL active leases.
- Worker SSE uses a serialized database drain loop. Database event rows remain the sole event authority; no second event store was introduced.
- `LocalSessionStore` avoids creation on protected routes and enforces expiry cleanup and a configured maximum of 1,024 entries. Capacity pressure evicts anonymous entries before authenticated owner sessions.
- `AuthThrottle` applies a threshold of five failures per socket client, exponential blocks capped at five minutes, at most 2,048 client entries, and four concurrent password verifications.
- Runtime authorization is defined in `packages/policy`; the worker's only built-in authorization is a local mock-only owner grant. PostgreSQL `runtime_kind = 'mock'` and `synthetic IS TRUE` constraints are unchanged.
- Migration checksums were added to the migration ledger while preserving existing rows. Migration SQL remains in ordered files under `packages/db/migrations`.
- `omnis` remains the database administrator. `pnpm db:roles` provisions `omnis_migrator` and `omnis_runtime`; `pnpm db:migrate` applies application and pg-boss migrations as the migrator. The worker fails closed unless its configured URL uses `omnis_runtime`, and starts pg-boss with schema migration disabled. New local setup keeps API, worker, migrator, and database-admin environment values in separate private files.
- Restore runs `pg_restore` under `omnis_migrator`, reapplies runtime grants/default privileges, and verifies a rollback-only runtime insert that consumes a task sequence value.
- Lease owner and generation checks were added to all worker-owned run transitions. Queue terminal reconciliation remains separate because it is not an execution-worker finalization.
- Backup creation now refuses snapshots incompatible with the existing safe-restore rule.
- ADR-0009 documents future connector, authorization, tool, workspace, and audit boundaries. Provider credentials must stay in a trusted connector/broker and never enter tool sandboxes.

## Verification performed

| Check | Result |
|---|---|
| Environment | WSL Linux, Node `v24.22.1`, pnpm `12.16.1`, Docker Engine `29.9.2`; PostgreSQL `17.6-alpine`, CI-pinned digest. The shell lacked the `docker` supplementary group; existing membership worked through `sg docker`. No group, socket, daemon, WSL, or MoniKey changes were made. |
| Disposable infrastructure | Unique Compose project `omnis-r1-verify-771cecb6e4`, loopback port `37385`, project-scoped disposable volume/network, label `com.omnis.os.r1g3-disposable=true`. Database was healthy before tests; all project resources were removed afterward. |
| Frozen installation | `npm exec --yes --package=pnpm@12.16.1 -- pnpm install --frozen-lockfile` — **passed**, lockfile unchanged. |
| `pnpm check` | **Passed** with PostgreSQL variables loaded and `OMNIS_SANDBOX_INTEGRATION=1`: formatting, ESLint, strict TypeScript, workspace tests, 16 PostgreSQL tests, 27 worker tests, 8 API tests, and 9 actual-container/security fixture tests. No tests were skipped. |
| `pnpm build` | **Passed** across workspace packages; Vite production bundle built. |
| PostgreSQL roles/migrations | Provisioning and migrations succeeded as restricted identities. Fresh install, repeat, concurrent migration lock, checksum drift rejection, legacy checksum-less R1 ledger upgrade, and preserved task row passed. Runtime DDL and `pg_reload_conf()` were rejected; task admission and pg-boss queue operations passed. |
| PostgreSQL lease/SSE | Two DB connections raced for one run; one claim won. Stale completion/failure/heartbeat/output/cancellation and post-cancel finalization were rejected. API smoke verified contiguous live events and `Last-Event-ID` replay; deterministic tests covered publish-during-replay, out-of-order wakeup, and terminal order. |
| Docker sandbox | `pnpm --filter @omnis/worker test:sandbox` and Docker-enabled `pnpm check` passed. Verified image digest, `/workspace` bind, runtime-managed `/sbin/docker-init`, no Docker socket, no extra mounts/env, network `none`, read-only root, seccomp, dropped caps, non-root container UID, resource limits, timeout/cancel, and cleanup. |
| Synthetic canary | Unique dummy value was injected only into the worker process and a host-only fixture file. It was absent from sandbox env, host-only file access, stdout/stderr, API response, SSE frames, PostgreSQL task/run/event/idempotency records, API logs, and worker logs. No OAuth/provider credentials were used. |
| Mock lifecycle/recovery | `integration:mock` and final `integration:recovery` passed with restricted runtime credentials. Covered API/worker restarts, abrupt worker kill, sandbox crash cleanup, PostgreSQL stop/start of the labeled disposable container, and no unsafe replay. |
| Backup/restore | Safe snapshot backup passed. A real backup rejected a queued run and left no archive/manifest. Restore to `omnis_restore_verify2` preserved record fingerprints and event sequences; restricted-role insert/sequence access passed in a rollback-only probe. Disposable artifacts were deleted. |
| Browser smoke | Firefox 156.0 via Playwright CLI: owner sign-in, login throttling, task creation, completed mock run/SSE trail, cancellation, reload/reconnect. At 390px and 1440px, document width matched viewport; zero browser console errors. |
| GitHub Actions | **Pending** branch push/workflow run. CI now triggers on `security/post-audit-remediation`; no repository settings or main-branch changes were made. |
| Independent Claude review | Not run. No external Claude process, model inference, or provider credentials were used. |

## Remaining risks and unverified controls

1. **Remote CI:** local checks passed, but the remediation branch still needs a passing GitHub Actions run for the verified SHA. Until then, the overall gate is conditional.
2. **Sandbox isolation:** WSL uses rootful Docker with the worker's host UID and no demonstrated disk quota or separate user namespace. These tests do not establish production-grade arbitrary-code isolation. General-purpose agent tools remain prohibited.
3. **Worker supervision:** the worker can exit during PostgreSQL outages. Recovery was verified after a controlled restart, but no persistent service supervisor/restart policy was added; avoid restart storms and unsafe replay.
4. **Backup protection:** manifests detect archive changes but do not authenticate archives. Scripts do not encrypt them. Approve key management, off-host retention, and recovery objectives before storing real data off-host.
5. **API protections:** bounded pagination/query limits, SSE subscriber limits/backpressure, HTTPS cookie deployment, host allowlisting, and append-only actor attribution remain open before any non-loopback exposure.
6. **Repository controls:** prior read-only GitHub API review on 2026-11-02 found `main` unprotected and no rulesets; Actions allow all actions; secret scanning and push protection are enabled; Dependabot security updates and non-provider pattern scanning are disabled. No settings were changed and plan-level eligibility was not established.
7. **Future runtime policy:** durable authorization, approvals, append-only audit, provider-policy review, connector credential revocation, egress policy, and per-run authorization remain mandatory. No Hermes, Codex, or Claude inference is enabled.

## Readiness recommendation

**Local remediation verification: conditional on remote CI.** PostgreSQL, Docker, backup/restore, worker recovery, canary, and browser checks passed in the disposable local environment. Mark the milestone Passed only after GitHub Actions passes on the exact remediation branch SHA and the evidence includes its run URL. **R1-G4 is not ready.** Any future runtime additionally requires durable authorization/audit, stronger isolation and egress controls, a trusted credential broker, provider-policy approval, and explicit owner authorization. This document grants no authorization to run models.

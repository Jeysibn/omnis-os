# R1 Post-Audit Security Remediation Evidence

- **Review date:** 2026-11-02
- **Audited base revision:** `708d0f5e9b6083da852e26c0643c60c0f5879f85`
- **Working branch:** `security/post-audit-remediation`
- **Verified implementation revision:** `0d92af6d98d5dca8dc4210d5569a5b4d4d992bd9`
- **Scope:** remediation of confirmed audit hypotheses and safe mock-only runtime foundations.
- **Data:** synthetic test fixtures only; no provider inference or provider credentials used.

## Executive result

The audit’s workspace, SSE, authentication, sandbox-test, migration, database-role, lease-fencing, and backup findings were confirmed in the current source. Their fixes were exercised against disposable PostgreSQL 17.6 and the local Docker daemon. The worker now connects only as `omnis_runtime`; a separate one-shot migration command uses `omnis_migrator`, and the database administrator credential is kept in a separate local environment file. pg-boss migrations and queue operations were verified with those roles.

Fresh migration, upgrade from the prior checksum-less R1 ledger, repeat/concurrent migration, checksum drift rejection, runtime privilege denial, two-worker claim fencing, recovery, backup rejection for queued work, backup/restore, actual sandbox namespace/security checks, synthetic canary sinks, and Firefox browser smoke all passed locally. `pnpm check`, production build, and frozen installation passed. GitHub Actions passed for the verified implementation revision; the milestone gate is **Passed for mock-only remediation verification**. No real AI runtime is authorized or enabled.

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
| GitHub Actions | **Passed** on `0d92af6d98d5dca8dc4210d5569a5b4d4d992bd9`: [run 41452709617](https://github.com/Jeysibn/omnis-os/actions/runs/41452709617). Frozen install, restricted-role provisioning, `pnpm check`, production build, and PostgreSQL recovery integration all passed. No repository settings or main-branch changes were made. |
| Independent Claude review | Not run. No external Claude process, model inference, or provider credentials were used. |

## Remaining risks and unverified controls

1. **Sandbox isolation:** WSL uses rootful Docker with the worker's host UID and no demonstrated disk quota or separate user namespace. These tests do not establish production-grade arbitrary-code isolation. General-purpose agent tools remain prohibited.
2. **Worker supervision:** the worker can exit during PostgreSQL outages. Recovery was verified after a controlled restart, but no persistent service supervisor/restart policy was added; avoid restart storms and unsafe replay.
3. **Backup protection:** manifests detect archive changes but do not authenticate archives. Scripts do not encrypt them. Approve key management, off-host retention, and recovery objectives before storing real data off-host.
4. **API protections:** bounded pagination/query limits, SSE subscriber limits/backpressure, HTTPS cookie deployment, host allowlisting, and append-only actor attribution remain open before any non-loopback exposure.
5. **Repository controls:** prior read-only GitHub API review on 2026-11-02 found `main` unprotected and no rulesets; Actions allow all actions; secret scanning and push protection are enabled; Dependabot security updates and non-provider pattern scanning are disabled. No settings were changed and plan-level eligibility was not established.
6. **Future runtime policy:** durable authorization, approvals, append-only audit, provider-policy review, connector credential revocation, egress policy, and per-run authorization remain mandatory. No Hermes, Codex, or Claude inference is enabled.

## Readiness recommendation

**Post-audit remediation verification: Passed for the mock-only implementation at `0d92af6d98d5dca8dc4210d5569a5b4d4d992bd9`.** Local PostgreSQL, Docker, backup/restore, worker recovery, canary, browser, build, and test checks passed; GitHub Actions passed on that implementation revision. **R1-G4 is not ready.** Any future runtime additionally requires durable authorization/audit, stronger isolation and egress controls, a trusted credential broker, provider-policy approval, and explicit owner authorization. This document grants no authorization to run models.

## Database integrity hardening follow-up — 2026-11-02

- **Review base:** `9d50ad1b830a8468a8dd639c069bced8de84cb3a` on `security/post-audit-remediation`.
- **Scope:** Claude Code follow-up items N-2 (runtime grants), N-3 (legacy upgrade), and M-7 (ID sequence integrity).
- **Verification data:** synthetic records and disposable PostgreSQL 17.6 only. No provider credentials or inference were used.

### Findings and implementation

| Finding | Disposition | Evidence |
|---|---|---|
| N-2 runtime database grants | **Confirmed; fixed and database verified** | New `0003_runtime_privileges.sql` removes broad application-table grants. Runtime receives `SELECT`, task insert columns `(id,title,detail)` and status-only task updates; run inserts are limited to `(id,task_id,task_title)` with mock/synthetic/status/usage defaults; run updates are limited to lifecycle fields; event inserts omit source/synthetic metadata and have no update/delete; idempotency has select/insert only; migration history has no runtime access; application sequences cannot be advanced with `setval`. Negative statements failed with PostgreSQL permission errors while task admission, event append, cancellation, worker execution, and pg-boss operations passed. Administrative, migration, and runtime identities remained distinct. |
| N-3 pre-role-separation upgrade | **Confirmed; fixed and verified from legacy source** | `tests/integration/legacy-upgrade.mjs` created a disposable database and worktree at `708d0f5e9b6083da852e26c0643c60c0f5879f85`, populated synthetic task/run/event/idempotency/pg-boss records, then ran current provisioning and migrations. Data fingerprints and migration checksums were preserved; relations, sequences, user-defined types, and routines were owned by `omnis_migrator`; the restricted worker completed the legacy queued run and a new post-upgrade run. The drill cleans its own database/worktree. |
| M-7 restored ID sequence integrity | **Confirmed; fixed and database verified** | Backup metrics now compare each sequence's next value (respecting `is_called` and increment) with the maximum numeric task/run ID, including empty tables, never-called sequences, malformed IDs, and stale task and run states. A real backup rejected a deliberately stale task sequence with a collision-specific error and produced no backup artifact. The safe retry restored to `omnis_restore_final_n2`; 9 tasks, 9 runs, 33 events, and 9 idempotency rows plus fingerprints/event ordering matched. Both rollback-only runtime task and run INSERTs, sequence reads, and post-restore application grants passed; resulting next IDs exceeded restored maxima. |

### Verification for this follow-up

| Check | Result |
|---|---|
| Frozen install | `npm exec --yes --package=pnpm@12.16.1 -- pnpm install --frozen-lockfile` — passed; lockfile unchanged. |
| Formatting, ESLint, TypeScript, tests | `pnpm check` — passed: formatting, ESLint, all workspace TypeScript checks, and 68 tests (3 contracts, 8 API, 19 PostgreSQL, 4 policy, 2 runtime-adapter, 27 worker including actual-container/security cases, 5 backup metrics). No tests were skipped. |
| Production build | `pnpm build` — passed. |
| Mock lifecycle and recovery | `pnpm integration:mock` and `pnpm integration:recovery` — passed with restricted runtime credentials and actual Docker sandbox execution. |
| Legacy upgrade | `pnpm integration:legacy-upgrade` — passed from the exact original revision above, including pg-boss and restricted worker execution. |
| Backup and restore | Real PostgreSQL backup rejected the intentionally stale task sequence. Valid backup and restore then passed into `omnis_restore_final_n2`; runtime task/run insert and sequence checks passed. The unsafe in-flight rejection remains covered by existing recovery integration and metrics tests. |
| Browser | No frontend or API contract changed in this follow-up. Existing Firefox owner sign-in, throttling, mock execution, cancellation, SSE reload/reconnect, and responsive checks remain recorded above; database integration reran the affected task/run HTTP path. |
| GitHub Actions | Pending for the final follow-up commit. The prior run URL above verifies only the earlier revision and does not cover this follow-up. |

The disposable PostgreSQL container was `omnis-db-integrity-20261102-postgres-1`, bound to loopback port `37441`, with a dedicated test volume/network. No unrelated containers or services were changed. The current WSL shell lacked the Docker supplementary group; `sg docker` used existing group membership. No socket, group, daemon, or WSL configuration was modified. Temporary credentials were synthetic, process-scoped or held in mode-0600 files under `/tmp`, and are not committed.

### Remaining requirements and gate

This closes N-2, N-3, and M-7 for the locally tested mock-only foundation. SQL grants constrain ordinary runtime access but do not provide a tamper-proof, actor-attributed audit system. The dump hash and count manifest detect accidental mismatch only: **backup encryption and manifest/archive authentication remain separate open requirements** pending an approved key-management design. Active-run backups remain rejected; operators must quiesce work and confirm settled/lease-free state before backup. A restore is proved using synthetic data and a rollback-only runtime insert probe, not a live production restore.

No provider adapter or inference was enabled. R1-G4 still requires durable runtime authorization, owner approval, persistent actor-attributed audit, trusted credential broker, effective in-run revocation, approved provider policies/authentication, connector egress restrictions, and trusted-connector canary verification. Rootful Docker/same-host UID, disk quota, and production-grade arbitrary-code isolation remain unverified and general-purpose tools remain prohibited.

**Local follow-up result: Passed for N-2/N-3/M-7 on the tested working tree; final milestone/release gate remains conditional on a clean final revision, passing remote GitHub Actions, and the review PR. This is not authorization for real AI execution.**

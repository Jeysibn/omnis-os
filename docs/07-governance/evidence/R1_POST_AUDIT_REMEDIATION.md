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
- Restore runs `pg_restore` under `omnis_migrator`, reapplies runtime grants/default privileges, verifies restored fingerprints before a post-restore probe, then commits a synthetic task and completed mock run under `omnis_runtime` and checks sequence safety again.
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
- **Implementation revision:** `900da0c0cb38978d712312a27b5accd09074753d`.
- **Scope:** Claude Code follow-up items N-2 (runtime grants), N-3 (legacy upgrade), and M-7 (ID sequence integrity).
- **Verification data:** synthetic records and disposable PostgreSQL 17.6 only. No provider credentials or inference were used.

### Findings and implementation

| Finding | Disposition | Evidence |
|---|---|---|
| N-2 runtime database grants | **Confirmed; fixed and database verified** | New `0003_runtime_privileges.sql` removes broad application-table grants. Runtime receives `SELECT`, task insert columns `(id,title,detail)` and status-only task updates; run inserts are limited to `(id,task_id,task_title)` with mock/synthetic/status/usage defaults; run updates are limited to lifecycle fields; event inserts omit source/synthetic metadata and have no update/delete; idempotency has select/insert only; migration history has no runtime access; application sequences cannot be advanced with `setval`. Negative statements failed with PostgreSQL permission errors while task admission, event append, cancellation, worker execution, and pg-boss operations passed. Administrative, migration, and runtime identities remained distinct. |
| N-3 pre-role-separation upgrade | **Confirmed; fixed and verified from legacy source** | `tests/integration/legacy-upgrade.mjs` created a disposable database and worktree at `708d0f5e9b6083da852e26c0643c60c0f5879f85`, populated synthetic task/run/event/idempotency/pg-boss records, then ran current provisioning and migrations. Data fingerprints and migration checksums were preserved; relations, sequences, user-defined types, and routines were owned by `omnis_migrator`; the restricted worker completed the legacy queued run and a new post-upgrade run. The drill cleans its own database/worktree. |
| M-7 restored ID sequence integrity | **Confirmed; fixed and database verified** | Backup metrics now compare each sequence's next value (respecting `is_called` and increment) with the maximum numeric task/run ID, including empty tables, never-called sequences, malformed IDs, and stale task and run states. A real backup rejected a deliberately stale task sequence with a collision-specific error and produced no backup artifact. The safe retry restored to `omnis_restore_postprobe`; the original 3 tasks, 3 runs, 11 events, and 3 idempotency rows plus fingerprints/event ordering matched before probing. `omnis_runtime` then durably created task `task-0004` and completed mock run `run-0004`; the post-insert metrics confirmed both sequence next values exceeded restored and newly issued maxima. |

### Verification for this follow-up

| Check | Result |
|---|---|
| Frozen install | `npm exec --yes --package=pnpm@12.16.1 -- pnpm install --frozen-lockfile` — passed; lockfile unchanged. |
| Formatting, ESLint, TypeScript, tests | `pnpm check` — passed: formatting, ESLint, all workspace TypeScript checks, and 68 tests (3 contracts, 8 API, 19 PostgreSQL, 4 policy, 2 runtime-adapter, 27 worker including actual-container/security cases, 5 backup metrics). No tests were skipped. |
| Production build | `pnpm build` — passed. |
| Mock lifecycle and recovery | `pnpm integration:mock` and `pnpm integration:recovery` — passed with restricted runtime credentials and actual Docker sandbox execution. |
| Legacy upgrade | `pnpm integration:legacy-upgrade` — passed from the exact original revision above, including pg-boss and restricted worker execution. |
| Backup and restore | Real PostgreSQL backup rejected the intentionally stale task sequence. Valid backup and restore passed into `omnis_restore_postprobe`; restored counts/fingerprints matched before a committed synthetic task/run was created under `omnis_runtime`. Post-insert sequence invariants passed. The unsafe in-flight rejection remains covered by existing recovery integration and metrics tests. |
| Browser | No frontend or API contract changed in this follow-up. Existing Firefox owner sign-in, throttling, mock execution, cancellation, SSE reload/reconnect, and responsive checks remain recorded above; database integration reran the affected task/run HTTP path. |
| GitHub Actions | **Passed** for implementation revision `900da0c0cb38978d712312a27b5accd09074753d`: [run 41461448602](https://github.com/Jeysibn/omnis-os/actions/runs/41461448602). Frozen install, role provisioning, `pnpm check`, production build, legacy upgrade, and recovery integration all passed. |

The disposable PostgreSQL container was `omnis-db-integrity-20261102-postgres-1`, bound to loopback port `37441`, with a dedicated test volume/network. No unrelated containers or services were changed. The current WSL shell lacked the Docker supplementary group; `sg docker` used existing group membership. No socket, group, daemon, or WSL configuration was modified. Temporary credentials were synthetic, process-scoped or held in mode-0600 files under `/tmp`, and are not committed.

### Remaining requirements and gate

This closes N-2, N-3, and M-7 for the locally tested mock-only foundation. SQL grants constrain ordinary runtime access but do not provide a tamper-proof, actor-attributed audit system. The dump hash and count manifest detect accidental mismatch only: **backup encryption and manifest/archive authentication remain separate open requirements** pending an approved key-management design. Active-run backups remain rejected; operators must quiesce work and confirm settled/lease-free state before backup. Restore was tested with synthetic data in a disposable database; no production restore was attempted.

No provider adapter or inference was enabled. R1-G4 still requires durable runtime authorization, owner approval, persistent actor-attributed audit, trusted credential broker, effective in-run revocation, approved provider policies/authentication, connector egress restrictions, and trusted-connector canary verification. Rootful Docker/same-host UID, disk quota, and production-grade arbitrary-code isolation remain unverified and general-purpose tools remain prohibited.

**Follow-up result: Passed locally and in GitHub Actions for N-2/N-3/M-7 at implementation revision `900da0c0cb38978d712312a27b5accd09074753d`; draft PR #1 is open and unmerged. This is not authorization for real AI execution.**

## Post-restore ACL verification follow-up — 2026-11-02

- **Base revision:** PR #2 merge commit `3b0f87feed80ca05b2ebfa3cabf929928237318a`; main CI passed in [run 41473213935](https://github.com/Jeysibn/omnis-os/actions/runs/41473213935).
- **Feature branch:** `security/restore-acl-validation`.
- **Draft PR:** [PR #3](https://github.com/Jeysibn/omnis-os/pull/3), open against `main`; no merge performed.
- **Implementation revision:** `b095290c994b9ddf151810d3bcbc0845e67cbca8`.
- **Scope:** F-1 post-restore ACL policy validation, F-2 real ACL-free archive compatibility coverage, and F-3 semantic source/restored ACL comparison.

New ACL-preserving backup manifests carry a normalized ACL snapshot for the `omnis` and `pgboss` schemas, including schema/table/sequence/column/routine/type and migration-owned default ACL entries. Restore verifies the runtime grant policy and compares the restored ACL entries with the snapshot before accepting the database. Grantor identity is normalized because `pg_restore --role=omnis_migrator` may change the recorded grantor while preserving the grantee and privilege. PUBLIC routine execution is accepted only for invoker-rights routines; PUBLIC type USAGE is retained where PostgreSQL/pg-boss defines it. Grant options and unreviewed grantees are rejected.

Older `postgres-custom` archives have no source ACL snapshot, so equality cannot be established. The compatibility path reconstructs only the current restricted application grants, revokes runtime access to future application relations/sequences, reapplies required pg-boss grants, and then runs the same runtime ACL policy validation. A real `pg_dump --no-acl` fixture is restored in CI and verifies that later ungranted relations/sequences remain inaccessible.

### Verification for F-1 through F-3

| Check | Result |
|---|---|
| ACL policy unit tests | Passed: safe current/pg-boss grants, prohibited DML, PUBLIC and unknown-role grants, grant options, invoker-rights routine handling, and snapshot drift. |
| New ACL-preserving archive | Passed against disposable PostgreSQL 17.6. Restored normalized ACLs matched the source snapshot, runtime ACL policy passed, and the synthetic task/run and sequence checks passed. |
| Unauthorized grant negative test | Passed against the restored database. A synthetic `DELETE` grant on `omnis.tasks` caused the ACL policy validator to reject the snapshot; the grant was revoked afterward. |
| ACL-free compatibility archive | Passed using a real custom-format `pg_dump --no-acl` archive and legacy manifest. Restore rebuilt the restricted baseline, and runtime reads of later ungranted fixtures and sequence access were denied. |
| Backup/restore disposable infrastructure | Project, source/restore databases, volume, archive, manifest, and temporary credentials were removed; no unrelated containers were touched. |
| Frozen install | Passed with `npm exec --yes --package=pnpm@12.16.1 -- pnpm install --frozen-lockfile`; lockfile unchanged. |
| Formatting, ESLint, TypeScript, unit tests | `pnpm check` passed. The DB and live-container suites are gated and skip without their integration DSNs/flag; the database and sandbox suites were run separately below. `pnpm test` includes 5 ACL-integrity unit tests and 5 backup metric tests, all passed. |
| Production build | `pnpm build` passed. |
| Actual Docker sandbox | Passed locally: 9 tests, 0 failures, 0 skipped. |
| Full local regression | Passed on the feature-branch working tree: frozen install, `pnpm check` (format, ESLint, TypeScript, all workspace tests and 10 recovery/ACL tests), `pnpm build`, real disposable PostgreSQL backup/restore, and actual Docker sandbox security suite (9 passed, 0 failed, 0 skipped). |
| GitHub Actions | Passed for implementation revision `b095290c994b9ddf151810d3bcbc0845e67cbca8` in [run 41475423033](https://github.com/Jeysibn/omnis-os/actions/runs/41475423033): frozen install, role provisioning, `pnpm check`, production build, legacy-upgrade, recovery, disposable backup/restore, and cleanup all succeeded. The subsequent documentation-only revision also passed in [run 41475925282](https://github.com/Jeysibn/omnis-os/actions/runs/41475925282). |

Backup encryption and manifest/archive authentication remain explicit upcoming requirements. The snapshot detects source/restored ACL drift and policy violations but is not authenticated against a malicious actor who can alter both archive and manifest. A separately reviewed key-management design is required before implementing either control. This work does not enable real model inference.

## PR #1 reliability follow-up — 2026-11-02

- **Merged baseline:** PR #1 was reviewed at `5a34c42940d378fc06b0a81e799449458a5e5fec`, marked ready, and squash-merged to `main` as `d9c715de80215d74a48ca0eb1d02515fd70fdc0b` with explicit owner authorization. Main CI passed at that SHA in [run 41464559948](https://github.com/Jeysibn/omnis-os/actions/runs/41464559948).
- **Follow-up branch:** `reliability/n7-backup-restore-ci`, based on the merge commit. Verified implementation revision: `7f701933bf33a7151af04c725a319cd768c7768c`, including the legacy-upgrade expectation for migration `0004`. This follow-up does not enable provider execution.

### N-7 — role reprovisioning safety

**Confirmed and fixed.** `provisionDatabaseRoles()` previously reapplied `0003_runtime_privileges.sql` whenever the application tables existed. That migration's broad `REVOKE` could undo grants from later approved migrations. Provisioning now manages role identity, schema ownership, and pg-boss ACLs only; ordered application migrations remain the authority for application-table grants. Migration `0004_narrow_runtime_sequence_defaults.sql` revokes the `0003` application-schema default sequence grant, while preserving grants on existing application sequences. This prevents new sequences from inheriting runtime access. PostgreSQL integration coverage creates later-migration-style approved and ungranted tables and sequences, re-provisions roles, then verifies approved grants remain, ungranted access is denied, and normal synthetic task/run admission still works.

Restores previously replayed `0003` after restoring ACL-free archives, so that path shared the same latent issue. New backups use a versioned `postgres-custom-acl-v1` manifest and retain PostgreSQL ACLs in the custom archive; restore applies the saved ACLs instead of replaying application grants. Legacy `postgres-custom` archives remain accepted and use the previous compatibility grant restoration. This preserves migration-added grants in new restores while retaining compatibility with older archive format.

### Disposable backup/restore CI

`pnpm integration:backup-restore` creates a unique Docker Compose project with an isolated PostgreSQL 17.6 service, synthetic credentials in mode-0600 temporary files, and a disposable volume. It provisions distinct admin/migrator/runtime roles, applies application and pg-boss migrations, runs the PostgreSQL database test suite, and inserts synthetic pg-boss/task/run/event records. It creates later-migration ACL fixtures to prove new archives preserve approved grants while denied future relations and sequences remain inaccessible after restore. A deliberately stale task sequence must make backup fail and remove partial archive/manifest files. The valid restore checks counts, row fingerprints, event ordering, and sequence safety, then commits a synthetic runtime task and completed mock run. Cleanup removes only the generated project, its volume, target database, and temporary directory; no backup is uploaded as a workflow artifact.

### Verification for this follow-up

| Check | Result |
|---|---|
| Main CI after PR #1 merge | Passed for `d9c715de80215d74a48ca0eb1d02515fd70fdc0b`: [run 41464559948](https://github.com/Jeysibn/omnis-os/actions/runs/41464559948). |
| Frozen installation | `npm exec --yes --package=pnpm@12.16.1 -- pnpm install --frozen-lockfile` — passed; lockfile unchanged. |
| Formatting, ESLint, TypeScript, unit tests | `pnpm check` — passed. The standalone check reports the database and live-Docker test suites as skipped when no DSNs/integration flag are set; both gated suites were run separately below. |
| Production build | `pnpm build` — passed. |
| PostgreSQL and N-7 integration | Passed as part of `pnpm integration:backup-restore` against disposable PostgreSQL 17.6: 20 database tests passed, including grant retention, denial of ungranted future tables/sequences, role re-provisioning, task/run admission, migration checksum/concurrency behavior, and lease fencing. |
| Backup/restore integration | Passed locally against the disposable Docker Compose project. Stale task sequence rejection and artifact cleanup passed; the ACL-preserving archive restored with matching fingerprints and sequence invariants. Approved future migration grants survived restore, ungranted fixtures stayed inaccessible, and the restricted runtime created a synthetic task and completed mock run. |
| Docker sandbox negative security test | Passed locally with `OMNIS_SANDBOX_INTEGRATION=1`: 9 tests passed, 0 failed, 0 skipped. This included actual-container mount, canary, identity, resource, process, timeout, and network checks. |
| API/browser regression | No API or UI behavior changed in this follow-up; no new browser run was performed. |
| Follow-up GitHub Actions | Passed for implementation revision `7f701933bf33a7151af04c725a319cd768c7768c`: [run 41466299224](https://github.com/Jeysibn/omnis-os/actions/runs/41466299224). Frozen install, role provisioning, `pnpm check` including real-container sandbox tests, production build, legacy upgrade, recovery integration, and disposable backup/restore all passed. |

### Remaining risks and gate

This follow-up changes ACL preservation and reprovisioning behavior, but PostgreSQL ACLs are not a tamper-proof audit trail. Backup encryption and authenticated manifests remain open pending an approved key-management design. Legacy archives without ACL entries use compatibility grant restoration; newly created archives retain ACLs. In-flight executions remain disallowed in backups. N-8 lifecycle constraints, N-9 pg-boss upgrade compatibility, worker supervision, separate sandbox UID and disk quotas, and production host/network isolation remain deferred. R1-G4 still requires durable runtime authorization, owner approval, actor-attributed persistent audit, a trusted credential broker, effective in-run revocation, approved provider policies/authentication, connector egress restrictions, and trusted-connector canary verification. Hermes, Codex, and Claude inference remain disabled.

## Restore ACL hardening follow-up — 2026-11-03

- **Merged base:** PR #3 was marked ready and squash-merged to `main` as `f8301c8d04803cc465037b88b7ad1ad7baebbcc6`; main CI passed in [run 41478720147](https://github.com/Jeysibn/omnis-os/actions/runs/41478720147).
- **Branch:** `security/restore-acl-hardening`.
- **Scope:** F-5 explicit application SELECT allowlist, F-6 end-to-end restore rejection for unauthorized ACLs and mismatched snapshots, F-7 unexpected-schema/public-grant/role-membership checks with extension compatibility, F-8 fresh-versus-legacy runtime ACL parity, and ADR-0010 for authenticated encrypted backups.
- **Local PostgreSQL verification:** passed against disposable PostgreSQL 17.6 using unique temporary projects and synthetic credentials. The integration exercised real malicious ACL-preserving archives, source/restored mismatch rejection, `pgcrypto` extension ACL behavior, ACL-free legacy restore, fresh-versus-legacy runtime grant parity, and post-restore synthetic task/run creation.
- **Legacy upgrade:** passed from audited revision `708d0f5e9b6083da852e26c0643c60c0f5879f85`; synthetic task/run/pg-boss data remained intact, ownership normalized, migration checksum upgraded, and restricted worker completed a run.
- **Recovery integration:** passed with PostgreSQL-backed API/SSE replay, abrupt worker recovery, sandbox crash cleanup, and no duplicate execution. The optional PostgreSQL-container outage injection was not run in this local invocation.
- **Docker sandbox:** actual-container suite passed, 9 tests, 0 failures, 0 skipped.
- **Frozen install:** passed with pnpm 12.16.1; lockfile unchanged.
- **Static checks and build:** `pnpm check` passed formatting, ESLint, TypeScript, workspace tests, and 13 recovery/ACL unit tests; the database package's separately gated test skipped without a test DSN, and real database coverage ran in the disposable integrations. `pnpm build` passed.
- **Browser regression:** not run because no UI or sign-in interfaces changed.
- **GitHub Actions:** pending push of this follow-up branch.

The restore policy permits runtime table SELECT only on `omnis.tasks`, `omnis.runs`, `omnis.run_events`, and `omnis.run_idempotency`; views and `schema_migrations` are denied. ACL collection now covers non-system schemas, database ACLs, default ACLs, and direct runtime memberships. It rejects unapproved runtime and PUBLIC grants while preserving PostgreSQL defaults required for `public` schema resolution, invoker-rights extension routines, type usage, and database connection/temporary behavior.

`restore-verify.mjs` now requires `OMNIS_TRUSTED_ARCHIVE_ACKNOWLEDGED=true`; this is an operator attestation, not cryptographic authentication or isolation. ADR-0010 (`docs/07-governance/adr/0010-encrypted-authenticated-backups.md`) proposes per-archive envelope encryption, authenticated manifests, safe key custody/rotation/revocation, and verification before PostgreSQL sees plaintext. It is proposed only; no algorithms, KMS/HSM vendor, or key lifecycle were approved or implemented. Until archive authentication and isolated restoration are independently reviewed, do not restore untrusted archives or use this verifier for production restoration. No real AI inference or provider credentials are enabled.

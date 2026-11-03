# R1-G4 Authorization Availability and Legacy Run Recovery

## Scope and disposition

This evidence covers PR #7 findings G4-9 and G4-10 on top of PR #6's squash merge `e463bf503b1344d56624745a20c75816a5661b42`. The feature branch is `security/r1g4-authorization-availability`; the final tested SHA and CI run will be added after publication.

No provider integration, provider credentials, or general-purpose tool execution was added. The runtime remains limited to the deterministic synthetic mock.

## G4-9 — Revocation availability

**Confirmed before the fix.** On a disposable PostgreSQL 17.6 instance, a connection using `omnis_runtime` acquired session advisory lock `70463909136524`. Owner revocation on another connection waited; the controlled test observed the revoker in `pg_locks` waiting on an advisory lock. The test was bounded and released the lock during cleanup.

Migration `0008_revocation_availability_and_legacy_run_recovery.sql` removes the shared advisory lock from direct authorization consumption and revocation. Admission still takes the pre-existing shared advisory lock for the global active-run cap/idempotency path, then obtains a row lock on the exact eligible grant through `lock_run_authorization_for_admission` before its task lock. Unconsumed revocation locks and re-reads the grant; if consumption won while revocation waited, it retries using the consumed path. Consumed revocation retains run-then-grant ordering used by worker transitions. The runtime-held advisory key no longer blocks revocation, and authorization race serialization is scoped to a grant.

A real PostgreSQL test repeats the original runtime-held advisory lock after migration 0008; revocation commits and records its audit event while the unrelated session lock remains held. Another test holds the grant row using the runtime-only admission lock and observes revocation fail after the transaction-local 3-second `lock_timeout` with SQLSTATE `55P03`. The grant remains authorized, no revocation audit is committed, the error propagates, and a retry succeeds after the holder rolls back. The worker endpoint maps this failure to HTTP 503 `authorization_busy`; it does not report the grant as revoked.

The fixed row timeout bounds one revocation attempt. It does not prevent repeated targeted contention, other PostgreSQL resource exhaustion, or every denial-of-service action available to a process with runtime credentials. In particular, because the existing global admission-cap advisory lock still uses the same key, a runtime session can still block new run admissions while holding that session lock; this is outside the revocation guarantee and remains a reliability risk to address separately. Runtime and authorizer credentials remain in the same worker process (G4-3).

## G4-10 — Historical grant-less runs

Migration 0008 creates `omnis.legacy_unscoped_runs` as a migration-owned provenance table and populates it only from active grant-less runs whose `created_at` predates the recorded application time of `0005_durable_authorization`. Active grant-less rows created after the authorization migration are not classified. Runtime and authorizer roles cannot read or write the table. No API-provided flag can classify a run as legacy.

For migration-classified rows, the restricted audit function permits only execution denial and terminal outcomes: cancellation, failure, or interruption. It records a NULL authorization ID and fixed `service:omnis-runtime` actor/effective identity; it does not manufacture an authorization record or impersonate a recovery principal. Execution claim remains denied, as do start/completion events. A grant-less post-authorization row is not classified: claim attempts fail closed, and mandatory audit association errors roll back lifecycle state. The runtime role can update approved run lifecycle columns directly, so database-enforced transition integrity remains the deferred N-8 finding; any runtime-originated event remains attributed to the runtime identity.

The integration suite exercises a real pre-authorization queued run from revision `708d0f5e9b6083da852e26c0643c60c0f5879f85`, migration-created provenance, owner cancellation, two historical running rows transitioned to interrupted/failed, no fabricated grants, role/table ACL restrictions, and successful authorized mock work after migration. It also holds a grant row to verify the internal worker API returns HTTP 503 without committing, then succeeds after a fresh retry. Unit-level PostgreSQL tests verify a migration-marked queued run cannot claim and is interrupted with an enforcement-denial audit event. A controlled direct runtime status update followed by append is attributed to `service:omnis-runtime`, never a recovery-service identity.

## Lock order

| Path | Lock order and release |
| --- | --- |
| Run-store admission | Existing transaction admission-cap advisory lock → eligible authorization row → task row → run insert/authorization consumption → audit foreign keys; all release at transaction end. |
| Direct consumption routine | Authorization row update → audit foreign keys; transaction-scoped. |
| Unconsumed revocation | Authorization row → audit foreign keys; transaction-scoped, with a 3-second transaction-local lock timeout. If consumption is observed after waiting, the routine returns a retry outcome. |
| Consumed revocation | Run row → authorization row → audit foreign keys; matches claim, heartbeat, completion, cancellation, and related worker transitions. |
| Worker transition | Run row → active authorization row → task/audit writes; transaction-scoped. |

The admission-cap advisory lock remains for the existing active-run and idempotency controls; revocation does not acquire it. The shared key formerly used for authorization revocation has been removed from the affected functions. PostgreSQL foreign-key checks can take key-share locks; the unconsumed paths rely on compatible key-share locks rather than an opposing task `FOR UPDATE` order.

## Verification

Environment: disposable PostgreSQL 17.6 container `omnis-pr7-authz-pg`, loopback port `15441`, no persistent volume, synthetic credentials and data. Actual Docker sandbox tests ran through the existing Docker group; no Docker daemon, socket permissions, WSL settings, production database, or MoniKey service was changed.

| Check | Result |
| --- | --- |
| Frozen install | `npm exec --yes --package=pnpm@12.16.1 -- pnpm install --frozen-lockfile` — passed. |
| Format, lint, TypeScript, tests | `pnpm check` — passed after correcting test fixture ordering: format, ESLint, TypeScript; 80 workspace unit/integration tests and 26 database-recovery policy tests passed, 0 failures, 0 skipped. PostgreSQL run-store tests: 35 passed. Actual-container sandbox and worker suite: 28 passed, 0 skipped. |
| Advisory-lock attack | Pre-fix reproduced as a PostgreSQL advisory lock wait; after migration 0008, same live runtime-held key did not block revocation. |
| Genuine row contention | Revocation timed out at 3 seconds with SQLSTATE `55P03`; no status/audit mutation occurred; retry succeeded after lock release. |
| G4-2 regression | Application admission/revocation and direct SQL consumption/revocation orderings passed against PostgreSQL; existing consumed-grant claim/completion revocation tests passed. |
| Legacy upgrade | `pnpm integration:legacy-upgrade` — passed from audited revision `708d0f5e9b6083da852e26c0643c60c0f5879f85`; historical cancellation/interruption/failure passed with no synthetic grants; role ownership/checksums and new authorized worker execution passed. |
| Worker recovery | `pnpm integration:recovery` — passed; PostgreSQL-backed lifecycle, SSE, worker restart, sandbox cleanup, and no duplicate execution. |
| Backup/restore | `pnpm integration:backup-restore` — passed; actual custom-format backup/restore and existing ACL/sequence/security checks succeeded, with temporary resources removed. |
| Production build | `npm exec --yes --package=pnpm@12.16.1 -- pnpm build` — passed. |
| GitHub Actions | Pending publication of the final feature branch. The workflow URL and tested commit SHA will be appended after completion. |

The first full `pnpm check` attempt found an ordering-only assertion mismatch after the new legacy test added a fourth run. The implementation paths had committed the expected state; the assertion was corrected to match the query's `ORDER BY run_id`. The full check then passed. The legacy-upgrade drill also found incomplete synthetic fixture fields; the fixture was corrected to satisfy the historical schema and then the complete drill passed.

## Remaining risks and gates

- A runtime session can still cause bounded row contention or repeated retries; this change removes the known indefinite shared advisory-lock path but does not provide general database availability isolation.
- The existing global admission-cap advisory lock remains publicly callable; a runtime session can still block new run admissions by holding its key. Revocation no longer uses that key. This is an open admission-availability risk.
- PostgreSQL runtime grants still permit lifecycle column updates; database-enforced state-machine integrity is deferred (N-8). The narrow legacy audit append function records the effective runtime identity and does not claim a privileged recovery actor.
- The runtime and authorizer credential trust boundary remains within one worker process (G4-3).
- Audit history is transactionally written and access-restricted, but is not cryptographically immutable or externally anchored.
- Grant-less runs not classified by migration provenance remain fail-closed and may require operator/database investigation rather than automatic termination.
- Real model providers, provider credentials, trusted credential brokering, restricted model-only execution, and general-purpose tools remain prohibited. ADR-0010 remains Proposed.

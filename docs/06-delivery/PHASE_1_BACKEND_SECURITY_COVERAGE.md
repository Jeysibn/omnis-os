# Phase 1 Backend Security Coverage

**Assessment date:** 2026-11-17
**Source baseline:** `1d947aba351f6e4d92542f299b7089903f98d29b`
**Purpose:** Supplemental backend test-coverage inventory. The canonical AO-101–AO-113 acceptance matrix remains [PHASE_1_COMPLETION_MATRIX.md](./PHASE_1_COMPLETION_MATRIX.md).

This assessment distinguishes offline source and test evidence from PostgreSQL integration, the combined launcher journey, and target-host runtime evidence. Passing execution-disabled tests do not establish mock execution or R1 acceptance.

| Area | Status | Evidence and limits |
| --- | --- | --- |
| Owner session, Origin, CSRF, and acceptance request shape | **VERIFIED in offline API tests** | Acceptance requires an owner session, configured Origin, session-bound CSRF, and UUID idempotency key. Denied requests do not reach the Authorizer. Exact eligible Run identity and latest-result checks are enforced by the Authorizer/database contract. |
| Owner acceptance transaction, concurrency, immutable receipt, and database-role boundary | **PARTIAL** | Role-separated PostgreSQL tests cover concurrent retries, eligibility, receipt immutability, and direct runtime-role denial of acceptance/completion. The database-dependent suite is skipped when its role-specific test database URLs are absent; this source audit did not provision or mutate a database. |
| Worker authorization and execution-disabled admission/stop | **VERIFIED in offline tests** | Coordinator and Worker route tests cover disabled admission and stop. The Worker HTTP boundary now has direct coverage for absent/incorrect internal tokens returning 401 and authenticated admission/stop returning 503 without authorization, store, or queue access. Configuration mismatch and restricted-mode contracts are covered separately. |
| Worker recovery, stale sessions, revocation, and completion fencing | **VERIFIED in offline and source tests; runtime PARTIAL** | Tests cover stale-session jobs, authorization recheck before execution, denied lease renewal during an active run causing abort/interruption, duplicate completion and uncertain recovery protections. Database integration covers revocation/completion races but was not run without the configured PostgreSQL test roles. The Worker session fence is process-local; it is not global revocation. |
| Persisted Run events and owner SSE | **VERIFIED for one API replica** | Tests cover cursor replay, subscribe-before-replay, out-of-order notifications, duplicate notification suppression, gap failure, reconnect, terminal ordering, unauthorized access, logout, expiry, session rotation, and disconnect cleanup. Session state and open-stream invalidation are process-local; cross-replica coordination is not established. |
| Synthetic-broker Task → Run → Review → Accept → Completed | **VERIFIED in the synthetic-broker browser journey** | One existing browser journey covers task creation, owner approval, synthetic Run, review, explicit acceptance, receipt, and completion. It is synthetic-broker scope and does not establish the sandbox-launcher journey. |
| Sandbox-launcher Task → Run → Review → Accept → Completed | **BLOCKED / incomplete** | The combined sandbox-launcher journey through owner acceptance is not yet verified. Platform integration is maintained by the platform owner; this backend change does not alter platform configuration or integration-test infrastructure. Separate test paths are not counted as one journey. |
| Target WSL2 security and operational evidence | **NOT TESTED / BLOCKED** | No target-host run, restart, cancellation, security-boundary, or owner-signoff evidence is included here. This work did not start Docker, a database, a Worker, a launcher, or a provider. |
| R1 acceptance | **BLOCKED / NOT ACCEPTED** | No source-only test result changes the separate runtime and owner-acceptance gates. Keep execution disabled until separately authorized and verified. |

## New offline regressions in this milestone

- Authenticated Worker Run admission and stop requests preserve the 401-before-503 boundary in disabled mode and perform no execution-related work.
- Loss of durable lease renewal while a mock Run is active aborts the runtime and records interruption rather than completion.
- Persisted event replay suppresses a repeated notification and closes the stream on a non-contiguous sequence.
- Owner acceptance API tests reject cross-Origin, missing or incorrect CSRF, missing keys, and malformed UUID keys before Authorizer forwarding.

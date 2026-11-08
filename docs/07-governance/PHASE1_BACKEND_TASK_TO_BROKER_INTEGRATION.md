# Phase 1 backend task-to-broker integration

Status: synthetic-only, test-mode backend integration. It does not enable real provider
authentication, credentials, inference, production broker selection, or deployment.

## Admission and execution flow

1. The owner submits a task run with the existing connector authorization ID, request binding,
   rendered request, and the original idempotency key. The API requires an owner session and
   CSRF protection, verifies the canonical digest and exact grant bindings, then forwards to
   the worker. A retry may use only the same request identity.
2. The worker test route reloads the task and immutable profile version, re-renders the prompt,
   and checks its digest. `PostgresRunStore.admitSyntheticBrokerRun` creates the canonical Run
   projection and the `pg-boss` job in the same PostgreSQL transaction. The queue payload has
   only `{ runId }`; the persisted binding contains no rendered prompt. Connector grant
   consumption and attempt creation remain exclusively in the PR #43/#45 authorizer lifecycle.
3. The worker reloads the task, profile version, and saved binding before execution. It checks
   the exact rendered prompt digest again, then calls the existing broker `/submit` operation
   through PR #46's broker client. The broker calls the PR #47 authorizer IPC, which remains the
   authority for one-use grant consumption and the durable provider attempt.
4. The worker records the result as Run events and a Run projection. The owner status response
   reads the authoritative attempt and usage from the authorizer and includes the matching Run
   projection when available. Run usage stays unknown; the API does not infer provider billing
   from tokens.

## Durable connector audit history

The owner may read bounded attempt audit history from
`GET /api/v1/tasks/:taskId/synthetic-runs/:authorizationId/events?after=:sequence&limit=:count`.
The API verifies the persisted authorization-to-task binding before forwarding to the
authorizer's service-token-protected event route. The authorizer reads the existing immutable
`connector_authorization_audit` records for the persisted attempt; it creates no second event
table or attempt state machine. The response contains only attempt ID, per-grant sequence, event
type, outcome, revocation generation, and timestamp. It excludes prompt text, provider payload,
response text, usage, and credentials.

This audit stream complements the canonical Run event/SSE history and has its own per-grant
cursor. The stream itself does not reconcile Runs. PR #46 adds a test-mode worker projection loop
that reads persisted unknown Runs, requests read-only broker evidence, and applies a bounded
projection repair without resubmitting. The authorizer attempt remains authoritative; see
[the reconciliation contract](PHASE1_PR46_LATE_RECONCILIATION.md).

The implementation adds no grant store, attempt ledger, or provider state machine. Migration
`0024_synthetic_task_run_projection.sql` adds a nullable projection to `omnis.runs`. It follows
merged migration 0023 and does not edit deferred PR #41's 0021 or merged 0022/0023.

## Failure, retry, and cancellation behavior

- The `pg-boss` task payload contains only the stable Run/correlation ID. Job retry is disabled.
- A broker timeout, lost response, malformed response, or worker lease expiry records Run status
  `unknown`; it never requeues a request that may have reached the provider. The authorizer
  attempt remains the source for `accepted`, `running`, final status, cancellation acknowledgement,
  and usage provenance.
- Every broker response, including an uncertain response, must carry the exact persisted grant
  `correlationId`. The worker rejects missing or mismatched correlation instead of attaching an
  attempt or result to the Run, and records the Run as `unknown`. PR #46 returns and validates this
  identity in the merged synthetic path; regression coverage includes missing and mismatched
  correlation (`apps/worker/src/synthetic-broker-run-coordinator.test.ts`).
- A worker restart does not submit again. An expired broker Run lease becomes unknown and is
  excluded from normal mock-run recovery. The API status route reports the authorizer attempt and
  matching Run projection when available. The test-mode worker performs bounded reconciliation
  from authoritative attempt evidence; it does not create a parallel attempt ledger.
- Owner cancellation revokes the grant first, then records a durable Run stop request. If the
  queued job has not started, the worker confirms cancellation before broker submission. During
  or after submission, the API reports `confirmed: false`; only the authorizer's correlated
  provider `interrupted` event is evidence that provider termination was confirmed.
- The worker's broker call is synchronous. A cancellation during that call does not interrupt the
  socket request. PR #46's broker recovery loop observes authorizer `cancelRequestedAt` and
  attempts the fixed fake-provider cancellation protocol. This is synthetic platform behavior,
  not proof of real cancellation semantics.

## Test-only boundary and platform dependency

The broker orchestration route and process wiring require both
`OMNIS_SYNTHETIC_BROKER_TEST_MODE=1` and `NODE_ENV=test`, plus the disposable broker socket and
test token. The worker's production runtime remains hard-wired to
`SandboxedMockRuntimeAdapter`; no production runtime selector or provider URL is added.

PR #46 provides the concrete submit endpoint and fake-provider recovery loop. PR #49's merged
work is a disposable Docker boundary test harness; it is not the broker application boundary and
does not prove that this backend worker is isolated. Actual process identity, socket peer UID/GID,
and enforced egress remain Codex #3 platform responsibilities. The rootful Docker launcher
remains host-root-equivalent; this work adds no real secret store and establishes no safe real
credential custody.

## Known integration dependencies

- The canonical task/profile renderer landed in PR #55 (merge commit
  `1b64a089d51f05797024c67b219dde9d2086fd24`). Revalidate renderer bindings if later code changes
  alter the task/profile contract.
- Deferred PR #41's migration 0021 is numbered before 0024 and its migration runner applies
  unapplied files in lexical order. Its current Draft also revokes direct runtime writes to
  `omnis.runs`, `omnis.tasks`, and `omnis.run_events`, replacing them with database transition
  functions. This PR is based on current main without migration 0021 and is mergeable only in that
  sequence; it does not include or change PR #41. If PR #41 is merged first, or before this PR is
  integrated, this branch must be adapted to the exact 0021 transition-function contract and
  re-reviewed before merge. The new column-level grants in 0024 do not restore any table write
  privileges revoked by 0021.
- PR #46 includes a test-mode worker-side `reconcileUnknownRuns` loop for late authoritative
  attempt outcomes; it is not a separate owner status route. The owner status API reads the
  authorizer attempt and the matching Run projection when available. The Run projection remains a
  bounded view and must not be treated as authorization or attempt authority.
- The audit-history read is additive to the Run SSE projection. It uses the append-only
  authorizer audit stream and adds no attempt ledger. Regardless of audit-history route version,
  broker responses must carry the persisted correlation ID.
- PR #41 remains deferred and nonmergeable. Its migration 0021 changes task/run event writes and
  runtime table privileges; this candidate must be adapted to those transition functions and
  re-reviewed before that migration can be integrated.

No tests in this PR establish host isolation, OS peer authentication, network egress enforcement,
provider cancellation, or real provider compatibility. G4-3 remains Partially Fixed, R1-G5
Partially Complete, AO-107/AO-113 BLOCKED, and production remains mock-only.

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

The implementation adds no grant store, attempt ledger, or provider state machine. Migration
`0024_synthetic_task_run_projection.sql` adds a nullable projection to `omnis.runs`. It follows
merged migration 0023 and does not edit deferred PR #41's 0021 or merged 0022/0023.

## Failure, retry, and cancellation behavior

- The `pg-boss` task payload contains only the stable Run/correlation ID. Job retry is disabled.
- A broker timeout, lost response, malformed response, or worker lease expiry records Run status
  `unknown`; it never requeues a request that may have reached the provider. The authorizer
  attempt remains the source for `accepted`, `running`, final status, cancellation acknowledgement,
  and usage provenance.
- A worker restart does not submit again. An expired broker Run lease becomes unknown and is
  excluded from normal mock-run recovery. The API status route still reports the authorizer
  attempt. The platform broker currently owns its own attempt recovery; this backend does not
  invent a parallel reconciliation ledger.
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

- This branch depends on the canonical task/profile renderer currently supplied by Draft PR #55.
  It is based on that branch and must be integrated with its reviewed head, or revalidated if the
  PR #55 base/head changes.
- Deferred PR #41's migration 0021 is numbered before 0024 and its migration runner applies
  unapplied files in lexical order. Its current Draft also revokes direct runtime writes to
  `omnis.runs`, `omnis.tasks`, and `omnis.run_events`, replacing them with database transition
  functions. This backend implementation currently uses the current-main direct RunStore write
  path. It therefore requires a compatibility update against the exact PR #41 candidate before
  these changes can be integrated with PR #41; PR #41 is untouched here.
- PR #46 does not expose a backend worker status/reconciliation route for a late attempt update.
  The owner status API reads the authorizer attempt directly, while the Run projection remains
  `unknown` after an uncertain worker result. The Run projection must not be treated as a
  reconciliation authority.

No tests in this PR establish host isolation, OS peer authentication, network egress enforcement,
provider cancellation, or real provider compatibility. G4-3 remains Partially Fixed, R1-G5
Partially Complete, AO-107/AO-113 BLOCKED, and production remains mock-only.

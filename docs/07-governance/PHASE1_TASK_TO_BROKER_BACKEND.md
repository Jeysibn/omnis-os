# Phase 1 task-to-synthetic-broker backend integration

Status: backend integration is implemented in the Draft PR #55 → #56 → #57 stack. It is
synthetic-only and disabled outside explicit test mode. It does not authorize credentials,
provider authentication, real inference, deployment, or production runtime selection.

## Live repository state

- Current main: `ac24bc3af8504c06465aeca2924011f4771252b3`.
- PR #49 is merged as `b2490501395a3e53fb0f97fc6ab3914a3300fa56`. It supplies disposable Docker
  boundary tests; those tests are not the broker application boundary.
- PR #52 is merged at `ac24bc3af8504c06465aeca2924011f4771252b3`. It supplies the original
  synchronous, test-only owner API → worker → broker path.
- PR #55 (`feat/phase1-canonical-synthetic-prompt`, head
  `428003209480e543263995c9ba18de6afd43a435`) binds owner consent and worker dispatch to the
  persisted task and immutable profile version.
- PR #56 (`feat/phase1-canonical-synthetic-runs`, head
  `bb945fcbad582e6a72a25f45b537ce7934ac28dc`) adds PostgreSQL Run projection, transactional
  pg-boss admission, worker orchestration, durable events, Run history, and the existing SSE
  replay surface.
- PR #57 (`feat/phase1-run-stop-revocation`, current head
  `71fdc437db0ef572b10a69588ec67ab4b4ecad62`) routes standard Run cancellation through the
  persisted grant binding and authorizer revocation.
- PRs #55–#57 are open Drafts and are not integrated into main. Their merge order is #55, #56,
  then #57. PR #41 remains deferred; if migration 0021 lands first, migration 0024 and its role
  contract require adaptation and renewed review.
- PR #46 (`codex/phase1-isolated-synthetic-broker`, head
  `16e5f2c1d8aa82324468a6ca8327059b497399d4`) remains Draft and security-blocked. It is not
  modified by this backend work.

PRs #43, #45, and #47 remain the only durable connector grant, attempt, submission, audit, and
broker-authorizer IPC authority. This stack creates no second grant store or attempt ledger.

## Backend task and Run flow

1. Owner consent uses PR #43's connector-specific authorization, not `mock.execute`. The API
   checks the owner session and CSRF protection and binds consent to the persisted task, project
   revision, immutable profile version, canonical rendered-request digest, connector/provider/
   model/operation, empty tool scope, limits, request identity, and authorizer correlation ID.
2. At test-only admission, API and worker reload persisted task/profile state and independently
   reproduce the canonical prompt. The worker rejects changed identity or digest before
   admission.
3. PostgreSQL creates the canonical Run projection, initial `run.queued` event, idempotency
   record, synthetic authorization reference, and pg-boss queue entry atomically. The queue
   carries only `runId`; it does not contain rendered prompt text.
4. The worker claims a bounded Run lease, reconstructs the same prompt from task/profile state,
   verifies the digest again, then calls the fixed Unix-socket broker client once. The broker
   reuses PR #47 IPC and PR #45 durable authorizer attempts; PostgreSQL remains authoritative for
   provider events and usage.
5. The worker maps confirmed broker outcomes to durable Run events and result projection. A lost
   or malformed broker response, a mismatched identity, or lease expiry remains `unknown`; the
   queue does not retry. Run history and SSE use the existing `runs`, `run_events`, and API
   replay path. The current Command Center labels these events as mock-source synthetic activity.
6. Owner cancellation resolves the persisted Run-to-grant binding rather than accepting a grant
   ID from the caller, revokes through the authorizer first, then requests a durable Run stop.
   Provider termination remains unconfirmed until a correlated `interrupted` event is persisted.

## Broker response identity contract

The broker request uses `omnis.synthetic-broker.v1`, a fixed local Unix socket, stable request
ID, persisted authorization ID, immutable binding, and exact rendered request. Its request and
response limits are 64 KiB. The worker does not accept caller-selected URLs and never retries a
request that may have crossed the provider boundary.

Every broker response, including HTTP 202 `unknown`, must include the attempt UUID and exact
persisted authorization `correlationId`. The worker validates task, authorization, request, and
correlation identity before accepting status or response text. A missing or mismatched
correlation is rejected; the Run remains unknown and the response cannot attach an attempt or
result to it. A completed response requires nonempty result text. Unreported usage remains
`unknown/not_reported`, not zero.

The current PR #46 branch omits `correlationId` in its uncertain HTTP 202 response at
`apps/synthetic-broker/src/server.ts`. The backend now rejects that response and preserves the Run
as unknown. Codex #3 must return the verified envelope's correlation ID for every outcome before
the cross-process flow can pass acceptance. PR #46 must remain separate from backend changes.

## Run event truthfulness and browser integration

The follow-on backend candidate based on PR #57 adds two explicit persisted Run events:

- `run.provider_submission_requested` is committed under the current worker lease before the
  broker client is called. Its message says provider acceptance is not yet confirmed.
- `run.outcome_unknown` is terminal and represents a potentially submitted request whose result
  cannot be confirmed. It is used for uncertain broker responses and expired connector Run leases;
  legacy mock lease expiry continues to use `run.interrupted`.

Migration `0025_synthetic_run_event_semantics.sql` updates only the Run event-type check to admit
those event names. It does not change grants, role ACLs, authorization records or submission
attempt tables. It follows PR #56's migration 0024. The normal migration-order coordination rule
for deferred PR #41 still applies.

The full-stack browser smoke now has an opt-in disposable owner-authorized synthetic Run path. It
starts a separate fake broker child process with an allowlisted environment, a fixed synthetic
completion, and only the worker test token plus broker-authorizer IPC credentials. The authorizer
alone receives the disposable Ed25519 private key. The Playwright scenario creates and approves
the exact task/profile prompt, then checks the persisted Run event order, result and measured
synthetic usage through the existing UI/API. The fixture uses Unix sockets and does not prove OS
peer UID/GID enforcement, a container boundary, network egress denial, or the executable PR #49
platform path. The PostgreSQL/browser scenario requires the repository's disposable PostgreSQL
integration environment; it has not been run locally in this worktree.

## Validation evidence and remaining gaps

- PR #55 exact-head CI: run `42295292543` passed; its independent reviewer approved the exact
  base/head after fixing persisted task identity validation.
- PR #56 exact-head CI: run `42309142334` passed; its independent reviewer approved the exact
  base/head. Its database projection and queue integration are covered by PostgreSQL CI, and its
  UI consumes the standard Run list/detail/SSE APIs.
- PR #57's exact-head CI run `42316272333` passed on
  `71fdc437db0ef572b10a69588ec67ab4b4ecad62`; the independent review returned implementation
  **APPROVE**, synthetic-only **ELIGIBLE**, and real-runtime **BLOCK**.
- The run-event and browser integration changes are a separate, uncommitted candidate based on
  PR #57. It has not yet received exact-head CI or independent review.
- These PRs remain Draft and stacked; passing CI and review do not mean the changes are on main.
- No local disposable PostgreSQL environment was available during PR #57 validation; the exact
  head's PostgreSQL, full-stack, browser, backup/restore, container, and aggregate CI jobs passed.
- The PR #46 independent review blocks milestone 1: the actual broker → authorizer → PostgreSQL
  → network fake-provider lifecycle has not passed in distinct running processes; systemd
  `IPAddressDeny` egress enforcement has not been demonstrated at the broker boundary; its
  cross-surface canary coverage is incomplete; and its current-main CI integration is dirty.
- PR #49's Compose/Docker boundary harness does not prove PR #46's broker process, actual
  end-to-end provider event persistence, systemd egress enforcement, or real credential custody.
- The rootful Docker launcher remains host-root-equivalent. Real provider credentials must not
  be stored on that host. G4-3 remains Partially Fixed, R1-G5 remains Partially Complete,
  AO-107/AO-113 remain BLOCKED, and production remains hard-wired to
  `SandboxedMockRuntimeAdapter`.

The queued Run/SSE backend stack is ready for owner merge sequencing, but it does not complete
synthetic end-to-end acceptance or authorize real runtime activation.

# Phase 1 task-to-synthetic-broker backend contract

Status: disabled-by-default backend integration for synthetic tests only. This contract does
not authorize provider credentials, real inference, deployment, or production runtime selection.

## Verified integration surface

- Current main at implementation start: `a89982c9af5c1107d5156b2ad53fd4d603de929b`.
- PR #49 is Draft (`test/disposable-docker-boundary`, head
  `d350a2450549c715ab562354f21b129f306ae1f9`) and currently changes only the disposable Docker
  boundary CI harness, its evidence, and the CI/package command. It does not provide a broker
  process, caller socket, task/run dispatcher, or cancellation API.
- PR #46 remains a separate Draft platform branch and is treated as historical context. This
  backend defines the fixed broker request below without editing or depending on that branch.
- PR #43/#45/#47 remain the only grant, attempt, submission, audit, and authorizer IPC sources
  of truth. No new authorization or attempt table is introduced.

## Owner API and worker contract

Test-only owner API, registered only when `NODE_ENV=test` and
`OMNIS_SYNTHETIC_BROKER_TEST_MODE=1`:

```text
POST /api/v1/tasks/{taskId}/synthetic-runs
Idempotency-Key: <UUID>
{
  "authorizationId": "<owner-approved connector grant UUID>",
  "request": { ... ConnectorAuthorizationRequest v1 ... },
  "renderedRequest": "<ephemeral exact rendered request>"
}
```

The API requires owner session and CSRF validation, validates the exact request digest, reads
the grant from the independent authorizer, checks task/project/profile/provider/model/operation/
limits against the persisted approved grant, and forwards the stable UUID as both request ID and
idempotency key. It never forwards an owner identity or approval flag. The worker revalidates
the task path, request schema, and idempotency identity and sends the ephemeral request over a
fixed Unix socket path to:

```text
POST /internal/broker/v1/submit
Authorization: Bearer <disposable synthetic broker caller token>
```

The broker request protocol is `omnis.synthetic-broker.v1`; its body contains only the grant ID,
stable request ID, immutable connector binding, and exact rendered request. The socket path is
absolute configuration, never caller input. The body and response are limited to 64 KiB; the
worker performs one request and never retries a possibly submitted request. Broker responses
must include an attempt UUID, the exact persisted grant correlation UUID, lifecycle state,
submission evidence, and a completed response only when the state is `completed`. Provider usage not present in the broker response is
reported as `unknown/not_reported`, never zero.

The broker calls the four existing authorizer IPC operations from
`PHASE1_PR_C_BACKEND_CONTRACT.md`. Its `attemptId` is the durable connector run identity; the
grant already binds project/task/profile and exact request digest. The authorizer attempt and
audit records remain authoritative. A caller can read status through the owner API path
`GET /api/v1/tasks/{taskId}/synthetic-runs/{authorizationId}`, which checks the grant/task
association and reads the persisted authorizer attempt and usage provenance. No request text,
token, or private signing key is returned.

Cancellation uses the existing owner-protected grant revocation operation. The authorizer
atomically marks the single-use grant revoked and records the in-flight attempt's durable
`cancelRequestedAt`; the owner API response is `requested: true, confirmed: false`. The broker
recovery loop may request provider cancellation, but only a correlated `interrupted` event
confirms termination. If the broker cannot establish the outcome, status and billing exposure
remain unknown. No cancellation result is inferred from a lost response.

## Security and production behavior

- The API and worker test-only routes are absent unless `NODE_ENV=test` and the explicit test
  switch is set; setting the switch outside test mode aborts startup.
- The standard worker runtime remains hard-wired to `SandboxedMockRuntimeAdapter`.
- The test broker client uses only a fixed local Unix socket, a distinct synthetic caller token,
  and the fixed synthetic-only broker contract. It does not accept provider URLs, credentials,
  OAuth data, runtime selection, or tool capabilities.
- The worker performs no direct authorization-table writes and cannot sign decisions. The broker
  holds no PostgreSQL credentials; the authorizer validates and consumes grants transactionally.
- Owner cancellation is a request, not proof of provider termination. Provider and run status
  are read from the durable attempt record after restart.
- This interface is application-level authentication only. It does not prove host peer UID/GID,
  socket ownership, process isolation, or network egress controls.

## Remaining integration gates

PR #49 does not implement the socket target above or the broker's execution contract, so the
owner-to-broker end-to-end path remains unavailable until Codex #3 aligns its active platform
work to this versioned interface and supplies executable peer-identity/egress evidence.
The current application `runs` table and pg-boss queue remain mock-specific; this integration
uses the existing connector attempt as its durable run identity and does not enqueue connector
prompts in PostgreSQL. This avoids persisting the exact rendered request, but it is a synchronous
worker dispatch rather than a pg-boss scheduled connector run. A future asynchronous scheduler
must decide how to retain or retrieve rendered input without storing it in plaintext, and must
link any run projection to the existing attempt rather than creating a second state machine.

The standard Run SSE stream remains mock-only. Connector status is available as a durable
attempt snapshot; a separate event-history/UI projection is not part of this backend slice.
Rootful Docker remains host-root-equivalent, so no real credential custody is permitted on that
host. G4-3 remains Partially Fixed, R1-G5 Partially Complete, AO-107/AO-113 remain BLOCKED, and
real-runtime activation remains BLOCK.

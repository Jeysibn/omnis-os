# Phase 1 PR C — authorizer IPC and fake-provider contract

Status: synthetic-only backend IPC contract. This does not authorize provider authentication,
provider credentials, real inference, production broker activation, or deployment.

## Authority and process boundary

The existing owner-approved connector grant in PostgreSQL remains the only approval authority.
The broker can consume an already approved grant only when `consumeForBroker` validates the
complete immutable request binding against that grant. The broker cannot create, decide, or
revoke grants. A request's `owner` identity is read from the persisted grant and signed by the
authorizer; IPC input containing an actor, principal, approval flag, or decision is rejected by
strict schemas.

The authorizer exposes a separate broker-only Unix domain socket when all synthetic IPC
configuration is present. The existing API authorizer socket and API service token remain
separate. The broker socket defaults to mode `0600`; a platform deployment may set `0660` only
when the parent directory group grants access to the dedicated broker service. The broker
also authenticates with a separate 256-bit-or-stronger bearer token and the exact
`x-omnis-service-identity: omnis-synthetic-broker` identity. The broker token is not accepted
on owner/API routes; the API token is not accepted on the broker socket. The broker process
receives neither database credentials nor the authorizer signing key.

Socket mode and service-token checks are separate controls. The Node authorizer does not read
Linux `SO_PEERCRED`; Codex #3 must enforce and test the peer UID/GID and socket directory/file
ownership at the host boundary. HTTP injection tests prove application authentication and route
scope, not OS peer isolation.

## Versioned authorizer IPC

All JSON bodies use `omnis.broker-authorizer-ipc.v1`, strict Zod schemas, a 64 KiB transport
body limit, and bounded prompt/event fields. The socket exposes only these operations:

| Method and path                              | Request                                             | Durable effect                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /internal/broker/v1/admissions`        | `{ version, authorizationId, requestId, request }`  | Reuses `consumeForBroker`: checks the persisted owner grant and exact request fingerprint/context, creates one attempt and nonce, signs the envelope inside the authorizer, consumes the grant, and appends audit in one transaction. `requestId` is an idempotency key; a repeat returns the same attempt/envelope. |
| `POST /internal/broker/v1/submissions/begin` | `{ version, attemptId, envelope, renderedRequest }` | Reuses `beginSyntheticSubmission`: verifies the exact persisted envelope and rendered-request digest, rechecks grant expiry/revocation/nonce/state under lock, then commits `submitting` and audit before the fake-provider call.                                                                                    |
| `POST /internal/broker/v1/provider-events`   | `{ version, attemptId, event }`                     | Reuses `recordSyntheticProviderEvent`: validates event schema and transition, fingerprints provider event identity, commits state and audit atomically, and accepts identical duplicate callbacks as no-ops.                                                                                                         |
| `POST /internal/broker/v1/recovery/list`     | `{ version, limit, afterAttemptId }`                | Bounded read-only scan of persisted synthetic attempts in `admitted`, `submitting`, `accepted`, `running`, or `unknown`; UUID cursor is exclusive and stable. It never reopens a grant or triggers a provider call.                                                                                                  |

Responses use the same protocol version and existing attempt/envelope schemas. A generic
`authorization_outcome_unknown` response is used for unexpected mutation failures because a
database commit may have succeeded before the reply was lost. The broker retries admission
only with the same `requestId`; it must not retry provider submission after `submitting` or an
uncertain response. Recovery must inspect the persisted status and reconcile by stable attempt
and provider-submission identities. `admitted` can be safely left pending or interrupted;
`submitting` is uncertain and must never be resubmitted. Revocation blocks future admission;
cancellation is confirmed only by an explicit provider `interrupted` event.

The bounded recovery scan is necessary after broker restart and returns no prompt text or
signing material. Pagination uses attempt UUID ordering; clients must continue with the last
returned ID until the page is empty. This is a status read, not an execution lease. The current
repository has no connector worker lease/dispatch queue, so concurrent broker singleton
enforcement remains Codex #3's platform responsibility.

## Signing-key custody

The authorizer's Ed25519 private key is loaded only from an owner-only, non-symlink regular
file owned by the authorizer UID. Only the authorizer process receives the file path/key
material and passes a signing closure to `PostgresConnectorAuthorizationStore`. The new broker
socket is enabled only when its separate service token, socket path, key file, key ID, and key
validity window are all configured. Partial configuration fails authorizer startup. No
private-key bytes are included in IPC responses or logs.

The broker must be configured independently with a pinned public trust anchor matching the
envelope `keyId`, plus explicit `notBefore`/`notAfter`. Unknown, expired, retired, invalid, or
out-of-window keys fail closed. Existing envelope verification limits validity and rotation
overlap to 60 seconds. Rotation requires provisioning the next public anchor before authorizer
activation and removing the old anchor after overlap; no endpoint dynamically trusts keys.
Tests use disposable Ed25519 keys only.

## Synthetic fake-provider network protocol for Codex #3

The backend intentionally does not implement an HTTP server, host firewall, container network,
or egress policy. Codex #3 owns those changes. The platform fake-provider adapter must use this
single fixed destination and transport:

```text
http://omnis-synthetic-provider:8787
```

No caller-controlled URL, host, port, path prefix, proxy, DNS server, or redirect is accepted.
The client uses an explicit fixed endpoint table, disables redirects, enforces the resolved
synthetic service address/network, and fails closed if the endpoint or egress policy is
unavailable. The only allowed application paths are:

- `POST /v1/submissions` — submit the versioned synthetic request containing `attemptId`, the
  signed envelope, and ephemeral rendered request. The fake verifies envelope bindings and
  digest. `attemptId` is its idempotency key; same-ID/same-body returns the same synthetic
  submission, while same-ID/different-body returns `409`. A valid accepted submission returns
  `202`; a deterministic completed fixture may return `200`; explicit policy rejection returns
  `422`; a failure proven to occur before acceptance returns `503`. The response body is the
  versioned correlated event schema. If the connection is lost after acceptance, the broker
  records `unknown` and does not POST again.
- `GET /v1/submissions/{providerSubmissionId}/events` — retrieve deterministic events, each
  carrying the original `attemptId`. Store event IDs and contents are stable across reads.
- `DELETE /v1/submissions/{providerSubmissionId}` — request cancellation. A response saying
  `requested` is not proof of termination; only a correlated `interrupted` event confirms it.
  Submission IDs use only URL-safe `[A-Za-z0-9._~-]` characters and remain path components,
  never full URLs.

Each request uses `Authorization: Bearer <synthetic-only test token>`, generated for the
disposable fake-provider environment. It is not a provider credential. It must not be logged,
returned to the guest, stored in PostgreSQL, or reused outside fake tests. Request body limit is
64 KiB. Connect timeout is 1 second and total request timeout is 5 seconds; cancellation and
event polling are bounded to 2 seconds each. No retries are allowed for submission POST after
the request may have been sent.

Test fixtures are selected by fake-provider startup configuration keyed to predeclared
synthetic attempt IDs, never by a broker-supplied arbitrary URL or free-form scenario header.
The fake must support accepted/completed, explicit rejection, delayed response, failure before
acceptance, connection loss after acceptance, delayed cancellation acknowledgement, repeated
identical events, and conflicting event-ID contents. A lost response after acceptance is
persisted as `unknown` with unknown billing exposure; there is no automatic resubmission.

The following are **network enforcement** tests and cannot be proven by mocked HTTP or
in-memory provider tests: successful access to the one fixed fake destination; denial of public
internet, cloud metadata, host/private services, alternate DNS, proxy variables, redirects,
alternate ports, and caller-controlled URL attempts; and failure closed when the network policy
or fake endpoint is unavailable. Socket peer UID/GID, file modes, broker DB/secret absence, and
synthetic canary non-leakage across process/container boundaries also require disposable
platform tests from Codex #3.

## Current deployment and Run SSE constraints (2026-11-09)

Main is `076b0c2668c76b5e21f31621c0e3c1eaf0fbe824`; its CI run
[42524011075](https://github.com/Jeysibn/omnis-os/actions/runs/42524011075) passed all eight
jobs. This is repository/CI evidence, not evidence that the Compose application or systemd
services are installed on the owner's host. The owner's 2026-11-09 platform handoff reports
WSL2 Ubuntu 26.04.1 with systemd running, but no Omnis systemd units, service accounts,
`/etc/omnis` configuration, runtime sockets, or listeners on ports 5432 and 8080. Therefore
target-host service identity, socket peer credentials, restart behavior, and host egress
enforcement remain unverified. The handoff also reports that the current user's Docker-group
membership grants root-equivalent Docker authority; no real credentials may be placed on this
host under the current boundary.

PR #87 closes an active Run SSE connection when its owning in-process session is logged out,
rotated, expired, or invalidated. The session store and stream registry are process-local
(`apps/api/src/session-store.ts` and `apps/api/src/run-event-stream-registry.ts`). The supported
API deployment is therefore one replica. Do not scale the API horizontally until session
validation and invalidation are shared across replicas, and integration tests prove that
revocation closes an already-open stream on every replica. CI does not launch the full
`docker-compose.app.yml` topology as a deployed application and cannot establish this host
behavior.

PR #86 adds bounded, read-only reconciliation of a late authoritative broker attempt into an
unknown Run projection; PR #87 adds the session-bound SSE closure described above. Neither
changes the production runtime selection: the owner-facing worker remains mock-only, while the
broker exercise remains synthetic and test-only.

## Scope and residual blockers

- No migration or database role change is required. Existing authorizer credentials are used
  only by the authorizer; the broker receives no database access.
- Production worker startup remains hard-wired to `SandboxedMockRuntimeAdapter`.
- This IPC contract does not itself prove peer UID isolation, network egress isolation, or
  provider transport security.
- The current rootful Docker launcher remains host-root-equivalent. No real credentials may
  be stored on that host; real custody still requires a protected VM/host or an independently
  reviewed removal of that authority.
- G4-3: Partially Fixed. R1-G5: Partially Complete. AO-107/AO-113: BLOCKED. Production remains
  mock-only.

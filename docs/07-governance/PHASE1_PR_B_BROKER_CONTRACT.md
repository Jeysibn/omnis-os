# Phase 1 PR B — Synthetic Broker Contract

Status: synthetic-only implementation contract. It does not approve provider authentication,
credentials, network access, inference, or production runtime selection.

## Authority and decision envelope

`PostgresConnectorAuthorizationStore.consumeForBroker()` consumes the existing PR #43 grant,
inserts one `connector_execution_attempts` row, stores the signed envelope and nonce, marks
the grant consumed, and appends the consumed audit event in one PostgreSQL transaction. It
cannot create or approve a grant. An idempotent repeat returns the same persisted attempt and
envelope; it never signs a new attempt. `mock.execute` remains a separate authorization path.

The `omnis.connector-decision.v1` envelope uses Ed25519, issuer `omnis-authorizer`, and the
single audience `omnis-synthetic-broker`. It binds owner principal, authorization/decision,
run/attempt/request/correlation, project and task revisions, immutable agent profile version,
exact rendered-request SHA-256 digest, fixed synthetic connector/provider/model/operation,
empty capabilities, limits, grant expiry, revocation generation zero, key ID, and unique nonce.
The request text and provider credentials are absent.

The signing private key is injected as a signing closure into the authorizer store and must
remain in that authorizer process boundary. The broker receives only an envelope and explicit
public trust anchors. No key file, secret-store integration, or production key is added here;
tests create disposable Ed25519 keypairs. Key IDs are immutable identifiers. A rotation may
temporarily publish old and new public anchors, but overlap must not exceed the 60-second
maximum envelope lifetime. Verification rejects unknown keys, envelopes that outlive a key,
expired keys, future-issued envelopes beyond clock skew, wrong audience, expired grants, and
invalid signatures. Unavailable trust or authorization fails closed. The durable nonce and
unique attempt/authorization constraints prevent replay; envelope validity alone does not
admit a submission.

## Broker-facing operations

- Authorizer `consumeForBroker(authorizationId, exactBoundRequest, requestId)` validates and
  consumes the existing owner grant. `requestId` is the stable execution idempotency key.
  It returns a persisted attempt plus the exact short-lived envelope.
- Broker receives the rendered request ephemerally, recomputes the existing canonical request
  digest, and compares it to the signed claim before calling authorizer
  `beginSyntheticSubmission(attemptId, envelope, renderedRequest)`. The authorizer independently
  repeats the digest check, compares the envelope digest to the persisted envelope, and rechecks
  expiry, revocation, generation, nonce, and attempt state while holding the grant lock. It does
  not persist request text. This commits `submitting` before the provider port call.
- Broker reports provider evidence through `recordSyntheticProviderEvent(attemptId, event)`.
  Strict event schemas bound event ID, state, optional provider submission identity, usage
  provenance, and completed response. The authorizer fingerprints each event, accepts an
  identical replay as a no-op, rejects event-ID reuse with different contents, and commits the
  attempt transition with its append-only audit event.
- These are in-process synthetic milestone interfaces. The future platform integration must
  transport them over authenticated IPC; the envelope signature does not authenticate the IPC
  peer, and socket peer identity does not replace authorizer admission.

## Submission lifecycle and uncertainty

`admitted -> submitting` is committed before the fake provider interface is called. The
authorizer checks the grant again under its row lock, so revocation racing admission wins or
loses atomically. Submission is never retried from `submitting` or `unknown`. A worker/broker
restart that cannot establish the provider result records `unknown` with billing exposure
unknown. Provider event IDs are unique per grant in append-only authorization audit, so
duplicate callbacks are idempotent. Out-of-order state regressions are rejected by both the
store and PostgreSQL transition trigger.

Supported transitions are `admitted -> submitting|interrupted`,
`submitting -> accepted|failed|unknown|interrupted`, `accepted -> running|completed|failed|
unknown|interrupted`, `running -> completed|failed|unknown|interrupted`, and evidence-based
reconciliation from `unknown` to a provider-supported terminal or active state. Cancellation
is a durable request timestamp, not proof of provider termination. Only an explicit
`interrupted` provider acknowledgement records termination. Revocation blocks a not-yet-started
submission and requests cancellation of in-flight work; it does not rewrite provider truth.

## Usage provenance

Measured values identify their authoritative source; estimates carry a method; unknown values
carry a reason and no numeric usage fields. Uncertain submission has unknown billing exposure.
Synthetic usage is not provider billing and no subscription cost is inferred from tokens.

## Codex #3 platform handoff

Platform integration is not part of this PR. Codex #3 owns a future platform PR that must:

- Authenticate the IPC peer independently of the signed authorization decision.
- Restrict the broker socket to the authorizer/broker service identities and prevent the guest
  from supplying an owner identity or decision.
- Deliver the envelope to a broker that verifies the configured public trust anchor, audience,
  key validity, expiry, full request binding, nonce, and current authorizer admission result.
- Ensure the guest receives neither the signing private key nor provider credentials.
- Keep network egress denied except for a separately approved fake-provider endpoint during
  synthetic testing; deny DNS/redirect/proxy escape and fail closed if policy is unavailable.
- Test forged peer identity, forged decision, envelope replay, duplicate IPC, restart after
  submission, revocation races, egress denial, and credential-canary absence from guest-visible
  logs/responses/events.
- Demonstrate isolation against the current rootful Docker launcher authority. Do not place
  real provider credentials on the launcher host: a protected VM/host or independently
  verified removal of its host-root authority is still required.

The current broker harness is not wired into `apps/worker`; production remains
`SandboxedMockRuntimeAdapter`. This contract is not proof of host isolation or a real provider
boundary.

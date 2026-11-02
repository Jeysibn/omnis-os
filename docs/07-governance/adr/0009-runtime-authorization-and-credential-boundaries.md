# ADR-0009: Runtime authorization and credential boundaries

**Status:** Accepted for durable mock-only authorization foundation; real runtime integrations remain blocked

**Date:** 2026-11-03

## Context

A runtime adapter describes its capabilities but cannot authorize itself. R1-G4 needs durable, task-scoped approval and revocation that survive worker restarts, plus an auditable record of security decisions. The current application has one owner login and only deterministic synthetic mock execution; it is not a multi-user identity or general-purpose IAM system.

## Decision

Omnis OS stores authorization requests, decisions, scope, expiry, consumption, revocation, and security audit events in PostgreSQL. The initial policy is intentionally fixed to the authenticated local `owner`, the `mock` runtime, the `execute_task` operation, the single `mock.execute` capability, and one task. Each authorization is consumed by at most one run.

The API derives the actor from its verified owner session and CSRF-protected route; it does not accept a caller-provided actor field. The API-to-worker boundary uses the existing private loopback endpoint and internal token. The worker maps that trusted request to the fixed `owner` principal. Agent and adapter identities are never approval authorities. This trust model is only as strong as the existing single-owner login and internal-token boundary.

`omnis_authorizer` is a separate restricted database login used only in the trusted worker process for authorization lifecycle writes. `omnis_runtime` cannot directly insert, update, or delete authorization records; it can read them and append audit rows. Run admission invokes a narrowly scoped, migration-owned `SECURITY DEFINER` routine in the same transaction as run and queue admission. It atomically consumes the exact approved authorization. The worker rechecks durable state before claim and uses row locking at claim and completion to serialize revocation against those state transitions. Revocation takes effect when its database transaction commits: a claim or completion that acquired the authorization lock first may commit before revocation; operations reaching the lock after revocation commit fail closed. This cannot undo an external side effect already completed, and no external side effects exist in the mock-only runtime.

Authorization lifecycle and run-operation audit rows are written in the same database transactions as the corresponding request, decision, revocation, admission, claim, and terminal transition where practical. Expiry is effective according to PostgreSQL time and is recorded when an expired authorization is next read through the authorizer store. Database or policy lookup errors prevent admission or execution.

The implementation does not change the database constraints requiring `runtime_kind = 'mock'` and `synthetic IS TRUE`. It does not add a provider adapter, credentials, network access, or arbitrary tool execution.

## Future connector boundary

Any later model-only connector must keep these responsibilities separate:

1. **Trusted credential broker:** holds provider credentials, supports revocation, and never passes secrets to an execution sandbox.
2. **Provider communication:** applies the provider's supported authentication and policy requirements from a trusted connector identity.
3. **Runtime authorization:** checks a durable actor-, operation-, capability-, scope-, and run-specific grant before each provider operation.
4. **Untrusted tool execution:** remains separately sandboxed, with explicit filesystem, process, and deny-by-default egress controls. General-purpose tools are not authorized by this ADR.
5. **Workspace data:** passes only task-scoped data; provider secrets do not enter workspaces, sandbox environments, logs, or events.
6. **Audit:** records connector provenance, authorization checks, revocation outcomes, and safe reason codes without credentials or unnecessary prompt content.

Before model-only execution, separately approve provider policy and authentication, a connector credential broker, in-run revocation behavior, network controls, connector identity, per-run authorization, and synthetic credential-canary verification. Do not reuse Hermes, Codex, or Claude local OAuth state or create a token tunnel.

## Consequences and limitations

- Authorization state and audit history survive API/worker restarts because PostgreSQL is authoritative.
- The fixed owner principal is derived from the current owner-session boundary; multi-user identity, delegated approvals, and independently attributable human approvers are not implemented.
- Audit rows are append-only for ordinary runtime SQL privileges, but the database administrator can change them and the runtime can append rows. This is not a cryptographically immutable or independently anchored audit log.
- Expiration is derived from the timestamp rather than a separate persisted `expired` status transition.
- Revocation cannot reverse an operation that committed before the revocation transaction.
- No Hermes, Codex, Claude, or other provider inference, credential access, connector network access, or arbitrary agent tool execution is enabled.

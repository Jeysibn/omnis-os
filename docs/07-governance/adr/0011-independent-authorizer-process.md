# ADR-0011: Independent authorizer process boundary

**Status:** Proposed; mock-only application boundary implemented for review

**Date:** 2026-11-03

## Context

The prior worker process loaded both the `omnis_runtime` and `omnis_authorizer` PostgreSQL credentials and exposed the owner authorization routes. Distinct PostgreSQL roles did not protect the owner decision boundary when their credentials were available to one worker process.

## Decision

Owner session and CSRF validation stay in the API. The API sends approval, decision, and revocation operations to a distinct loopback authorizer process using a dedicated service token. The authorizer accepts no caller-supplied actor identity, assigns the fixed `owner` principal only after service authentication, validates the input schema, and uses the `omnis_authorizer` role for transactional state and audit writes. Authorization request idempotency keys are supplied by the API caller and uniquely persisted, so a replay returns the original task-scoped request. If the authorizer or PostgreSQL is unavailable, the API returns a failure and never falls back to worker-side approval.

The worker starts with only the `omnis_runtime` connection and API-to-worker token. It has no authorization approval or revocation endpoints. It continues to perform existing persisted-grant checks during admission and run execution. Runtime admission no longer accepts an owner actor header, and migration `0010` removes the actor argument from both runtime grant-lock and consumption functions. The database checks the persisted `requesting_actor='owner'` grant and writes consumption audit events under `service:omnis-runtime`. Runtime denial auditing uses the restricted database append function; it cannot create owner decision events.

## Trust boundary limitations

This code change separates process entry points, configured database credentials, routes, and service tokens. The current local developer workflow still launches processes as one Unix user, stores private environment files readable by that user, and gives the worker Docker-daemon access. A compromised worker running under this identity may inspect same-user process environment or files, and Docker-daemon access can inspect or control other services. Loopback HTTP and distinct tokens therefore do not provide host-enforced isolation in this deployment. G4-3 is partially addressed, not closed.

Before any provider data or real inference is considered, deployment must establish distinct operating-system or container identities, narrowly scoped secret delivery, private authenticated transport, and a worker without control-plane or Docker-daemon access. A separate approval must define connector credentials, independently enforced in-run revocation, audit isolation, network egress, provider policy, and credential-canary verification. ADR-0010 remains Proposed. No provider integration or arbitrary tool execution is authorized by this ADR.

## Consequences

- Authorizer database credentials are absent from the worker's configuration and its process startup environment in the supported local scripts and integration harness.
- Runtime cannot assume the authorizer PostgreSQL role and cannot call owner authorization routes.
- Owner-facing approval and revocation behavior remains behind the API's existing session and CSRF controls.
- The authorizer is an additional required local service; its outage makes authorization decisions unavailable, fail-closed.
- Database authorization remains durable across authorizer restarts.
- This change does not make a compromised host, same-UID worker, or Docker-daemon holder trustworthy.
- Real Claude, Codex, Hermes, OpenAI, or other provider execution remains disabled.

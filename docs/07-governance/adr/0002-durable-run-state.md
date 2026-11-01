# ADR-0002: Database-Authoritative Tasks, Runs and Events

- **Status:** Proposed technical decision
- **Date:** 2026-11-02

## Context

The UI, schedules, analytics and 3D simulation must agree on current agent activity despite browser refresh, failed network streams and worker restarts. Runtimes may report events out of order or without strong exactly-once guarantees.

## Options

1. Runtime session files as source of truth - minimal app DB, but adapter-specific and difficult to reconcile.
2. UI-derived state - simple demo but inconsistent across browsers/restarts.
3. PostgreSQL canonical task/run/event ledger plus external runtime mapping - more upfront design, durable and cross-runtime.

## Decision

Keep canonical task/run transition and app event sequence in PostgreSQL. Runtimes are event producers, not authoritative owners of project acceptance. Each execution attempt maps to external runtime ID and stores adapter generation/idempotency information. SSE and office are projections only.

## Consequences

- Reconciliation and event de-dup code required.
- Run `completed` is not task `accepted`.
- External effects cannot be blindly rolled back or assumed absent after disconnect.

## Revisit when

An event sourcing or streaming platform is demonstrably necessary for scale; preserve app-level idempotency and audit semantics either way.

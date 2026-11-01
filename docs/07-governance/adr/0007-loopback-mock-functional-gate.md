# ADR-0007: Loopback Mock Functional Gate

- **Status:** Proposed for owner review
- **Date:** 2026-11-02

## Context

Phase 0 did not establish an authorized real runtime or a usable PostgreSQL service. A first reviewable slice is still needed to validate Omnis OS task admission, event contracts, cancellation, and the operator workflow without contacting a provider or invoking local tools.

## Decision

For the first functional gate only, run the web app, API, and synthetic worker on loopback. Require a single local owner session for API access, protect mutations with same-origin and CSRF checks, and label every mock event/output as synthetic. The API must not execute native tools. Mock records may remain in process memory for this gate; worker restart durability is explicitly out of scope.

This is a temporary implementation boundary, not approval for remote exposure or real provider credentials. It does not replace [ADR-0002](0002-durable-run-state.md), which remains the proposed target for PostgreSQL-authoritative task, run, and event state.

## Consequences

- Review can proceed on the lifecycle UI and runtime adapter contract without provider inference or billing.
- The first gate can reconstruct state after a browser reload only while the worker process remains alive.
- Secure cookie deployment, durable secret/session storage, worker OS isolation, network egress rules, PostgreSQL persistence, manual verified-result acceptance, and real runtime permissions remain later gates.
- Synthetic output must not be displayed or accepted as verified provider evidence.

## Revisit when

Before enabling any real runtime or exposing the app beyond loopback, and before claiming R1 completion.

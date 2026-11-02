# ADR-0009: Runtime authorization and credential boundaries

**Status:** Accepted for mock-only authorization scaffolding; real runtime integrations remain blocked
**Date:** 2026-11-02

## Context

A runtime adapter describes what it can do, but must not authorize itself to do it. Future integrations will also need to keep provider credentials away from untrusted tool processes and agent workspaces. Omnis OS currently supports only deterministic synthetic mock execution.

## Decision

Omnis OS owns authorization records. Each record identifies the initiating actor, selected runtime, operation, allowed capabilities, scope, approval requirement, authorization status, policy version, expiry, revocation state, and provenance. Admission checks the Omnis-owned record before creating a queued run. The trusted worker checks it again immediately before claiming execution. Missing, expired, revoked, pending, denied, or insufficient records fail closed. Adapter capability discovery is descriptive and cannot grant permission.

The initial implementation is deliberately limited to an explicit local owner grant for the mock runtime and `mock.execute`. It is an in-memory policy foundation for the current single-owner process, not a durable authorization registry, multi-user identity system, or approval workflow. No real runtime adapter is implemented. PostgreSQL checks requiring `runtime_kind = 'mock'` and `synthetic IS TRUE` remain unchanged.

For any future real integration, keep these responsibilities separate:

1. **Trusted model authentication:** a connector or provider broker owns provider credentials and refresh/revocation operations.
2. **Provider communication:** a trusted connector applies the provider's supported authorization and policy requirements.
3. **Runtime authorization:** Omnis OS authorizes each actor, runtime, operation, capability, scope, and run; approval and revocation are first-class.
4. **Untrusted tool execution:** tool processes run in a separately restricted sandbox with explicit filesystem, process, and egress policy.
5. **Agent workspace data:** task inputs and workspace data are passed through narrowly scoped interfaces; provider secrets are not copied into the workspace or sandbox environment.
6. **Audit events:** authorization decisions, approvals, revocation, connector activity, and tool actions are recorded with actor, run, policy version, and outcome while redacting credential material.

Provider credentials must remain in the trusted connector or broker. Do not build a token tunnel, reuse local Claude/Codex/Hermes OAuth state, or mount provider credentials into arbitrary tool execution. Before any provider is authorized, verify provider policy compliance, consent for background operation, per-run grants, capability enforcement, deny-by-default network egress, revocation behavior, and synthetic credential-canary absence from runtime environment, files, output, events, database records, and logs.

## Consequences

- Mock task admission and execution are checked against Omnis policy independently of adapter declarations.
- Revocation is checked again before a worker claims queued work; revoked queued work is interrupted without execution or automatic retry.
- The authorization records are currently process-local. A durable, owner-managed policy store and audit trail are required before real runtimes or multiple actors.
- No provider inference, credentials, or third-party network access are enabled by this decision.

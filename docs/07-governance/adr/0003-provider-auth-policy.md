# ADR-0003: OAuth-First, Provider-Authorized Native Runtime Use

- **Status:** Accepted preference; policy implementation gated
- **Date:** 2026-11-02

## Context

The owner wants existing Claude and Codex subscriptions and Hermes provider logins used instead of unpredictable per-token API billing where possible. However, OAuth proves identity, not necessarily an entitlement for third-party automated workflows. Native runtimes require carefully scoped tools and secrets.

## Options

1. Intercept/substitute subscription OAuth tokens in a custom API proxy - technically brittle and may violate provider terms.
2. Use native authorized CLIs/gateways with policy probes and do not extract credentials - preserves legitimate auth boundaries but capabilities differ.
3. API keys for all agents - straightforward automation but potentially metered costs and different access rules.

## Decision

Prefer option 2 for interactive and permitted execution. Do not build a token tunnel or impersonate first-party apps. Disable unverified unattended subscription automation. A metered API may be used **only** via a separately approved future opt-in with budgets and billing display.

## Consequences

- Runtime adapters must present supported capabilities, `allowed_use`, plan/entitlement unknowns, and usage quality.
- Claude Code background integration is feature gated pending official policy check; Codex automated use similarly verified.
- Private chat and scheduled agents can compete for shared subscription limits.

## Revisit when

Official provider developer programs, entitlement modes or terms materially change.

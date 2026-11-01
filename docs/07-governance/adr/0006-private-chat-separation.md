# ADR-0006: Private Chat Is Isolated from Operational Work

- **Status:** Accepted product direction
- **Date:** 2026-11-02

## Context

The user needs a conventional AI chat with selectable model and employee personality, while operational agents are executing projects and scheduled tasks. Reusing live agent sessions could contaminate state, memory or permissions.

## Options

1. Direct chat into operational employee thread - convenient but high risk to ongoing work.
2. Clone profile snapshot into a private session - repeatable personality without operational side effects.
3. Separate neutral-only chat with no agent personality - safest but does not meet product need.

## Decision

Private/Profile Chat uses option 2, with no tools or memory access by default. Explicit operational interactions live in a distinct agent-workspace mode and require authorization. Shared model subscription quota remains a common resource and is managed separately.

## Consequences

- More session and context lifecycle management.
- 'Chat to task' and 'knowledge proposal' must be explicit reviewed transitions.
- UI must visibly label private vs operational mode.

## Revisit when

The owner requests a gated 'ask agent about live task' experience; implement as an authorized read-only task inspector, not raw session sharing.

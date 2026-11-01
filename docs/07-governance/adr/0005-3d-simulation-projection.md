# ADR-0005: Virtual Office Is an Event-Driven Projection

- **Status:** Accepted product direction; renderer proposed
- **Date:** 2026-11-02

## Context

A game-like company office is compelling, but it must not misrepresent autonomous work, become the scheduler, or force GPU rendering while ordinary operations are underway.

## Options

1. Scripted fake employee activity as production UI - visual appeal but misleading.
2. 3D scene owns execution state - couples game state with business logic and breaks restart/reconnect.
3. State-driven 3D read model with optional 2D fallback - honest, replaceable, accessible.

## Decision

Build option 3. Read persistent run events and project/agent state; map to avatar animation. Scene-specific camera/pose state is ephemeral. Operational actions are explicit control-plane commands with normal authorization.

## Consequences

- Need deterministic state-to-pose mapping and staleness rules.
- Mock data allowed only under visible DEMO banner.
- More UI engineering for accessible 2D fallback, rendering performance and asset licensing.

## Revisit when

User testing favors simpler visualization, or host performance cannot sustain a dedicated 3D route.

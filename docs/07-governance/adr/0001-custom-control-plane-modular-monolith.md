# ADR-0001: Build a Custom Modular Control Plane

- **Status:** Accepted product direction; proposed implementation style
- **Date:** 2026-11-02

## Context

The owner selected a custom control plane for Omnis OS rather than a fork of an existing agent control-plane product. Ten user-facing modules share operational state and need consistent authorization, auditability and lifecycle rules. A one-module-per-service approach would amplify deployment, schema and debugging complexity early.

## Options

1. Fork Paperclip/OpenFang. Faster feature adoption; harder to own product architecture and UX.
2. One custom modular monolith. Unified state and transactions, fewer operational services, still testable internal seams.
3. Microservices from day one. Independent scaling but heavy networking, distributed consistency and operations costs.

## Decision

Build our own modular Fastify/TypeScript control plane, with separate privileged agent execution workers. Agents are integrated through runtime adapters. Avoid microservices until observed scaling or isolation constraints justify extraction.

## Consequences

- Requires explicit module ownership and interface/contract tests to prevent a monolith becoming tangled.
- Simpler transactions and event state across projects, runs, approvals, knowledge and usage.
- Worker isolation remains nonnegotiable; 'monolith' does not mean executing native CLI processes inside public API handlers.

## Revisit when

Load, security segregation, or operational ownership requires independently scaling a documented module.

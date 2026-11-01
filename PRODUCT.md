# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React, Vite, Tailwind CSS, Fastify, and strict TypeScript, selected for the first functional gate from the proposed handoff. pnpm version `12.16.1` is proposed from the available npm registry and is not yet owner-approved.

## Users

One owner operating a local agent command center.

## Product Purpose

Omnis OS manages agents, projects, tasks, and runs. The target workflow lets the owner create a task, start an authorized read-only run, observe authentic events, cancel when needed, inspect output, manually accept a verified result, and reload without losing state.

## Positioning

The command center presents agent work as governed operational records: explicit grants, inspectable run events, evidence, and a human acceptance step.

## Operating Context

The first environment is a single-owner local WSL/Linux host. Native agent runtimes may have powerful tools and provider credentials, so app/API processes must not inherit those privileges. Real execution belongs behind a restricted worker/runtime boundary.

## Capabilities and Constraints

- The first implementation gate is a deterministic mock run lifecycle.
- Mock activity must be visibly synthetic and must not appear as real provider activity.
- Real provider use is blocked until policy, credential ownership, tool restrictions, isolation, and a supported runtime probe are approved.
- Claude background execution remains disabled pending owner/policy review.
- No third-party token tunnel may be created.
- Provider secrets must never appear in browser code, logs, connection metadata, or committed files.
- Docker access is currently denied in the host environment.

## Brand Commitments

Use the name Omnis OS in the application, documentation, and navigation. The first run lifecycle screen uses a dark operations-console direction, as selected for this gate.

## Evidence on Hand

The handoff defines the R1 success workflow and implementation constraints. Phase 0 environment/runtime evidence is recorded in `docs/07-governance/`. No real provider execution proof, production customer, or operational capability is claimed.

## Product Principles

- Keep identity and authority visible at the boundary where work is admitted.
- Preserve an ordered event record users can reconstruct after refresh.
- Distinguish mock, unknown, recovered, and real provider states in both data and presentation.
- Require human acceptance of verified results.
- Stop real execution when policy or isolation is unproven.

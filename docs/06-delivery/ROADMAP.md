# Phased Implementation Roadmap

**No fixed calendar promised.** This is an ordered sequence with concrete exit gates, not a completion-time estimate. Finish one gate before advertising the next release as operational.

## Phase 0 - Discovery and entitlement validation

Deliverables: environment inventory, runtime policy matrix, native Hermes/Codex/Claude smoke test evidence, chosen model paths, permissions baseline, feature-flag plan, dependency version decision, release 1 risk list.

Exit: owner accepts policy limitations and a safe first runtime; no credentials copied to codebase. See `PHASE_0_1_HANDOFF.md`.

## Phase 1 - Foundation and first working task

Deliverables: typed monorepo, auth/private access, PostgreSQL migrations, Agent/Department/Project/Task/Run entities, Fastify API, one verified runtime adapter, durable events/SSE, cancellation, evidence panel, basic usage event ingestion, initial command center, tests/CI.

**Current checkpoint:** R1-G1 delivered the PostgreSQL-backed mock task/run/event slice. R1-G2 locally verified the mock execution container, filesystem/credential isolation, default-deny network, resource limits, cancellation, and lease-based orphan cleanup. The Phase 1/R1 exit gate remains open: no real runtime is authorized, broader domain entities are not implemented, remote CI and production sandbox deployment are unverified. See the R1-G1 and R1-G2 evidence reports.

Exit: task can complete or fail honestly; browser reload/worker restart preserves state; audit and authorization enforced.

## Phase 2 - Multi-runtime and AI Chat Workspace

Deliverables: runtime capability matrix, supported Codex and Claude paths after policy gates, model picker, isolated private/profile chat, chat history/streaming, per-chat usage, controls to convert chat to a task.

Exit: casual chat never touches operational task/memory, unsupported models unavailable, shared provider contention handled.

## Phase 3 - Skills/MCP and Shared Second Brain

Deliverables: versioned Skills, quarantine/import review, MCP registry, tool grants, knowledge proposals/revisions, project ACL and search, local embedding optional.

Exit: tool abuse blocked by gateway/host permissions, cross-project knowledge cannot leak, reviewed docs searchable with citations.

## Phase 4 - Project workflows, schedules and budgets

Deliverables: milestones/epics/dependencies, scheduling+occurrences and recovery, overlap/missed policies, human approval UX, actual charges vs estimated value, budget alerting, project review dashboard.

Exit: controlled automated run, no duplicated side effects after crash, quota unknown handled safely.

## Phase 5 - Multi-agent collaboration and 3D office

Deliverables: team/delegation, evidence handoffs, minimal low-poly office with real event mapping, employee inspector, department room layout, 2D fallback.

Exit: scene matches backend state after reload/outage; delegation bounded and attributable; acceptable performance on target host.

## Phase 6 - Production operations

Deliverables: backup/restore drill, secrets handling, private DNS/CA/TLS, k3s deployment, worker isolation, database migrations, observability, load testing, regression security audit and rollback procedure.

Exit: documented production readiness checklist passes; no runtime or DB ports publicly exposed.

## Stage ordering rules

- You may develop a **visual-only 3D prototype** in parallel with Phase 1 if it has no privileged runtime connection and is labeled DEMO.
- Real scheduling cannot precede durable task admission/recovery and provider background-use verification.
- Skill marketplace cannot precede a content quarantine/scanning and approval flow.
- Multi-agent delegation cannot precede run cost attribution, scopes and approval enforcement.
- k3s deployment cannot precede local rollback and backup/restore tests.

## Release labels

`prototype` = mock-only; `alpha` = one verified workflow; `private-beta` = multiple gated modules; `production-ready` = Phase 6 acceptance. Never use 'complete' to mean the UI contains placeholders.

# Omnis OS - Master Implementation Plan

**Version:** 1.1 (project branding update; technical scope unchanged)  
**Status:** Scope agreed, architecture proposed; no code yet.  
**Date:** 2026-11-02  
**Product name:** Omnis OS (selected by owner).  
**Repository slug:** `omnis-os`.  
**Trademark/domain status:** Not verified; do not infer availability.

## 1. Vision

**Omnis OS** is the project identity; the platform is a local-first, private multi-agent company operating system. One director controls AI employees with personalized identities, professions, capabilities, and knowledge. Agents can collaborate on real projects and tasks, scheduled routines, and approved automation. A separate personal AI chat area supports isolated conversations. A 3D isometric office simulates actual activity, without becoming the source of truth. Cost analytics separates token usage and estimated value from actual charges.

## 2. Non-negotiable principles

1. **Own the control plane.** Custom product, not an existing platform fork.
2. **Reuse runtimes.** Hermes, Codex, and Claude Code are adapters, not recreated LLM engines.
3. **OAuth-first, policy-first.** Authorized native subscription flows where available; no subscription-token impersonation, token extraction, or unexpected metered API fallback.
4. **Data integrity.** The database is the canonical operational state; execution events are durable.
5. **Least privilege.** An agent's job title or personality is never authorization.
6. **Separate contexts.** Private chat, operational runs, personal memory, shared knowledge, and raw logs are distinct.
7. **Evidence-driven results.** Agent 'done' messages are not proof of task acceptance.
8. **Real state drives simulation.** No fictitious work statuses outside clearly labeled demo mode.
9. **Designed for one owner first.** Strong isolation and schema boundaries to support users later, but no unnecessary enterprise multi-tenancy in MVP.
10. **Incremental delivery.** Build a working vertical slice before automation, full 3D office, and large teams.

## 3. Ten first-class modules

The product uses the name **Omnis OS**. Proposed screen aliases are documented in `docs/04-design/BRAND_IDENTITY.md`; canonical module vocabulary below remains the architecture source of truth.

| Module | Purpose | MVP or later |
|---|---|---|
| Command Center | Agent, task, approval and system visibility | MVP shell |
| Agents & Profiles | Identity, personality, profession, versioned instructions, departments | MVP |
| Skills & Integrations | Skills, MCP connections, grants, auditing | Basic registry MVP; execution later |
| Shared Second Brain | Project/global knowledge, provenance, semantic retrieval | After first run |
| Tasks & Orchestration | Durable task/run lifecycle, approvals, delegation | Single-agent MVP; collaboration later |
| 3D Virtual Office | Event-driven employees, rooms, departments | Early mock; integrated later |
| Cost & Usage Center | Usage ledger, estimated value, actual spending, budgets | Basic event model MVP; dashboards later |
| Automations & Scheduler | One-time, recurring, event/conditional workflows | After task engine |
| AI Chat Workspace | Separate sessions and profile-based isolated chat | First runtime integration tranche |
| Project Management | Goals, epics, milestones, dependencies, deliverables, team | Foundation MVP; AI PM later |

## 4. Proposed technical direction

- **Web:** React + Vite + TypeScript, Tailwind, shadcn/ui; Zustand where state warrants.
- **Control plane:** Fastify + TypeScript modular monolith, REST + SSE.
- **Storage:** PostgreSQL as source of truth; pgvector later for semantic retrieval; Git-backed Markdown vault for approved knowledge.
- **Jobs:** pg-boss on PostgreSQL; no Redis requirement for MVP.
- **Runtimes:** Hermes API or supported gateway; Codex CLI/SDK and unmodified Claude Code through policy-verified adapters.
- **3D:** Three.js + React Three Fiber + Drei, low-poly environment and a 2D fallback.
- **Integration:** MCP stdio/remote transport based on tested protocol-version compatibility.
- **Local execution:** Docker Compose for app/database; isolated workers for tools and native CLI processes.
- **Target deployment:** Private homelab/k3s after tests and controls; remote access through private networking, not public open ports.
- **Operational language:** English first; time and schedules default to `Asia/Manila` (PHT, UTC+8).

These are proposed defaults, **not claims that dependencies are installed or integrations are working**.

## 5. Trusted execution path

Director -> Web UI -> authenticated Fastify control plane -> authorization and budget checks -> durable task/run record -> job worker -> selected runtime adapter -> sandbox/approved tools -> events/artifacts -> verification -> project state and optional Second Brain proposal. Chat uses a **different context and permission policy**. The 3D scene subscribes to read-only projections.

## 6. Release sequence

- **Phase 0: Investigation + guardrails.** Versions, entitlement/policy checks, capability probes, host security, acceptance targets.
- **Phase 1: Foundation + one real run.** Auth, DB, profile, project/task, Hermes-first adapter if verified, SSE, cancel, persistent history, test harness.
- **Phase 2: Runtime plurality + isolated chat.** Codex and Claude paths behind capability gates, per-chat sessions, model picker, token measurement.
- **Phase 3: Skills/MCP + knowledge.** Approved skill snapshots, scoped tool grants, global/project knowledge and write-review flow.
- **Phase 4: PM + workflows + automation.** Dependencies, milestones, scheduling, retries, announcements, budget controls.
- **Phase 5: 3D office integration + teams.** Real-state avatar mapping, departments, delegation, interactive inspector, reduced-motion fallback.
- **Phase 6: Production hardening.** Threat review, backup/restore drill, CI/CD, auditability, performance and k3s private deployment.

A 3D **mock-only prototype** is allowed earlier but must never be confused with a functional runtime.

## 7. MVP acceptance

- Single authenticated human can create an agent profile, a project and a task.
- Policy-verified local runtime connection passes a read-only smoke test.
- A task run has persisted lifecycle and SSE activity events; a page refresh reconstructs state.
- The run can complete, fail, or cancel with consistent state and logs.
- Task evidence is reviewable and task acceptance is independent of runtime exit status.
- Run usage is captured when exposed, else shown as `unknown`.
- Unit, integration, e2e and security smoke tests pass on a clean environment.

## 8. Cost and time policy

- Actual subscription invoices and provider API charges are independent from **API-equivalent value**.
- No invented token counts, quota percentages, or costs; unknown remains unknown.
- All internal timestamps stored in UTC with timezone metadata for future runs; displayed and user schedules default to PHT.
- Subscription quotas may be shared between autonomous work and personal chats.

## 9. Approval model

- Never silently deploy, merge, delete, alter infrastructure, post to public services, or spend money.
- Require explicit permissions and, for sensitive actions, a human approval bound to exact proposed arguments and expiry.
- Agent-produced Skills, tool descriptions, retrieved knowledge, and documents are untrusted inputs, not instructions overriding governance.

## 10. Source-of-truth hierarchy

1. Human-approved architectural decisions and system permissions.
2. Current project configuration and verified published knowledge.
3. Durable run/task events and artifacts.
4. Agent reports, proposals, and unverified external content.

See separate specs for each module, `docs/07-governance/DECISIONS_RISKS.md` for unresolved questions, and `docs/07-governance/REFERENCES.md` for vendor documentation and technical research.

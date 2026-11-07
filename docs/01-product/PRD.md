# Product Requirements Document (PRD)

## Product and users

**Name:** Omnis OS (selected official project name). **User:** One technical owner/director initially. **Deployment:** Self-hosted, private, browser accessible on trusted network. **Language:** English-first. **Timezone:** Asia/Manila by default.

## Identity and brand status

**Omnis OS** is the selected name; `omnis-os` is the preferred repository slug. Brand aliases remain proposed; see [Brand Identity](../04-design/BRAND_IDENTITY.md).

## Problem

General AI chats do not provide a persistent organization of agents with governed roles, shared knowledge, verified project delivery, separate casual chat, repeatable schedules, cost attribution, and a state-truthful 3D environment. Existing frameworks may provide agent reasoning but not the owner's preferred integrated control plane.

## Vision / value

A single place to define AI employees, give them tasks in projects, observe verified execution, approve important actions, manage reusable capabilities, preserve trusted knowledge, understand model usage, and explore the same organization through an optional 3D office.

## Goals

G1. One persistent project/task/run lifecycle with recoverable events and evidence.
G2. Hermes, Codex, and Claude Code integrated through policy-compliant, capability-probed native interfaces.
G3. Agent profiles that persist across runtimes without leaking context or privileges.
G4. Skills and MCP connections managed in one UI, with separate authorization and backend registries.
G5. Global/project-scoped Second Brain with provenance, review, access control and search.
G6. Private chats that cannot affect operational agents without an explicit authorized transition.
G7. Scheduled and event-triggered execution that respects limits, approvals and reliability policies.
G8. Token usage, reference value and actual costs reported distinctly.
G9. An expressive 3D company view reflecting real task events, with accessible 2D fallback.
G10. Private, testable, backup-able deployment using Docker Compose on a self-hosted Linux machine.

## Non-goals (initial releases)

- Build our own LLM inference model, AGI kernel, or vendor-auth proxy.
- Work around provider subscription restrictions or provide public SaaS subscription access to others.
- Fully autonomous software deployment/production modifications without human approval.
- Enterprise HR/payroll, realistic employee simulation AI, persistent 3D multiplayer gameplay.
- Native mobile app, voice/video meetings, public online user marketplace, distributed microservices.
- Guaranteed exact dollar accounting when only subscription token estimates are known.

## Personas

- **Director:** Creates profiles/projects, monitors all work, approves risk, asks questions, reviews results.
- **AI Project Manager:** Suggests work breakdown, dependencies, assignments, and progress reports; proposals require human review initially.
- **Specialist AI Employee:** Acts within role/profile, tools and project scope, leaves execution evidence.
- **Personal Chat User:** Same human director, but in isolated conversational mode with no operational side effects by default.

## Core user journeys

1. **New project:** Create project -> goals and acceptance -> milestone -> task -> assign employee -> execute -> inspect logs and artifact -> approve outcome.
2. **New employee:** Define identity/profession/personality -> choose runtime -> attach Skills and capabilities -> probe connection -> save profile version.
3. **Shared knowledge:** Agent reads scoped docs -> submits proposed insight -> review with sources -> publish revision -> other agents retrieve with citations.
4. **Private conversation:** Select profile and model -> open isolated chat -> read generated answer and measured usage -> optionally convert conversation to approved task.
5. **Scheduling:** Create task template -> cron/timezone or condition -> authorize scope and budget -> schedule -> inspect occurrence and results.
6. **3D observation:** Open office -> see employees in truthful states -> click avatar -> inspect current run -> open operational task if authorized.
7. **Cost analysis:** Filter by date/agent/project -> compare token categories -> view reference API-equivalent value vs actual charges and provider quota signals.

## Functional requirements

### Command Center
- REQ-CMD-01: Show current status and unread approvals sourced from persisted state.
- REQ-CMD-02: Link each actionable status to its underlying entity and evidence.
- REQ-CMD-03: Distinguish disconnected runtime, inactive agent, and idle agent.

### Agents & Profiles
- REQ-AGT-01: Create, edit, archive agents with immutable IDs and profile versions.
- REQ-AGT-02: Configure identity, profession, personality, instructions, autonomy, departments and team membership.
- REQ-AGT-03: Bind agents to runtimes and models without changing other agents' configuration.
- REQ-AGT-04: Separately grant workspace/Skill/MCP permissions (profession is not access control).

### Skills & Integrations
- REQ-SKL-01: Import, inspect, validate and pin Agent Skills from approved paths or reviewed sources.
- REQ-SKL-02: Register MCP connections, discover advertised capabilities and test health.
- REQ-SKL-03: Scope capabilities to agent, project, run and chat mode.
- REQ-SKL-04: Sensitive tools require explicit approval and audited execution.

### Second Brain
- REQ-KNW-01: Search global and authorized project knowledge by keyword; later hybrid semantic search.
- REQ-KNW-02: Allow agents to propose knowledge with citations and confidence classification.
- REQ-KNW-03: Review, publish, supersede and rollback knowledge revisions.
- REQ-KNW-04: Prevent search/index responses from including unauthorized documents.

### Tasks & Orchestration
- REQ-TSK-01: Persistent task/run distinction with retries, stop, cancel, interrupt and unknown states.
- REQ-TSK-02: Stream execution events and allow refresh/reconnect without losing durable history.
- REQ-TSK-03: Verify outputs against acceptance criteria before marking task accepted.
- REQ-TSK-04: Enforce preflight permission, authentication, usage and concurrency checks.

### Virtual Office
- REQ-3D-01: Reflect persisted employee/run state; no fabricated live activity.
- REQ-3D-02: Show departments, desks, avatars, interaction panels, simulated knowledge retrieval and handoffs.
- REQ-3D-03: Provide 2D fallback and reduced-motion modes.

### Cost & Usage
- REQ-CST-01: Attribute reported tokens and usage events to agent, model, runtime, run/chat, project.
- REQ-CST-02: Separate actual charged dollars from reference API-equivalent token value.
- REQ-CST-03: Mark missing/ambiguous quota and cost data explicitly unknown.
- REQ-CST-04: Enforce configurable billable spend and concurrency safeguards without relying on unverified quotas.

### Automations
- REQ-AUT-01: Define one-time, recurring timezone-aware schedules with manual run/pause/resume.
- REQ-AUT-02: Log occurrence, task run, retry, missed execution and overlap policy.
- REQ-AUT-03: Never bypass approvals/permissions in unattended runs.
- REQ-AUT-04: Event/conditional triggers follow after reliable scheduled MVP.

### AI Chat Workspace
- REQ-CHT-01: Select profile snapshot, authorized runtime/model, and isolated conversation.
- REQ-CHT-02: Default no tools, no operational memory reads/writes, no shared knowledge writes.
- REQ-CHT-03: Stream responses, preserve thread history, report usage or unknown.
- REQ-CHT-04: Require explicit, reviewed transition to create an operational task or publish knowledge.

### Project Management
- REQ-PRJ-01: Projects with goals, milestones, epics, tasks, dependencies, artifacts, team and permissions.
- REQ-PRJ-02: Status/progress based on verified tasks and recorded milestones.
- REQ-PRJ-03: Associate repository/workspace, knowledge scope, schedules, and usage/cost records.

## Nonfunctional requirements (engineering targets; validate in Phase 0)

- **Security:** default deny, signed-in owner, protected secrets, isolated runtime execution, private network exposure.
- **Reliability:** no duplicate task execution from UI retries; recovery actions explicitly separate unknown state from success.
- **Persistence:** operational entities, events and history survive process restart.
- **Performance:** aspirational p95 under 400 ms for ordinary local DB-backed API reads excluding inference; 3D cap 30 FPS default with pause when hidden; benchmark on actual hardware.
- **Accessibility:** WCAG-aligned keyboard navigation, focus states, reduced-motion and 2D alternative.
- **Privacy:** no credentials or unrestricted model tool logs in public dashboards.
- **Operations:** migrations, logs, metrics, backups, restore drill, dependency patch plan, resource limits.
- **Quality:** contract tests for runtime adapters; CI tests mock external providers.

## Product success criteria

For the initial release: a real read-only task with evidence, durable events, visible approvals/cancel behavior, an independently selectable private chat context, and no security/policy surprises. Later: an owner can execute multi-agent project workflows and inspect the same operational truth in the 3D scene.

## Risks / dependencies

Provider automation entitlement, token telemetry differences, native tools bypass risk, 3D/GPU contention, MCP prompt injection, knowledge cross-scope leakage, durable idempotency, and under-specified scheduler semantics. Resolved in specs and tracked in `../07-governance/DECISIONS_RISKS.md`.

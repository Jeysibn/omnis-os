# Omnis OS - Brand Identity and Naming Guide

**Status:** Product name selected by the owner on 2026-11-02. Visual design, screen aliases, and tagline are proposed and subject to user validation.

## Canonical identity

| Field | Direction |
|---|---|
| Product name | **Omnis OS** |
| Repository / package namespace (preferred) | `omnis-os` / `@omnis/*` |
| Category | Self-hosted AI organization operating system |
| Concise description | Coordinate AI employees, projects, skills, tools, memory, and work in one trusted workspace. |
| Suggested tagline | *One intelligence network. Infinite possibilities.* (proposed, not yet adopted as final) |
| Visual metaphor | An AI organization with a central shared knowledge library and specialized departments |
| Trademark / domain | Not researched or cleared; do not claim ownership or availability |

Use exactly **Omnis OS** in product headers, page titles, desktop window labels, docs, onboarding, and contributor instructions. Use `omnis-os` for repository, folder and service-name slugs when applicable. Avoid legacy names `Agent OS` as a product title or `agent-os` as the repository name. Generic descriptive terms such as *agent operating system* are still accurate in explanatory prose.

## Product architecture vocabulary

The ten module names below are canonical for specifications and permission models. Optional short branded names are **UI copy proposals**, not separate services or mandatory routes.

| Canonical module | Optional UI alias | Responsibility |
|---|---|---|
| Command Center | Omnis Command | Operations, alerts, approvals |
| Agents & Profiles | Omnis Workforce | Agent identity, profession, personality, runtime bindings |
| Skills & Integrations | Skills & Integrations | Skills, MCP connections, grants |
| Shared Second Brain | Omnis Knowledge | Approved shared organizational/project knowledge |
| Tasks & Orchestration | Tasks | Work items, runs, delegation, outcomes |
| 3D Virtual Office | Omnis HQ | 3D state-driven workforce simulation |
| Cost & Usage Center | Omnis Insights | Tokens, cost estimates, actual charges and quotas |
| Automations & Scheduler | Automations | Scheduled, conditional, and event-triggered work |
| AI Chat Workspace | Omnis Chat | Isolated private/profile chat |
| Project Management | Omnis Projects | Objectives, milestones, epics and project delivery |

Do not duplicate modules or backend databases solely to match a UI alias. Avoid showing all ten brand prefixes in the sidebar if it makes navigation harder; use concise names in navigation and full names in page headers or help content.

## Visual style direction (proposed)

**Character:** Professional, calm, technologically capable; interactive and human-scale without imitating a generic sci-fi HUD. The **3D office** may be playful; core operations should remain readable and efficient.

| Token | Color | Role |
|---|---|---|
| Navy | `#101927` | Dark app foundation |
| Slate | `#263750` | Sidebar and secondary dark surfaces |
| Soft White | `#EEF1F5` | Light background/surfaces |
| Blue | `#648DF6` | Primary actions, selection and focus |
| Teal | `#45C5AA` | Healthy, active and observed states |
| Amber | `#EAB56A` | Pending approval / human attention |

Type: **Space Grotesk** (short display headings), **Inter** (UI and content), **IBM Plex Mono** (timestamps, source events and token figures). Obtain fonts through proper licensed channels in implementation; no font binaries are included in this documentation pack.

The logo is *not finalized*. A geometric orbit motif can serve as a mockup placeholder, but do not invent a registered mark or claim design approval. Follow accessible contrast, visible focus, reduced-motion and responsiveness requirements in `UI_UX_SPEC.md`.

## Language and naming rules

- **Director** refers to the human who owns approvals and organizational decisions.
- **AI Employee** or **Agent** refers to a persistent worker; employee titles and personalities do not grant permissions.
- **Task** is a work item; **Run** is one execution attempt; **Automation** triggers work; **Project** owns delivery scope.
- **Second Brain** is shared approved knowledge, not raw unreviewed execution logs or another agent's private memory.
- **Private Chat** means isolated by default; say explicitly when tools, shared knowledge, or operational task creation are enabled.
- **Token value** must be labeled *API-equivalent estimate*; subscription token usage is not a confirmed additional bill.
- The **Virtual Office** is a visual projection of observed work; animations must never imply unobserved tool use or completion.

## Proposed key screens

- Landing/Command Center: **Omnis OS** as product name; *Command Center* as main nav destination.
- Virtual office immersive route: **Omnis HQ**, with 2D fallback and agent inspector.
- Project overview: **Omnis Projects**, with verified task progress.
- Private conversation: **Omnis Chat**, always showing isolation and selected model/profile.
- Knowledge discovery: **Omnis Knowledge**, clear global versus project scope.
- Usage view: **Omnis Insights**, actual vs estimated money distinctly presented.

## Design and copy acceptance

- App title, repository examples and documentation use Omnis OS / `omnis-os` consistently.
- No new branded aliases are introduced without documenting their mapping to canonical modules.
- All UI can be used without WebGL; 3D loading does not block tasks or chat.
- Status and billing language describe source and confidence rather than infer details.
- Names, logos, product claims and external publishing get a separate trademark/domain check before release.

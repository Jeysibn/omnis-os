# Module - Agents, Profiles, Departments and Teams

## Purpose

Persistent AI employees with personality, professional responsibilities, model/runtime preferences, and permissions, organized into departments and optionally teams. **Identity and authorization are different concerns.** A profession never grants system privileges.

## Profile structure

- Identity: stable agent ID, name, avatar, bio, display color, archived status.
- Profession: title, level, specialties, responsibilities, example deliverables.
- Personality: traits, tone, collaboration habits, response style, principles.
- Behavior: level of initiative, escalation rules, uncertainty handling, quality bar.
- Runtime: preferred connection, allowed models, authorized fallback order; fallback never silently changes billing mode.
- Skills: approved versioned Skill assignments.
- Tools: MCP and native tool grants, workspace/file network scope.
- Memory: private agent memory namespace, project knowledge scopes.
- Organization: department, optional team, supervisor/reporting links.
- Operations: concurrency, quotas, working schedule, current status.

## Profile versioning

- Profile editor creates a **draft** then publishes immutable version `N`.
- A run stores exact profile version and runtime/model snapshot used at admission.
- Updating a live agent's personality does **not** mutate ongoing runs, isolated chat snapshots or historical results.
- Work should be reproducible at the configuration layer: version, selected Skills, model ID, and granted tools recorded without storing credentials.
- Runtime adapters translate approved profile fields to Hermes profile/SOUL.md, Codex AGENTS.md or Claude Code instructions in an isolated workspace as supported by installed versions. Not all fields map 1:1.

## Lifecycle

`draft -> available -> busy|offline|paused -> archived`; operational status derived from run and connection state, not hand-edited fictional 'working'. Archived agents keep history and are not schedulable.

## Example agents (not mandatory defaults)

| Name | Profession | Preferred runtime | Department | Behavior |
|---|---|---|---|---|
| Atlas | Systems Architect | Claude Code | Engineering | methodical, skeptical, explains tradeoffs |
| Nova | Software Engineer | Codex | Engineering | test-driven, concise, evidence-first |
| Sentry | DevOps / NOC | Hermes | Operations | calm, cautious, escalation-focused |
| Scout | Research Analyst | Hermes | Research | curious, source-oriented, clear uncertainty |

## UI

Directory cards, filter by department/status/runtime; editor tabs `Identity`, `Profession`, `Personality`, `Runtime`, `Skills & MCP`, `Memory`, `Permissions`, `History`. Show actual availability and entitlement; do not allow user to pick a model that installed runtime cannot run.

## Safety

- A 'System Administrator' profession is descriptive, not `sudo` authority.
- Prevent agents from editing own trust policies, Skill grants, login credentials or profile ownership.
- Always confirm profile version at run start and persist resolved config.
- Agent deletion is archive; references to older runs remain valid.

## Acceptance

1. Create Atlas and edit personality: old run and chat continue using old snapshot; new run uses new version.
2. Assign a read-only MCP tool and verify Atlas cannot call unauthorized write functions.
3. Move agent to another department and verify 3D placement updates without changing task history.
4. Runtime unavailable: shows unavailable and prevents admission without fabricating a fallback.

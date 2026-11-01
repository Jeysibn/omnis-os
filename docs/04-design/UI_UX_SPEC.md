# UI / UX Specification

## Design north star

**A working control center, not a sci-fi control room.** The standard UI is calm, restrained, accessible and information-efficient. The optional 3D Office is the one deliberately playful interface and must remain a separate route. The product should feel like a professionally designed developer tool with a living company behind it.

## Visual identity

The selected product name is **Omnis OS**. The following design tokens and module aliases are proposed until UI validation; see [Brand Identity](BRAND_IDENTITY.md) for complete naming and copy rules.

### Color and typography (proposed; revisit after mockups)

- Deep Navy `#101927` - dark theme foundation and title accents.
- Slate `#263750` - sidebar / depth.
- Soft White `#EEF1F5` - light surfaces.
- Blue `#648DF6` - focus and interactive actions.
- Teal `#45C5AA` - real active/healthy state.
- Amber `#EAB56A` - approvals and attention.

Typography: **Space Grotesk** (reserved display/department titles), **Inter** (UI/body), **IBM Plex Mono** (timestamps, event IDs, token numbers). Validate font licensing before bundling any font files; use installed/served fonts in code, not unlicensed binary assets in docs.

## Navigation architecture

Left navigation on desktop; compact adaptive navigation on mobile:

```text
[Omnis OS]               [Global Search]    [Approvals] [Account]
  Command Center (Omnis Command)
  AI Chat (Omnis Chat)
  Projects (Omnis Projects)
  Tasks
  Automations
  Agents & Profiles (Omnis Workforce)
  Skills & Integrations
  Second Brain (Omnis Knowledge)
  Cost & Usage (Omnis Insights)
  Virtual Office (Omnis HQ)
  Settings / Runtime Connections
```

Avoid 10 equally dense dashboards: each route owns one primary task and a meaningful empty state. Active projects and live agent status should be readily reachable without excessive page switches.

## Information hierarchy

### Command Center

- First row: operational status (active runs, tasks awaiting action, runtime availability) rather than vanity counters.
- Main content: current work and approvals with real updates; recent verified outcomes.
- Secondary: upcoming schedules, budget warnings, quick links to Projects and Virtual Office.
- Action: `Create task`, `New project`, `New chat`.

### AI Chat

- Single readable message column; collapsible thread sidebar, clear model/profile dropdown, streaming text, citations and attachment chips.
- Persistent **Private Session** indicator for isolated mode; operational mode visually separate.
- Usage inspector collapsible to avoid clutter.
- Safe explicit `Create task from chat` and `Propose knowledge` actions.

### Projects

- One project page with overview, board, milestones, activity, knowledge, artifacts and budgets as tabs.
- Board shows blocked reasons and verified acceptance state. No green 'complete' for mere model final output.

### Agents & Profiles

- Grid/list of agents by department with avatar, role, runtime availability and active task.
- Profile editor tabs: identity, personality, profession, runtime, Skills/MCP, permissions, memory, history.

### Skills & Integrations

- Tabs: Skills, MCP Connections, Access, Audit. Show risk classification and installed/pinned version.
- Connection setup wizard offers approved local stdio or vetted remote HTTP; warnings for high-risk tools.

### Cost & Usage

- Separate tiles for **Measured Tokens**, **API-equivalent Value**, **Actual Charges**, **Quota Status**.
- Filters by agent, project, task, model, date and source confidence. Unknown data never represented as zero.

### Automations

- Table/list with next run in selected timezone, schedule status, assignee, last result and overlap/missed policy.

### Virtual Office

- 3D canvas focal point, minimal overlay: room selector, FPS/reduced motion, active agents, selected employee inspector.
- Direct link to accessible 2D equivalent.

## Wireframes (low fidelity)

```text
COMMAND CENTER
+------------------------------------------------------------------+
| Logo / Search                      Approvals(2)  Profile          |
| Nav    | Running now           | Action queue                  |
|        | [Nova: tests]         | [Approve Atlas plan]         |
|        | [Sentry: health]      | [Investigate failed job]     |
|        |--------------------------------------------------------|
|        | Projects (recent)     | Upcoming automations         |
|        | Usage alert summary  | Runtime health               |
+------------------------------------------------------------------+

AI CHAT
+------------------------------------------------------------------+
| Threads   | Profile: Atlas  Model: Claude  [PRIVATE]             |
|           |                                                     |
|           |                  Conversation                       |
|           |                                                     |
|           | [Attach]  Ask a question...           [Send]         |
|           | Usage (collapsed)   [Propose knowledge] [Create task]|
+------------------------------------------------------------------+

VIRTUAL OFFICE
+------------------------------------------------------------------+
| Back to Command Center   3D Office   Camera / FPS / 2D fallback  |
|                                                                  |
|      [Engineering] [Research] [Operations]  [Knowledge Library]  |
|                  interactive isometric office                    |
|                                                                  |
|                         [Selected Employee Inspector]            |
+------------------------------------------------------------------+
```

## Interaction design rules

- Every control must have real effect; do not render dummy action buttons in production.
- Every status has an explicit source: live/last-seen timestamp and connection quality.
- Loading/empty/error states explain what to do next; avoid generic `Something went wrong`.
- Confirm high-risk actions with an exact target/impact summary and irreversible warning when applicable.
- Escape-close, keyboard focus, ARIA labels, visible focus ring, adequate contrast, reduced-motion preference.
- Responsive at 360px and 1920x1080; avoid excessive text scaling on large screens.
- No reliance on color alone for statuses; include icon + text.
- Skeletons/polling should not simulate live events. No exaggerated animation in standard pages.

## UI QA acceptance

- Critical flows usable without 3D/WebGL.
- Profile model and runtime picker only shows permitted available selections.
- Private Chat clearly indicates it cannot touch operational agents.
- SSE reconnect never duplicates events or falsely changes final status.
- 3D office load is opt-in and does not drain GPU while hidden.
- Project/task/agent detail visible via deep links after refresh.

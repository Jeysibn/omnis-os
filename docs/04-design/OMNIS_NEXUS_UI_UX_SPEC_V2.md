# OMNIS NEXUS
## Cinematic Command Center — UI/UX Design Specification V2.0

**Product:** Omnis OS  
**Screen:** Command Center  
**Design language:** Cinematic sci-fi / precision instrumentation  
**Signature centerpiece:** Hybrid Neural Reactor  
**Reference:** User-provided JARVIS neural-core command-center screenshot  
**Status:** Visual direction approved; implementation pending

---

## 1. Product objective

Design a high-fidelity, cinematic operational command environment for a self-hosted, multi-agent AI operating system.

The screen must feel like the operator is standing in front of an intelligent, living machine. Instead of a traditional dashboard filled with cards and charts, the visual focus is an enormous, luminous neural reactor surrounded by precise operational instruments.

The Command Center must answer three questions:

1. What is Omnis OS doing right now?
2. Which tasks, runs or decisions require attention?
3. What can the operator safely do next?

**Design thesis:** The center expresses the life of the system. The perimeter provides its controls and evidence.

The experience must remain usable without animation or WebGL.

## 2. Design identity

### Visual atmosphere

- Near-black environment, with deep green-blue undertones.
- A brilliant emerald-jade reactor suspended at the center.
- Thousands of fine points and interconnected paths forming a translucent neural sphere.
- Organic, asymmetric geometry rather than a perfectly uniform globe.
- Deep perspective, atmospheric scattering and subtle volumetric illumination.
- Fine technical rules, dividers and instrumentation around the outer edges.
- Minimal conventional dashboard cards.
- Dense information presented only where it helps the operator act.

The design should feel futuristic and expensive, not cluttered, gimmicky or game-like.

### Signature visual risk

**The center of the screen is intentionally occupied by an enormous cinematic visualization rather than traditional metrics.**

This works because the important actionable information is moved to the perimeter, while the central visualization responds to verified operational state.

Do not fill unused space with decorative statistics or fabricated activity.

## 3. Color system

| Design token | Hex | Intended role |
|---|---|---|
| Void Black | `#060C0E` | Primary background |
| Carbon Slate | `#101C20` | Panels and overlays |
| Instrument Edge | `#28433E` | Hairlines and separators |
| Reactor Jade | `#91F2CD` | Core illumination and selected activity |
| Signal Amber | `#F0BD76` | Approval and attention states |
| Frost White | `#EAF4EE` | Primary typography |

Additional semantic tokens: original Omnis OS blue `#648DF6` for keyboard focus and selected controls; a distinct accessible red for failures.

The reactor is the brightest element. Peripheral panels must not compete through equally intense glows.

### Typography

- **Space Grotesk:** product branding, major screen titles and reactor identification.
- **Inter:** navigation, descriptions, buttons and operational content.
- **IBM Plex Mono:** event IDs, timestamps, runtime identifiers and telemetry.

Use generous letter spacing for small technical labels but never sacrifice the readability of functional content. Main panel text should generally remain at least 13–14px on desktop; detailed tables and interactive controls must be comfortably readable.

## 4. Desktop composition

Target the primary design at 1920×1080 while supporting 1440×900 and smaller desktop viewports.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ OMNIS OS / NEXUS    Environment     Connection      PHT Clock   Account │
├──────┬───────────────┬─────────────────────────────┬────────────────────┤
│      │ SYSTEM VITALS │                             │ REQUIRES ATTENTION │
│ NAV  │               │       NEURAL MESH           │                    │
│      │ Active runs   │     ╭────────────╮          │ Approvals          │
│      │ Task queue    │    /              \         │                    │
│      │ Failures      │   |   ◉ REACTOR    |        │ Agent activity     │
│      │               │    \              /         │                    │
│      │ SYSTEM        │     ╰────────────╯          │ Priority events    │
│      │ CONTEXT       │                             │                    │
│      │               │    SYSTEM STATE / MODE      │ Mission details    │
│      │               │    [ CREATE TASK ]          │                    │
│      │               │    [ PRIVATE CHAT ]         │                    │
├──────┴───────────────┴─────────────────────────────┴────────────────────┤
│ LIVE MISSION LANE       EVENTS / REPLAY / FILTERS / INSPECTION           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Layout proportions

At 1920px, proposed starting proportions:

- Navigation rail: 64–76px.
- Left telemetry column: 230–270px.
- Center stage: remaining flexible area, ideally at least half the content width.
- Right intelligence column: 280–340px.
- Top bar: approximately 56–64px.
- Collapsed mission lane: approximately 96–120px, expandable for detailed inspection.

These are design targets rather than rigid measurements.

The central reactor should occupy approximately 60–75% of the available center-stage height at desktop sizes, while leaving sufficient space for a meaningful command deck.

All peripheral content must remain outside the reactor's essential visual silhouette.

## 5. Top command bar

### Content

**Left:** Omnis OS identity, with NEXUS used as the Command Center's visual-mode label.

**Middle:** Current environment and trustworthy connection state.

**Right:** Notifications/approvals access, Asia/Manila clock, operator account and settings.

### Behaviors

- Environment must be explicit and accurate.
- API connectivity is not the same as runtime availability.
- Runtime availability must not be inferred from an open SSE connection.
- Clock displays Philippine time; event timestamps retain correct timezone conversion.
- Account and navigation controls remain keyboard-accessible.
- Important connection problems are identified with words, not merely colors.

### Visual treatment

A thin dark instrument header with restrained typography, subtle separators and one clearly visible active environment state.

## 6. Left telemetry and navigation

### Primary navigation

Use a slim, recognizable navigation rail. Preserve working application destinations and existing URL behavior.

Canonical destinations include:

- Command Center
- Agents & Profiles
- Departments
- Projects
- Tasks
- Runs
- AI Chat
- Skills & Integrations
- Automations
- Second Brain
- 3D Virtual Office
- Settings

The actual visible navigation must reflect implemented routes. Do not imply future modules work when they do not.

### System vitals panel

Prioritize:

1. Running tasks and active runs.
2. Pending or queued work.
3. Failed or interrupted runs.
4. Last verified event.
5. Connection and runtime health.
6. Current project/department context, where supported.

Each metric should provide an appropriate path to the underlying source.

Display **0** only when the source has confirmed zero. Display **Unknown**, **Unavailable**, **Not connected** or **Not implemented** when those meanings are more accurate.

### Visual behavior

Instrument labels use small mono typography with important values in larger, clearly readable text.

Only include sparklines when real historical data exists. Avoid fabricated history or decorative charts.

## 7. Central Hybrid Neural Reactor

### Geometry

The reactor consists of five visual layers.

**A. Inner nucleus:** An intense concentrated light source. White-jade center fading into emerald illumination.

**B. Primary neural structure:** An irregular spherical mesh of hundreds of visible points and interconnected strands.

**C. Secondary network shell:** Dimmer, more widely distributed particles that add depth and scale.

**D. Orbital structures:** Two or three thin, differently angled orbital paths. These are sparse and elegant rather than thick concentric HUD rings.

**E. Environmental field:** Soft atmospheric glow, a subtle vanishing-point grid and controlled parallax.

### Behavior

The neural geometry moves slowly and organically, never as a rigid spinning globe.

The nucleus breathes with a low-amplitude illumination change. Orbital elements respond to verified activity.

The reactor is a presentation of system state, not a simulation of actual agent thoughts.

### Interaction

Selecting a verified object associated with a run or agent opens its details in an accessible inspector.

The operator should be able to return to the whole-system view without losing current navigation state.

The reactor must have an equivalent accessible text/list interface.

### Required reactor states

| State | Visual response | UI label |
|---|---|---|
| Idle | Low-energy breathing, calm neural movement | Idle |
| Mock run active | Gentle directional activity | Mock execution active |
| Queued task | Reserved peripheral indicator | Queued |
| Approval pending | Amber segment and attention marker | Approval required |
| Run failed | Brief red failure cue followed by persistent readable state | Run failed |
| Run canceled | Motion settles and event history remains | Canceled |
| Telemetry disconnected | Reactor dims and live-motion cues stop | Live updates disconnected |
| Runtime unavailable | Muted orbital indicators | Runtime unavailable |
| Loading | Static, subtle placeholder | Loading system state |
| Graphics unavailable | Static illustration with intact controls | Visualization unavailable |

A future real-runtime state must not be enabled until there is verified backend evidence of real execution.

### Core focus behavior

When a run is selected, the global constellation changes to a restrained focused state:

- Selected run receives an identifiable marker.
- Related operational events are highlighted.
- Other activity fades but remains visible.
- The right panel shows the source-backed details.
- The mission lane filters or scrolls to related events.

The visualization never becomes the source of truth for task or run state.

## 8. Center command deck

Place the command deck below the reactor.

### Required actions

**Create task** — Uses the existing approved task-creation flow.

**Open private chat** — Available only when the private chat workspace is genuinely implemented.

**View runs** — Navigates to the current run list or selected run.

**Review approvals** — Opens the existing trusted approval interface.

### UX design

Prefer one prominent primary action and a small group of secondary actions.

Do not combine private chat with operational task execution in one ambiguous text box.

If task composition is supported inline, it must preserve the existing form validation, permissions and confirmation behavior.

Do not create visually convincing but nonfunctional controls.

## 9. Right-side action intelligence

The right panel answers: **What needs my attention?**

### Section A — Approval queue

Highest priority.

Display actual pending decisions, their targets, requesting context and permitted review actions.

An approval opens the existing secure approval interaction. Never approve merely by interacting with the reactor.

### Section B — Current activity

Display current runs and, where authoritative information is available, the associated agents.

Distinguish an agent profile, a configured runtime, and a verified live execution.

### Section C — Priority events

Display verified failures, interruptions, authorization denials or relevant availability issues.

Use consistent severity and readable source references.

### Section D — Selected mission

When a mission or run is selected, open the detailed inspector without hiding urgent approval information.

On smaller screens, this inspector can become a drawer or dedicated detail surface.

## 10. Bottom Live Mission Lane

This is a defining part of the experience.

### Design

A narrow, illuminated operational rail spanning the content width, showing an ordered sequence of real run and task events.

Events appear as compact nodes with readable labels, timestamps and meaningful status indicators.

### Behaviors

- Read from the established event history and live update mechanism.
- Preserve event order and replay behavior.
- Avoid duplicate entries after reconnection.
- Use Asia/Manila for human-readable timestamps.
- Allow inspection of underlying events.
- Support a user-controlled pause of automatic scrolling.
- Preserve access to historical events when live updates disconnect.
- Keep animation separate from the canonical event stream.
- Ensure events remain readable as a list when the rail is expanded or on mobile.

No fictitious event activity is allowed outside a clearly labeled, isolated visual demonstration.

## 11. Motion choreography

### First entrance

A cinematic but non-blocking sequence:

**0–300 ms — Ignition:** A faint central light appears.

**300–800 ms — Neural formation:** A portion of the mesh emerges and becomes legible.

**800–1200 ms — Orbital stabilization:** Orbit paths become visible and the interface settles.

The precise timing should be tuned through actual browser testing. Critical controls must not be blocked by the animation.

### Idle animation

- Very slow constellation drift.
- Subtle deformation of the mesh.
- Low-frequency luminous breathing.
- Sparse orbital movement.
- Minimal environmental particles.

### Event-driven animation

- Approval request: localized amber attention.
- Run transition: brief directional illumination.
- Failure: short warning transition without continuous flashing.
- Connection loss: movement stops or substantially reduces.

### Motion restrictions

- Respect `prefers-reduced-motion`.
- No mandatory sound effects.
- Pause costly rendering when not visible.
- Avoid unnecessary perpetual animation in the outer panels.
- No prolonged flashing, aggressive bloom or distracting camera rotation.

## 12. Responsive experience

### Large desktop: 1440px and above

Full five-region composition with side panels and cinematic core.

### Compact desktop: 1024–1439px

Preserve the central reactor. Collapse secondary sidebar information and shorten the mission lane before reducing the essential core area.

### Tablet: 768–1023px

Use a center-first layout with operational panels available through clearly labeled tabs or expandable drawers. Prioritize approvals over purely decorative content.

### Mobile: below 768px

Use a condensed, static or lightweight reactor near the top; show attention-required actions prominently; stack important operational information below.

Convert the horizontal mission lane into a readable event list.

Test narrow mobile widths around 360px, as well as tablet and common desktop sizes.

## 13. Accessibility requirements

- Entire Command Center usable without WebGL.
- Keyboard-accessible navigation and controls.
- Visible focus styles.
- Clear text alternatives to graphic status indications.
- No critical information encoded only by color or animation.
- Sensible heading order and landmark semantics.
- Sufficient contrast for interactive and informational text.
- Nonanimated fallback for reduced motion.
- No essential data contained exclusively inside the reactor.
- Error and empty states with clear recovery guidance.
- Status changes announced appropriately without overwhelming screen-reader users.

## 14. Performance requirements

The cinematic renderer must be isolated from normal operational UI rendering.

Recommended approach:

- A separate visual component, loaded only on the Command Center route.
- GPU-accelerated rendering if appropriate and supported.
- Conservative particle counts with adaptive quality.
- Device-pixel-ratio limits on lower-powered displays.
- Avoid React state updates for every particle animation frame.
- Release graphics resources when the component unmounts.
- Pause or reduce updates when the tab is hidden.
- Static fallback if graphics initialization fails.

Aim for smooth interaction on a representative desktop and responsive controls on lower-powered devices. Validate performance with browser profiling; do not claim a frame-rate target was achieved without measurement.

## 15. Application-state integrity

This is a visual redesign, not a control-plane replacement.

Preserve:

- Existing owner authentication.
- CSRF and authorization requirements.
- Task and run lifecycle.
- Run cancellation and approval semantics.
- Persisted SSE event ordering and replay.
- Browser navigation and deep linking.
- Existing data validation and error behavior.
- Real-versus-mock execution distinctions.

The reactor must never fabricate task completion, online-agent presence, token counts, connectivity or provider activity.

## 16. Visual QA and design acceptance

The design is ready for acceptance when:

1. The Hybrid Neural Reactor is immediately the dominant visual element.
2. Its neural geometry looks organic rather than like a generic rotating globe.
3. The surrounding operational information remains readable.
4. Approvals and failures are discoverable without using the visualization.
5. Existing task, run and approval interactions remain functional.
6. The interface degrades gracefully without WebGL.
7. Mobile screens prioritize actual operator actions.
8. No fake live telemetry appears.
9. Motion responds to legitimate states and respects accessibility preferences.
10. The design feels distinctly Omnis OS rather than a copied JARVIS screen.

## 17. Implementation sequence

**Stage 1 — Visual foundation:** Establish the design tokens, Command Center shell, typography and responsive peripheral panels.

**Stage 2 — Reactor foundation:** Build a static fallback and isolated cinematic reactor component.

**Stage 3 — Operational integration:** Connect visual states to existing task, run, approval and event data.

**Stage 4 — Cinematic refinement:** Improve mesh depth, illumination, orbital geometry, motion and transitions.

**Stage 5 — Quality verification:** Perform functional, responsive, accessibility, performance and regression testing.

**Stage 6 — Independent review:** Codex #2 reviews frontend changes. Security-related changes, if separately authorized, follow the established backend/security review workflow.

---

**Design decision:** Hybrid Neural Reactor is the selected centerpiece.  
**Implementation owner:** Claude #2.  
**Independent frontend reviewer:** Codex #2.  
**Merge authority:** Human project owner.

This design specification supersedes the previous non-cinematic visual direction for the Command Center, while preserving operational correctness and the separate 3D Virtual Office module.

# Omnis OS web interface

Most of the web app uses neutral, light content surfaces with a restrained navy application header
and blue interaction accents, so operational records stay easy to scan.

The **Command Center** (`#command-center`) is the exception. It follows the approved
[OMNIS NEXUS UI/UX specification V2](../../docs/04-design/OMNIS_NEXUS_UI_UX_SPEC_V2.md): a dark,
cinematic mission-control screen centered on the Hybrid Neural Reactor, with system vitals on the
left, items needing attention on the right, and a mission lane along the bottom. Its styles are
scoped to `.nexus` in `src/ui/nexus/nexus.css`; other screens are unchanged.

### Command Center (OMNIS NEXUS) implementation notes

- **Isolation.** `src/ui/nexus/` is lazy-loaded only on the Command Center route (its own chunk).
  The reactor is an imperative Canvas 2D renderer (`reactorRenderer.ts`); animation state never
  touches React state. No graphics dependency was added.
- **Truthful state.** `reactorState.ts` derives one labelled state from loaded task/run data. The API
  does not yet expose a pending-approval list, runtime health, or agent attribution, so the
  "Approval required" and "Runtime unavailable" states are implemented and unit-tested but are never
  entered from missing evidence. Connection health is reported by the mission lane, not the reactor.
  Run markers on the orbits are real runs; only active runs move.
- **Mission lane (run events only).** Follows the per-run event stream
  (`GET /api/v1/runs/:id/events`) for at most 4 runs (unfinished first), keeps at most 40 events per
  run in the display (a display limit, not proof that older events are gone), and de-duplicates by
  run sequence. Reconnects are bounded: five failures without progress, or 30 s without a successful
  reconnect, close the stream until the user presses Refresh. Streams close while the tab is hidden
  and replay on return. Task events are **not** available from the API yet; see
  `docs/04-design/NEXUS_MISSION_LANE_TASK_EVENTS_BACKEND_HANDOFF.md`. The V2 requirement for task and
  run events stays open until that backend dependency is delivered.
- **Fallbacks.** `prefers-reduced-motion` and widths below 768px render a static frame; a missing
  2D context shows a static SVG illustration with all controls intact. Rendering pauses while the tab
  is hidden or the reactor is off screen, and releases its canvas on unmount.
- **Approvals.** The reactor and lane never authorize anything. "Review approval" opens the existing
  owner-password approval dialog.
- **Fonts.** Space Grotesk, Inter and IBM Plex Mono are named first in the font stacks but are not
  bundled, to avoid third-party requests and new dependencies; system fonts are the fallback until
  self-hosted font files are approved.

The run event stream stays connected while the Runs workspace is open, including when the inspector
is below the fold. Leaving Runs or signing out closes the stream. This avoids repeated reconnection
and replay when a user scrolls through a long history; only the selected run is subscribed to.

Browser tests use a strict Playwright API fixture and synthetic mock records. They verify frontend
request contracts and interactions, not behavior against a live backend.

The current API has no authorization lookup endpoint. If an owner decision request has an uncertain
network or response outcome, the interface does not repeat the decision or start a run; the owner
must review the authorization through the available operational process.

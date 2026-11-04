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
  does not yet expose a pending-approval list, runtime health, or agent attribution, and this screen
  holds no event stream, so the "Approval required", "Runtime unavailable" and "Live updates
  disconnected" states are implemented and unit-tested but are never entered from missing evidence.
  Run markers on the orbits are real runs; only active runs move.
- **Mission lane.** Built from persisted run records (queued time and last change), in Asia/Manila
  time. Per-event replay stays in the Runs inspector, which keeps the existing SSE behavior.
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

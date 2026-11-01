# Module - 3D Virtual Office Simulation

## Vision

An interactive, isometric, low-poly office with departments, workstations, employees, meeting rooms and a central Second Brain library. The director can zoom, pan, select avatars and open operational inspector panels. **The office is a read-only simulation of durable Omnis OS state**, except for explicit authorized user actions forwarded to the control plane.

## Important truths

- An avatar typing means a real run reports activity; decorative movement never means a model took action.
- A walk to the knowledge library is a metaphor for an observed knowledge retrieval event.
- Meeting animations depict recorded delegation/handoff events, not internal agent conversations inferred by the UI.
- UI refresh reconstructs the same employee status from backend state.
- Demo mode must be permanently labeled `SIMULATED DEMO` and cannot be mistaken for real execution.

## Scene model

- Rooms are departments, with editable names, placements and layout metadata.
- Avatar model/wardrobe/color ties to agent identity; does not affect agent behavior.
- Agent activity is a deterministic projection: `(agent id, state, event timestamp, room placement, animation policy, server time)` -> pose/action.
- Room layout stored as versioned data. Scene assets (GLB) are separate from the DB and must be source/license reviewed.
- When event data is stale/disconnected, switch to offline or uncertain state; don't keep animating indefinitely as if task progressed.

## Animations and cues

| Backend observation | 3D cue |
|---|---|
| idle | seated/relaxed |
| task queued | task badge at desk |
| run running | workstation animation, current action label |
| tool reads knowledge | brief library animation |
| delegated task | collaboration / meeting animation |
| pending approval | attention icon and clickable inspector |
| failed/cancelled | stopped animation, warning status |
| runtime unavailable | disconnected avatar/status |

## Interaction model

- Click avatar -> inspector: identity, profession, runtime/model, current task, latest safe event, Skills, budget/usage, history and action link.
- Click department -> team roster, active projects and health.
- Click library -> Second Brain explorer.
- Optional camera presets: whole office, department, selected employee.
- Any mutation (assign, pause, approve) opens explicit control-plane dialog with confirmation and audit.

## Technical plan

- React Three Fiber + Three.js + Drei within a separate route, not on the main dashboard.
- Zustand or a dedicated scene store for ephemeral camera/select state, not authoritative task statuses.
- SSE event stream drives re-fetch/patch of a permission-safe office snapshot.
- Prefer instanced meshes/lightweight low-poly avatars, LOD/frustum culling and GLB assets licensed for reuse.
- Bound performance: FPS selector 15/30/60 with 30 default, no rendering in hidden tab, no continuous GPU rendering when unnecessary.
- Reduced motion and an accessible 2D list/card view must expose the same underlying actions and states.
- Show no secrets, unredacted tool logs, or sensitive project details on public/cinematic scenes.

## Validation plan

1. Inject deterministic fake events into a non-production demo and snapshot resulting poses for each state.
2. Real safe run enters `running`, office reflects within bounded SSE delay; reloading keeps state consistent.
3. Disconnect runtime: avatar shows stale/offline, not fictional productivity.
4. Keyboard-only user can inspect a selected employee through 2D fallback.
5. Measure frame time, memory and model contention on actual host hardware.

## Inspiration (not dependencies)

- https://github.com/Bogdusik/AI-Office - data-driven office from persisted work state.
- https://github.com/andrizpray/Hermes-office - Hermes-related virtual office integration inspiration.
- https://github.com/pmndrs/react-three-fiber - supported React renderer.

Do not copy third-party 3D assets without inspecting their separate licenses.

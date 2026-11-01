# Modules - Project Management, Tasks and Orchestration

## Project Management

Project is a container for a goal and delivery evidence. Core entities: `Project`, `Milestone`, `Epic`, `Task`, `Dependency`, `Deliverable`, `Project Team`, `Workspace`, `Project Knowledge Scope` and `Budget`.

Each project has key, objective, scope/non-goals, priority, lifecycle (`proposed, active, paused, completed, archived`), attached repo refs, milestones, assigned agents, human approval policies, and evidence-backed progress. Progress is based on accepted tasks/milestones, not agent confidence.

### Planned views

- Project overview: goal, status, owner, team, budget/usage summary, blockers, timeline.
- Kanban board: backlog, ready, in progress, in review, accepted, blocked.
- Milestones & dependencies: linked tasks, predecessor state and deliverable acceptance.
- Artifacts & reviews: code/test/doc evidence and human decision.
- Activity: durable run and approval events scoped to project.
- 3D office: filter employees by active project without making an extra project state source.

## Tasks & Orchestration

**Task** = desired work with acceptance criteria. **Run** = one attempted execution. **Artifact** = output evidence. **Approval** = authorization for a precise restricted action. **Workspace** = isolated filesystem/environment for this run.

### Admission checklist

1. Task is ready; dependencies satisfied.
2. Agent not archived/paused; concurrency slots available.
3. Runtime policy, model availability, and auth condition verified.
4. Project+agent grants checked for read/write/tool/network scope.
5. Budget and quota signals evaluated; unavailable quota must not imply unlimited.
6. Resolved profile version, skills snapshots, workspace and idempotency key persisted.
7. Job admitted. Browser immediately receives receipt and can reconnect later.

### Execution

Worker claims job, starts allowed adapter, streams sanitized status, tool events and usage, stores artifact IDs/checksums, reconciles terminal status, then submits result for automated tests/human review. Worker must not claim `completed` based solely on output text.

### Retry / recovery

- Failed read-only tasks can be retried after policy check.
- External writes/deploys have per-operation idempotency and require review before retry following unknown state.
- Reconnect after backend restart to persisted external run if supported; otherwise mark uncertain and require reconciliation.
- Cancellation signals are asynchronous: stop requested != stopped.

### Multi-agent delegation (later)

- Task owner agent can propose subtasks; control plane enforces delegation policy, budget cap, depth limit and project membership.
- Each delegate task has separate run, evidence, cost and responsible agent; parent aggregates only accepted results.
- Prevent circular delegation, recursive self-assignment and unbounded budget cascade.

## Acceptance

- A failing test artifact cannot be accepted by automated success rules.
- Two concurrent `POST .../runs` requests using same idempotency key create one canonical run.
- Cyclic task dependency is rejected.
- A reviewed write action cannot be changed after authorization by editing arguments.
- Archiving a project preserves its audit history and prevents new runs unless reopened.

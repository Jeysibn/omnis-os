# Control Plane Application Interface (Proposed)

**Status:** Design baseline with incrementally implemented endpoints. Canonical executable request/response schemas are in `packages/contracts`. Version as `/api/v1`. No direct passthrough of native privileged runtime APIs to browsers.

## Conventions

- Authentication: secure user session, CSRF protection for cookie-authenticated commands, role checks on every request.
- JSON requests and responses with stable ID, `request_id`, UTC timestamps and scoped error codes.
- Pagination via `cursor` + `limit` for unbounded collections.
- Mutation idempotency for run admission, automation occurrence, external writes.
- HTTP 401 unauthenticated; 403 unauthorized; 404 hidden resource when privacy requires; 409 invalid state/version conflict; 422 validation error; 429 concurrency/limit; 503 disconnected runtime.
- Never expose runtime bearer keys or account tokens to browser.

## Stage 1 endpoints

| Method    | Path                                     | Meaning                                                    |
| --------- | ---------------------------------------- | ---------------------------------------------------------- |
| GET       | `/api/v1/health`                         | App health, no secret details                              |
| GET       | `/api/v1/me`                             | Authenticated director identity                            |
| GET/POST  | `/api/v1/departments`                    | List/create departments                                    |
| GET/POST  | `/api/v1/agents`                         | List/create agent                                          |
| GET/PATCH | `/api/v1/agents/{agentId}`               | Agent details and versioned profile edit                   |
| GET       | `/api/v1/runtime-connections`            | Display configured runtime status/capabilities             |
| POST      | `/api/v1/runtime-connections/{id}/probe` | Re-check capability under privileged backend policy        |
| GET/POST  | `/api/v1/projects`                       | List/create project                                        |
| GET       | `/api/v1/projects/{id}`                  | Read project details                                       |
| PUT       | `/api/v1/tasks/{taskId}/project`         | Associate or unassign a task from a project                |
| POST      | `/api/v1/tasks`                          | Create an unassigned or project-associated task            |
| GET       | `/api/v1/tasks`                          | List owner-visible tasks with project association          |
| GET       | `/api/v1/projects/{projectId}/tasks`     | Read a bounded page of project tasks and latest run states |
| GET       | `/api/v1/tasks/{id}`                     | Task, acceptance criteria, verification status             |
| POST      | `/api/v1/tasks/{id}/runs`                | Admit execution attempt (Idempotency-Key required)         |
| GET       | `/api/v1/runs/{id}`                      | Run state and sanitized evidence                           |
| GET       | `/api/v1/runs/{id}/events`               | SSE, supports cursor resume                                |
| POST      | `/api/v1/runs/{id}/cancel`               | Request stop, not guaranteed immediate                     |
| POST      | `/api/v1/runs/{id}/accept`               | Explicitly accept verified task result                     |
| GET       | `/api/v1/runs/{id}/usage`                | Measured token telemetry or unknown                        |

### Implemented Project Foundation

The owner-authenticated project API implements `GET` and `POST /api/v1/projects`, `GET` and `PATCH /api/v1/projects/{projectId}`, and `POST /api/v1/projects/{projectId}/archive`. `POST` accepts a unique uppercase project `key`, `name`, `objective`, and optional `priority` (`low`, `normal`, `high`, `urgent`; defaults to `normal`). Creation always starts in `proposed` status and requires a UUID `Idempotency-Key`. A repeated key with the same validated request replays the original project; reuse with a different request or a duplicate project key returns `409`.

List summaries use `id`, `ownerId`, `key`, `name`, `status`, `priority`, `revision`, `createdAt`, and `updatedAt`; detail adds `objective`. `revision` starts at 1 and increments atomically after every successful edit or archive. The compact list is ordered by creation time and stable ID, remains complete up to 500 projects, and fails closed with `503` if the bound is exceeded. Archived projects remain visible in the list and readable by ID; this preserves existing read behavior. Project keys are immutable. `PATCH` accepts at least one of `name`, `objective`, or `priority`, plus `expectedRevision`. Archive accepts `expectedRevision`. Both mutations require a UUID `Idempotency-Key`, owner authentication, and session-bound CSRF. Matching retries replay the stored response; reuse for another operation or payload returns `409`. A stale revision returns `409`; unknown IDs return `404`; edits after archival and a new archive request for an already archived project return `409`. There is no restore endpoint in V1.

Mutations and metadata-only audit rows commit in the same transaction. Update audit entries record only changed field names; archive entries contain no field values. `omnis_runtime` has no project table access and no direct permission to insert tasks or change their project association. It can create tasks or change a pre-history task association only through the narrowly scoped `omnis.create_task` and `omnis.set_task_project` functions. Those functions have a fixed search path, enforce the runtime session identity, and atomically validate owner/project state. The runtime role remains without direct `tasks.project_id` update privileges.

The owner-authenticated Project Milestones API V1 is `GET`/`POST /api/v1/projects/{projectId}/milestones`, `GET`/`PATCH /api/v1/projects/{projectId}/milestones/{milestoneId}`, and `POST /api/v1/projects/{projectId}/milestones/{milestoneId}/archive`. Milestones have immutable project identity, a date-only optional target, revisioned owner edits, and statuses `planned`, `in_progress`, `completed`, or `archived`. Allowed status transitions are `planned` to `in_progress` or `completed`, `in_progress` to `completed`, and any non-archived status to `archived`; archived milestones are readable and immutable. Any non-archived project status permits milestone changes. Project and milestone locks serialize those changes against project archival. Reads use bounded signed keyset pagination (default 50, maximum 100) and report the total observed in the current query snapshot; a project is limited to 500 milestones. Mutations require owner authentication, session-bound CSRF, a UUID `Idempotency-Key`, and `expectedRevision` for updates/archive. Matching retries replay receipts and changed payload reuse returns `409`. Metadata-only audit entries are transactionally coupled to each actual mutation. No milestone-to-task association, automatic progress calculation, or runtime execution behavior is added. See [Project Milestones API V1](../03-modules/PROJECT_MILESTONES_API_V1.md) for schemas, examples, lifecycle and errors.

Task responses include `projectId` and `associationRevision`; legacy tasks without a project remain unassigned (`projectId: null`) and are not backfilled. `POST /api/v1/tasks` accepts an optional `projectId`. Project-associated creation requires a UUID `Idempotency-Key`; old unassigned task creation without a key remains supported. `PUT /api/v1/tasks/{taskId}/project` accepts `{ "projectId": "prj_…" | null, "expectedAssociationRevision": 1 }` and requires owner authentication, session-bound CSRF and a UUID `Idempotency-Key`. A stale revision returns `409`; unknown task/project IDs return `404`; archived-project assignment returns `409`. Association changes are allowed only before the task has any run or runtime authorization; this freezes project history once execution authorization begins. A task already linked to an archived project cannot be unassigned or reassigned, so removing the link cannot bypass archive enforcement. Same-key, same-input retries replay the original response, including after a project is later archived.

Only `archived` project status blocks association and new run admission; `proposed`, `active`, `paused`, and `completed` projects remain admissible in this mock-only increment. A database trigger guards every run-row insert, including the supported runtime admission transaction, by locking the task and associated project through commit. Project archival takes a conflicting row lock, so either a run admission commits before the archive or it observes the archived status and fails with `409 project_archived`. Legacy tasks with no project remain admissible. Already admitted runs, queue entries and recovery continue after archival; an exact retry returns the previously admitted run, while a new admission is denied. Archiving does not cancel runs or mutate task/run/authorization history. No project-based runtime permissions or general runtime database grants are added.

The implemented department endpoints (`GET`/`POST /departments`, `PATCH /departments/{id}`, `POST /departments/{id}/archive`) and their error behavior are defined by `packages/contracts` and the [AO-104 department evidence](../07-governance/evidence/AO_104_DEPARTMENT_MANAGEMENT.md); the planned web screens are in the [Department Management V1 frontend specification](../04-design/DEPARTMENT_MANAGEMENT_V1_FRONTEND.md). That specification is documentation only and changes no contract.

The owner-authenticated Project Workspace read API is `GET /api/v1/projects/{projectId}/tasks`. It resolves project identity and lifecycle through the existing authorizer project-detail read, then requests a bounded task/latest-run projection from the worker. It accepts optional `limit` (default 50, maximum 100) and signed `cursor` query parameters. The response contains the existing `Project` detail, task summaries (`id`, `title`, task `status`, `createdAt`, `projectId`, `associationRevision`), and `latestRun` (`id`, actual run `status`, `createdAt`, `updatedAt`) or `null`. It omits task detail, run usage, event/log content, leases, and authorization metadata. Tasks are ordered by `(created_at DESC, id DESC)`; `page.observedTotal` is the project task count observed by that request, `page.complete` says no further page currently remains, and `page.nextCursor` is null only when complete. This is a live association view, not a snapshot spanning HTTP requests. If an unexecuted task is reassigned while paging, restart from the first page. Tasks with any run or runtime authorization cannot be reassigned under the existing contract, keeping historical runs attached to the task's project. Archived projects remain readable; unknown projects return `404`; malformed identifiers, pagination values, or cursors return `422`. Legacy unassigned tasks do not appear in any project workspace. No database privileges or mutation paths are added.

See [Project Workspace API V1](../03-modules/PROJECT_WORKSPACE_API_V1.md) for response and frontend integration examples.

The minimum **read-only** slice of the agent and profile-version endpoints needed by the first Agents & Profiles frontend is requested, with conventions and open decisions, in [Agents & Profiles - Proposed Read API Contract](AGENTS_READ_API_PROPOSAL.md). That document is a proposal, not an implemented API. It follows the implemented `camelCase` contract convention rather than the `snake_case` used in the examples below.

### Example: create run

```http
POST /api/v1/tasks/tsk_123/runs
Idempotency-Key: 7204a1e7-1fb1-4db1-9f5d-121c40f5a515
Content-Type: application/json

{
  "agent_id": "agt_123",
  "runtime_connection_id": "rt_123",
  "profile_version_id": "apv_9",
  "mode": "read_only",
  "requested_scopes": ["workspace.read"]
}
```

Proposed `202` response:

```json
{
  "run_id": "run_123",
  "task_id": "tsk_123",
  "status": "queued",
  "replayed": false,
  "events_url": "/api/v1/runs/run_123/events"
}
```

Do not forward the app's `run_id` directly as a provider session ID without the adapter recording its mapping.

## Next release endpoints (not Stage 1)

- **Chat:** `POST /chats`, `POST /chats/{id}/messages`, `GET /chats/{id}/events`, `POST /chats/{id}/convert-to-task`; no tools by default.
- **Skills:** `GET /skills`, `POST /skills/import`, `POST /skills/{id}/approve`, `PUT /agents/{id}/skill-grants`.
- **MCP:** `GET /mcp/connections`, `POST /mcp/connections`, `POST /mcp/connections/{id}/probe`, `GET /mcp/connections/{id}/tools`, `PUT /mcp/grants/{id}`.
- **Knowledge:** `GET /knowledge/search`, `POST /knowledge/proposals`, `POST /knowledge/proposals/{id}/review`, `GET /knowledge/documents/{id}`.
- **Projects:** project-scoped milestone endpoints are documented in `PROJECT_MILESTONES_API_V1.md`; owner-managed Epic endpoints are documented in `PROJECT_EPICS_API_V1.md`; current Epic/task association is documented in `PROJECT_EPIC_TASK_ASSOCIATION_API_V1.md`. Task dependency graphs remain future work.
- **Automations:** `GET/POST /automations`, `POST /automations/{id}/run`, `POST /automations/{id}/pause`, `POST /automations/{id}/resume`, `GET /automations/{id}/occurrences`.
- **Cost:** `GET /usage/summary`, `GET /usage/events`, `GET /budgets`, `POST /budgets`.
- **Office:** `GET /office/snapshot`, `GET /office/events`, `PATCH /office/placements/{id}` (director actions only).
- **Approvals:** `GET /approvals`, `POST /approvals/{id}/decide` (bind exact proposed arguments hash and expiry).

All routes use the `/api/v1` prefix, omitted from the shorthand list above.

## API security checks

1. User and scope permission checked before existence and after lookup.
2. All JSON requests validated with typed schemas; cap text, upload sizes and list lengths.
3. No arbitrary process execution or untrusted URL access through `/runtime-connections` or `/mcp` configurations.
4. Output redaction and record-level policy applied on reads/events/search.
5. Runtime errors translated to a stable app code while preserving redacted diagnostic correlation ID.
6. No high-privilege GET routes; all state changes through authenticated POST/PATCH.

## OpenAPI generation policy

Once implementation begins, code-generated OpenAPI derived from route schemas is canonical. This document is the design baseline until an executable API and tests exist. Keep examples aligned as routes are implemented.

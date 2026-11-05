# Project Workspace API V1

This backend read contract lets the owner view a project's current task associations and the actual latest run state for each task. It does not add project UI, execution behavior, or database permissions.

## Request

```http
GET /api/v1/projects/prj_0123456789abcdef0123456789abcdef/tasks?limit=50
Cookie: omnis_session=...
```

The route requires the existing owner session. Optional query parameters:

| Parameter | Default |       Bounds | Meaning                                         |
| --------- | ------: | -----------: | ----------------------------------------------- |
| `limit`   |      50 |        1–100 | Maximum task summaries in this page             |
| `cursor`  |    none | 1–1024 chars | Signed continuation token bound to this project |

Requests require the authenticated owner session (`401 unauthorized` otherwise). Unknown query parameters and invalid values return `422 invalid_input`. A cursor from another project, a modified cursor, or a cursor invalidated by worker-token rotation returns `422 invalid_cursor`. Unknown project IDs return `404`. An archived project's detail and tasks remain readable.

## Response

```json
{
  "project": {
    "id": "prj_0123456789abcdef0123456789abcdef",
    "ownerId": "owner",
    "key": "AO-105",
    "name": "Project workspace",
    "objective": "Read project task state.",
    "status": "active",
    "priority": "normal",
    "revision": 1,
    "createdAt": "2026-11-04T00:00:00.000Z",
    "updatedAt": "2026-11-04T00:00:00.000Z"
  },
  "tasks": [
    {
      "id": "task-0001",
      "title": "Review the deliverable",
      "status": "in_progress",
      "createdAt": "2026-11-04T01:00:00.000Z",
      "projectId": "prj_0123456789abcdef0123456789abcdef",
      "associationRevision": 1,
      "latestRun": {
        "id": "run-0001",
        "status": "running",
        "createdAt": "2026-11-04T02:00:00.000Z",
        "updatedAt": "2026-11-04T02:01:00.000Z"
      }
    }
  ],
  "page": {
    "observedTotal": 1,
    "complete": true,
    "nextCursor": null
  }
}
```

`latestRun` is null when the task has no run. Otherwise the status comes from the run row with greatest `(created_at, id)`, and is one of `queued`, `running`, `stopping`, `completed`, `cancelled`, `failed`, `interrupted`, or `unknown`. Task status remains independent: `open`, `in_progress`, or `completed`.

`observedTotal` is the number of tasks associated with the project at the database snapshot for this request. `complete` describes whether another page currently has rows; when false, `nextCursor` continues after the last task in `(created_at DESC, id DESC)` order. Each HTTP request is its own database snapshot. Project-association changes to unexecuted tasks between requests can change later pages; restart at the first page after reassignment. Tasks with runs or runtime authorizations cannot be reassigned to another project, so historical run state remains attached to its task identity. `associationRevision` is shared with the separately managed Epic association, so it can advance even though this response does not expose Epic IDs; see `PROJECT_EPIC_TASK_ASSOCIATION_API_V1.md`.

An empty project returns `tasks: []`, `observedTotal: 0`, `complete: true`, and `nextCursor: null`. Legacy tasks whose `projectId` is null are excluded. The response contains no task detail, run events or logs, usage, lease data, authorization information, credentials, or worker-internal metadata. GET requests do not mutate project, task, run, audit, or authorization state.

## Data access and boundaries

The API confirms project existence and lifecycle using its existing owner-authenticated authorizer read. It then calls a worker-internal, token-protected read route. The worker filters on `tasks.project_id` in SQL and uses a bounded lateral lookup against runs for each page. It does not read the projects table. The feature adds no migration, grant, runtime write authority, or run-admission path.

No client may call the worker directly. The API returns `Cache-Control: no-store` using the existing response policy. Runtime mode remains synthetic/mock-only; this endpoint reports persisted state without implying provider activity.

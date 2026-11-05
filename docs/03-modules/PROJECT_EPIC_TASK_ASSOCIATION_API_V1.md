# Project Epic-to-Task Association API V1

## Scope and relationship

An owner may assign each existing task to zero or one Epic in the same project. An Epic can contain multiple tasks. Tasks with no project, including legacy tasks, remain valid and cannot be assigned to an Epic. The association is stored in `task_epic_associations`, separate from `tasks`, so the new Epic identifier is not exposed through the runtime's existing task-table `SELECT` grant.

The composite foreign keys bind `(project_id, task_id)` to the task and `(project_id, epic_id)` to the Epic. The database therefore rejects cross-project and projectless associations independently of API validation. `tasks.association_revision` is shared by project and Epic association changes.

This contract describes the current association. Historical runs and events remain attached to the stable task ID; reassignment does not rewrite or erase run history. The existing Project Workspace task response is unchanged and does not include an Epic field. Use the routes below for Epic-specific task information.

## Routes

All routes require the existing owner session. Mutations also require the session-bound CSRF token and a UUID `Idempotency-Key`.

### Read a task's current Epic

```http
GET /api/v1/tasks/task-0001/epic
```

The response is `TaskEpicResponseSchema`:

```json
{
  "taskId": "task-0001",
  "projectId": "prj_0123456789abcdef0123456789abcdef",
  "epic": {
    "id": "epc_0123456789abcdef0123456789abcdef",
    "projectId": "prj_0123456789abcdef0123456789abcdef",
    "title": "Prepare launch",
    "description": null,
    "status": "planned",
    "revision": 1,
    "archivedAt": null,
    "createdAt": "2026-11-05T00:00:00.000000Z",
    "updatedAt": "2026-11-05T00:00:00.000000Z"
  },
  "associationRevision": 2
}
```

When the task has no Epic, `epic` is `null`. A projectless task returns `projectId: null`, `epic: null`, and its current association revision. Unknown task IDs return `404`.

### Set, change, or remove a task's Epic

```http
PUT /api/v1/tasks/task-0001/epic
Idempotency-Key: 4de8c9e2-5f8e-4d2f-9f01-5632f94b7e43
```

Assign or move an association:

```json
{
  "expectedAssociationRevision": 2,
  "epicId": "epc_0123456789abcdef0123456789abcdef"
}
```

Remove the association without deleting the task:

```json
{
  "expectedAssociationRevision": 3,
  "epicId": null
}
```

The response is `TaskEpicAssociationSchema`:

```json
{
  "taskId": "task-0001",
  "projectId": "prj_0123456789abcdef0123456789abcdef",
  "epicId": "epc_0123456789abcdef0123456789abcdef",
  "associationRevision": 3
}
```

Every actual association change increments `associationRevision` and writes a metadata-only audit row in the same transaction. Setting the existing association is a no-op and does not increment the revision. Repeating the same idempotency key and request replays its original receipt; reusing the key with another task or request payload returns `409`. Concurrent requests based on one revision serialize; only the first actual change succeeds, and the other receives `409`.

Task project reassignment is rejected while an Epic association exists. Explicitly unlink first, then use the existing project-association route and its latest revision. The database task row lock serializes project and Epic association changes, so no committed cross-project state is possible.

### List tasks in an Epic

```http
GET /api/v1/projects/:projectId/epics/:epicId/tasks?limit=50&cursor=...
```

The response uses the existing `ProjectWorkspaceTaskPageSchema` with safe task summaries and their latest actual run status. It excludes task detail, run events/logs, credentials, leases, authorization metadata, and worker internals. An empty Epic returns an empty complete page. Archived Epics remain readable, including their currently associated tasks.

Ordering is stable `(createdAt DESC, id DESC)`. The default page size is 50; the maximum is 100. `page.observedTotal`, `page.complete`, and `page.nextCursor` describe current membership for the request. The signed cursor is bound to both project and Epic and uses its own derived signing domain. Pagination is not a historical snapshot: after task membership changes, restart from the first page. Tampered, foreign-project, foreign-Epic, or key-rotated cursors return `422`.

## Lifecycle and concurrency behavior

- Assignments require an existing task with an active project and an existing, non-archived Epic in that project.
- Projectless tasks and cross-project Epic IDs cannot be assigned.
- Archiving an Epic preserves existing task associations. Those tasks remain visible in the archived Epic's read list.
- An archived Epic cannot receive assignments. Its existing assignment may be removed or replaced with an active Epic while the parent project remains active.
- An archived project remains readable but blocks all new Epic-association changes, including unlinking.
- Project archival and association mutation serialize on the project row. Epic archival and assignment serialize on the Epic row. Task Epic changes and project reassignment lock the task first.
- Epic status does not affect run admission. The existing project-aware run admission guard remains the authority; existing and future runs are not rewritten by Epic changes.
- Epic association changes may occur after task runs or authorizations exist. The task and historical run/event IDs are unchanged; the association is current organizational metadata, not a rewrite of historical run records.

## Errors

- `401`: owner session missing or invalid.
- `403`: owner authorization, origin, or CSRF check failed.
- `404`: task, project, or Epic is unknown or outside the specified project.
- `409`: stale association revision, idempotency conflict, archived target/parent, projectless task assignment, or task project move attempted before Epic unlink.
- `422`: malformed identifiers, invalid body/query, or invalid signed cursor.
- `503`: authorizer is unavailable or a mutation outcome is uncertain; the same idempotency key is safe to retry.

Error messages do not include SQL, credentials, or submitted task content.

## Database boundary

The API forwards reads and mutations through the private authorizer service. Narrow `SECURITY DEFINER` functions use a fixed `pg_catalog, omnis` search path, require `session_user = 'omnis_authorizer'`, validate project and Epic scope, and enforce revisions/idempotency transactionally. The authorizer has no direct association-table privileges. `omnis_runtime` has no association-table access or Epic-specific function grants, and no Epic identifier is added to the runtime-visible `tasks` table. The existing `set_task_project` function refuses project movement until explicit Epic unlinking. Audit records store task/project/Epic IDs, action, owner marker, request UUID, and time only.

## Frontend handoff and limits

Frontend consumers can read the current Epic from `GET /api/v1/tasks/:taskId/epic`, assign/change/unlink through the corresponding `PUT`, and page Epic task summaries through the nested Epic route. Send the latest `associationRevision` on every mutation and a fresh UUID idempotency key for each distinct operation. Display archived Epics as readable but unavailable for new assignments.

V1 does not calculate Epic progress, add task dependencies, associate milestones with Epics, alter run-admission policy, implement Epic UI, or enable runtime/provider or multi-user capabilities.

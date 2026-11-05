# Project Epics API V1

## Scope

An Epic is an owner-managed planning record scoped to exactly one project. V1 supports create, list, detail, metadata/status update, and archive. Epic completion is explicitly owner-set and is not computed from tasks, milestones, or runs.

V1 does not associate Epics with tasks or milestones, calculate progress, schedule agents, or change task/run execution. These relationships require a separate contract and privilege review.

## Data model

`project_epics` stores an immutable `epc_` identifier, parent project ID, title, optional description, status, positive revision, archived timestamp, and UTC creation/update timestamps. The `(project_id, id)` key enforces project-scoped identity. A project can contain at most 500 Epics.

Titles are trimmed and limited to 120 characters. Descriptions are optional, trimmed, and limited to 2,000 characters. The API and persistence boundary apply the existing heuristic credential scanner. This scanner reduces accidental credential storage but is not comprehensive secret prevention.

## Lifecycle

New Epics start as `planned`. Allowed transitions are:

| Current       | Allowed next                           |
| ------------- | -------------------------------------- |
| `planned`     | `in_progress`, `completed`, `archived` |
| `in_progress` | `completed`, `archived`                |
| `completed`   | `archived`                             |
| `archived`    | none                                   |

Archived Epics remain readable and cannot be edited or restored. Any non-archived project status permits Epic mutation. An archived project remains readable but blocks Epic creation and mutation. Project archival does not delete or rewrite Epic history. Parent project row locks serialize Epic mutations against project archival.

## Endpoints

All routes require the existing owner session. Mutations additionally require the session-bound CSRF token and a UUID `Idempotency-Key`.

- `GET /api/v1/projects/:projectId/epics?limit=50&cursor=...`
- `POST /api/v1/projects/:projectId/epics`
- `GET /api/v1/projects/:projectId/epics/:epicId`
- `PATCH /api/v1/projects/:projectId/epics/:epicId`
- `POST /api/v1/projects/:projectId/epics/:epicId/archive`

Create body:

```json
{ "title": "Prepare launch", "description": "Optional planning detail." }
```

Update body (at least one editable field is required):

```json
{ "expectedRevision": 1, "title": "Prepare first launch", "status": "in_progress" }
```

To clear a description, send `"description": null`. Archive body:

```json
{ "expectedRevision": 2 }
```

Responses use the canonical `EpicSchema`:

```json
{
  "id": "epc_0123456789abcdef0123456789abcdef",
  "projectId": "prj_0123456789abcdef0123456789abcdef",
  "title": "Prepare launch",
  "description": null,
  "status": "planned",
  "revision": 1,
  "archivedAt": null,
  "createdAt": "2026-11-05T00:00:00.000000Z",
  "updatedAt": "2026-11-05T00:00:00.000000Z"
}
```

## Pagination

Lists are ordered by `(createdAt DESC, id DESC)`. Default page size is 50; the maximum is 100. The signed keyset cursor is bound to its project and uses an Epic-specific HKDF domain. A response includes `page.observedTotal`, `page.complete`, and `page.nextCursor`. Pagination observes current data and is not a historical snapshot; concurrent inserts can change subsequent page contents. The 500-Epic project capacity and explicit completeness metadata prevent silent truncation.

## Revisions and retries

Every successful update or archive increments `revision`. Stale expected revisions return HTTP 409. Concurrent mutations serialize at the Epic row and only one request based on a given revision succeeds. A successful mutation and its metadata-only audit event commit atomically.

Idempotency is keyed by the shared management request UUID. Retrying the same operation with the same key and request fingerprint returns its original receipt. Reusing the key for a different operation or payload returns HTTP 409. A retry of a committed mutation remains replayable even if the project is archived later.

## Errors

- `401`: owner session is missing or invalid.
- `403`: owner authorization or CSRF/origin protection failed.
- `404`: project is unknown, or Epic is unknown/outside the specified project.
- `409`: stale revision, idempotency conflict, archived target, invalid lifecycle transition, or archived parent project.
- `422`: malformed IDs, invalid fields/status/query, or credential-like content rejected by the heuristic scanner.
- `503`: per-project Epic capacity has been reached.

Errors do not include submitted title/description values, internal SQL, or authorization tokens.

## Database security

The API forwards requests through the existing private authorizer boundary. `omnis_runtime`, `omnis_launcher`, and `omnis_authorizer` have no direct table privileges on Epic or Epic audit tables. Only the authorizer login receives `EXECUTE` on the five narrowly scoped `SECURITY DEFINER` list/get/create/update/archive functions. Functions set a fixed `pg_catalog, omnis` search path and verify `session_user`. Mutations check owner/project scope inside the function. `omnis_runtime` receives no new privileges.

Audit records contain the owner actor marker, project/Epic IDs, action, request UUID, changed field names, and timestamp; submitted text is excluded. Restore ACL policy explicitly reapplies the Epic function grants and revokes direct table access.

## Frontend handoff

Frontend consumers should use the owner session through the API, include CSRF and an idempotency UUID for mutations, and send the latest `revision` when editing or archiving. Archived Epics are returned in project lists and detail reads with status `archived`; display them as read-only. Do not infer progress or execution state from Epic status.

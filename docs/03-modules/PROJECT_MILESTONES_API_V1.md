# Project Milestones API V1

## Scope and lifecycle

Milestones are owner-managed records scoped to exactly one project. V1 stores a stable `mil_` identifier, title, optional description, optional date-only target, lifecycle status, revision, UTC timestamps, and archival timestamp. The optional target is a calendar date in `YYYY-MM-DD`; it is not an instant in a timezone.

Milestone statuses are `planned`, `in_progress`, `completed`, and `archived`. Allowed transitions are:

| Current status | Allowed next status                    |
| -------------- | -------------------------------------- |
| `planned`      | `in_progress`, `completed`, `archived` |
| `in_progress`  | `completed`, `archived`                |
| `completed`    | `archived`                             |
| `archived`     | none                                   |

Milestones can be created or changed while their project is in any non-archived project state (`proposed`, `active`, `paused`, or `completed`). The project row is locked inside each mutation function. Project archival takes a conflicting lock, so a mutation either commits before archival or observes the archived state and fails. Archived projects and milestones remain readable. Archived milestones cannot be edited or restored. Project archival does not archive or rewrite its milestone history.

Milestone status is set by the owner; it is not inferred from task state. V1 has no milestone-to-task relationship, progress calculation, or automated completion.

## API

All endpoints require the existing owner session. Mutations also require session-bound CSRF protection and a UUID `Idempotency-Key` header.

### `GET /api/v1/projects/:projectId/milestones`

Query parameters:

- `limit`: optional integer from 1 to 100; default 50.
- `cursor`: optional signed cursor returned by the previous response.

Returns all milestone states, including archived milestones, in `(createdAt DESC, id DESC)` order. Pagination is keyset-based and live across requests. Cursors are signed with a domain-separated HKDF key derived from the configured management signing key and are bound to the project. A signing-key rotation invalidates outstanding cursors; clients should restart from the first page. `observedTotal` counts the project's milestones in the database snapshot used for the current page query; it may change between pages. Restart from the first page after changing milestone data. At most 500 milestones may belong to a project, and creation fails closed at that limit.

```json
{
  "milestones": [
    {
      "id": "mil_0123456789abcdef0123456789abcdef",
      "projectId": "prj_0123456789abcdef0123456789abcdef",
      "title": "First release",
      "description": null,
      "status": "planned",
      "targetDate": "2027-01-31",
      "revision": 1,
      "archivedAt": null,
      "createdAt": "2026-11-05T00:00:00.000000Z",
      "updatedAt": "2026-11-05T00:00:00.000000Z"
    }
  ],
  "page": { "observedTotal": 1, "complete": true, "nextCursor": null }
}
```

### `POST /api/v1/projects/:projectId/milestones`

Creates a planned milestone under a non-archived project.

```json
{
  "title": "First release",
  "description": "Publish the first usable increment.",
  "targetDate": "2027-01-31"
}
```

`description` and `targetDate` are optional; `targetDate` may be `null` when explicitly cleared on update. Title is limited to 120 characters; description is limited to 2,000 characters. Input is checked by the existing credential heuristic. This heuristic is not comprehensive secret detection.

Matching retries with the same UUID idempotency key and normalized payload replay the original response. Reusing a key for another operation or payload returns `409`. A lost response should be retried with the same key.

### `GET /api/v1/projects/:projectId/milestones/:milestoneId`

Returns the exact milestone only when it belongs to the given project. Archived records remain readable. Unknown project IDs, unknown milestone IDs, and IDs belonging to a different project return `404`.

### `PATCH /api/v1/projects/:projectId/milestones/:milestoneId`

Requires `expectedRevision` plus at least one mutable field:

```json
{ "expectedRevision": 1, "title": "First public release", "status": "in_progress" }
```

Allowed fields are `title`, `description`, `targetDate`, and `status`; project identity and milestone ID are immutable. A successful change increments the revision. Concurrent edits based on the same revision serialize; only the first succeeds and stale edits return `409`. Allowed status transitions are listed above. The `archived` status is set only by the archive endpoint.

### `POST /api/v1/projects/:projectId/milestones/:milestoneId/archive`

Requires `{ "expectedRevision": n }`. Archiving preserves the record and history, sets status to `archived`, and increments its revision. A retry with the same key replays the response. A new archive request after archival returns `409`. There is no restore operation in V1.

## Errors and persistence boundary

- `401`: no owner session.
- `403`: owner session missing valid origin/CSRF protection for a mutation.
- `404`: unknown project or milestone, including a milestone outside the requested project.
- `409`: stale revision, idempotency-key reuse, archived resource, archived parent, or invalid status transition.
- `422`: malformed, oversized, unsafe, or invalid query/input.
- `503`: database capacity or service limit could not be satisfied.

Each mutation writes the milestone and a metadata-only audit row in the same transaction. Audit records contain actor, action, request ID, changed field names, and timestamps; they do not store titles, descriptions, or submitted values. Audit history is immutable. The authorizer invokes narrowly scoped `SECURITY DEFINER` functions with fixed search paths and explicit grants. Direct table privileges remain revoked from `omnis_runtime`, `omnis_authorizer`, and `omnis_launcher`; `omnis_runtime` receives no milestone mutation authority.

Milestone reads and writes pass through the internal authorizer service. Browsers have no direct access to the authorizer or database. This V1 adds no task links, runtime permissions, execution behavior, providers, or multi-user access.

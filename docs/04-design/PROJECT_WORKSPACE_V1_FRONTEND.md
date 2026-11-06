# Project Workspace V1 — Frontend

Owner-facing project management in the Omnis OS web app, built on the OMNIS NEXUS design system
([NEXUS_DESIGN_SYSTEM.md](NEXUS_DESIGN_SYSTEM.md)). The backend contracts are in
[PROJECT_WORKSPACE_API_V1.md](../03-modules/PROJECT_WORKSPACE_API_V1.md) and
[API_CONTRACT.md](../02-architecture/API_CONTRACT.md). Executable contracts
(`packages/contracts`, `apps/api/src/project-*.ts`) were treated as authoritative.

Runtime stays synthetic: nothing here starts a run or contacts a provider. This feature adds no
backend, database, dependency or font change.

## Routes and composition

Hash routing, matching the rest of the app. **Projects** is a primary-navigation entry (`#projects`).

| Hash                  | Screen                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| `#projects`           | Directory. `?archived=1` also shows archived projects.                 |
| `#projects/new`       | Create form                                                            |
| `#projects/<id>`      | Detail: project facts, objective, archive action, paged task summaries |
| `#projects/<id>/edit` | Edit form (an archived project shows a read-only message instead)      |

An id that is not `prj_` plus 32 hex characters is a malformed link and makes no request. Direct
entry, reload and browser back/forward work for every route. After in-app navigation focus moves to
the screen's heading; a direct load never moves focus. The shell owns the page's `h1` ("Projects");
the screens use an `h2` panel per screen and `h3` for sub-sections.

Code: `apps/web/src/ui/projects/` (`ProjectsWorkspace` router, `ProjectDirectory`, `ProjectDetail`,
`ProjectForm`, `hooks.ts`, `data.ts`, `recovery.ts`, `messages.ts`, `intent.ts`, `route.ts`).

Components reused: `Panel`, `InfoGroup`, `NxButton`, `Field`, `NxInput`, `NxTextarea`, `NxSelect`,
`StatusBadge`, `DataTable`, `SearchFilter`, `LoadingState`, `EmptyState`, `ErrorState`,
`ConfirmDialog`. The workspace is a dark NEXUS surface inside the still-light application shell
until the shell is migrated.

## API contract as implemented

| Purpose        | Request                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| Directory      | `GET /api/v1/projects`                                                          |
| Detail         | `GET /api/v1/projects/:id`                                                      |
| Task summaries | `GET /api/v1/projects/:id/tasks?limit=25[&cursor=…]`                            |
| Create         | `POST /api/v1/projects` `{key, name, objective, priority}`                      |
| Edit           | `PATCH /api/v1/projects/:id` `{expectedRevision, name?, objective?, priority?}` |
| Archive        | `POST /api/v1/projects/:id/archive` `{expectedRevision}`                        |

Every response is parsed with the shared strict schema, and a 2xx for a mutation is accepted only if
it also matches the request (same key/name/objective/priority, `revision === expectedRevision + 1`,
`status: archived` for archive). `GET /api/v1/tasks/:id` does not exist and is never called.

- **Mutations** send the session CSRF token (`x-omnis-csrf`) and a UUID `Idempotency-Key`. The API
  also checks `Origin`; same-origin fetches satisfy it.
- **The project list is not paginated.** It is `{projects, total, complete: true}`, ordered by
  creation, complete up to 500 and fail-closed (`503 limit`) beyond that. Summaries have no
  objective. Search and the archived toggle are client-side over the complete list.
- **Archived projects** are returned by the list and readable by id. The directory hides them by
  default and says how many are hidden.
- **Task page.** `page.observedTotal` is the count at that request, `complete` says whether another
  page remains, `nextCursor` is null only when complete. The UI shows "Showing N tasks so far. M
  tasks were associated … when the latest page was read" while incomplete, "Showing all N tasks"
  when complete and consistent, and warns when they disagree. It never presents a partial page as a
  total. Later pages are de-duplicated by task id. `422 invalid_cursor` offers a restart from the
  first page; a failed later page keeps what is already shown.
- **`conflict` (409) is ambiguous on the wire.** The project store uses it for a duplicate key, a
  stale revision and idempotency-key reuse. The UI reads it by operation: create → key taken;
  edit/archive → stale revision, confirmed by re-reading the project.
- **`invalid_transition` (409)** means an edit or archive of an already-archived project.
- **`503 limit`** from create is a definite refusal. Other 5xx, network failures and unverifiable
  bodies leave the outcome **unknown**.
- **401** at any point returns to sign-in through the shell's existing session-expiry handling.
  Unsaved form input is not preserved across sign-in.
- Timestamps use `Asia/Manila`, as elsewhere in the app.

## Mutations, revisions and unknown outcomes

- **One idempotency key per intent** (`intent.ts`). A key is reused only when the identical request
  is sent again after an unknown outcome; any change to the request, or a definite outcome, gets a
  new key.
- **No duplicate submissions.** A synchronous in-flight guard, the busy (non-clicking) button, and a
  paused form while an outcome is unresolved.
- **Create.** Client checks mirror the schema (key `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$`, 2–32; name ≤120;
  objective ≤4000) and explain; the server stays authoritative. Failures keep every typed value. A
  taken key is shown on the key field.
- **Edit.** Only changed fields are sent, with `expectedRevision`. On a stale revision the project
  is re-read and the form offers, explicitly: _Load latest values (discard my edits)_ or _Keep my
  edits on the latest version_ (untouched fields take the latest value). Nothing is resubmitted
  automatically; a deliberate second save uses the new revision and a new key. A project archived
  meanwhile makes the form read-only.
- **Archive.** `ConfirmDialog` (danger) states that it cannot be undone, that there is no restore,
  that the project stays readable but is no longer editable, that new runs can no longer be started
  for its tasks, and that started runs are not cancelled. Cancel has initial focus; Escape cancels.
  After success the Edit and Archive actions disappear and focus moves to the confirmation.
- **Unknown outcome** (network failure, ambiguous 5xx, unverifiable body): the screen re-reads
  authoritative state — the list for create (matching on key, name and priority, because list rows
  have no objective), the project for edit and archive — and says what it found: applied, not
  applied, changed by something else, or still unknown. "Try again" is offered only when the read
  shows the operation did not apply, and it reuses the same key and body, which the server replays
  or applies once. If the project changed in between, retry is withheld in favour of _Load latest_.
  If the recheck itself fails, saving stays paused and only _Check again_ is offered.
- **CSRF rejection (403)** refreshes the token and asks the owner to try again; the change was not
  applied.

User-facing copy lives in `messages.ts` as a keyed catalogue; every rendered message exposes
`data-message-key`. Tests assert exact wording typed independently of the catalogue.

## Accessibility

Real labels, hints and error text wired with `aria-describedby`/`aria-invalid`; invalid fields take
focus after a failed submit; tables have captions and a keyboard-focusable scroll region (they
scroll inside it at narrow widths rather than widening the page); status uses shape plus text;
errors and uncertain outcomes are announced (`role="alert"`), progress and success politely
(`role="status"`); the archived banner is a standing state and is not announced; dialog focus is
native (`<dialog>`), returning to the opener. Reduced motion removes animation.

## Verification performed

Chromium only, against a contract-parsed fixture API with an unexpected-request guard (see
`apps/web/src/ui/projects.spec.ts` and `projects.fixture.ts`): directory, detail, paging, create,
edit, conflicts, archive, CSRF, session expiry, duplicate submission, unknown outcomes, stale and
out-of-order responses, history, focus, axe at 390 and 1440 px (screens, errors, dialog), overflow at
320/390/720/1024/1440 px, a 16 px minimum-font setting at 320 px, genuine 200% zoom, and reduced
motion. Not performed: other browsers, a screen reader, OS-level zoom, or the real backend.

## Limitations and deferred work

- **Task association.** Creating tasks inside a project and assigning tasks to projects are not in
  V1; existing endpoints (`POST /api/v1/tasks` with `projectId`, `PUT /api/v1/tasks/:id/project`)
  support them and are a follow-up. Task detail and Mission Lane task-event history are out of scope.
- No restore (the API has none), no delete, no project status transitions other than archive (the API
  exposes none), no sorting, no server-side search. Milestones and Epics have backend APIs but no UI.
- The directory shows every project the API returns (≤500); there is no paging to implement.
- Drafts are not preserved across a session expiry.
- The workspace is dark inside a light shell until the shell is migrated to NEXUS.

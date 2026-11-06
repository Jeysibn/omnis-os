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
- **`conflict` (409) does not say why.** The project store maps a duplicate key, a stale revision and
  reuse of an idempotency key to one code, `conflict`, with one message ("A project with this key
  already exists or the idempotency key was reused."), and `invalid_transition` (also 409) to an edit
  or archive of an already-archived project. The UI therefore never explains a 409 from the response
  alone: it reads the authoritative state and states only what that read shows (see below). The
  response message is never shown or parsed for a cause, and no subcode is invented.
- **`503 limit`** from create is a definite refusal. Other 5xx, network failures and unverifiable
  bodies leave the outcome **unknown**.
- **401** at any point returns to sign-in through the shell's existing session-expiry handling.
  Unsaved form input is not preserved across sign-in.
- Timestamps use `Asia/Manila`, as elsewhere in the app.

## Mutations, revisions and unknown outcomes

### What each kind of evidence can prove

| Evidence                                                                                    | What the UI may say                                                                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A 2xx whose body matches the request (`revision === expected + 1`, same fields, `archived`) | **Confirmed:** the server confirmed this request.                                        |
| A definitive 4xx/`503 limit` with a valid error envelope                                    | **Rejected:** the change was not applied. The _reason_ is only what the response proves. |
| A readback after an **unknown** outcome (network, ambiguous 5xx, unverifiable body)         | **Observed state:** what the project looks like now. Never proof of who wrote it.        |
| A readback after a **409**                                                                  | **Observed state**, used to word the conflict. A 409 is not a diagnosis.                 |
| A failed readback                                                                           | **Unresolved:** say so, keep the owner's values, offer _Check again_.                    |

Matching values at the next revision after a lost edit, an existing project with the submitted key,
and an archived project after a lost archive are all consistent with this request having worked and
with another owner session having done the same thing. They are reported as observed, with the
sentence "We couldn't confirm whether this request …".

### Idempotency-key lifetime (`intent.ts`)

One key per distinct intent. A key is reused only when the **identical** request (same method, path
and body, including `expectedRevision`) is sent again after an **unknown** outcome. It is dropped, and
the next submit gets a new key, when: the outcome becomes known (confirmed or rejected), the request
changes in any way, the owner chooses **Edit values**, or the owner loads the latest values or keeps
edits on the latest version. Leaving the screen discards it; reopening the form starts from the
server's values with no retry pending.

### Frozen retry versus Edit values

When an unknown outcome is read back as "not applied", the form offers **Try again**. That retry
resends the stored request, so the form is **frozen** for as long as it is on offer: text inputs are
read-only, the priority select is disabled, and the submit button is disabled. The inputs are also
locked while a request or a recheck is in flight. Editing is never possible while a retry is
available, so the visible values can never differ from what _Try again_ will send. As defence in
depth, _Try again_ rebuilds the request from the visible values and refuses to send the stored one if
they differ, telling the owner the values changed and nothing was sent.

**Edit values** ends the frozen retry: it drops the idempotency key, unlocks the form, moves focus to
the first control and says that saving now sends a new request. A recheck that answers after the
owner has left the state is ignored (each recheck is sequence-numbered). Reload and browser
back/forward leave the state too; nothing is sent by navigating.

### Per operation

- **Create.** Client checks mirror the schema (key `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$`, 2–32; name ≤120;
  objective ≤4000) and explain; the server stays authoritative. Failures keep every typed value.
  - _409:_ the project list is read. If the submitted key is present, the UI says that key is used by
    a project of that name and that the server's conflict response does not say which condition
    caused it; the key field is marked. If it is absent, the message is neutral and the key field is
    not marked. If the list cannot be read, it says the conflict could not be resolved. A project
    with the same key, name and priority is never treated as this request's result. Nothing is
    resent automatically; a deliberate second attempt is a new request with a new key.
  - _Unknown outcome:_ the list is read. A row with the key, name and priority is reported as
    observed ("We couldn't confirm whether this request created it") with _Open project_.
- **Edit.** Only changed fields are sent, with `expectedRevision`.
  - _409:_ the project is read. Archived → described as currently archived, without saying who
    archived it. A revision **different** from the one opened → the only case called stale, with
    _Load latest values (discard my edits)_ or _Keep my edits on the latest version_ (untouched
    fields take the latest value; a deliberate second save uses the new revision and a new key).
    The **same** revision → neutral ("the project is unchanged at revision N, so Omnis OS can't tell
    why"); edits are kept and saving again is a new request. Failed read → unresolved.
  - _Unknown outcome:_ matching values at `expectedRevision + 1` → "The project currently has the
    requested values. We couldn't confirm whether this request saved them." and the screen returns to
    the project; nothing is called saved. Previous values at the same revision → not applied, frozen
    retry. Anything else → changed, with _Load latest_ / _Keep my edits_ and no retry.
- **Archive.** `ConfirmDialog` (danger) states that it cannot be undone, that there is no restore,
  that the project stays readable but is no longer editable, that new runs can no longer be started
  for its tasks, and that started runs are not cancelled. Cancel has initial focus; Escape cancels.
  After a confirmed success the Edit and Archive actions disappear and focus moves to the
  confirmation.
  - _409:_ the project is read and shown. Archived → "currently archived", no attribution. Different
    revision → "changed since you opened it, so it was not archived". Same revision, still active →
    neutral, "not archived", confirming again is a new request. Failed read → state unconfirmed;
    reload before trying again.
  - _Unknown outcome:_ archived → "The project is now archived … We couldn't confirm whether this
    request archived it." Still active at the same revision → not applied, _Try again_ with the same
    key and body. Changed → review the latest version.
- **No duplicate submissions.** A synchronous in-flight guard, the busy (non-clicking) button, locked
  inputs, and a paused form while an outcome is unresolved. Each layer is covered by its own test.
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
edit, conflicts (with the backend's real, non-specific 409 message), archive, CSRF, session expiry,
duplicate submission, unknown outcomes, the frozen retry and Edit values, late recheck responses,
confirmed versus observed outcomes, stale and out-of-order responses, history, focus, axe at 390 and 1440 px (screens, errors, dialog), overflow at
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
- A 409 can never be attributed to a specific cause from the response. A readback shows the state
  after the fact, so a changed project and a lost race look the same; the wording stays neutral
  where the evidence does not separate them.
- While a retry is on offer the form is locked; the owner must choose _Edit values_ to change
  anything, which discards the pending retry.
- The workspace is dark inside a light shell until the shell is migrated to NEXUS.

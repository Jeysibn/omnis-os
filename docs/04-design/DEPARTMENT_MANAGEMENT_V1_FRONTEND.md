# Department Management V1 - Frontend Specification

**Status: SPECIFICATION ONLY.** This document describes a future frontend change. It adds no application code, and merging it does **not** implement Department Management, complete AO-104, or complete AO-110. Implementation starts only after this specification is reviewed and the owner decisions in section 4 are answered.

**Baseline:** `main` at `a3c53e2` (Read-only Agents & Profiles V1, PR #20; department backend, PR #19). Date: 2026-11-04.

## 1. Purpose and source of truth

Department Management V1 lets the single owner (Director) list, create, rename and archive departments from the web app, using only the department endpoints that already exist on `main`. It is a small secondary screen, not an organization-chart feature.

| Concern | Authoritative document |
|---|---|
| Implemented request/response schemas | `packages/contracts/src/index.ts` (Zod; the executable contract) |
| Backend behavior and database rules | [AO-104 Department Management evidence](../07-governance/evidence/AO_104_DEPARTMENT_MANAGEMENT.md) |
| Domain rules for departments, agents and profiles | [Agents, Profiles, Departments and Teams](../03-modules/AGENTS_PROFILES.md) |
| HTTP conventions | [API Contract](../02-architecture/API_CONTRACT.md) |
| Existing agents UI conventions (routing, states, safe rendering) | [Agents & Profiles V1 Frontend](AGENTS_PROFILES_V1_FRONTEND.md) |
| Product-wide UI/UX and brand | [UI/UX Specification](UI_UX_SPEC.md), [Brand Identity](BRAND_IDENTITY.md) |
| Agent safety rules | `AGENTS.md` |

This document governs only how department management is **presented, navigated and tested**. If it disagrees with `packages/contracts` or the backend on behavior, the implemented contract wins and this document must be corrected.

## 2. Verified backend contract (`a3c53e2`)

Verified by reading `packages/contracts/src/index.ts`, `apps/api/src/department-routes.ts`, `apps/api/src/auth.ts`, `apps/authorizer/src/app.ts`, `packages/db/src/department-management-store.ts` and migration `0013_department_management.sql`. Nothing below is proposed; anything not listed does not exist.

### 2.1 Endpoints

All paths are under `/api/v1`. All require the owner session (`401` otherwise). Mutations additionally require the same-origin check and the session-bound CSRF token in the `x-omnis-csrf` header (`403`, code `csrf_rejected`, message "Refresh the page and retry the action.").

| Method and path | Request | Success |
|---|---|---|
| `GET /departments` | Optional query `includeArchived=true\|false` (anything else is `422`) | `200` `{ departments: Department[], total }`, ordered by `lower(name)`, then `id`. Default is active departments only. `total` always equals `departments.length` (a Zod refinement rejects anything else). |
| `POST /departments` | JSON `{ slug, name }` (strict: extra fields are `422`) | `201` the created `Department` |
| `PATCH /departments/:departmentId` | JSON `{ slug, name }` (the **full** pair, strict) | `200` the updated `Department` |
| `POST /departments/:departmentId/archive` | No body | `200` the archived `Department` |

There is no `DELETE`, no unarchive, no `GET /departments/:id`, no search, no pagination, no ordering parameter, no `Idempotency-Key` support and no concurrency token (`ETag`, `If-Match` or version field).

### 2.2 Schemas

`Department` (strict; an unknown field makes the response fail validation):

| Field | Rule |
|---|---|
| `id` | opaque string, 1-128 characters, `^[A-Za-z0-9][A-Za-z0-9._~-]*$` (generated as `dep_<32 hex>`) |
| `slug` | `^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 80 characters |
| `name` | trimmed, 1-120 characters |
| `archivedAt` | ISO datetime or `null` |
| `createdAt`, `updatedAt` | ISO datetimes (UTC) |

Request body (`CreateDepartmentSchema`, also used for rename): `slug` is **trimmed, then** matched against the same slug rule (so uppercase letters, spaces, underscores, leading, trailing or doubled hyphens are rejected, not normalized), at most 80; `name` is trimmed, 1-120. Both fields are required.

### 2.3 Business rules

- **Slug uniqueness** is per owner, across **active and archived** departments (`UNIQUE (owner_id, slug)`). An archived department keeps its slug, so the slug cannot be reused. Names are **not** unique.
- **Rename** may change the name, the slug, or both, and always sends both. Renaming an archived department is rejected (`409`).
- **Archive** is one-way and only allowed when **no agent references the department** (including archived agents); otherwise `409`. Archiving an already archived department succeeds (`200`) and returns the existing row; it is idempotent.
- **No hard delete**, no unarchive. Archived rows are immutable.
- **Limit:** at most 500 departments in total (active plus archived). Creating the 501st is `422` with code `limit`; a list that would exceed 500 fails closed with `503` code `limit` and no partial result.
- **Concurrent edits** are last-write-wins: `PATCH` locks the row, but carries no token, so two overlapping renames both succeed and the later one wins. `updatedAt` is returned but cannot be sent back.
- **Credential-like input** (names or slugs that match the backend's credential heuristic) is rejected with `422` and the generic message "Department input is invalid." The response does not say which field.
- **Audit:** every create, rename and archive writes an append-only audit record (actor, action, department id, request id, time). The UI does not display audit data in V1.
- **Effect on agents:** agent summaries embed `{ id, slug, name }` of their department, so a rename appears in the agents directory the next time it is fetched. Department ids never change.

### 2.4 Error responses

Errors use the existing envelope `{ "error": { "code", "message", "requestId"? } }`.

| Status | Code (observed) | When |
|---|---|---|
| `401` | `unauthorized` | No valid owner session |
| `403` | `csrf_rejected` | Mutation with a missing, wrong or cross-origin CSRF check. The request had **no effect**. |
| `404` | `not_found` | Unknown department id on rename or archive |
| `409` | `conflict` | Create or rename: slug already exists (active or archived) |
| `409` | `invalid_transition` | Rename of an archived department; archive of a department that agents reference |
| `422` | `invalid_input` | Schema violation, unknown field, bad `includeArchived`, credential-like input |
| `422` | `limit` | Create when 500 departments exist |
| `503` | `limit` | List would exceed 500 |
| `503` | `department_outcome_unknown` | A mutation could not be confirmed. The message says: "Read the department state before retrying." The change may or may not have committed. |
| `503` | `authorizer_unavailable` / other | Store or control plane unavailable (reads, or failures before a write) |

The API documentation lists `409` for "duplicate slugs and invalid lifecycle transitions" but does not declare `code` values as a stable public contract. Section 8 therefore branches on the HTTP status and on re-reading state, and uses `code` only as a labelled, replaceable hint (owner decision D-7).

### 2.5 Frontend facts the design must fit

| Area | Fact (`a3c53e2`) |
|---|---|
| Routing | Hash routing via `readRoute()` in `App.tsx`; `Page` is `'command-center' \| 'tasks' \| 'runs' \| 'agents'`; the destination is the hash up to the first `/` or `?`. `agents/<id>` treats any non-empty segment as an agent id, so an agent may legally have the id `departments`. |
| Navigation | Four primary links. At 320 px they fit only because nav icons are hidden at <= 360 px (PR #20). A fifth link does not fit without a separate responsive-navigation decision. |
| Mutations | `csrfToken` lives in `App.tsx` state and is sent as `x-omnis-csrf`; `refreshCsrf()` re-fetches it. A mutation `403` does not expire the session (existing test). A `401` goes through `expireSessionIfNeeded`. Task creation treats a non-rejected failure (`outcome` `uncertain` or `invalid-response`) as "could not be confirmed; reload and check before trying again." |
| Dialog | `ApprovalDialog` uses a native `<dialog>` with `showModal()`, focuses the first enabled button (Cancel) on open, handles Esc through `onCancel`, and restores focus to the trigger on close. |
| Skip link | PR #16: the skip link focuses `<main>` with no hash or history change; the focus ring is a 3px `--blue` outline. |
| Tests | 117 Playwright tests (strict contract-parsing fixtures, axe at several widths), synthetic only. |

## 3. Scope and principles

**In scope (V1):** list active departments, optionally including archived; create; rename; archive; all for the single owner.

**Out of scope:** unarchive, delete, reordering, moving agents between departments, department detail pages, audit-log display, teams, room placement, bulk actions, import/export, agent create/edit (AO-104 lifecycle writes remain unavailable), Projects, runtime or permission display.

Principles:

1. **The server is the source of truth.** No optimistic updates, no row appears, changes or disappears before a successful response, and the list is re-read after every successful mutation (section 7).
2. **Honest outcomes.** A rejected request is shown as rejected; an unconfirmed one as unconfirmed, with a way to read the real state. A failed read is never rendered as an empty list.
3. **Smallest surface.** Only the fields and actions the backend supports. No unsupported control is rendered disabled "for later".
4. **Plain text only.** Department names and slugs are untrusted text (section 11).
5. **Reuse, don't redesign.** Existing panels, buttons, status patterns, the native dialog pattern, Asia/Manila time formatting and the brand tokens as shipped.

## 4. Owner decisions (proposed defaults, **not yet approved**)

These are product decisions. The defaults below are this document's proposals; none is treated as approved until the owner answers. Implementation must not start on a decision still marked Open.

| ID | Decision | Proposed default | Status |
|---|---|---|---|
| D-1 | Where does Department Management live? | A secondary screen at `#departments`, linked from the Agents directory. **Not** a fifth primary-navigation item. | **Open - owner approval required** |
| D-2 | Undo for archive | None. Archive is one-way and the UI says so. There is no Unarchive action because the backend provides none. | **Open - owner approval required** |
| D-3 | Concurrent rename | Accept the backend's last-write-wins behavior. The UI does not claim to detect conflicting edits; it shows the server's result and refreshes the list. | **Open - owner approval required** |
| D-4 | Duplicate-slug feedback | A field-specific message on the slug field on a `409` from create. For a rename `409`, the UI first re-reads the department (section 8.2) and shows the slug message only when the department is still active; otherwise it shows the archived state. No field-specific message is shown for any other error. | **Open - owner approval required** |
| D-5 | Agents directory department filter | Keeps using the department data embedded in agent summaries. No change to the agents screens and no `GET /departments` call from them until a separate integration change is justified. | **Open - owner approval required** |
| D-6 | Primary nav state on `#departments` | No primary nav item is marked `aria-current`; the screen shows a "← Agents" link and its own `h1`. (Marking Agents current would announce a page the user is not on.) | Proposed, low risk |
| D-7 | Telling the two `409` causes apart on rename | Do not depend on error `code`. Re-read the department list with `includeArchived=true`: archived means the rename hit the archived rule, active means a slug conflict. If the backend later declares `conflict` / `invalid_transition` as stable public codes, the UI may use them with the re-read as fallback. | Proposed; backend input (Codex #1) welcome |
| D-8 | Slug suggestion while typing a new name | Convenience only: until the user edits the slug field, suggest a slug derived from the name (lowercase, runs of non-alphanumerics become one hyphen, trimmed, at most 80). The server rules remain authoritative. May be dropped without affecting the contract. | Proposed |

## 5. Routes and navigation

### 5.1 Grammar

Let `hash` be `location.hash` without the leading `#`. Split off the query at the first `?`, then split the path on `/`.

| Hash | Result |
|---|---|
| `#departments` or `#departments/` | Department list (a trailing `/` is normalized away with `history.replaceState`) |
| `#departments?archived=1` | Department list including archived departments |
| Any other path under `departments` (`departments/x`, `departments/x/y`) | **Malformed link**: "This link isn't valid" with a link to the department list; **no API request** |

The query is read only for the `archived` parameter (`1` shows archived; any other value or unknown parameter is ignored). Create, rename and archive are **in-page** interactions with no routes of their own, so there is no identifier-bearing path to collide with anything.

### 5.2 Why `#departments` and not `#agents/departments`

`#agents/<id>` accepts any non-empty id, and ids match `^[A-Za-z0-9][A-Za-z0-9._~-]*$`, so `departments` is a valid agent id. Reserving it inside the agents grammar would make a legitimate agent unreachable or the route ambiguous. A separate top-level destination has no such collision: `agents` and `departments` are distinct first segments.

### 5.3 Route ownership

- `readRoute()` maps the destination `departments` to a new `Page` value `'departments'` (the only shell routing change, alongside the render switch). Parsing of the `?archived=1` query and of malformed paths lives in a `departments/` feature module, mirroring `agents/route.ts`. Existing routes and their tests are unchanged.
- The shell renders `<DepartmentsWorkspace>` for `page === 'departments'`, passing `onUnauthorized` (the existing 401 handling), the current `csrfToken` and `refreshCsrf`. The shell h1 is "Departments" and the subtitle "Create, rename and archive the departments agents belong to."
- `'departments'` is **not** added to `navItems` (D-1). The primary nav stays at four links. The `departments` page behaves like any other page for the SSE effect: no `EventSource` is opened.
- The workspace subscribes to `hashchange`, aborts in-flight reads when the route changes, and ignores late responses for a superseded route, as the agents workspace does.

### 5.4 Entry points

- The Agents directory (`#agents`) shows one secondary link, "Manage departments", near its toolbar (`href="#departments"`). It is a real anchor, so open-in-new-tab, copy-link, Back/Forward and refresh all work.
- `#departments` shows a back link "← Agents" (`href="#agents"`).
- The Agents screens are otherwise unchanged (D-5): their department filter still derives from embedded summaries.

### 5.5 Focus and announcements

After in-app navigation to `#departments`, focus moves to the screen's `h2` ("Department directory", `tabindex="-1"`) and the workspace's visually hidden `role="status"` region announces "Department directory". On initial page load focus does not move. The merged F0b skip link must keep working on this route: activating it keeps the hash and focuses `<main>` (tested, section 12).

## 6. Screens

### 6.1 Department directory (`#departments`)

**Data:** one `GET /api/v1/departments` per mount, with `?includeArchived=true` when the archived toggle is on. Never cached across visits; every mount and every toggle refetches. No pagination: the backend returns a complete list capped at 500 or fails closed.

**Layout:** shell h1 "Departments"; back link "← Agents"; `h2` "Department directory"; a toolbar with the "Show archived" checkbox, the result count (`aria-live="polite"`), and the primary "New department" button; then the create form when open (6.2); then the list. A single static note under the toolbar: "Departments group agents. Archiving a department is permanent and is only possible when no agent, including an archived one, references it."

**List:** a semantic list (`<ul>`) of rows in the order the server returns (by name). Each row shows:

- the department name as plain text (the row's heading, `h3`),
- the slug in a monospace-style span labelled "Slug",
- an "Archived" badge (icon plus text) with the archive time when `archivedAt` is set,
- "Created" and "Updated" times in Asia/Manila,
- actions: **Rename** and **Archive** for active departments only. Archived rows have **no actions**; they are not disabled controls, they are simply absent, and the row says "Archived departments can't be changed."

Row action buttons have accessible names that include the department name ("Rename Engineering", "Archive Engineering") so a screen-reader user can tell rows apart; the visible label stays "Rename" / "Archive". Two departments with the same name remain distinguishable because the slug (unique) is part of each row's text.

**States:**

| State | Presentation |
|---|---|
| Loading | `role="status"` "Loading departments…"; no skeleton rows implying data; no actions |
| Empty (validated `total: 0`, archived toggle off) | "No departments yet." with the "New department" button available. The text never claims archived departments do not exist. |
| Empty with archived shown | "No departments yet." (the response is authoritative: with `includeArchived=true`, zero means none exist) |
| Only archived exist (toggle off, zero active) | "No active departments." plus the hint "Turn on Show archived to see archived departments." This case is detectable only after the toggle is turned on; the UI does not guess. |
| Error | `ResourceFailure` pattern: "Departments unavailable", the server message, a Retry button; no stale list, and never the empty state |
| 401 | Existing session-expiry flow; no department data remains |
| 403 | "You don't have access to departments." Session stays valid; navigation still works |
| `503` code `limit` | "The department list is too large to show reliably." plus Retry. No partial list. |
| Invalid response (schema failure, `total` not equal to the item count, duplicate `id`, duplicate `slug`) | "Omnis OS received an unexpected department response." plus Retry. No partial render and never the empty state. Because `Department` is strict, a backend field addition also lands here until the shared schema is updated. |

### 6.2 Create department

**Opening:** the "New department" button toggles an inline panel (a `<form>`, not a dialog) above the list. Focus moves to the Name field. Cancel closes it without a request, discards unsaved input and returns focus to "New department".

**Fields (both required, visible `<label>`s):**

| Field | Rules shown as helper text | Client-side check (mirrors the server, which stays authoritative) |
|---|---|---|
| Name | "1-120 characters." | Trimmed length 1-120 |
| Slug | "Lowercase letters, numbers and single hyphens, up to 80 characters. Used as a stable short name. Can be changed later, but is never reusable once taken, even by an archived department." | Trimmed; matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`; length <= 80. Uppercase is **not** silently lowercased: the error says "Use lowercase letters, numbers and single hyphens." |

The UI sends exactly `{ slug, name }` with both values trimmed, and nothing else (the body is strict). Client checks are a convenience to avoid obvious round-trips; their messages must not claim to be the server's.

**Submit:** one request at a time. While pending the submit button is disabled and shows "Creating…", the fields stay editable-looking but are `readonly`, and a `role="status"` line says "Creating department…". `POST /api/v1/departments` carries `x-omnis-csrf`. There is no idempotency key (the backend does not support one), so **a create is never retried automatically** (section 7).

**Outcomes:**

| Result | Presentation | Focus |
|---|---|---|
| `201` | Panel closes; the list is re-read; a status message "Created <name>." (`role="status"`); the new row is present once the re-read succeeds | The new row's heading if it is in the refreshed list, else "New department" |
| Client validation fails | Error summary (8.3) and inline field errors; **no request** | Error summary |
| `409` (slug taken) | Field error on Slug: "This slug is already used by another department (including an archived one). Choose a different slug." The Name value is preserved | Slug field |
| `422` `invalid_input` | Form-level message: "The server rejected these values. Check the name and slug, and remove anything that looks like a credential or secret." The response does not identify a field, so none is flagged | Error summary |
| `422` `limit` | "The department limit (500) has been reached. Archive is permanent, so existing departments can't be removed in this release." | Error summary |
| `403` | "Your secure session needs refreshing." The UI calls `refreshCsrf()` and offers "Try again" (a rejected request had no effect, so a manual retry is safe). The session is not expired | Error summary |
| `401` | Existing session-expiry flow | n/a |
| `503` `department_outcome_unknown`, network failure, or an unverifiable response | "Omnis OS couldn't confirm whether this department was created." with a "Check departments" action that re-reads the list. The form stays open with the input intact; submit is disabled until the check completes. If the re-read shows a department with the same slug **and** name, the message becomes "A department with this slug and name now exists. It was probably created." and the form offers Close (the UI does not claim certainty). If it shows nothing matching, the message says no matching department was found and the form re-enables | Error summary |
| Other `5xx` | Generic failure message from the server with the form re-enabled | Error summary |

### 6.3 Rename department

**Supported mutable fields:** `name` and `slug` only. `id`, `createdAt`, `archivedAt` are immutable and never editable. The edit surface is an inline form that replaces the row's content (one row edits at a time; opening a second row's form closes the first and discards its unsent edits, since nothing was sent). It uses the same two labelled fields and the same rules and messages as create, pre-filled with the current values.

**Identity preserved:** the request is `PATCH /api/v1/departments/<encodeURIComponent(id)>` with `{ slug, name }`. The row keeps its `id`-keyed identity, so its position changes only because the server orders by name after the re-read.

**Changing the slug:** the form shows the warning "Changing the slug changes how this department is identified in short form. Agents keep their department; their department label updates the next time they are loaded."

**Concurrency (D-3):** no token exists. A short, always-visible note on the edit form says "Edits are saved as typed. If this department was changed elsewhere, your change replaces it." The UI never says a conflict was detected. After a successful save the displayed values come from the re-read list, which is the server's current value.

**Outcomes:**

| Result | Presentation |
|---|---|
| Unchanged values (both equal the current ones after trimming) | No request. "No changes to save." and the form stays open |
| `200` | Form closes, list re-read, status "Renamed to <name>." Focus returns to the row's Rename button (or the heading if the row moved) |
| `409` | The UI re-reads `GET /departments?includeArchived=true` for this id (D-7). **Still active** -> slug field error "This slug is already used by another department (including an archived one). Choose a different slug." **Now archived** -> the form closes and the row shows its archived state with the status "This department was archived and can't be changed." Cannot re-read -> a neutral message "The rename was rejected. This slug may already be in use, or the department may have been archived. Reload to check." with a Reload action |
| `404` | "This department no longer exists." The list is re-read |
| `422` / `403` / `401` / uncertain | As in 6.2, mapped to the edit form. For an unconfirmed rename the "Check departments" re-read compares the stored `name` and `slug` with the submitted ones and reports "It appears to have been saved" only when both match exactly |

### 6.4 Archive department

**Trigger:** the row's "Archive <name>" button opens a confirmation `<dialog>` using the same native-dialog pattern as `ApprovalDialog`.

**Dialog content:**

- Title: "Archive this department?"
- The department name and slug (plain text).
- Body: "Archiving is permanent. This department will no longer accept new agents and can't be renamed, restored or deleted. Its history is kept. Archiving is only possible when no agent, including an archived one, references the department."
- Buttons: **Cancel** (default focus) and **Archive department** (a destructive-style secondary button; it is not styled as the primary action).
- Esc and Cancel close it with no request and restore focus to the originating "Archive <name>" button. Clicking the backdrop does nothing special (no accidental confirm).

**Submit:** while pending both buttons are disabled, the dialog shows "Archiving…" in a `role="status"` region, and Esc is ignored until the request settles. `POST /api/v1/departments/<id>/archive` carries `x-omnis-csrf`. Because the backend treats archiving an already archived department as success, a retry after an unconfirmed result is safe; the UI still re-reads first (section 7) so the outcome shown is the server's.

**No false success and no vanishing rows:** the row stays visible and unchanged during the request. Only after `200` **and** a successful re-read does the row change. With the archived toggle **off** the archived row then leaves the list, which is stated in the status message ("Archived <name>. It's hidden while Show archived is off."); with the toggle **on** it stays with its Archived badge and without actions.

**Outcomes:**

| Result | Presentation | Focus |
|---|---|---|
| `200` | Dialog closes; the list is re-read; the status message above | If the row remains, its heading; otherwise the result count or "New department" |
| `409` (department is assigned to agents) | The dialog stays open and shows: "This department can't be archived because agents still reference it. Archived agents count too, and agents can't be moved to another department in this release." No change is made and the row stays active. The Cancel button is relabeled Close and the Archive button is removed | The Close button |
| `404` | Dialog closes with "This department no longer exists." and the list is re-read | The list heading |
| `403` | "Your secure session needs refreshing." `refreshCsrf()` runs; the dialog stays open with "Try again" | Dialog |
| `401` | Existing session-expiry flow | n/a |
| `503` `department_outcome_unknown`, network failure or unverifiable response | "Omnis OS couldn't confirm whether this department was archived." The dialog offers "Check departments", which re-reads with `includeArchived=true`. Archived -> the dialog closes with "It was archived." Still active -> the dialog says it was not archived and re-enables Archive. The UI never reports success without the re-read | Dialog |
| Other `5xx` | Server message; dialog stays open and Archive is re-enabled | Dialog |

An archive `409` is distinguishable from a rename `409` by the endpoint that returned it: on the archive endpoint the only `409` is the "referenced by agents" rule (`invalid_transition`), because archiving an already archived department is a `200`.

## 7. Mutation handling

1. **One mutation in flight** across the whole screen. While any create, rename or archive is pending, all other mutation controls are disabled.
2. **CSRF:** every mutation sends `x-omnis-csrf` from the shell's current token. A `403` is treated as "rejected with no effect" (the backend's CSRF check runs before any write): call `refreshCsrf()`, keep the form/dialog and the user's input, and offer a manual retry. A `403` never expires the session (existing behavior and test).
3. **No idempotency key and no automatic retry.** The backend does not support department idempotency, so the UI never resends a mutation on its own, including after a network error. A resend after an unconfirmed create could report a misleading slug conflict, which is why the recovery path is a re-read.
4. **Outcome classification** reuses `ApiRequestError.outcome`: `rejected` (a definitive `4xx`) shows the specific message; `uncertain` (network failure, `5xx`) and `invalid-response` use the "couldn't confirm" flows above. For `503` `department_outcome_unknown` the server itself instructs "Read the department state before retrying", and the UI does exactly that.
5. **Re-read after every successful mutation.** The list is refetched with the current archived setting and is the only source for what the screen shows. The mutation response is validated against `DepartmentSchema` and used to confirm identity (id, and for create the submitted slug) but is not merged into the list.
6. **No optimistic UI, no partial state.** Nothing is added, changed or removed locally before the server confirms.
7. **No browser persistence:** no `localStorage`, no cached departments, no draft storage.
8. **Aborts:** list reads abort on route change or toggle change. Mutations are not aborted by navigation; if the screen unmounts mid-request the result is discarded, and the next mount re-reads the true state.

## 8. Error mapping

### 8.1 Branching policy

The UI branches on the **HTTP status**, on **which endpoint** returned it, and on **re-read state**, not on `code` or `message` text, with one narrow, labelled exception: a `422` with code `limit` on create selects the limit message. If that code ever changes, the UI falls back to the generic `422` rejection message, which is still truthful. `503` `department_outcome_unknown` needs no code dependence, because every non-rejected mutation failure already takes the "couldn't confirm" path. Server messages are displayed as supporting text, never used for control flow.

### 8.2 Status table

| Status | Read (`GET`) | Create | Rename | Archive |
|---|---|---|---|---|
| `401` | Session expiry | Session expiry | Session expiry | Session expiry |
| `403` | "You don't have access to departments." | CSRF refresh and manual retry | CSRF refresh and manual retry | CSRF refresh and manual retry |
| `404` | n/a (no such route) | n/a | "No longer exists" | "No longer exists" |
| `409` | n/a | Slug field error | Re-read, then slug field error or archived state (D-7) | "Agents still belong to it" (stays open) |
| `422` | Unexpected-response error (the UI sends only valid queries) | Form-level server rejection, or the limit message | Form-level server rejection | Treated as an unexpected response |
| `503` / network / invalid response | Error with Retry | "Couldn't confirm" flow | "Couldn't confirm" flow | "Couldn't confirm" flow |

### 8.3 Error summary

A form that fails validation (client-side or server-side) shows one error summary at the top of the form: a container with `role="alert"` and `tabindex="-1"` that receives focus, a short heading ("There is a problem") and a list of items. Each item is a **button** (not a fragment link, which would change the hash route) that moves focus to its field. Each invalid field also has an inline error element referenced by `aria-describedby` and `aria-invalid="true"`. Errors clear when the field is corrected. Server-level errors with no field (credential rejection, limit, unconfirmed outcome) appear in the summary without a field button.

## 9. Accessibility requirements

- **Landmarks and headings:** the shell h1 "Departments"; `h2` "Department directory"; each row's name is an `h3`; the create/rename form has its own labelled `<form>` heading ("New department" / "Rename <name>") at `h3`; the dialog title is the dialog's accessible name.
- **Labels:** every input has a visible `<label>` (never placeholder-only), helper text is attached with `aria-describedby`, required fields are marked in the label text ("required"), not by color alone. Inputs use `autocomplete="off"` and sensible `inputmode`/`spellcheck="false"` for the slug.
- **Validation feedback:** section 8.3. Errors are text with an icon, not color alone, and meet contrast 4.5:1 using shipped tokens (`--red` on white).
- **Keyboard:** every control is reachable and operable with Tab, Shift+Tab, Enter and Space. Tab order follows reading order: toolbar, create form (if open), rows (heading, Rename, Archive). No keyboard traps; the native dialog traps focus only while modal.
- **Archive confirmation and focus restoration:** focus moves to Cancel on open; Esc and Cancel restore focus to the originating Archive button (which stays in the DOM unless its row legitimately disappeared, in which case focus goes to the result count or list heading, never to `body`). After a successful archive the focus target is defined in 6.4.
- **Status announcements:** one polite `role="status"` region owned by the workspace announces: screen changes, "Creating department…", "Created <name>.", "Renamed to <name>.", "Archived <name>…", and re-read results. Errors use `role="alert"` only in the error summary and the inline resource-failure pattern, so each failure is announced once.
- **Focus indicators:** shipped 3px `--blue` focus outline on every focusable element, including inside the dialog and the error-summary buttons, never removed; the form panel does not clip it.
- **Touch targets:** buttons, checkbox rows and row actions are at least 44 x 44 CSS px at <= 820 px.
- **Reduced motion:** no new animation; the existing global `prefers-reduced-motion` rule applies and no transition is required for any state change.
- **Skip link:** unchanged and tested on `#departments` (PR #16 behavior: hash and history preserved, `<main>` focused).
- **Zoom and text size:** no clipping at 200% zoom or a 16px minimum user font size; long names and slugs wrap (`overflow-wrap: anywhere`).

## 10. Responsive requirements

Tested at **1440, 820, 390, 360 and 320 px**; no horizontal page scroll at any width.

- **>= 900 px:** toolbar on one row; the create/rename form uses a two-column field grid (Name, Slug); each row shows facts and actions on one line with wrapping.
- **< 900 px:** form fields stack; row actions wrap below the facts and stay full-size touch targets; timestamps move under the name.
- **<= 360 px:** actions stack at full width; the toolbar controls stack; the dialog is at least `100% - 24px` wide, scrolls internally if taller than the viewport, and keeps both buttons reachable.
- The primary navigation stays at four links and still fits at 320 px (PR #20 rule); `#departments` adds no nav item.
- Long unbroken names (120 characters) and slugs (80 characters) wrap inside their rows without overflow.

## 11. Safe rendering

Names and slugs are **untrusted text** even though only the owner writes them. Render only as React text nodes: no `dangerouslySetInnerHTML`, no markdown or HTML rendering, no auto-linking, no URL fetching. Text containers use `dir="auto"` and `unicode-bidi: isolate`. Names and slugs are single-line values, so `white-space: pre-wrap` is not used; a pasted line break is collapsed by the single-line input. Nothing from a department is logged or stored in the browser, and no department value is used as a CSS value, `href`, or `id` attribute (row and error ids use React `useId`).

## 12. Acceptance criteria and test plan

All Playwright tests use **strictly schema-validated synthetic fixtures**: responses are built with `DepartmentSchema` / `DepartmentListResponseSchema`; request bodies are parsed with `CreateDepartmentSchema` (strict); mutations without the correct `x-omnis-csrf` header get a `403` `csrf_rejected` from the fixture; any unexpected request fails the test. These tests establish **frontend behavior against the documented contract only**. They do **not** establish live-backend integration (section 14).

### 12.1 Read, list and states

| ID | Criterion |
|---|---|
| DM-01 | `GET /departments` renders each department's name, slug, created and updated times (Asia/Manila), in server order; archived are hidden by default and the request carries no query. |
| DM-02 | Toggling "Show archived" refetches with `includeArchived=true`, shows the Archived badge and no actions on archived rows, and updates the URL (`#departments?archived=1`) with `replaceState` (no history entry). Reload and Back/Forward preserve the setting. |
| DM-03 | A validated empty response shows "No departments yet." with "New department"; a failed, loading or invalid response never shows it. |
| DM-04 | An API failure shows "Departments unavailable" with Retry and no list; Retry recovers. |
| DM-05 | `403` shows the access message and keeps the session and navigation working; `401` follows the existing session-expiry flow and leaves no department data. |
| DM-06 | Invalid responses (schema failure, `total` mismatch, duplicate `id`, duplicate `slug`, an extra field) show the unexpected-response error, never an empty or partial list. `503` `limit` shows the too-large state with no partial list. |
| DM-07 | Two departments with the same name are distinguishable (slug shown) and their row actions have distinct accessible names. |

### 12.2 Create

| ID | Criterion |
|---|---|
| DM-08 | Client validation blocks empty/overlong names, empty/overlong or malformed slugs (uppercase, spaces, underscores, leading/trailing/doubled hyphens) with an error summary and field errors; **no request** is sent; uppercase slugs are not silently lowercased. |
| DM-09 | A valid create sends exactly `{ slug, name }` (trimmed, schema-parsed in the fixture) with the CSRF header, disables submit while pending, closes on `201`, re-reads the list and announces success. The new row appears only after the re-read. |
| DM-10 | `409` shows the slug field error and keeps the name; the slug field receives focus; no row is added. |
| DM-11 | `422` `invalid_input` shows the form-level rejection without flagging a field; `422` `limit` shows the limit message. |
| DM-12 | `403` refreshes the CSRF token, keeps the input and the session, and a manual retry then succeeds; the fixture proves the second request carries the refreshed token. |
| DM-13 | `503` `department_outcome_unknown` / a network drop shows "couldn't confirm", never retries by itself (the fixture counts exactly one POST), and "Check departments" resolves to the created or not-created message from the re-read. |
| DM-14 | Create is not offered as an optimistic row: during the pending request the list is unchanged. |

### 12.3 Rename

| ID | Criterion |
|---|---|
| DM-15 | Rename pre-fills name and slug, sends `PATCH` with the full pair, preserves the department `id`, and reflects the re-read values; unchanged values send no request. |
| DM-16 | A rename `409` re-reads: still active -> slug field error; now archived -> archived state with no editing; unreadable -> the neutral message with Reload. |
| DM-17 | `404` shows "no longer exists" and refreshes the list; unconfirmed outcomes use the re-read and claim "appears to have been saved" only on an exact match. |
| DM-18 | The last-write-wins note is visible on the edit form, and a fixture-simulated concurrent change is overwritten without any conflict claim. |
| DM-19 | Archived rows offer no Rename or Archive controls. |

### 12.4 Archive

| ID | Criterion |
|---|---|
| DM-20 | "Archive <name>" opens the confirmation dialog with the one-way explanation, focus on Cancel; Esc and Cancel send no request and restore focus to the originating button. |
| DM-21 | Confirming sends one POST with the CSRF header; the row is unchanged during the request; after `200` and the re-read the row is archived (toggle on) or removed with the explanatory status (toggle off); focus lands on the defined target, never `body`. |
| DM-22 | `409` keeps the dialog open with the "agents still belong to it" message and makes no change; the row stays active. |
| DM-23 | `404`, `403` (CSRF refresh and manual retry), `401`, and unconfirmed outcomes (re-read with `includeArchived=true`; success is never claimed without it) behave as in 6.4. |
| DM-24 | There is no Unarchive, Delete or Undo control anywhere, and no archived row can be edited. |

### 12.5 Navigation, accessibility and regression

| ID | Criterion |
|---|---|
| DM-25 | `#departments` and `#departments?archived=1` deep links survive reload; Back/Forward works; `#departments/x` is a malformed-link state with no request; `#agents/departments` still means the agent with id `departments` (fixture agent) and does not reach the department screen. |
| DM-26 | The primary nav has exactly four links, none marked current on `#departments`; the "Manage departments" link on `#agents` and the "← Agents" link navigate correctly. |
| DM-27 | The skip link on `#departments` keeps the hash, adds no history entry and focuses `<main>` with a visible ring. |
| DM-28 | Error summary behavior: it takes focus on a failed submit, its items are buttons that focus the right field, fields expose `aria-invalid` and `aria-describedby`, and no fragment links are used. |
| DM-29 | Status announcements appear in the single polite region (asserted by text), and errors are announced once. |
| DM-30 | Axe reports no serious or critical violations on the list, empty, error, create form with errors, rename form, archive dialog (open, pending, 409) at 1440, 390 and 320 px. |
| DM-31 | No horizontal overflow and all controls reachable at 1440, 820, 390, 360 and 320 px, with 120-character names and 80-character slugs; touch targets >= 44 px at <= 820 px. |
| DM-32 | Reduced-motion emulation produces no animation-dependent state; keyboard-only operation completes create, rename and archive end to end. |
| DM-33 | Hostile text (`<img onerror>`, `<script>`, markdown, bidi controls) in names and slugs renders inert as text and executes nothing. |
| DM-34 | Regression: all existing tests (117 at `a3c53e2`) pass unmodified: Command Center, Tasks, Runs, SSE, approvals, the four-link nav, Agents and the F0b skip link. |

### 12.6 Mutation-test expectations for review

Independent reviewers should confirm, by temporarily disabling each guard in a disposable worktree, that tests fail when: the CSRF header is omitted; the strict body check is removed; the re-read after mutation is skipped (optimistic update); the archive dialog's Cancel-first focus or focus restoration is removed; the rename-409 re-read is replaced by a guess; and the "no automatic retry" rule is broken (the fixture counts requests).

## 13. PR boundaries and dependencies

| Milestone | Content | Entry criteria |
|---|---|---|
| 1 - this PR | Documentation only: this specification and one-paragraph cross-references | Scope approved by independent frontend review; owner decisions D-1 to D-5 answered before milestone 2 starts |
| 2 - list, create, rename | `departments/` module; `Page` union and `readRoute()` change; "Manage departments" link on the Agents directory; fixtures and Playwright/axe tests for DM-01 to DM-19, DM-25 to DM-34 | Milestone 1 merged; D-1, D-3, D-4, D-5, D-7 settled |
| 3 - archive | Archive dialog, focus restoration and outcomes; DM-20 to DM-24 and their axe/responsive cases | Milestone 2 merged; D-2 settled |

Each milestone is a separate Draft PR with independent frontend QA, and no PR merges without explicit owner authorization. Milestone 2 does not render the archive control; milestone 3 adds it.

Backend dependencies: none beyond what is merged (PR #19). Open items for the backend implementer, none of which blocks this specification:

- Declare `conflict` and `invalid_transition` (and `limit`, `department_outcome_unknown`) as stable public error codes, or confirm that clients must not rely on them (D-7).
- Whether a concurrency token or `If-Match` will be added; V1 assumes it will not.
- Whether unarchive will ever exist (D-2).
- Optionally a field-level error shape for `422` so the UI could flag the offending field.

## 14. Live-backend verification (outstanding, separate)

Fixture-backed browser tests do not demonstrate that the real backend behaves as documented. Before any deployment, the department endpoints must be covered by the same authorized, isolated live smoke environment already owed for AO-104 (PostgreSQL, a real owner session, disposable data): list with and without `includeArchived`, create, duplicate-slug `409`, rename, rename of an archived department, archive, archive of a referenced department (`409`), idempotent re-archive, `401`, CSRF `403`, and parsing of every real response with the shared schemas. This is not part of the documentation or frontend PRs and no production system is used.

## 15. Deferred features

Each needs its own approved scope and real contracts: unarchive or delete; moving agents between departments or bulk reassignment; department detail pages and agent lists per department; audit display; teams and room placement; search and pagination (not needed under the 500 cap); import/export; any fifth primary-navigation item (needs a separate responsive-navigation decision).

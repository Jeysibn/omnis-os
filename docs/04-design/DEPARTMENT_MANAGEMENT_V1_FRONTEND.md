# Department Management V1 - Frontend Specification

**Status: SPECIFICATION ONLY.** This document describes a future frontend change. It adds no application code, and merging it does **not** implement Department Management, complete AO-104, or complete AO-110. This specification can be reviewed and merged on its own: **merging it approves no product decision**. Each implementation milestone starts only after the owner has explicitly approved the decisions that gate it (section 4.2); a decision that does not gate a milestone never blocks it.

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

## 4. Owner decisions (approved by the owner on 2026-11-04)

### 4.1 Decisions

**Status update, 2026-11-04.** The owner explicitly approved all eight decisions below, D-1 to D-8, on 2026-11-04, and authorized **milestone 2 implementation and a Draft PR only**. D-2 (archive) applies to the later milestone 3: the archive UI is not part of milestone 2. D-8 is approved **for deferral**: slug suggestions are not implemented in V1 and the user types the slug. Approval of the decisions does not authorize merging or deploying anything; every PR merge needs its own explicit owner decision. The wording below is otherwise unchanged from the reviewed specification, and "Proposed default" now reads as the approved default.

| ID | Decision | Approved default | Gates | Status |
|---|---|---|---|---|
| D-1 | Where does Department Management live? | A secondary screen at `#departments`, linked from the Agents directory. **Not** a fifth primary-navigation item. | Milestone 2 | Approved 2026-11-04 |
| D-2 | Undo for archive, and archive behavior | No Undo and no Unarchive: archive is one-way, the UI says so, and the backend provides no such action. The archive confirmation dialog, its wording and its outcomes (section 6.4) are the proposed archive UX. | Milestone 3 | Approved 2026-11-04 (applies to milestone 3 only) |
| D-3 | Concurrent rename | Accept the backend's last-write-wins behavior. The UI does not claim to detect conflicting edits; it reports what the server confirmed and what the latest list shows. | Milestone 2 | Approved 2026-11-04 |
| D-4 | Duplicate-slug feedback | A field-specific message on the slug field on a `409` from create. For a rename `409`, a slug message is shown only when a trustworthy read-back observation supports it (section 7.5). No field-specific message for any other error. | Milestone 2 | Approved 2026-11-04 |
| D-5 | Agents directory department filter | Keeps using the department data embedded in agent summaries. No change to the agents screens and no `GET /departments` call from them until a separate integration change is justified. | Milestone 2 | Approved 2026-11-04 |
| D-6 | Primary nav state on `#departments` | No primary nav item is marked `aria-current`; the screen shows a "← Agents" link and its own `h1`. (Marking Agents current would announce a page the user is not on.) | Milestone 2 | Approved 2026-11-04 |
| D-7 | Telling the two `409` causes apart on rename | Do not depend on error `code`. Use a read-back of `GET /departments?includeArchived=true` and state only what it shows (section 7.5). If the backend later declares `conflict` / `invalid_transition` as stable public codes, the UI may use them with the read-back as fallback. | Milestone 2 | Approved 2026-11-04 |
| D-8 | Slug suggestion while typing a new name | **Deferred from V1 (approved).** The slug is a plain labelled field with no suggestion. The feature is optional and omitted from this specification's screens and criteria; it can be proposed again later with its own spec change. | None (see 4.2) | Approved 2026-11-04 for deferral |

### 4.2 Decision gates by milestone

| Milestone | Decisions that must be explicitly approved by the owner before its implementation starts |
|---|---|
| 1 - documentation (this PR) | **None.** D-1 to D-8 may all remain Proposed. The specification can be reviewed and merged independently of implementation approval. |
| 2 - list, create, rename | D-1, D-3, D-4, D-5, D-6, D-7 |
| 3 - archive | D-2, **plus** the milestone 2 decisions above (all of D-1, D-3, D-4, D-5, D-6, D-7 must already be approved, since milestone 3 builds on that navigation and mutation-safety behavior) |
| D-8 | Not a gate for any milestone. It is deferred from V1; leaving it open does not block anything, and an omitted optional feature is never a reason to hold an implementation. If the owner later wants it, it needs an approved spec change first. |

The gates above were satisfied for milestone 2 by the owner's approval of D-1 to D-8 on 2026-11-04. Milestone 3 still needs its own Draft PR and independent review, and no PR merges without explicit owner authorization.

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
| Empty, active-only request (validated `total: 0`, "Show archived" off) | The neutral message **"No active departments. Turn on Show archived to check for archived departments."** with the "New department" button available. An active-only response cannot tell "no departments exist" from "departments exist only in archived state", so this state never says "No departments yet" and never says or implies that archived departments exist or do not exist. |
| Empty, include-archived request (validated `total: 0`, "Show archived" on, request succeeded) | "No departments yet." This is the only state that claims none exist, because the response included archived rows and was empty. |
| Only archived departments exist | Shown **only** after a successful `includeArchived=true` response that contains archived rows and no active rows: the list shows those rows with the note "No active departments. All departments shown here are archived." It is never inferred from an active-only response. |
| Include-archived request fails (the user turned "Show archived" on, or opened `#departments?archived=1`) | The ordinary Error state for that request ("Departments unavailable", Retry, no list). The UI does not infer, state or imply whether archived departments exist, and does not fall back to showing the earlier active-only result as if it were current. |
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
| `201` (confirmed, section 7.2) | Panel closes; a status message "The server confirmed the department was created." (`role="status"`) naming the confirmed values; the list is re-read and the new row appears only once the re-read succeeds. If the re-read fails, section 7.3 applies | The new row's heading if it is in the refreshed list, else "New department" |
| Client validation fails | Error summary (8.3) and inline field errors; **no request** | Error summary |
| `409` (slug taken) | Field error on Slug: "This slug is already used by another department (including an archived one). Choose a different slug." The Name value is preserved | Slug field |
| `422` `invalid_input` | Form-level message: "The server rejected these values. Check the name and slug, and remove anything that looks like a credential or secret." The response does not identify a field, so none is flagged | Error summary |
| `422` `limit` | "The department limit (500) has been reached. Archive is permanent, so existing departments can't be removed in this release." | Error summary |
| `403` | "Your secure session needs refreshing." The UI calls `refreshCsrf()` and offers "Try again" (a rejected request had no effect, so a manual retry is safe). The session is not expired | Error summary |
| `401` | Existing session-expiry flow | n/a |
| Outcome unknown (`503` including `department_outcome_unknown`, any other `5xx`, network failure, or a `2xx` whose body does not validate or match the submitted values) | "The outcome of creating this department is unknown." The form stays open with the input intact. The recovery model in section 7 applies in full: a read-only "Check departments" recheck, no automatic retry, no success or failure claim, and submit stays disabled until a recheck succeeds (7.4, 7.5, 7.7) | Error summary |

### 6.3 Rename department

**Supported mutable fields:** `name` and `slug` only. `id`, `createdAt`, `archivedAt` are immutable and never editable. The edit surface is an inline form that replaces the row's content (one row edits at a time; opening a second row's form closes the first and discards its unsent edits, since nothing was sent). It uses the same two labelled fields and the same rules and messages as create, pre-filled with the current values.

**Identity preserved:** the request is `PATCH /api/v1/departments/<encodeURIComponent(id)>` with `{ slug, name }`. The row keeps its `id`-keyed identity, so its position changes only because the server orders by name after the re-read.

**Changing the slug:** the form shows the warning "Changing the slug changes how this department is identified in short form. Agents keep their department; their department label updates the next time they are loaded."

**Concurrency (D-3):** no token exists. A short, always-visible note on the edit form says "Edits are saved as typed. If this department was changed elsewhere, your change replaces it." The UI never says a conflict was detected. After a successful save the displayed values come from the re-read list, which is the server's current value.

**Outcomes:**

| Result | Presentation |
|---|---|
| Unchanged values (both equal the current ones after trimming) | No request. "No changes to save." and the form stays open |
| `200` (confirmed, section 7.2) | Form closes; status "The server confirmed the update: name <name>, slug <slug>."; the list is re-read and rows reflect it only after the re-read succeeds (7.3 if it fails). Focus returns to the row's Rename button (or the heading if the row moved) |
| `409` (rejected) | Diagnosed only from a trustworthy read-back, never from error `code` or message (D-7, section 7.5): a slug message appears only when the read-back shows another department using the slug; an archived observation, an inconclusive observation, or a failed read-back each have their own wording |
| `404` | "The server reports that this department doesn't exist." The list is re-read |
| `422` / `403` / `401` | As in 6.2, mapped to the edit form |
| Outcome unknown (same definition as 6.2) | "The outcome of this rename is unknown." The recovery model in section 7 applies in full; the row's Rename and Archive stay unavailable until a recheck succeeds. Observations are described, never claimed as caused by this request (7.6) |

### 6.4 Archive department

**Trigger:** the row's "Archive <name>" button opens a confirmation `<dialog>` using the same native-dialog pattern as `ApprovalDialog`.

**Dialog content:**

- Title: "Archive this department?"
- The department name and slug (plain text).
- Body: "Archiving is permanent. This department will no longer accept new agents and can't be renamed, restored or deleted. Its history is kept. Archiving is only possible when no agent, including an archived one, references the department."
- Buttons: **Cancel** (default focus) and **Archive department** (a destructive-style secondary button; it is not styled as the primary action).
- Esc and Cancel close it with no request and restore focus to the originating "Archive <name>" button. Clicking the backdrop does nothing special (no accidental confirm).

**Submit:** while pending both buttons are disabled, the dialog shows "Archiving…" in a `role="status"` region, and Esc is ignored until the request settles. `POST /api/v1/departments/<id>/archive` carries `x-omnis-csrf`. The backend treats archiving an already archived department as a no-op success, so repeating an archive cannot make things worse; even so, after an unknown outcome the UI rechecks first and describes what the latest list shows (section 7.7) rather than repeating the request on its own.

**No false success and no vanishing rows:** the row stays visible and unchanged during the request. After a confirmed `200` the row changes only when the re-read also succeeds; if the re-read fails, the confirmation is kept and the list is marked possibly out of date (section 7.3) instead of being edited locally. After a successful re-read with the archived toggle **off** the archived row leaves the list, which is stated in the status message ("The server confirmed the department is archived. It's hidden while Show archived is off."); with the toggle **on** it stays with its Archived badge and without actions.

**Outcomes:**

| Result | Presentation | Focus |
|---|---|---|
| `200` (confirmed, section 7.2) | Dialog closes; the status message above; the list is re-read (7.3 if the re-read fails) | If the row remains, its heading; otherwise the result count or "New department" |
| `409` (department is assigned to agents) | The dialog stays open and shows: "This department can't be archived because agents still reference it. Archived agents count too, and agents can't be moved to another department in this release." No change is made and the row stays active. The Cancel button is relabeled Close and the Archive button is removed | The Close button |
| `404` | Dialog closes with "This department no longer exists." and the list is re-read | The list heading |
| `403` | "Your secure session needs refreshing." `refreshCsrf()` runs; the dialog stays open with "Try again" | Dialog |
| `401` | Existing session-expiry flow | n/a |
| Outcome unknown (same definition as 6.2) | "The outcome of archiving this department is unknown." The dialog stays open with "Check departments". The recovery model in section 7 applies in full; the UI never reports archive success or failure on its own, and observations are described without causality (7.7) | Dialog |

An archive `409` is distinguishable from a rename `409` by the endpoint that returned it: on the archive endpoint the only `409` is the "referenced by agents" rule (`invalid_transition`), because archiving an already archived department is a `200`.

## 7. Mutation handling and outcome recovery

### 7.1 Rules that always apply

1. **One mutation in flight** across the whole screen. While any create, rename or archive is pending, all other mutation controls are disabled.
2. **CSRF:** every mutation sends `x-omnis-csrf` from the shell's current token. A `403` is treated as "rejected with no effect" (the backend's CSRF check runs before any write): call `refreshCsrf()`, keep the form/dialog and the user's input, and offer a manual retry. A `403` never expires the session (existing behavior and test).
3. **No idempotency key and no automatic retry.** The backend does not support department idempotency, so the UI never resends a mutation on its own, including after a network error, after a failed or inconclusive recheck, or after a failed list refresh. Every resend is an explicit user action.
4. **No optimistic UI, no partial state.** Nothing is added, changed or removed locally before the server confirms; a mutation response is validated and used for confirmation but is never merged into the displayed list.
5. **No browser persistence:** no `localStorage`, no cached departments, no draft storage. Any unresolved-outcome state (7.4) lives only in memory; a reload discards it, and the screen then shows fresh server state with no claim about earlier requests.
6. **Aborts:** list reads abort on route change or toggle change. Mutations are not aborted by navigation; if the screen unmounts mid-request the result is discarded, and the next mount reads the true state.

### 7.2 Three evidence levels

Every mutation ends in exactly one of these. The wording the UI may use is limited by the level; it never says more than the evidence establishes.

| Level | When | The UI may say | The UI must not say |
|---|---|---|---|
| **Confirmed** | A `2xx` response whose body validates against `DepartmentSchema` **and** matches the request: create returns the submitted slug and name; rename returns the route id and the submitted slug and name; archive returns the route id with a non-null `archivedAt` | "The server confirmed ..." (created / the update / the department is archived), naming the confirmed values | That the visible list is current (that depends on the refresh, 7.3), or who else changed anything |
| **Rejected** | A definitive `4xx` with a valid error envelope (`403`, `404`, `409`, `422`) | What the server rejected, e.g. "The server rejected this change." For `403` additionally that the change was not applied (the CSRF check precedes any write) | A cause the response does not establish; for `409` on rename, a cause not supported by a trustworthy read-back (7.5) |
| **Unknown** | Everything else: `503` (including `department_outcome_unknown` and `authorizer_unavailable`), any other `5xx`, a network failure or timeout, and any `2xx` whose body fails validation or does not match the request | "The outcome ... is unknown." | That the change succeeded, that it failed, or that nothing happened |

### 7.3 Confirmed, then the list refresh fails

After a **confirmed** create, rename or archive the UI re-reads the list (with the current archived setting). If that read fails (or returns an invalid response, or `401`, which follows the session-expiry flow):

- the confirmation stays visible and is not retracted: "The server confirmed <the specific result>.", naming the values from the confirmed response;
- the screen states "The department list couldn't be refreshed, so what is shown may be out of date." The list region shows that state instead of rows (no stale rows are presented as current), with a read-only **Refresh list** button;
- no mutation control is shown until a refresh succeeds, and the mutation is **never** repeated automatically (7.1);
- after a successful refresh the rows replace the notice; the earlier confirmation is not announced again.

### 7.4 Rechecking after an unknown outcome

The **recheck** is one read-only request, `GET /departments?includeArchived=true`, so it can see active and archived rows. It is never a mutation, and the UI never sends one in response to its result. The first recheck is offered as **Check departments**; after a failed or inconclusive one the same control is labelled **Check again**.

- **What a recheck establishes:** only the contents of that single response. It describes the server's state at the moment it was read. It cannot establish which request, session or time caused that state, and it cannot rule out a change that commits after it was read.
- **Claim rule (semantic, not word-based):** the UI describes observations as "currently" and "in the latest list". What is limited is the **claim a message makes**, not the vocabulary it uses; section 7.8 defines the claim types and the evidence levels that permit them. A sentence that expresses uncertainty ("this doesn't prove the create failed") is allowed even though it contains the word "failed", while an assertion that the create failed is not allowed for an unknown outcome.
- **A failed recheck** (network error, `5xx`, `401` follows session expiry, invalid response, duplicate ids or slugs, or a missing row set) leaves the outcome **unresolved**. The UI says so ("Omnis OS couldn't check either, so the outcome is still unknown.") and offers **Check again**. It never turns a failed recheck into a conclusion.
- **Unresolved state:** while a recheck has not succeeded, a screen-level `role="status"` banner names the unresolved operation and its target and keeps **Check again** available, and the controls that could repeat that operation stay unavailable: for create, the form's submit button and "New department"; for rename or archive, that department's Rename and Archive. Other departments stay usable. Closing the form or dialog does not clear the unresolved banner.

### 7.5 Rename `409`: diagnosis only from a trustworthy observation

A rename `409` has two possible causes (another department holds the slug, or this department is archived) and the response does not say which (D-7). After a `409` the UI performs the recheck (7.4) and states only what the latest response shows:

| Read-back | UI statement and controls |
|---|---|
| Read-back fails | Neutral: "The server rejected the rename. Omnis OS couldn't check why. The slug may already be in use, or the department may be archived." No field-specific error. **Check again** |
| This department's id is absent | "The server rejected the rename, and this department doesn't appear in the latest list." Unresolved; no field error. **Check again** |
| This department appears **archived** | "The server rejected the rename. The department currently appears as archived, so it can't be changed." The form closes; the row shows its archived state. The UI does not say when it was archived |
| This department is **active** and a **different** department (another id) currently has the submitted slug | Slug field error: "Another department currently uses this slug (an archived department keeps its slug). Choose a different slug." The name stays |
| This department is **active** and **no** other department has the submitted slug | Inconclusive: "The server rejected the rename, but the latest list doesn't show why. Something may have changed in between. Reload and try again." No field error; the form stays open with the input |

A create `409` can only come from the slug rule (a create has no archived-state rule), so it uses the slug field error directly, per D-4, without a read-back.

### 7.6 Recovery after an unknown outcome: create

Submitted values are slug `S` and name `N`. After a successful recheck (7.4):

| Observation in the latest list | UI statement | Controls |
|---|---|---|
| A department has slug `S` **and** name `N` (active or archived) | "The latest list includes a department with this slug and name. It may be the one you submitted or one created elsewhere; Omnis OS can't tell." No `success` or `cause` claim (it does not say this request created it). | **Close**; no resubmit offered |
| A department has slug `S` but a **different name or is archived** | "The latest list has a department with this slug, named "<name>"<, archived>. Choose a different slug." (an observation; it doesn't say whether your request or another one produced it) | Slug field error; form re-enabled with the input kept |
| **No** department has slug `S` | "No department with this slug appears in the latest list. This doesn't prove the create failed: a late commit can't be ruled out. If it does commit later, trying again would report the slug as taken." | **Check again** and an explicit **Try creating again** (a user action; duplicates are impossible because slugs are unique); form re-enabled |
| Recheck fails | Unresolved (7.4) | **Check again** only; submit stays disabled |

A department created by another session with the same slug is indistinguishable from this request's result, which is why the first two rows describe state without attributing it.

### 7.7 Recovery after an unknown outcome: rename and archive

**Rename** (id `I`; earlier values `P`; submitted slug `S` and name `N`). After a successful recheck:

| Observation in the latest list | UI statement | Controls |
|---|---|---|
| `I` is absent | "This department doesn't appear in the latest list, so the outcome of the rename can't be determined." (the API has no delete, so this is unexpected) | Unresolved; **Check again** |
| `I` is active with slug `S` and name `N` | "The department currently has the name <N> and the slug <S>. This may be the result of your request or of another change; Omnis OS can't tell." No `success` or `cause` claim (it does not say the rename succeeded or that this request caused the values) | Form closes; the row shows the current values |
| `I` is active with its earlier values `P` | "The department currently still has its previous name and slug. This doesn't prove the request never reached the server." | Form stays open with the input; explicit **Try again** (last-write-wins applies, D-3) |
| `I` is active with other values (matching neither `P` nor `S`/`N`, including a partial match) | "The department currently has the name <X> and the slug <Y>, which differs from your change and from its earlier values. It may have been changed elsewhere." | **Edit current values** (reloads the form from the latest list); nothing is overwritten without a user action |
| `I` appears archived | "The department currently appears as archived, so it can't be renamed. Omnis OS can't tell whether that happened before or after your request." | Form closes; row archived |
| Recheck fails | Unresolved (7.4) | **Check again**; that row's Rename and Archive stay unavailable |

**Archive** (id `I`). After a successful recheck:

| Observation in the latest list | UI statement | Controls |
|---|---|---|
| `I` is absent | "This department doesn't appear in the latest list, so the outcome of the archive can't be determined." | Unresolved; **Check again** |
| `I` appears archived | "The department currently appears as archived. This may be the result of your request or of another session; Omnis OS can't tell." No `success` or `cause` claim | Dialog closes; the row shows its archived state per the toggle |
| `I` appears active (including with a different name or slug than before) | "The department currently appears active. This doesn't prove the archive request wasn't applied; it could still commit. Archiving again is safe: the server treats it as a no-op if the department is already archived." If the name or slug changed, the current values are shown. | Dialog stays open; **Archive department** is re-enabled as an explicit user action |
| Recheck fails | Unresolved (7.4) | **Check again**; Archive stays unavailable |

**Concurrent changes** by another session can produce any of the observations above at any time. The wording above is deliberately limited to the latest list, so the UI never attributes a state to a request, and it always offers **Check again** because an observation can be out of date the moment it is read.

### 7.8 Message claims and a deterministic way to test them

Every user-visible message in the create, rename and archive flows (status, alert, banner, field and form errors) makes zero or more **claims**. A claim is a statement of fact about the mutation or the server's state:

| Claim type | Meaning | Example (illustrative) |
|---|---|---|
| `success` | The mutation took effect | "The server confirmed the department was created." |
| `failure` | The mutation did not take effect or was refused | "Creation failed." / "The server rejected this change." |
| `cause` | The observed state was produced by this request | "Your rename definitely succeeded." / "Your request archived it." |
| `observation` | What the latest list currently shows, without attributing it | "The department is currently archived." |
| `uncertainty` | An explicit statement that the outcome is not established, including negated forms | "The latest list does not establish whether the create failed." |
| `progress` | The request is in flight | "Creating department…" |

Which claims each evidence level (7.2) permits:

| Evidence state | Permitted claim types | Not permitted |
|---|---|---|
| **Confirmed** (validated `2xx` that matches the request) | `success` (as "The server confirmed ..."), `progress`, and an `uncertainty` about list freshness when a refresh failed (7.3) | `cause` about other sessions; any claim that the visible list is current while a refresh is failed |
| **Rejected** (definitive `4xx`) | `failure` limited to what the response establishes: "The server rejected ..."; for `403` also that the change was not applied; and `observation` from a diagnosing read-back (7.5) | `success`; a `cause` the response does not establish; for `404`, `409` and `422`, a claim that no part of the change was applied beyond what the endpoint's contract states |
| **Unknown** | `uncertainty`, `observation`, `progress` | `success`, `failure`, and `cause` of any kind. Negated or hedged sentences ("doesn't prove it failed", "can't tell whether this was your request") are `uncertainty`, not `failure` or `success` |

The words "created", "renamed", "archived", "failed" and "succeeded" are therefore **not** banned. They are allowed wherever the claim they carry is permitted: for example, "Created <name>" is a permitted `success` announcement only after Confirmed creation, and "The department is currently archived" is a permitted `observation` after an unknown archive outcome, but "Your archive succeeded" is a forbidden `success` or `cause` claim in that state.

**Deterministic test mechanism.** Substring or keyword checks on visible text are not an acceptable acceptance test. The implementation renders these messages from a single typed message catalog keyed `<evidence>.<operation>.<observation>` (for example `confirmed.create`, `confirmed.listStale`, `unknown.create.noMatch`, `unknown.archive.active`, `rejected.rename.conflictOtherSlug`; the full set is the entries named in 7.5 to 7.7 and 12.7), where each entry declares its claim types and its exact text. The rendered message element carries its catalog key in a `data-message-key` attribute. Future tests then assert, per scenario: (1) the message key shown is the one this document assigns to that scenario (each row in 7.5 to 7.7 and 12.7 names one entry); (2) the visible text equals the catalogued text; (3) a catalog-level test asserts that every entry's declared claim types are a subset of the types permitted for its evidence level in the table above. Reviewers read the catalog and the declared claim types for meaning; the key assertion makes the check deterministic without banning vocabulary.

## 8. Error mapping

### 8.1 Branching policy

The UI branches on the **HTTP status**, on **which endpoint** returned it, and on **read-back observations** (section 7), not on `code` or `message` text, with one narrow, labelled exception: a `422` with code `limit` on create selects the limit message. If that code ever changes, the UI falls back to the generic `422` rejection message, which is still truthful. `503` `department_outcome_unknown` needs no code dependence, because every non-rejected mutation failure already takes the unknown-outcome path (7.2). Server messages are displayed as supporting text, never used for control flow.

### 8.2 Status table

| Status | Read (`GET`) | Create | Rename | Archive |
|---|---|---|---|---|
| `401` | Session expiry | Session expiry | Session expiry | Session expiry |
| `403` | "You don't have access to departments." | CSRF refresh and manual retry | CSRF refresh and manual retry | CSRF refresh and manual retry |
| `404` | n/a (no such route) | n/a | "No longer exists" | "No longer exists" |
| `409` | n/a | Slug field error | Read-back diagnosis, only from a trustworthy observation (7.5, D-7) | "Agents still reference it" (stays open) |
| `422` | Unexpected-response error (the UI sends only valid queries) | Form-level server rejection, or the limit message | Form-level server rejection | Treated as an unexpected response |
| `503` / other `5xx` / network / invalid response | Error with Retry | Unknown-outcome recovery (7.2, 7.4, 7.6) | Unknown-outcome recovery (7.7) | Unknown-outcome recovery (7.7) |

### 8.3 Error summary

A form that fails validation (client-side or server-side) shows one error summary at the top of the form: a container with `role="alert"` and `tabindex="-1"` that receives focus, a short heading ("There is a problem") and a list of items. Each item is a **button** (not a fragment link, which would change the hash route) that moves focus to its field. Each invalid field also has an inline error element referenced by `aria-describedby` and `aria-invalid="true"`. Errors clear when the field is corrected. Server-level errors with no field (credential rejection, limit, unconfirmed outcome) appear in the summary without a field button.

## 9. Accessibility requirements

- **Landmarks and headings:** the shell h1 "Departments"; `h2` "Department directory"; each row's name is an `h3`; the create/rename form has its own labelled `<form>` heading ("New department" / "Rename <name>") at `h3`; the dialog title is the dialog's accessible name.
- **Labels:** every input has a visible `<label>` (never placeholder-only), helper text is attached with `aria-describedby`, required fields are marked in the label text ("required"), not by color alone. Inputs use `autocomplete="off"` and sensible `inputmode`/`spellcheck="false"` for the slug.
- **Validation feedback:** section 8.3. Errors are text with an icon, not color alone, and meet contrast 4.5:1 using shipped tokens (`--red` on white).
- **Keyboard:** every control is reachable and operable with Tab, Shift+Tab, Enter and Space. Tab order follows reading order: toolbar, create form (if open), rows (heading, Rename, Archive). No keyboard traps; the native dialog traps focus only while modal.
- **Archive confirmation and focus restoration:** focus moves to Cancel on open; Esc and Cancel restore focus to the originating Archive button (which stays in the DOM unless its row legitimately disappeared, in which case focus goes to the result count or list heading, never to `body`). After a successful archive the focus target is defined in 6.4.
- **Status announcements:** one polite `role="status"` region owned by the workspace announces screen changes, progress ("Creating department…") and the outcome of each mutation, limited by the evidence level (7.2, 7.8). "Created <name>." is permitted **only after a confirmed creation**, "Renamed to <name>." **only after a confirmed rename**, and "Archived <name>." **only after a confirmed archive** (the longer wording in 6.2 to 6.4, "The server confirmed ...", is equally acceptable). For an **unknown** outcome the announcement uses the uncertainty and current-state observation wording of 7.6 and 7.7 and never a success, failure or cause claim. For a **definitive rejection** the announcement states the supported rejection ("The server rejected this change") without claiming any effect that was not observed. Errors use `role="alert"` only in the error summary and the inline resource-failure pattern, so each failure is announced once.
- **Focus indicators:** shipped 3px `--blue` focus outline on every focusable element, including inside the dialog and the error-summary buttons, never removed; the form panel does not clip it.
- **Touch targets:** buttons, checkbox rows and row actions are at least 44 x 44 CSS px at <= 820 px.
- **Reduced motion:** no new animation; the existing global `prefers-reduced-motion` rule applies and no transition is required for any state change.
- **Skip link:** unchanged and tested on `#departments` (PR #16 behavior: hash and history preserved, `<main>` focused).
- **Zoom and text size:** content must reflow at 200% **browser zoom**, at the WCAG 1.4.10 reflow size (320 x 256 CSS px, the size of 400% zoom at 1280 px) and at a 16px minimum user font size: no horizontal scrolling, no clipped or inaccessible controls, no truncated labels or messages, and long names and slugs wrap (`overflow-wrap: anywhere`). Automated viewport and density tests cover reflow geometry; a recorded manual verification in a real browser at 200% zoom is mandatory (DM-31, section 12.8).

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
| DM-03 | Empty states are neutral about archived rows: (a) a validated empty **active-only** response shows exactly "No active departments. Turn on Show archived to check for archived departments." with "New department" and never "No departments yet"; (b) "No departments yet." appears only for a successful `includeArchived=true` response with zero rows; (c) "Only archived" wording ("All departments shown here are archived.") appears only after a successful include-archived response containing archived and no active rows; (d) if the include-archived request fails the ordinary error state shows (no list, Retry) and no statement about whether archived departments exist; (e) a failed, loading or invalid response never shows any empty-state text. |
| DM-04 | An API failure shows "Departments unavailable" with Retry and no list; Retry recovers. |
| DM-05 | `403` shows the access message and keeps the session and navigation working; `401` follows the existing session-expiry flow and leaves no department data. |
| DM-06 | Invalid responses (schema failure, `total` mismatch, duplicate `id`, duplicate `slug`, an extra field) show the unexpected-response error, never an empty or partial list. `503` `limit` shows the too-large state with no partial list. |
| DM-07 | Two departments with the same name are distinguishable (slug shown) and their row actions have distinct accessible names. |

### 12.2 Create

| ID | Criterion |
|---|---|
| DM-08 | Client validation blocks empty/overlong names, empty/overlong or malformed slugs (uppercase, spaces, underscores, leading/trailing/doubled hyphens) with an error summary and field errors; **no request** is sent; uppercase slugs are not silently lowercased. |
| DM-09 | A valid create sends exactly `{ slug, name }` (trimmed, schema-parsed in the fixture) with the CSRF header, disables submit while pending, closes on a confirmed `201`, re-reads the list and announces the confirmed creation (`confirmed.create`). The new row appears only after the re-read. |
| DM-10 | `409` shows the slug field error and keeps the name; the slug field receives focus; no row is added. |
| DM-11 | `422` `invalid_input` shows the form-level rejection without flagging a field; `422` `limit` shows the limit message. |
| DM-12 | `403` refreshes the CSRF token, keeps the input and the session, and a manual retry then succeeds; the fixture proves the second request carries the refreshed token. |
| DM-13 | Unknown create outcomes (`503 department_outcome_unknown`, other `5xx`, network drop, `2xx` with an invalid or mismatching body) show "The outcome of creating this department is unknown.", with no success or failure claim and no optimistic row. The fixture counts exactly one POST until the user explicitly clicks **Try creating again**. Recheck results follow section 7.6 and recovery rows RM-01 to RM-08: failed recheck (submit and "New department" stay disabled, **Check again** works), matching row, same slug with different details, absent slug (no "failed" claim; explicit retry allowed), and a row that another session created. Confirmed `201` followed by a failed list refresh follows 7.3 (RM-01). |
| DM-14 | Create is not offered as an optimistic row: during the pending request the list is unchanged. |

### 12.3 Rename

| ID | Criterion |
|---|---|
| DM-15 | Rename pre-fills name and slug, sends `PATCH` with the full pair, preserves the department `id`, and reflects the re-read values; unchanged values send no request. |
| DM-16 | A rename `409` is diagnosed only from a trustworthy read-back (section 7.5, RM-15): another department has the slug -> slug field error; this department archived -> archived observation, form closes; active and no other department has the slug -> the inconclusive message with no field error; read-back fails or this id is absent -> neutral or unresolved message, no field error. Error `code` and `message` are never used for the diagnosis. |
| DM-17 | `404` shows that the server reports the department doesn't exist and refreshes the list. Unknown rename outcomes follow section 7.7 and RM-02 and RM-09 to RM-14: failed recheck (that row's Rename and Archive stay unavailable), id absent (unresolved), requested values present (observation only, never "Renamed"), previous values present (explicit retry), different values from a concurrent change (**Edit current values**, nothing overwritten without a user action), and archived. A confirmed `200` followed by a failed refresh follows 7.3. No automatic PATCH is ever sent after the first. |
| DM-18 | The last-write-wins note is visible on the edit form, and a fixture-simulated concurrent change is overwritten without any conflict claim. |
| DM-19 | Archived rows offer no Rename or Archive controls. |

### 12.4 Archive

| ID | Criterion |
|---|---|
| DM-20 | "Archive <name>" opens the confirmation dialog with the one-way explanation, focus on Cancel; Esc and Cancel send no request and restore focus to the originating button. |
| DM-21 | Confirming sends one POST with the CSRF header; the row is unchanged during the request; after a confirmed `200` and a successful re-read the row is archived (toggle on) or removed with the explanatory status (toggle off); focus lands on the defined target, never `body`. If the re-read fails after the confirmed `200` the confirmation stays, the list is marked possibly out of date with a read-only **Refresh list**, the row is **not** changed or removed locally, and no second POST is sent (RM-03). |
| DM-22 | `409` keeps the dialog open with the "agents still belong to it" message and makes no change; the row stays active. |
| DM-23 | `404`, `403` (CSRF refresh and manual retry) and `401` behave as in 6.4. Unknown archive outcomes follow section 7.7 and RM-16 to RM-20: failed recheck and absent id (unresolved, Archive unavailable), archived observation (an `observation` only, with no `success` or `cause` claim), active observation (an `uncertainty` that the archive was not applied is allowed, a `failure` claim is not; explicit retry sends exactly one more POST), and active with changed details. For an unknown outcome no archive `success`, `failure` or `cause` claim is made, and no POST is sent without a user action (7.8). |
| DM-24 | There is no Unarchive, Delete or Undo control anywhere, and no archived row can be edited. |

### 12.5 Navigation, accessibility and regression

| ID | Criterion |
|---|---|
| DM-25 | `#departments` and `#departments?archived=1` deep links survive reload; Back/Forward works; `#departments/x` is a malformed-link state with no request; `#agents/departments` still means the agent with id `departments` (fixture agent) and does not reach the department screen. |
| DM-26 | The primary nav has exactly four links, none marked current on `#departments`; the "Manage departments" link on `#agents` and the "← Agents" link navigate correctly. |
| DM-27 | The skip link on `#departments` keeps the hash, adds no history entry and focuses `<main>` with a visible ring. |
| DM-28 | Error summary behavior: it takes focus on a failed submit, its items are buttons that focus the right field, fields expose `aria-invalid` and `aria-describedby`, and no fragment links are used. |
| DM-29 | Status announcements appear in the single polite region and errors are announced once. Each mutation announcement is asserted by catalog key and exact catalogued text (7.8); "Created", "Renamed" and "Archived" announcements occur only for confirmed outcomes, unknown outcomes use only uncertainty and observation messages, and rejections state only the supported rejection. |
| DM-30 | Axe reports no serious or critical violations on the list, empty, error, create form with errors, rename form, archive dialog (open, pending, 409) at 1440, 390 and 320 px. |
| DM-31 | Responsive, reflow, font-size and zoom conditions, verified with section 12.8. **Automated:** (a) no horizontal overflow and all controls reachable at 1440, 820, 390, 360 and 320 px, with 120-character names and 80-character slugs, and touch targets >= 44 px at <= 820 px; (b) the same checks in a reduced CSS viewport at device scale 2 (for example 720 x 450), which is a viewport and pixel-density test and **not** browser zoom; (c) the same checks at the WCAG reflow size of 320 x 256 CSS px; (d) the same checks with a 16px minimum font size. Under (b) to (d): labels, helper text, inline errors and the error summary are fully visible and not truncated or clipped; the archive dialog scrolls internally, keeps both buttons reachable and visible after keyboard focus, and Esc, Tab and Shift+Tab work; text reflows with `scrollWidth <= clientWidth`; create, rename and archive complete end to end by keyboard. **Manual and mandatory:** (e) the recorded real-browser 200% zoom verification of section 12.8, covering form readability, list layout, labels and validation errors, create and rename controls, the archive dialog, keyboard focus and navigation, text reflow, visible error summaries and the absence of clipped or unreachable controls. DM-31 passes only when (a) to (d) pass and (e) is recorded as passed. |
| DM-32 | Reduced-motion emulation produces no animation-dependent state; keyboard-only operation completes create, rename and archive end to end. |
| DM-33 | Hostile text (`<img onerror>`, `<script>`, markdown, bidi controls) in names and slugs renders inert as text and executes nothing. |
| DM-34 | Regression: all existing tests (117 at `a3c53e2`) pass unmodified: Command Center, Tasks, Runs, SSE, approvals, the four-link nav, Agents and the F0b skip link. |

### 12.6 Mutation-test expectations for review

Independent reviewers should confirm, by temporarily disabling each guard in a disposable worktree, that tests fail when: the CSRF header is omitted; the strict body check is removed; the re-read after mutation is skipped (optimistic update); the archive dialog's Cancel-first focus or focus restoration is removed; the rename-409 re-read is replaced by a guess; and the "no automatic retry" rule is broken (the fixture counts requests).

Additional guards for the recovery model (section 7): sending any mutation without a user action (automatic retry after an unknown outcome, a failed recheck, or a failed refresh); turning a failed recheck into a success or failure message; making a `success`, `failure` or `cause` claim (7.8) for an unknown outcome, or adding a catalog entry whose declared claim types exceed its evidence level; treating an active observation as proof that an archive never happened; producing the rename slug-conflict message without a supporting observation; showing stale rows as current after a confirmed mutation whose refresh failed.

### 12.7 Recovery test matrix (referenced by DM-13, DM-17, DM-21 and DM-23)

Fixtures are schema-valid. "Fixture" means a scripted synthetic response; "concurrent" means the fixture changes the list between the mutation and the recheck. Every row also asserts: the mutation POST/PATCH count equals the number of explicit user submissions (never an automatic one), the message shown is the catalogued message this row names and its declared claim types are permitted for the row's evidence level (7.8; asserted by `data-message-key`, exact catalogued text and the catalog-level claim-type test, not by banning words), and focus lands on a defined target rather than `body`.

| ID | Scenario | Expected |
|---|---|---|
| RM-01 | Create `201`, then the list refresh fails | `confirmed.create` stays (a permitted `success` claim) together with `confirmed.listStale` (`uncertainty` about list freshness); confirmation naming the values stays; "list may be out of date" with **Refresh list**; no rows shown as current; no mutation controls; one POST; after a successful refresh the rows appear and the confirmation is not repeated |
| RM-02 | Rename `200`, then the refresh fails | Same pattern as RM-01 with `confirmed.rename` and `confirmed.listStale` |
| RM-03 | Archive `200`, then the refresh fails | Same pattern with `confirmed.archive` and `confirmed.listStale`; the row is not changed or removed locally; no second POST |
| RM-04 | Create `503 department_outcome_unknown`, recheck fails | `unknown.create.outcome` then `unknown.create.recheckFailed`: "Outcome unknown"; "Omnis OS couldn't check either"; submit and "New department" disabled; **Check again** works; one POST |
| RM-05 | Create unknown; recheck shows slug `S` with name `N` | `unknown.create.matchingRow`: "The latest list includes a department with this slug and name ... can't tell" (`observation` + `uncertainty`; no `success` or `cause` claim); Close only |
| RM-06 | Create unknown; recheck shows slug `S` with a different name, and again with an archived row | `unknown.create.slugTaken`: `observation` message and slug field error; form re-enabled with input kept; no `cause` claim |
| RM-07 | Create unknown; recheck shows no slug `S` | `unknown.create.noMatch`: "No department with this slug appears in the latest list. This doesn't prove the create failed ..." is an `uncertainty` claim and is the expected text; the message makes no `failure` claim (it must not assert that the create failed). **Try creating again** is a user action that sends exactly one more POST; if the fixture then answers `409`, the slug field error appears |
| RM-08 | Create unknown; concurrent: the fixture inserts a department with slug `S` and name `N` before the recheck | Same catalog entry as RM-05 (`unknown.create.matchingRow`; cannot tell whose it is); no `cause` claim that this request created it |
| RM-09 | Rename unknown, recheck fails | `unknown.rename.recheckFailed`; unresolved; that row's Rename and Archive unavailable; other rows usable; **Check again** works |
| RM-10 | Rename unknown; recheck lacks the department id | `unknown.rename.absent`: "can't be determined"; unresolved; no field error |
| RM-11 | Rename unknown; recheck shows the requested name and slug | `unknown.rename.requestedValues`: "currently has the name ... and slug ..." `observation` + `uncertainty`; no `success` or `cause` claim that the rename succeeded or caused the values; form closes |
| RM-12 | Rename unknown; recheck shows the earlier values | `unknown.rename.previousValues`: "doesn't prove the request never reached the server" (`uncertainty`; no `failure` claim); explicit **Try again** only |
| RM-13 | Rename unknown; concurrent: third values `X`/`Y` (and a partial match) | `unknown.rename.otherValues`: current values shown as an `observation`; **Edit current values**; nothing overwritten without a user action |
| RM-14 | Rename unknown; recheck shows the department archived | `unknown.rename.archived`: "currently appears as archived ... can't tell whether before or after" (`observation` + `uncertainty`); form closes |
| RM-15 | Rename `409` diagnosis: (a) another id has the slug; (b) department archived; (c) active and slug unused by others; (d) read-back fails; (e) id absent | (a) `rejected.rename.conflictOtherSlug`: slug field error; (b) `rejected.rename.archived`: archived `observation`; (c) `rejected.rename.inconclusive`: inconclusive message, no field error; (d) `rejected.rename.readbackFailed`: neutral message, no field error; (e) `rejected.rename.absent`: unresolved. None makes a diagnosis the observation does not support |
| RM-16 | Archive unknown, recheck fails | `unknown.archive.recheckFailed`; unresolved; Archive unavailable; **Check again** |
| RM-17 | Archive unknown; id absent | `unknown.archive.absent`: "can't be determined"; unresolved |
| RM-18 | Archive unknown; recheck shows archived (variants: archived by this request, archived by another session) | The same entry for both variants (`unknown.archive.archived`): "The department currently appears as archived ..." (`observation` + `uncertainty`); no `success` or `cause` claim that the archive succeeded or was done by this request; dialog closes |
| RM-19 | Archive unknown; recheck shows active | `unknown.archive.active`: "doesn't prove the archive request wasn't applied" (`uncertainty`); no `failure` claim that the archive failed or was not applied; Archive re-enabled; explicit retry sends exactly one more POST |
| RM-20 | Archive unknown; recheck shows active with a changed name or slug | Same entry as RM-19 (`unknown.archive.active`) plus the current values as an `observation` |
| RM-21 | Recheck response invalid (schema failure, duplicate ids or slugs, total mismatch) for any operation | Treated as a failed recheck (`unknown.<operation>.recheckFailed`, unresolved), never as an `observation` |
| RM-22 | A `2xx` mutation response whose body is invalid or does not match the request | Treated as an unknown outcome (`unknown.<operation>.outcome`), not as confirmed: no `success` claim |

### 12.8 Viewport, density, font-size and browser-zoom verification (method only)

This section specifies how DM-31 is to be verified later. **No browser validation of this feature has been performed** (the feature does not exist yet), and nothing here is a claim that any of these checks has passed.

**What the automated checks are, and are not.** A reduced CSS viewport combined with an adjusted device-scale factor is a viewport and pixel-density test. It is not a substitute for actual browser zoom and does not reproduce all browser text-scaling behavior. The automated checks below are retained for responsive and reflow verification, and they do not satisfy the real-browser-zoom requirement on their own.

| Check | How | Automated or manual |
|---|---|---|
| Responsive widths | Viewports 1440, 820, 390, 360 and 320 px (DM-31 a) | **Automated** (Playwright) |
| Reduced viewport with density 2 | A window of `W x H` becomes a layout viewport of `W/2 x H/2` CSS px at `deviceScaleFactor` 2: `browser.newContext({ viewport: { width: W/2, height: H/2 }, deviceScaleFactor: 2 })` (for example 720 x 450 for 1440 x 900). It tests layout at the reduced CSS size and pixel density only. Verified once on 2026-11-04 with the repository's Playwright Chromium that such a context reports `innerWidth` 720, `innerHeight` 450 and `devicePixelRatio` 2 (a statement about the setup, not about this feature) | **Automated**; a viewport/density test, not browser zoom |
| WCAG reflow size | A 320 x 256 CSS px viewport (device scale factor 1 or 4), the size of 400% zoom at 1280 px, so the dialog and error summary are exercised in a tiny viewport | **Automated**; a viewport test |
| 16px minimum font size | Chromium with `--blink-settings=minimumFontSize=16` (a dedicated Playwright project or launch option). Verified once on 2026-11-04 that the setting takes effect: an 11px text run measured 153 CSS px wide by default and 215 CSS px with the setting (the method only) | **Automated**, plus the manual setting below where the browser offers it |
| **Real browser zoom at 200%** | In a real desktop browser, zoom to 200% with the browser's own zoom control (Ctrl/Cmd and +, or the browser menu) | **Manual, mandatory** |

**Assertions for the automated checks:** `document.documentElement.scrollWidth <= clientWidth`; each interactive control, label, inline error, error-summary item and dialog button is fully inside the viewport horizontally and reachable by keyboard (focusing it scrolls it into view vertically); no label or message has `scrollWidth > clientWidth`; the archive dialog's content scrolls inside the dialog and its buttons stay reachable; Esc closes it and focus is restored; create, rename and archive complete by keyboard only.

**Mandatory manual verification (part of satisfying DM-31).** A reviewer performs, in at least one real desktop browser (named with its version and operating system; a second engine is recommended), the following at **200% browser zoom**, once per implementation milestone for the screens it adds (milestone 2: list, create and rename; milestone 3: the archive dialog):

1. Form readability: Name and Slug labels, helper text and values are readable and not clipped.
2. Department-list layout: rows, badges, times and actions reflow without horizontal scrolling or overlap.
3. Labels and validation errors: inline errors stay attached to their fields and fully visible.
4. Create and rename controls: all fields and buttons are reachable and operable.
5. Archive confirmation dialog (milestone 3): the title, explanation and both buttons are reachable, the dialog scrolls internally if needed, Esc works and focus is restored.
6. Keyboard focus and navigation: Tab order is logical, focus rings are visible, and nothing is trapped.
7. Text reflow: text wraps at the zoomed width with no two-dimensional scrolling.
8. Visible error summaries: the error summary receives focus and is fully visible after a failed submit.
9. No clipped or unreachable interactive controls anywhere on the screen.

The reviewer also repeats the pass with the browser's minimum font size set to 16 where the browser offers that setting. The result is recorded in the PR: browser, version, operating system, window size, zoom level, and a pass or fail with notes for each of the nine items. **DM-31 is not satisfied by the automated checks alone, and an unrecorded manual pass does not satisfy it.**

## 13. PR boundaries and dependencies

| Milestone | Content | Entry criteria |
|---|---|---|
| 1 - this PR | Documentation only: this specification and one-paragraph cross-references | Scope approved by independent frontend review. No owner decision is required to merge it (section 4.2); a merge approves no decision |
| 2 - list, create, rename | `departments/` module; `Page` union and `readRoute()` change; "Manage departments" link on the Agents directory; fixtures and Playwright/axe tests for DM-01 to DM-19 and DM-25 to DM-34 (the archive-dialog parts of DM-30 and DM-32 belong to milestone 3), including the recovery matrix rows for create and rename (section 12.7) | Milestone 1 merged; D-1, D-3, D-4, D-5, D-6 and D-7 explicitly approved by the owner |
| 3 - archive | Archive dialog, focus restoration and outcomes; DM-20 to DM-24, the archive-dialog parts of DM-30 and DM-32, and the recovery matrix rows for archive | Milestone 2 merged; D-2 explicitly approved, with the milestone 2 decisions still approved |

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

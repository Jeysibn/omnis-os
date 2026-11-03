# Agents & Profiles V1 - Frontend Specification

**Status: SPECIFICATION ONLY. No Agents & Profiles UI exists on `main`.** This document is documentation for a future frontend change. Merging it does **not** complete AO-104 or AO-110, and implementation **must not begin** until the read API contracts requested in the [proposed API contract](../02-architecture/AGENTS_READ_API_PROPOSAL.md) are implemented and reviewed (section 12, Phase B).

**Baseline:** `main` at `81a017a` (Command Center V1, PR #12). Date: 2026-11-04.

## 1. Purpose and source of truth

Agents & Profiles V1 is a **read-only** Agent Directory, Agent Profile, and immutable profile-version history for the single owner (Director). It is a small, honest slice of the Agents & Profiles module, not a workforce dashboard.

This document does not replace any existing source of truth:

| Concern | Authoritative document |
|---|---|
| Domain rules (identity, profession, versioning, lifecycle, safety) | [Agents, Profiles, Departments and Teams](../03-modules/AGENTS_PROFILES.md) |
| Data model | [Data Model](../02-architecture/DATA_MODEL.md) |
| Requested read API (proposed, unimplemented) | [Agents & Profiles - Proposed Read API Contract](../02-architecture/AGENTS_READ_API_PROPOSAL.md) |
| Product-wide UI/UX and brand direction | [UI/UX Specification](UI_UX_SPEC.md), [Brand Identity](BRAND_IDENTITY.md) |
| Roadmap and AO identifiers | [Backlog](../06-delivery/BACKLOG.md) |
| Agent safety rules | `AGENTS.md` |

This document governs only how V1 is **presented and navigated** in the web app. If it conflicts with the module spec on domain behavior, the module spec wins. Once an executable API exists, the generated OpenAPI and `packages/contracts` are canonical for data shapes.

## 2. Verified baseline (`81a017a`)

What exists and what does not, checked against the repository:

| Area | Fact |
|---|---|
| Backend | No agent, department, or profile-version tables (migrations 0001-0010 cover tasks, runs, events, idempotency, authorization). No `/agents` or `/departments` routes. No agent schemas in `packages/contracts`. `CapabilitiesSchema` exists (mock-only literals) but no route serves it. |
| Run attribution | `RunSchema` has no `agentId` or `profileVersionId`. |
| Frontend | React 19, Vite, Tailwind 4, `lucide-react`; **no router library, state library, or component library.** `apps/web/src/ui/App.tsx` (1,805 lines) holds the shell and all pages; `api.ts` provides the typed `request()` and `ApiRequestError`. |
| Routing | Hash routing via `readRoute()`: `#command-center`, `#tasks`, `#runs`, `#runs/<id>`. |
| Shell | Primary nav has 3 links, no overflow at 1440/820/390/360/320 px (probe on `81a017a`); at a 320 px viewport the 3-link nav is already 288 px wide, so a fourth link must be verified. |
| Skip link (existing defect) | The skip link is `href="#main-content"`. Because routing is hash-based and `readRoute()` falls back to Command Center for unknown hashes, activating it on `#tasks` changes the URL to `#main-content` and switches the app to Command Center (observed in a browser probe on `81a017a`; the existing test only focuses the link and never activates it). Any deep link, including the future agents routes, is lost. This is out of scope for this documentation PR; see section 12 (F0b) and F-6. |
| Tests | 34 Playwright tests (strict contract-parsing fixture, axe at four widths), synthetic only. No unit-test runner in `apps/web`. |
| Fonts | `Inter` is the first declared family but no font files or `<link>` are loaded; it resolves to an installed font or system fallback. Space Grotesk and IBM Plex Mono are not loaded. |

## 3. Principles and scope

1. **Real data only.** Every value on screen comes from the backend. No frontend-owned persistence, seeded agents, fake activity, or decorative metrics. An empty directory is a correct result.
2. **Identity is not authority.** A profession, title, seniority, or personality never implies permissions. The UI must not word anything so that it does.
3. **Lifecycle is not activity.** See section 4.
4. **Historical honesty.** A selected historical version is always that version, never silently the current one.
5. **Inert text.** All profile text is data, rendered as plain text (section 9).
6. **No unsupported claims.** Runtime availability, grants, active tasks, and usage are not shown without backend data (and no V1 endpoint provides them).
7. **Preserve Command Center.** V1 must not change the behavior of owner authentication, CSRF, Tasks, Runs, approvals, replayable SSE, Stop, synthetic labeling, Asia/Manila timestamps, or any of the 34 existing regressions.

**V1 contains:** Agent Directory, Agent Profile, Historical Profile Version. **V1 does not contain:** see section 13.

## 4. Terminology: lifecycle versus observed activity

| Term | Meaning | Shown in V1? |
|---|---|---|
| **Profile lifecycle** | Owner-controlled state of the profile record: `draft`, `available`, `archived` | Yes |
| **Observed activity** | Run- or runtime-derived state: busy, offline, paused, running a task, last seen | **No.** Not available from any V1 endpoint. |

UI wording for lifecycle (labels are display text; the contract value is in the right column). Every lifecycle badge combines an icon with text and never relies on color alone.

| Label | Contract value | Helper text (profile pages) |
|---|---|---|
| Draft | `draft` | "No published profile version yet." |
| Active profile | `available` | "This profile is published. It does not mean the agent is running or reachable." |
| Archived | `archived` | "Archived. History is preserved; this agent can't be assigned new work." |

The label "Available", "Online", "Idle", "Working", or any traffic-light status is **not** used. If the backend renames `available` (Open Decision D-2 in the API proposal), only the label map changes.

## 5. Screen specifications

### 5.1 Agent Directory

**Route:** `#agents`. **Page title in shell:** "Agents & Profiles". **Nav label:** "Agents". **Subtitle:** "Review agent identities and immutable profile versions. Read-only in this release."

**Data:** one `GET /api/v1/agents` per entry to the directory. All filtering is local and only when `page.complete === true` (API proposal section 3.1). Never cached across visits as if fresh: the list is refetched on every mount.

**Layout:**

- The shell already renders the page `h1` ("Agents & Profiles" from `pageTitles`); the directory adds an `h2` "Agent directory", then a toolbar with: search field, department select, "Show archived" checkbox, result count.
- Results as a responsive card grid in a semantic list (`<ul>`): 3 columns at >= 1100 px, 2 columns from 640 to 1099 px, 1 column below 640 px. Cards use the existing card surface (white, `--line` border, `--radius`).
- Default sort: `name` ascending (case-insensitive, locale `en`), then `id`.

**Card content (all from `AgentSummary`):**

- Initials avatar (decorative, `aria-hidden`; first letters of the name; neutral, not color-coded by department).
- Agent name as the card's single link (`<a href="#agents/<encoded id>">`); the whole card is clickable through a stretched pseudo-element, with no nested interactive elements.
- Profession and seniority from `currentVersion`, or "No published version" for a draft.
- Department chip, or "No department".
- Lifecycle badge (icon + text).
- A conspicuous "Demo agent (synthetic)" badge when `provenance === 'demo_seed'`.
- Nothing about runtimes, status "dots", tasks, or metrics.

**Search and filters:**

- Search matches, case-insensitively and after trimming, all whitespace-separated terms (AND) against `name`, `slug`, `currentVersion.profession`, and `department.name`.
- Department select: "All departments", each department present in the loaded list (sorted by name), and "No department".
- "Show archived" is off by default. Archived agents are excluded until it is on. Draft agents always appear.
- Result count line: "Showing N of M agents", where `M` is the number of agents eligible after the "Show archived" setting but before search and department filtering, and `N` is the number matching them. It is an `aria-live="polite"` region updated after filter changes.
- Filter state lives in the URL (section 7.3) so Back from a profile restores the same filtered view.

**States:**

| State | Presentation |
|---|---|
| Loading | Existing `ResourceLoading` pattern; a status line, no skeleton rows that imply data |
| Empty (zero agents) | "No agents yet." plus "Agent creation isn't available in this release." No create button. |
| Empty because everything is archived | "All agents are archived." with the Show archived control focusable |
| No match | "No agents match these filters." with a "Clear filters" button that resets URL filter state and returns focus to the search field |
| Error | The existing `ResourceFailure` pattern ("Agents unavailable", the backend message, a Retry button); no stale list shown |
| 403 | "You don't have access to agents." Session stays valid; nav still works |
| 401 | Existing session-expiry flow; no agent data remains |
| Incomplete list (`complete: false`) | "The agent directory is incomplete and can't be shown reliably in this version." plus Retry. No cards, no filters. |
| Invalid response | "Omnis OS received an unexpected agent response." plus Retry. No partial render. |

**Keyboard and screen reader:**

- Tab order: skip link, nav, search, department, Show archived, then one tab stop per card (its link). The result count announces politely.
- Search and filters are labeled form controls (visible labels, not placeholder-only). Enter in the search field does nothing special (no submit); filtering is live.
- Each card's accessible name is the agent name; lifecycle and department are exposed as text inside the card so a screen reader reading the link context gets "Name, profession, department, lifecycle".
- Focus rings use the existing blue focus style; no focus trapping.

### 5.2 Agent Profile

**Route:** `#agents/<agentId>`. **Data:** `GET /agents/:agentId` (identity and current snapshot) and, independently, `GET /agents/:agentId/versions` (history).

**Layout:** a back link "Agents" (`<a href="#agents">`; it opens the unfiltered directory, while the browser Back button returns to the previously filtered one); `h2` agent name (the shell supplies the single page `h1`); header facts (department, lifecycle badge, provenance badge if demo, created/updated in Asia/Manila); then in-page sections. At >= 900 px an in-page section list sits beside the content; below that it collapses above the content as a labeled `<nav aria-label="Profile sections">` list of **buttons** that scroll to the section and move focus to its heading. Section navigation must **not** use fragment links (`href="#identity"`): with hash routing, a fragment would change the route.

**Sections (each an `<section>` with a heading):**

1. **Identity** - name, slug, department, lifecycle with its helper text, provenance, timestamps.
2. **Profession** - title, seniority, specialties (as a plain list; "None listed" when empty).
3. **Personality and behavior** - traits, tone, principles, autonomy, escalation, all as plain text; "Not specified" per missing field. Not editable.
4. **Instructions** - the verbatim `instructions` text in a labeled, keyboard-scrollable read-only region (`tabindex="0"`, `role="region"`, accessible name "Instructions (plain text)"). Omitted entirely if the backend does not return the field (D-3).
5. **Current version** - "Version N, published <time> by <actor>" with a link to `#agents/<id>/v/<N>`.
6. **Version history** - list of versions (newest first) each a link to `#agents/<id>/v/<n>` showing version number, "Current" marker (from `isCurrent`), profession/seniority, publish time, publisher. "Load more" appears only when `nextCursor` is present; the count reads "Showing N of M versions".
7. **Permissions note** - a fixed, backend-independent explanation, always shown: "A job title or personality does not grant authority. Actions require explicit authorization recorded by Omnis OS." It lists **no grants**, because no V1 endpoint returns any. It states: "Tool and skill permissions aren't shown in this release." This is a static statement of policy, not data.

**Not shown anywhere on the profile:** runtime availability, runtime bindings, tool/skill/MCP grants, memory, active tasks or runs, usage, avatars from remote URLs, or "last active".

**States:**

| State | Presentation |
|---|---|
| Loading | Existing `ResourceLoading` status in place of the content; the shell `h1` is unchanged |
| Profile loaded, history loading | Profile renders; History section shows its own loading state |
| History failed | History section shows an inline failure with Retry; the rest of the profile remains |
| Draft (no `currentVersion`) | Identity renders; Profession/Personality/Instructions/Current version show "No published version yet." |
| Archived | Persistent banner (not dismissible) "This agent is archived. History is preserved and the agent can't be assigned new work."; all content read-only as always |
| Missing field | "Not specified" for that field only |
| Unknown agent (404) | "Agent not found" with a link to the directory |
| Malformed link | "This link isn't valid" with a link to the directory; **no API request is sent** |
| 403 / 401 / error / invalid response | As in 5.1 (access, session expiry, Retry, unexpected response) |

### 5.3 Historical Profile Version

**Route:** `#agents/<agentId>/v/<version>`. **Data:** `GET /agents/:agentId/versions/:version` (snapshot + embedded agent). One request.

**Presentation:**

- Header: back link "Back to <agent name>" (`#agents/<id>`), `h2` "<agent name> - Version N" (the shell supplies the page `h1`).
- A persistent banner distinguishing the two cases:
  - Historical: "You are viewing version N, an immutable snapshot published <time> by <actor>. It may differ from the current profile." with a link to the current version (`isCurrent` false).
  - Current: "This is the current version (N)." (`isCurrent` true).
- Content sections identical to 5.2 sections 2-4, plus version identity (version number, `versionId` in monospace, publish time, publisher). Identity-level facts (name, department, lifecycle) come from the response's embedded `agent` and are labeled "As of now" because they are not part of the version snapshot. This distinction must be visible so a reader does not mistake current department or lifecycle for historical fact.
- No actions: no restore, no rollback, no compare (deferred).

**Guarantees enforced by the frontend:**

- The response's `version.agentId`, `agent.id` and `version.versionNo` must equal the route. Any mismatch is an "unexpected response" error. The UI **never** falls back to current-profile data, a cached current snapshot, or another version.
- The selected version number is always visible in the heading and banner.
- Changing the route to another version discards the previous version's content immediately (no stale flash) and aborts its in-flight request.

**States:**

| State | Presentation |
|---|---|
| Loading | Loading status; no snapshot content |
| Not found (404) | "Version not found" for the agent (agent name shown if known), links to the agent's profile and directory. If the **agent** is unknown: "Agent not found". |
| Archived agent | Same archived banner as 5.2, in addition to the version banner |
| Malformed (`v/0`, `v/01`, `v/abc`, extra segments) | "This link isn't valid"; no API request |
| Other errors | As in 5.1 |

## 6. Responsive behavior

Tested widths: **1440, 820, 390, 360, 320 px.** No horizontal page scroll at any width. Long names, slugs, specialties, and instructions wrap (`overflow-wrap: anywhere`); the instructions region scrolls inside itself. Touch targets (links, buttons, checkbox rows) are at least 44 x 44 CSS px at <= 820 px. Content is not clipped at 200% zoom or with 16 px user font size.

At 1440 px the content stays within the existing `.main-content` max width (1320 px); no full-bleed grid. Grid columns: 3 (>= 1100), 2 (640-1099), 1 (< 640). Profile sections stack in one column below 900 px.

The 4th nav link ("Agents") must fit and remain fully reachable at 320 px (baseline 3-link nav is already 288 px wide at a 320 px viewport). If it does not fit, the shell's nav behavior must be adjusted as part of the implementation PR with its own regression test; it must not be hidden or truncated unreachably.

## 7. Routing specification

### 7.1 Grammar

Let `hash` be `location.hash` without the leading `#`.

1. Split off the query at the first `?`: `path` and `query`.
2. Split `path` on `/` into `segments`.
3. Match on `segments[0] === 'agents'` (case-sensitive). Anything else is outside this feature.

| Path | Result |
|---|---|
| `agents` or `agents/` | Directory (a trailing `/` is normalized away with `history.replaceState`) |
| `agents/<id>` | Profile |
| `agents/<id>/v/<n>` | Historical version |
| Any other shape (`agents/<id>/x`, `agents/<id>/v`, `agents/<id>/v/1/extra`, empty `<id>`) | **Malformed link** |

- `<id>`: `decodeURIComponent` is applied; a `URIError` yields **malformed link** (no raw-string fallback). The decoded value is non-empty. It is re-encoded with `encodeURIComponent` for the API path and for every generated link. The frontend does not constrain the ID format beyond non-empty; the backend decides existence.
- `<n>`: must match `^[1-9][0-9]*$` and be a safe integer. `0`, leading zeros (`01`), signs, decimals, exponent forms, and whitespace are **malformed link**. The canonical form is the one generated by the app.
- The query is read only on the directory route (section 7.3). It is ignored on profile and version routes.

Malformed links are a distinct state from unknown agents: malformed sends **no** request; unknown (valid grammar, backend 404) shows "not found".

### 7.2 Browser behavior

- Every in-app link is a real anchor (`href="#agents/..."`), so Back, Forward, open-in-new-tab, copy-link, and refresh all work with no router library.
- Refresh on any agents URL reloads the data for that URL and shows the same screen. Nothing relies on in-memory state to render a deep link.
- The agents workspace subscribes to `hashchange` (as the shell does) and aborts in-flight requests when the route changes; late responses for a previous route are ignored.
- After in-app navigation between agents screens, focus moves to the new screen's `h2` (`tabindex="-1"`, the same pattern the run inspector heading already uses), and the agents workspace's own visually hidden `role="status"` region announces the new screen. The shell has no shared live region, so the module provides one. On the initial page load, focus is not moved.
- Leaving `#agents` (to Tasks, Runs, or Command Center) unmounts the workspace and cancels its requests. Returning refetches.

### 7.3 Directory query grammar (filter state)

`#agents?q=<text>&dept=<departmentId>&nodept=1&archived=1`

| Param | Rule |
|---|---|
| `q` | Trimmed text for search; ignored if empty. |
| `dept` | A department `id`. If it matches no loaded department the UI shows "Unknown department" in the select, applies the filter (yielding no matches), and offers "Clear filters". It is never silently ignored. |
| `nodept` | `1` selects "No department"; takes precedence over `dept`. |
| `archived` | `1` shows archived agents. |
| Unknown params, invalid values | Ignored. |

Filter changes update the URL with `history.replaceState` (no history spam while typing). Entering a profile from the directory is a normal navigation, so Back returns to the same filtered directory.

### 7.4 Shell integration (the only `App.tsx` changes)

No routing-framework migration and no broad `App.tsx` refactor. The future implementation touches the shell minimally:

1. Add `'agents'` to the `Page` union, `navItems` (label "Agents", `lucide-react` icon), `pageTitles`, and `pageSubtitles`.
2. Make `readRoute()` derive the destination from the hash up to the first `/` **or** `?`, so `#agents?...` resolves to the agents page. Existing `#runs` and `#runs/<id>` behavior is unchanged; existing run-route tests must pass unmodified.
3. Render `<AgentsWorkspace onUnauthorized={...} />` for the `agents` page, passing the shell's existing 401 handling (`expireSessionIfNeeded`) as a callback.
4. The SSE effect (`page !== 'runs'` closes the stream) is not changed; the agents page must open no `EventSource`.

All agents route parsing lives in the `agents/` module, not in `readRoute()`.

## 8. Frontend architecture

### 8.1 Module layout (feature-oriented)

```text
apps/web/src/ui/agents/
  route.ts              pure parse/build of agents hashes and the query grammar
  AgentsWorkspace.tsx   route switch, hashchange subscription, focus/announcement
  AgentDirectory.tsx    toolbar (search, department, archived), count, results
  AgentCard.tsx         one directory card
  AgentProfile.tsx      profile screen and sections
  ProfileSections.tsx   read-only identity/profession/personality/instructions blocks
  VersionHistory.tsx    history list, Load more
  VersionSnapshot.tsx   historical version screen
  useAgentsData.ts      fetch hooks: abort, race protection, error classification
```

Styles are added to `styles.css` under an `.agents-*` class prefix using the existing CSS variables; no new CSS framework or UI library, and no new runtime dependency is expected.

### 8.2 Data handling

- All requests go through the existing `request(path, init, parse)` in `api.ts`, with `parse` using shared Zod schemas from `packages/contracts` (defined in the backend change, section 12). The web app never defines duplicate agent schemas.
- `useAgentsData` uses `AbortController` per request, keyed by route; responses for superseded routes are discarded.
- Beyond schema validation, the hook enforces the invariants in the API proposal (section 5): `archivedAt`/`lifecycle`, `currentVersion` consistency, id/version equality. Violations are "unexpected response" errors.
- Error classification reuses `ApiRequestError`: 401 -> `onUnauthorized`; 403 -> access state (no session expiry); 404 -> not found; 429/5xx/network -> Retry state; schema/invariant failure -> unexpected response.
- No client-side persistence (no `localStorage`, no cached agents), and no `POST`/`PATCH`/`DELETE`.

### 8.3 Shared presentational components

`EmptyState`, `ResourceLoading`, `ResourceFailure`, and `StatusPill` currently live inside `App.tsx` and are not exported. Two options, to be decided at review:

- **Preferred:** a small, behavior-preserving prep change that moves them to `apps/web/src/ui/components/` with no visual change, verified by the unchanged 34 regression tests.
- **Alternative:** the agents module defines its own equivalents that reuse the same CSS classes. This risks visual drift.

Either way, this is not a broad `App.tsx` refactor.

## 9. Safe rendering of profile text

Profile text (name, profession, specialties, personality, behavior, instructions, actor names, department names) is **untrusted data**, even though only the owner writes it (it may be pasted from elsewhere or later written by a runtime proposal).

- Render only as React text nodes. **No** `dangerouslySetInnerHTML`, no markdown or HTML renderer, no auto-linking, no image or URL fetching from profile content.
- Preserve line breaks with `white-space: pre-wrap`; wrap with `overflow-wrap: anywhere`.
- Isolate directionality: text containers use `dir="auto"` and `unicode-bidi: isolate` so bidirectional-control characters cannot reorder surrounding UI.
- Truncation in cards is CSS-only (line clamp); the full value is always available on the profile page.
- Avatars are decorative initials. No remote or backend-supplied URL is loaded as an image or style in V1; no backend value is used as a CSS value.
- Nothing from profile content is logged or written to storage.

## 10. Visual design

Reuse the Command Center V1 language: restrained navy header, neutral light content surfaces, restrained blue accents, readable type, compact hierarchy, visible focus rings, and modest motion. Motion is limited to existing hover/focus transitions and respects `prefers-reduced-motion` (the existing global rule). No decorative imagery, gradients, glows, or animated "activity".

### 10.1 Proposed brand tokens versus shipped accessible colors

`BRAND_IDENTITY.md` and `UI_UX_SPEC.md` label their palette "proposed". Command Center V1 ships darker values for accessibility. Contrast ratios below were computed (WCAG relative luminance) for this document.

| Role | Proposed (brand guide) | Contrast on white | Shipped (`styles.css`) | Contrast on white |
|---|---|---|---|---|
| Interactive blue | `#648DF6` | 3.14 : 1 | `--blue #315cc8` | 6.01 : 1 |
| Healthy/active | Teal `#45C5AA` | 2.14 : 1 | `--green #13795b` | 5.37 : 1 |
| Attention | Amber `#EAB56A` | 1.86 : 1 | `--amber #9c6510` | 4.90 : 1 |
| Header/dark | Navy `#101927` | n/a | `--navy #18263c` | n/a |
| Page background | Soft White `#EEF1F5` | n/a | `#f4f6f9` (page), `#fff` (surface) | n/a |
| Body ink | n/a | n/a | `--ink #17243a` on `#f4f6f9` | 14.37 : 1 |

The proposed blue, teal, and amber fail the 4.5 : 1 text threshold on white and would fail the 3 : 1 UI-component threshold in two of three cases, so they are unsuitable for text or required state indicators. V1 uses the shipped tokens, adds no new colors, and does not alter any token.

**Whether the brand documents should be corrected to match shipped values is a separate decision for the owner and design reviewer.** This PR does not edit `BRAND_IDENTITY.md` or `UI_UX_SPEC.md` tokens.

### 10.2 Typography

Use the existing font stack. Do not add font files or font `<link>`s. Space Grotesk and IBM Plex Mono require a licensing check first (per the brand guide); until then, identifiers, version IDs, and timestamps use the system monospace stack where monospace is wanted.

## 11. Dependency matrix

The documentation-only milestone **does not complete AO-104 or AO-110.** Implementation of the Agent Directory cannot begin until the read API contracts are implemented and reviewed.

### 11.1 Roadmap items

| ID | Backlog statement (`BACKLOG.md`) | Relevance to this work |
|---|---|---|
| AO-104 (P0) | Agent profile version + department CRUD; depends AO-102, AO-103; "Old snapshot preserved on edit" | **Blocking dependency.** The read slice requested here is the *minimum subset* needed by the frontend. AO-104 as a whole (create/edit/department CRUD) is **not** completed or scoped by this work, and remains backend-owned. |
| AO-110 (P1) | Agent Directory, project/task forms, run inspector UI; depends AO-104, AO-105, AO-109; "Playwright owner journey passes" | V1 is **one slice** of AO-110 (read-only directory and profile). The remainder (editing, project/task forms) is outside this work. AO-110 stays open. |
| AO-105 | Project/task/run core schema and state transitions | Listed as an AO-110 prerequisite. The V1 read slice itself does not call task or run APIs. `BACKLOG.md` does not track completion of AO-105/AO-109 and this document makes no claim about their status. |
| AO-109 | Event persistence and SSE reconnection | Same as AO-105. V1 opens no SSE connection. |
| AO-102 / AO-103 | DB migrations; owner authentication | Prerequisites of AO-104. Owner authentication and CSRF exist on `main` and are reused. |

Agents cannot exist until a backend path to create them exists (AO-104 write path or an owner-approved, labeled seed). The frontend will not seed them. Until then the correct V1 outcome is the honest "No agents yet." state (API proposal D-6).

### 11.2 UI feature to API capability

| UI feature | Required API capability | Available today | Verdict |
|---|---|---|---|
| Directory list, identity, profession, department | `GET /agents` (`AgentSummary`) | No | Blocked |
| Search and department filter (client-side) | `GET /agents` with `page.complete: true` | No | Blocked |
| Lifecycle and archived presentation | `lifecycle`, `archivedAt` in `AgentSummary` | No | Blocked |
| Demo-agent labeling | `provenance` | No | Blocked |
| Profile identity and current snapshot | `GET /agents/:id` | No | Blocked |
| Version history list | `GET /agents/:id/versions` | No | Blocked |
| Historical snapshot | `GET /agents/:id/versions/:version` | No | Blocked |
| Authentication, CSRF, 401/403 handling | Existing session and error envelope | Yes | Reusable |
| Timestamps in Asia/Manila | Existing `formatDate` | Yes | Reusable |
| Hash routing and nav integration | Shell changes in section 7.4 | n/a (frontend) | Independent, but only valuable once data exists |
| Static "permissions do not come from titles" note | None (policy text) | n/a | Independent; contains no data |
| Runtime availability, bindings | `GET /runtime-connections` (not requested) | No | Deferred |
| Grants and permissions list | Agent grant model (AO-111, Phase 3) | No | Deferred |
| Active task / run per agent | `agentId` and `profileVersionId` on runs | No | Deferred |

## 12. Implementation phases and PR boundaries

| Phase | Owner | Content | Entry criteria |
|---|---|---|---|
| 0 - this PR | Frontend | Documentation only: this spec and the proposed API contract | Scope approved by frontend review |
| B - backend read slice | Backend implementer; independent backend/security review | Shared contracts, migration(s), owner-authenticated `GET` routes per the API proposal, contract tests, updated `API_CONTRACT.md`/OpenAPI | Backend owner accepts or amends the proposal; open decisions D-1..D-6 resolved |
| F0 - prep (optional) | Frontend | Behavior-preserving move of shared state components (8.3) | Reviewers approve option |
| F0b - shell skip-link fix | Frontend; independent frontend review | Small separate fix so the skip link moves focus to `<main>` without changing the hash, with a regression test that activates it on a deep link. A behavior change to the shell, so it is **not** bundled into F1 or this PR | Reviewers confirm the defect and approach (F-6) |
| F1 - frontend read-only | Frontend; independent frontend review | `agents/` module, nav/route integration, Playwright and axe coverage (section 14) | Phase B merged and reviewed; spec re-reconciled with the implemented contracts |
| Later | Separate approved scopes | Create/edit with versioning, runtime and grant display, run attribution, department placement | Each needs real contracts and its own spec |

Backend implementation is outside this PR and outside this document's ownership.

## 13. Deferred features (not in V1)

Each requires its own approved scope and real supporting contracts:

- Agent creation or editing
- Deletion or archiving controls
- Runtime execution controls
- Provider or runtime availability monitoring
- Active-agent or active-task metrics, usage, or cost
- Tool permissions or grant management
- Skills, MCP, or memory management
- 3D office features
- Chat interface
- Projects workspace
- Version comparison, restore, or rollback
- Department management or hierarchy
- Any frontend-owned (synthetic) persistence

## 14. Acceptance criteria for the future implementation

These are requirements for the F1 implementation, **not** tests added by this documentation PR. Tests use the existing strict, contract-parsing Playwright fixture extended with agent routes built from the shared Zod schemas. Fixture agents are test data only.

### 14.1 Playwright

| ID | Criterion |
|---|---|
| AP-01 | Directory loads from `GET /agents`; cards show name, profession/seniority, department, lifecycle. |
| AP-02 | Search is case-insensitive, trimmed, multi-term AND over name, slug, profession, department name. |
| AP-03 | Department filter, "No department", and "Show archived" each produce the correct set; counts read "Showing N of M". |
| AP-04 | Filters round-trip through the URL; reload and Back from a profile restore the same filtered directory. `dept` for an unknown department shows the unknown state, not an unfiltered list. |
| AP-05 | Card link opens `#agents/<id>`; profile shows identity, profession, personality, behavior, instructions, current version, history. |
| AP-06 | History lists versions newest first with a server-driven "Current" marker; "Load more" only when `nextCursor` is present; count is truthful. |
| AP-07 | Selecting version N opens `#agents/<id>/v/N`; heading and banner show N; content is that snapshot's, different from the current profile. |
| AP-08 | A version request never renders current-profile content; a response whose `agentId`/`versionNo` mismatches the route shows the unexpected-response error. |
| AP-09 | Deep links to the directory, a profile, and a version survive reload and browser Back/Forward; opening in a fresh page works. |
| AP-10 | Malformed links (`v/0`, `v/01`, `v/abc`, extra segments, bad percent-encoding) show "link isn't valid" and send **zero** agent API requests. |
| AP-11 | Unknown agent and unknown version (404) show distinct not-found states with recovery links. |
| AP-12 | Archived agent: hidden by default, shown with the toggle, direct link works, persistent archived banner on profile and version screens. |
| AP-13 | Draft agent (`currentVersion: null`) renders "No published version yet" without errors. |
| AP-14 | Empty directory, all-archived, no-match, loading, error with Retry, and history-only failure (profile stays) each render correctly. |
| AP-15 | `complete: false` produces the incomplete-directory error: no cards, no filters. |
| AP-16 | Directory 401 reuses the session-expiry flow and leaves no agent data; 403 shows the access state and the session remains usable (Tasks still loads). |
| AP-17 | Hostile profile text (`<img src=x onerror=...>`, `<script>`, `javascript:` links, markdown links, bidi-override characters, very long unbroken strings, zero-width characters) renders literally: no injected DOM nodes, no script execution, no navigation, layout intact. |
| AP-18 | The fixture records **no** non-GET request on any agents route; any unexpected request fails the test. |
| AP-19 | No `EventSource` is constructed on any agents route (verified through an init-script spy); the same spy counts a construction on a Runs deep link, proving it works. |
| AP-20 | Superseded responses are discarded: with delayed fixtures, navigating from agent A to agent B never shows A's data. |
| AP-21 | Demo agents (`provenance: 'demo_seed'`) carry the conspicuous synthetic badge; owner-created agents do not. |
| AP-22 | Permissions note is present on profiles, lists no grants, and no text anywhere implies a title confers authority. No runtime, grant, activity, or task content appears. |
| AP-23 | All **34 existing** Command Center tests pass unchanged, including the SSE `Last-Event-ID` reconnect, terminal-run revisit, 600-event replay, session reauthentication, Stop targeting, duplicate Stop, and existing axe tests. |
| AP-24 | Activating the skip link on a directory, profile, and version route keeps the URL and screen and moves focus to the main content. Requires F0b first; until then this criterion cannot pass on any route. |

### 14.2 Accessibility

- Zero serious or critical axe findings on the directory (populated, empty, no-match, error), a profile (loaded, draft, archived), and a historical version, at each tested width.
- Full keyboard operation: every control reachable and operable; no keyboard traps; visible focus rings; logical tab order.
- One `h1` per screen (the shell's); ordered `h2`/`h3` headings below it; landmarks preserved from the shell; skip link works without changing the route (depends on F0b, AP-24); no fragment links for in-page navigation.
- Focus moves to the screen `h2` on in-app navigation; polite announcements for filter result counts and screen changes; errors use `role="alert"`.
- Form controls have visible labels; links have unique, meaningful names; status is never color-only.
- Contrast uses the shipped tokens (section 10.1); text >= 4.5 : 1.
- `prefers-reduced-motion: reduce` produces no non-essential motion.
- Content reflows at 200% zoom with no loss of information or function.

### 14.3 Responsive

At **1440, 820, 390, 360, and 320 px**: no horizontal page overflow; the primary nav including "Agents" is fully reachable; grid columns match section 6; long hostile strings wrap or scroll within their region; touch targets >= 44 px at <= 820 px.

## 15. Open decisions

Tracked in the API proposal (D-1 to D-6) plus:

| ID | Decision |
|---|---|
| F-1 | Shared-component prep change (8.3, preferred) versus duplicated equivalents. |
| F-2 | Whether to correct brand-token documentation to the shipped accessible values (10.1), as a separately reviewed change. |
| F-3 | Filters in the URL (7.3) are retained from the approved scope; reviewers may prefer session-only filter state to reduce route surface. |
| F-4 | If the nav cannot fit a fourth link at 320 px (section 6), the approach to adjusting the shell. |
| F-5 | The shell shows a "Mock-only mode" badge next to every page title, including Agents. It describes runtime mode, not agent data. Whether to keep it on the Agents page, or rely on the per-agent `provenance` badge to avoid implying agent data is mock, is a design-review call. |
| F-6 | The existing skip-link defect (section 2): confirm it, and approve fixing it as a separate shell change (F0b) before F1, versus accepting AP-24 as a known failing criterion. |

# Agents & Profiles V1 - Frontend Specification

**Status:** This is the original read-only presentation specification. The read APIs it required are now implemented. Phase 1 owner mutations are defined separately in [Agent Profile Management V1 — Phase 1 Supplement](AGENT_PROFILE_MANAGEMENT_V1_FRONTEND.md); that supplement supersedes only the old no-create and AP-18 no-mutation rules. This document remains authoritative for read views and their honesty, accessibility, navigation, and security behavior.

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
| Published | `available` | "This profile version is published. This is not a runtime status: it does not mean the agent is running, online, or reachable." |
| Archived | `archived` | "Archived. History is preserved; this agent can't be assigned new work." |

"Published" is only a display label. It follows the module spec's own wording (the profile editor "publishes immutable version N") and introduces no new lifecycle state: the contract value stays `available`. The labels "Available", "Active", "Online", "Idle", "Working", or any traffic-light status are **not** used, because they read as runtime connectivity. To keep the distinction visible, the directory shows a one-line static legend under the toolbar, "Profile status describes the profile record. It does not show whether an agent is running.", and each profile page shows the helper text from the table above next to the badge. If the backend renames `available` (Open Decision D-2 in the API proposal), only the label map changes.

## 5. Screen specifications

### 5.1 Agent Directory

**Route:** `#agents`. **Page title in shell:** "Agents & Profiles". **Nav label:** "Agents". **Subtitle:** "Review agent identities and immutable profile versions. Read-only in this release."

**Data:** one `GET /api/v1/agents` per entry to the directory. All filtering is local and only when the response passes the frontend-checkable properties (single response with `complete: true`, item count equal to `total`, consistent metadata; API proposal sections 2.5 and 3.1). That the response contains every agent that exists is a backend guarantee the frontend cannot prove. Never cached across visits as if fresh: the list is refetched on every mount.

**Layout:**

- The shell already renders the page `h1` ("Agents & Profiles" from `pageTitles`); the directory adds an `h2` "Agent directory", then a toolbar with: search field, department select, "Show archived" checkbox, result count, followed by a one-line static legend: "Profile status describes the profile record. It does not show whether an agent is running." (section 4).
- Results as a responsive card grid in a semantic list (`<ul>`): 3 columns at >= 1100 px, 2 columns from 640 to 1099 px, 1 column below 640 px. Cards use the existing card surface (white, `--line` border, `--radius`).
- Default sort: `name` ascending (case-insensitive, locale `en`), then `id`.

**Card content (all from `AgentSummary`):**

- Initials avatar (decorative, `aria-hidden`; first letters of the name; neutral, not color-coded by department).
- Agent name as the card's **only link and its heading**: `<h3><a href="#agents/<encoded id>">Name</a></h3>`. The link text is the display name alone. Navigation always uses the stable agent `id`, never the name. The whole card is clickable through a stretched pseudo-element (CSS only), with no nested interactive elements.
- One **context line** (a single `<p>` that is the link's accessible description, see "Accessible name and description" below) holding, in this order and separated by visible separators: profession and seniority from `currentVersion` (or "No published version" for a draft), the department (or "No department"), the lifecycle badge (icon + text, labels from section 4, e.g. "Published"), a conspicuous "Demo agent (synthetic)" marker when `provenance === 'demo_seed'`, and, only on a display-name collision, "Slug: <slug>".
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
| Empty (zero agents) | Shown **only** for a validated response with `total: 0`, no items, `complete: true` (API proposal PG-6): "No agents yet." plus "Agent creation isn't available in this release." No create button. A failed, loading, or invalid response never renders this state. |
| Empty because everything is archived | "All agents are archived." with the Show archived control focusable |
| No match | "No agents match these filters." with a "Clear filters" button that resets URL filter state and returns focus to the search field |
| Error | The existing `ResourceFailure` pattern ("Agents unavailable", the backend message, a Retry button); no stale list shown |
| 403 | "You don't have access to agents." Session stays valid; nav still works |
| 401 | Existing session-expiry flow; no agent data remains |
| Incomplete list (valid response with `complete: false` and a continuation cursor) | "The agent directory is incomplete and can't be shown reliably in this version." plus Retry. No cards, no filters. V1 does not paginate the directory. |
| Invalid response (schema failure, or metadata that violates API proposal PG-1 to PG-7: e.g. `complete` disagreeing with `nextCursor`, item count not equal to `total`, duplicate `id`s, duplicate `slug`s) | "Omnis OS received an unexpected agent response." plus Retry. No partial render, and never the empty state. |

**Keyboard and screen reader:**

- Tab order: skip link, nav, search, department, Show archived, then one tab stop per card (its link). The result count announces politely.
- Search and filters are labeled form controls (visible labels, not placeholder-only). Enter in the search field does nothing special (no submit); filtering is live.
- Focus rings use the existing blue focus style; no focus trapping.

**Accessible name and description (deterministic strategy):**

- **Name.** The link's accessible name is its visible text: the agent's display name, nothing else. No `aria-label`, `aria-labelledby`, or `title` overrides it, so the visible label and the accessible name always match (WCAG 2.5.3).
- **Description.** The link has `aria-describedby` pointing at exactly one element: the card's context line (above). Its id is generated per card by React `useId()`, never derived from backend text, and ids are never shared between cards. The context line does **not** repeat the display name, so nothing is announced twice because of it.
- **Heading.** The name sits in an `h3` under the directory `h2`, so heading navigation lists agents by name.
- **Stable identity.** The link target is `#agents/<encodeURIComponent(id)>`. Two agents can share a display name, but never an `id` or a `slug` (both stable and unique in the proposed contract). The frontend treats a duplicate `id` or `slug` in one response as an invalid response (section 8.2).
- **Duplicate display names.** Two agents collide when their names are equal after trimming, collapsing internal whitespace, Unicode NFC normalization, and case-insensitive comparison (`toLocaleLowerCase('en')`), compared across **all loaded agents**, not only those currently shown. On a collision, every colliding card's context line also shows "Slug: <slug>", which is unique by contract, so every pair is distinguishable even if department, profession, and lifecycle are identical. Non-colliding cards omit the slug to avoid noise. Because the slug is visible text in the context line, it is both described and seen.

What assistive technology will announce (the text of the description is exposed through the accessibility tree; whether and when it is spoken depends on the screen reader, browser, and verbosity settings, so the spec does **not** rely on speech alone):

| Situation | Exposed to assistive technology |
|---|---|
| Tab to a card link | Name "Atlas", role link, description "Systems Architect, Senior · Engineering · Published" (spoken where the AT announces descriptions) |
| Tab to a colliding card | Name "Atlas", role link, description "... · Published · Slug: atlas-research" |
| Browse/virtual cursor | Heading level 3 containing the link "Atlas"; then the context line as ordinary text in reading order. Some AT may announce the description with the link and again when reading the paragraph; that small repetition is accepted because the line is short and the alternative (no description) leaves duplicate names indistinguishable in Tab navigation. |
| Link purpose | Determinable from the list item (the card) as context, which satisfies WCAG 2.4.4; the name alone is never the only disambiguator when names collide. |

### 5.2 Agent Profile

**Route:** `#agents/<agentId>`. **Data:** `GET /agents/:agentId` (identity and current snapshot) and, independently, `GET /agents/:agentId/versions` (history).

**Layout:** a back link "Agents" (`<a href="#agents">`; it opens the unfiltered directory, while the browser Back button returns to the previously filtered one); `h2` agent name (the shell supplies the single page `h1`); header facts (department, lifecycle badge, provenance badge if demo, created/updated in Asia/Manila); then in-page sections. At >= 900 px an in-page section list sits beside the content; below that it collapses above the content as a labeled `<nav aria-label="Profile sections">` list of **buttons** that scroll to the section and move focus to its heading. Section navigation must **not** use fragment links (`href="#identity"`): with hash routing, a fragment would change the route.

**Sections (each an `<section>` with a heading):**

1. **Identity** - name, slug, department, lifecycle with its helper text, provenance, timestamps.
2. **Profession** - title, seniority, specialties (as a plain list; "None listed" when empty).
3. **Personality and behavior** - traits, tone, principles, autonomy, escalation, all as plain text; "Not specified" per missing field. Not editable.
4. **Instructions** - the verbatim `instructions` text in a labeled, keyboard-scrollable read-only region (`tabindex="0"`, `role="region"`, accessible name "Instructions (plain text)"). Omitted entirely if the backend does not return the field (D-3).
5. **Current version** - "Version N, published <time> by <actor>" with a link to `#agents/<id>/v/<N>`.
6. **Version history** - list of versions (newest first) each a link to `#agents/<id>/v/<n>` showing version number, "Current" marker (from `isCurrent`), profession/seniority, publish time, publisher. Versions load one page at a time following the pagination contract in API proposal section 2.5. The frontend checks the properties it can observe; the remaining invariants (notably PG-8, no skipped records) are backend guarantees it cannot prove. "Load more" appears only while `complete` is `false`; the count reads "Showing N of M versions" while accumulated < `total`, and "M versions" only after the traversal ended with `complete: true` and the accumulated unique count equals `total` (a consistency check that does not by itself prove the backend returned every record). Sequential loading: one request in flight at a time, aborted on route change.
7. **Permissions note** - a fixed, backend-independent explanation, always shown: "A job title or personality does not grant authority. Actions require explicit authorization recorded by Omnis OS." It lists **no grants**, because no V1 endpoint returns any. It states: "Tool and skill permissions aren't shown in this release." This is a static statement of policy, not data.

**Not shown anywhere on the profile:** runtime availability, runtime bindings, tool/skill/MCP grants, memory, active tasks or runs, usage, avatars from remote URLs, or "last active".

**States:**

| State | Presentation |
|---|---|
| Loading | Existing `ResourceLoading` status in place of the content; the shell `h1` is unchanged |
| Profile loaded, history loading | Profile renders; History section shows its own loading state |
| History failed (first page) | History section shows an inline failure with Retry; the rest of the profile remains. This is never shown as "No versions". |
| History partially loaded then failed, invalid cursor (`422`), contradictory metadata, or `total` changed | Checked pages stay visible, labeled "Showing N of M versions", with an inline error and a Reload action (restarts the traversal). Never labeled complete; "History changed while loading" for a changed `total`. |
| History empty | Shown only for a validated `total: 0` response (PG-6), with the wording "No versions published yet." |
| Draft (no `currentVersion`) | Identity renders; Profession/Personality/Instructions/Current version show "No published version yet." |
| Archived | Persistent banner (not dismissible) "This agent is archived. History is preserved and the agent can't be assigned new work."; all content read-only as always |
| Missing field | "Not specified" for that field only |
| Agent not found (404 on `/agents/:id`) | "Agent not found" with a link to the directory. On this route the 404 can only concern the agent. |
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
| Not found (404) | One **generic** state: "We couldn't find this agent version." with the supporting line "The agent or this version may not exist." It offers two links: "Open this agent's profile" (`#agents/<id>`) and "Back to the directory" (`#agents`). The UI branches on the HTTP status only (never on the error `code` or `message`), does **not** name the agent, and does not state or infer whether the agent or the version is missing, because the API deliberately returns the same 404 for both (API proposal 3.4). Opening the profile link is an ordinary navigation that performs its own request. |
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

Malformed links are a distinct state from not-found: malformed sends **no** request and shows "This link isn't valid"; a valid-grammar link that the backend answers with 404 shows the route's not-found state ("Agent not found" on the profile route, the generic version-not-found state on the version route, section 5.3).

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
- Collection responses are checked on every response against the **frontend-checkable** properties of API proposal 2.5 (PG-1 to PG-7 and PG-9, and the observable parts of PG-4 and PG-10), including uniqueness of `id` (and of `slug` for agents) and `versionNo` ordering among received items. PG-8 (no skipped records) and the other backend guarantees BG-1 to BG-4 cannot be verified by the frontend and are not claimed. The history hook keeps the accumulated set, loads one page at a time, and never labels a collection complete until the final response reconciles with `total`; that is a consistency check, not proof of dataset completeness.
- Beyond schema validation, the hook enforces the invariants in the API proposal (section 5): `archivedAt`/`lifecycle`, `currentVersion` consistency, id/version equality. Violations are "unexpected response" errors.
- Error classification reuses `ApiRequestError`: 401 -> `onUnauthorized`; 403 -> access state (no session expiry); 404 -> the route's not-found state, chosen by route only (never by error `code` or `message`); 429/5xx/network -> Retry state; schema/invariant failure -> unexpected response.
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
| AO-104 (P0) | Agent profile version + department CRUD; depends AO-102, AO-103; "Old snapshot preserved on edit" | **Owns agent profiles, profile versioning, and profile editing**: the data model, create/edit and department CRUD, and the rule that an edit preserves the old snapshot. It is the **blocking dependency** of this work. The read slice requested here is only the *minimum subset* the frontend needs to read what AO-104 stores. AO-104 as a whole is **not** completed or scoped by this work, and remains backend-owned. |
| AO-110 (P1) | Agent Directory, project/task forms, run inspector UI; depends AO-104, AO-105, AO-109; "Playwright owner journey passes" | **Owns the frontend user journeys** that consume those capabilities and **remains open**. V1 is **one slice** of it (read-only directory and profile). Its other documented dependencies and journeys (AO-105, AO-109, project/task forms, run inspector) are unchanged and outside this work. A profile *editing* journey, if scoped later, is an AO-110 frontend journey that **depends on** AO-104's write capability; the capability itself belongs to AO-104. |
| AO-105 | Project/task/run core schema and state transitions | Listed as an AO-110 prerequisite. The V1 read slice itself does not call task or run APIs. `BACKLOG.md` does not track completion of AO-105/AO-109 and this document makes no claim about their status. |
| AO-109 | Event persistence and SSE reconnection | Same as AO-105. V1 opens no SSE connection. |
| AO-102 / AO-103 | DB migrations; owner authentication | Prerequisites of AO-104. Owner authentication and CSRF exist on `main` and are reused. |

`PHASE_0_1_HANDOFF.md` lists a "Basic Agent Directory editor" among Phase 1 frontend work. V1 does **not** deliver an editor; editing needs AO-104's write capability first. Nothing in the backlog is marked complete or reassigned by this document.

Agents cannot exist until a backend path to create them exists (AO-104 write path or an owner-approved, labeled seed). The frontend will not seed them. Until then the correct V1 outcome is the honest "No agents yet." state (API proposal D-6).

### 11.2 UI feature to API capability

| UI feature | Required API capability | Available today | Verdict |
|---|---|---|---|
| Directory list, identity, profession, department | `GET /agents` (`AgentSummary`) | No | Blocked |
| Search and department filter (client-side) | `GET /agents` returning a single response with `complete: true` and count equal to `total`, with the backend guaranteeing it holds every agent (BG-3) | No | Blocked |
| Lifecycle and archived presentation | `lifecycle`, `archivedAt` in `AgentSummary` | No | Blocked |
| Demo-agent labeling | `provenance` | No | Blocked |
| Profile identity and current snapshot | `GET /agents/:id` | No | Blocked |
| Version history list | `GET /agents/:id/versions` | No | Blocked |
| Historical snapshot | `GET /agents/:id/versions/:version` | No | Blocked |
| Truthful multi-page version history | Collection metadata and invariants PG-1 to PG-10 on `GET /agents/:id/versions`, with backend guarantees BG-1 to BG-4 (API proposal 2.5), including no silently skipped records, covered by backend tests | No | Blocked |
| Generic not-found for version deep links | One indistinguishable 404 for unknown agent or version (API proposal 3.4) | No (existing 404 envelope and hidden-resource rule suffice) | Blocked on the route itself; no new error codes needed |
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
| F0b - shell skip-link fix | Frontend; independent frontend review | A separate, focused app-shell correction, to be implemented **after** this documentation milestone and **not** in this PR or bundled into F1. The skip link must focus the main content without changing the active route or hash. Playwright tests must actually activate it (keyboard Enter and click) from Tasks and from a Runs deep link, and assert the URL, the visible page, and focus on `<main>` | Reviewers confirm the defect and approach (F-6) |
| F1 - frontend read-only | Frontend; independent frontend review | `agents/` module, nav/route integration, Playwright and axe coverage (section 14) | Phase B merged and reviewed; spec re-reconciled with the implemented contracts |
| Later | Separate approved scopes | Profile create/edit with versioning (the capability is AO-104; the frontend journey is AO-110), runtime and grant display, run attribution, department placement | Each needs real contracts and its own spec |

Backend implementation is outside this PR and outside this document's ownership.

## 13. Deferred features (not in V1)

Each requires its own approved scope and real supporting contracts:

- Agent creation or editing (the capability belongs to AO-104; a frontend editing journey belongs to AO-110 and needs it first)
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
| AP-01 | Directory loads from `GET /agents`; cards show name, profession/seniority, department, and the lifecycle label ("Published", "Draft", "Archived"; never "Active" or "Available"); the profile-status legend is present. |
| AP-02 | Search is case-insensitive, trimmed, multi-term AND over name, slug, profession, department name. |
| AP-03 | Department filter, "No department", and "Show archived" each produce the correct set; counts read "Showing N of M". |
| AP-04 | Filters round-trip through the URL; reload and Back from a profile restore the same filtered directory. `dept` for an unknown department shows the unknown state, not an unfiltered list. |
| AP-05 | Card link opens `#agents/<id>`; profile shows identity, profession, personality, behavior, instructions, current version, history. |
| AP-06 | Version history is retrieved correctly across multiple pages and fails honestly: multi-page retrieval, stable ordering, no duplicate versions, detection of skipped versions that cause an observable count mismatch, correct display of a complete valid fixture, cursor handling, invalid cursor, and contradictory metadata, with a server-driven "Current" marker. Cases AP-06a to AP-06k in 14.1.1. |
| AP-07 | Selecting version N opens `#agents/<id>/v/N`; heading and banner show N; content is that snapshot's, different from the current profile. |
| AP-08 | A version request never renders current-profile content; a response whose `agentId`/`versionNo` mismatches the route shows the unexpected-response error. |
| AP-09 | Deep links to the directory, a profile, and a version survive reload and browser Back/Forward; opening in a fresh page works. |
| AP-10 | Malformed links (`v/0`, `v/01`, `v/abc`, extra segments, bad percent-encoding) show "link isn't valid" and send **zero** agent API requests. |
| AP-11 | A 404 on `/agents/:id` shows "Agent not found". A 404 on `/agents/:id/versions/:version` shows one **generic** not-found state that does not name or infer the missing resource and offers links to the agent's profile and to the directory. Case detail in 14.1.2. |
| AP-12 | Archived agent: hidden by default, shown with the toggle, direct link works, persistent archived banner on profile and version screens. |
| AP-13 | Draft agent (`currentVersion: null`) renders "No published version yet" without errors. |
| AP-14 | Empty directory (only for a validated `total: 0` response), all-archived, no-match, loading, error with Retry, and history-only failure (profile stays) each render correctly. Every error and invalid-response fixture asserts the empty-state text is absent. |
| AP-15 | A valid response with `complete: false` and a cursor produces the incomplete-directory error. Contradictory metadata (`complete` vs `nextCursor` disagreement, item count not equal to `total`, duplicate `id` or `slug`) produces the unexpected-response error. In both: no cards, no filters, no empty state, and Retry works. |
| AP-16 | Directory 401 reuses the session-expiry flow and leaves no agent data; 403 shows the access state and the session remains usable (Tasks still loads). |
| AP-17 | Hostile profile text (`<img src=x onerror=...>`, `<script>`, `javascript:` links, markdown links, bidi-override characters, very long unbroken strings, zero-width characters) renders literally: no injected DOM nodes, no script execution, no navigation, layout intact. |
| AP-18 | The fixture records **no** non-GET request on any agents route; any unexpected request fails the test. |
| AP-19 | No `EventSource` is constructed on any agents route (verified through an init-script spy); the same spy counts a construction on a Runs deep link, proving it works. |
| AP-20 | Superseded responses are discarded: with delayed fixtures, navigating from agent A to agent B never shows A's data. |
| AP-21 | Demo agents (`provenance: 'demo_seed'`) carry the conspicuous synthetic badge; owner-created agents do not. |
| AP-22 | Permissions note is present on profiles, lists no grants, and no text anywhere implies a title confers authority. No runtime, grant, activity, or task content appears. |
| AP-23 | All **34 existing** Command Center tests pass unchanged, including the SSE `Last-Event-ID` reconnect, terminal-run revisit, 600-event replay, session reauthentication, Stop targeting, duplicate Stop, and existing axe tests. |
| AP-24 | Activating the skip link (keyboard Enter and click) on a directory, profile, and version route keeps the URL and screen and moves focus to the main content. Requires F0b first; until then this criterion cannot pass on any route. |
| AP-25 | Duplicate display names stay distinguishable and operable. Case detail in 14.1.3. |

#### 14.1.1 AP-06 cases (version history retrieval)

Fixture: an agent with 5 versions served as three pages `[5, 4]`, `[3, 2]`, `[1]` with `total: 5` (the worked example in API proposal 2.5). The fixture records each request's URL.

**What these tests do and do not show.** They are synthetic frontend fixtures. They show how the frontend behaves for the responses it is given: it checks what it can observe (types, metadata agreement, counts, duplicates, order among received items, total changes), displays honestly, and fails closed. They do **not** show that a real backend never skips, duplicates by omission, or misreports a record, because a frontend cannot observe that (BG-1 to BG-4). Those guarantees need backend contract or integration tests, owned by the backend and independently reviewed; no Playwright fixture substitutes for them.

| Case | Setup | Required result |
|---|---|---|
| AP-06a Multi-page retrieval | Pages as above | Exactly three requests, one in flight at a time. Counts read "Showing 2 of 5 versions", then "Showing 4 of 5 versions" with Load more present after pages 1 and 2; after page 3 Load more is gone and the count reads "5 versions". |
| AP-06b Stable ordering | Same | DOM order is 5, 4, 3, 2, 1. The "Current" marker appears only on the row the server flags. A variant flags version 4 as current and the marker is on 4, not on the highest number. |
| AP-06c No duplicates | Variant: page 2 is `[4, 3]` | Traversal stops; pages already checked stay visible labeled "Showing 2 of 5 versions" with an error and Reload; version 4 appears once; never labeled complete. |
| AP-06d Observable skipped records | Variant: pages `[5, 4]` then `[2, 1]`, final `complete: true`, `total: 5`. **Scope:** shows detection of a skipped-item fixture *when the omission creates an observable count mismatch*. It does not prove arbitrary no-skip correctness; an omission with a consistent `total` is undetectable here (API proposal 2.5, BG-1). | The count mismatch (4 unique items against `total: 5`) is detected on the final page, which is discarded as the offending response: checked pages stay, labeled "Showing 2 of 5 versions" with an error and Reload; never "5 versions"; no Load more. |
| AP-06e Display of a complete valid fixture | Pages as above. **Scope:** shows that the frontend correctly displays the complete dataset a valid fixture supplies. It does not establish that the real backend never omits a record (BG-1). | Exactly 5 rows with 5 unique `versionNo`; the final label is "5 versions". |
| AP-06f Cursor handling | Cursors `cur_A` and an opaque value containing reserved characters (e.g. `a+b/c=`) | The first request carries no `cursor`; each continuation carries the previous `nextCursor` exactly and decodes server-side to the original value; no other query parameter is invented. |
| AP-06g Invalid cursor | Continuation answered `422` with the standard envelope | Checked pages remain, labeled partial, with a Reload action; Reload re-requests the first page without a cursor and rebuilds the list with no duplicates. |
| AP-06h Contradictory metadata | One variant per row of the invalid-metadata table in API proposal 2.5 (`complete` vs `nextCursor` disagreement; empty page with a cursor; repeated cursor; `total` 5 then 6; first page count not equal to `total` with `complete: true`) | The result in that table: error state, the stated labels, never complete, never the empty state. The `total`-change variant shows "History changed while loading" with Reload. |
| AP-06i Honest failures | `5xx`, `429`, and a network error on page 1, and on page 2 | Page 1: error with Retry and no "No versions" text. Page 2: checked pages stay labeled partial with Retry. Retry repeats the same request. |
| AP-06j Empty history | A validated `total: 0` response | "No versions published yet." appears here and only here. |
| AP-06k Route change | Navigate to another agent or leave Agents while page 2 is delayed | The pending request is aborted; late data never appends to another agent's list (overlaps AP-20). |

#### 14.1.2 AP-11 cases (not found)

1. `GET /agents/<unknown>` returns 404: the profile route shows "Agent not found" with a link to the directory.
2. On the version route the fixture returns a byte-identical 404 for (a) an unknown agent and (b) a known agent with an unknown version, and a third variant changes only the error `code` and `message` text (for example `agent_not_found` versus `version_not_found`). The rendered state is identical in all three: the generic text of section 5.3, no agent name, no claim about which resource is missing, links "Open this agent's profile" (`#agents/<id>`) and "Back to the directory" (`#agents`).
3. The profile link navigates normally and its own request decides what appears next (the profile for a known agent, "Agent not found" for an unknown one).
4. A malformed route is not a not-found case: it shows "This link isn't valid" and sends zero requests (AP-10).

#### 14.1.3 AP-25 cases (duplicate display names)

Fixture: three agents named "Atlas" (A1: Engineering, slug `atlas`; A2: Research, slug `atlas-research`; A3: Engineering, same profession and lifecycle as A1, slug `atlas-2`), plus a unique agent "Nova". A variant uses "atlas " and "ATLAS" to verify collision normalization. Another variant gives two agents the same `slug`.

- Three links have the accessible name "Atlas" and one has "Nova"; links are located by `href` (`#agents/<encoded id>`) for the assertions that follow, never by name alone.
- Each link's `aria-describedby` resolves to its own context element; the three descriptions (`toHaveAccessibleDescription`) are pairwise different and each contains its own slug; Nova's description contains no slug; no description repeats the display name.
- Keyboard: Tab visits each card link exactly once in order; Enter on the second opens A2's profile, whose identity section shows A2's department and slug; Back returns to the directory.
- Search for `atlas-research` matches only A2.
- Two agents with the same `slug` in one response are rejected as an invalid response (AP-15 behavior).
- axe reports no serious or critical violations on this state at the tested widths.

### 14.2 Accessibility

- Zero serious or critical axe findings on the directory (populated, empty, no-match, error), a profile (loaded, draft, archived), and a historical version, at each tested width.
- Full keyboard operation: every control reachable and operable; no keyboard traps; visible focus rings; logical tab order.
- One `h1` per screen (the shell's); ordered `h2`/`h3` headings below it; landmarks preserved from the shell; skip link works without changing the route (depends on F0b, AP-24); no fragment links for in-page navigation.
- Focus moves to the screen `h2` on in-app navigation; polite announcements for filter result counts and screen changes; errors use `role="alert"`.
- Form controls have visible labels; link names equal their visible text, and agents with the same display name are distinguished by the accessible description and the visible slug (AP-25); status is never color-only.
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

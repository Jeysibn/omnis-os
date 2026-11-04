# Agents & Profiles - Proposed Read API Contract (V1)

**Status: PROPOSED CONTRACT REQUEST. Not implemented. Not an API specification.** No agent, department, or profile-version route, contract schema, or database table exists on `main` (verified against `81a017a`). This document is the frontend's minimum request to the backend owner for a **read-only** slice of AO-104. It does not complete AO-104 and does not authorize any implementation by itself.

- **Requested by:** frontend ([Agents & Profiles V1 frontend specification](../04-design/AGENTS_PROFILES_V1_FRONTEND.md)).
- **Owned and implemented by:** the backend/security implementer, with independent backend/security review. Nothing in this document changes backend ownership.
- **Precedence:** once routes exist, the code-generated OpenAPI and the shared contracts in `packages/contracts` are canonical (see [API Contract](API_CONTRACT.md), "OpenAPI generation policy"). Any difference between those and this proposal must be reconciled by amending this document and the frontend spec **before** frontend implementation begins.
- **Domain rules:** the entity model stays defined by [Agents, Profiles, Departments and Teams](../03-modules/AGENTS_PROFILES.md) and [Data Model](DATA_MODEL.md). This document only requests how a read-only slice of it is exposed.

## 1. Conventions to reuse

| Convention | Source | Requirement |
|---|---|---|
| Path prefix and versioning | [API Contract](API_CONTRACT.md) | All routes under `/api/v1`. |
| Owner authentication | `requireOwner` pre-handler used by existing routes | Every route in this document requires the owner session. No anonymous or runtime-credential access. |
| Property naming | Implemented schemas in `packages/contracts` (`createdAt`, `taskId`, `requestId`) | **camelCase.** `API_CONTRACT.md` examples use `snake_case` (`agent_id`, `request_id`); they predate the implemented contracts. This proposal follows the implemented convention. See Open Decision D-1. |
| Error envelope | `ApiErrorSchema`: `{ "error": { "code", "message", "requestId?" } }` | Reuse unchanged. The web client's typed `request()` already depends on it. |
| Timestamps | Existing schemas (`z.string().datetime()`) | UTC ISO-8601. The frontend renders them in `Asia/Manila`. |
| IDs | Existing schemas (`z.string().min(1)`) | Opaque strings. The frontend never parses or constructs them. |
| Response validation | Shared Zod schemas in `packages/contracts` | The backend defines the schemas; the web app imports them and validates every response at the boundary. The web app defines no duplicate agent schemas. |
| Unknown fields | Existing read schemas are non-strict | The frontend ignores unknown response fields. Required fields below must never be omitted. |
| Read safety | API Contract "API security checks" | Reads are `GET`, free of side effects, schema-typed, size-bounded, and redacted per record policy. |

## 2. Shared shapes

### 2.1 `DepartmentSummary`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable. |
| `slug` | string | Stable, unique. |
| `name` | string | Display name. |

V1 treats departments as flat. `parent_id` (hierarchy) is not requested.

### 2.2 `AgentSummary`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable agent ID. |
| `name` | string | Display name. Bounded length declared in the schema. |
| `slug` | string | Stable, unique. |
| `department` | `DepartmentSummary \| null` | Embedded so no second request is needed. `null` = no department. |
| `lifecycle` | `'draft' \| 'available' \| 'archived'` | **Profile lifecycle only.** See section 2.4 and D-2. |
| `archivedAt` | datetime \| null | Non-null **if and only if** `lifecycle === 'archived'`. The frontend treats a violation as an invalid response. |
| `currentVersion` | `{ versionNo, profession, seniority } \| null` | Summary of the current published version. `null` means no published version exists yet (a `draft` agent). |
| `provenance` | `'owner_created' \| 'demo_seed'` | Lets the UI label seeded demonstration agents conspicuously synthetic, consistent with the mock-run rule in `AGENTS.md`. |
| `createdAt`, `updatedAt` | datetime | UTC. |

### 2.3 `AgentProfileVersion` (immutable snapshot)

| Field | Type | Notes |
|---|---|---|
| `versionId` | string | Stable, opaque version identity. |
| `agentId` | string | Must equal the requested agent. |
| `versionNo` | integer >= 1 | Stable per-agent sequence number; this is what routes use. |
| `profession` | string | Title. |
| `seniority` | string \| null | Backend-defined vocabulary; the frontend displays it as text and does not branch on its value. |
| `specialties` | string[] | Bounded. |
| `personality` | `{ traits: string[], tone: string \| null, principles: string[] }` | **Typed and bounded.** The request is explicitly *not* for free-form `personality_json`. |
| `behavior` | `{ autonomy: string \| null, escalation: string \| null }` | Typed and bounded, following `docs/08-templates/AGENT_PROFILE.example.yaml`. |
| `instructions` | string | Plain text (the stored `instructions_md` source, returned verbatim). Bounded; the bound is declared in the schema. May be empty. See D-3. |
| `createdBy` | `{ id: string, displayName: string }` | Actor who published the version. |
| `createdAt` | datetime | Publication time. |

Immutability guarantee: for a given `(agentId, versionNo)`, every field above is byte-for-byte stable after publication. The frontend relies on this and never caches a snapshot as "current".

Credentials, tokens, runtime bearer keys, and secret references must never appear in any field (`AGENTS.md`; API Contract "Never expose runtime bearer keys...").

### 2.4 Lifecycle versus observed activity

The module spec writes the lifecycle as `draft -> available -> busy|offline|paused -> archived`, and `DATA_MODEL.md` has one `agents.status` column. These mix two different things:

- **Profile lifecycle**: an owner-controlled property of the profile record (`draft`, `available`, `archived`).
- **Observed operational state** (`busy`, `offline`, `paused`): derived from run and runtime-connection state. The module spec requires it to be derived, "not hand-edited fictional 'working'".

**V1 reads expose lifecycle only.** Observed state is out of scope and **must not** be returned in, or inferred into, `lifecycle`. The word `available` here means "published profile that can be referenced", **not** "online" or "reachable". The frontend therefore displays this value as "Published" (a display label only, consistent with the module spec's "publishes immutable version N"; no new lifecycle state is introduced). See D-2 for the naming risk.

### 2.5 Collection metadata (`AgentPage`) and pagination invariants

Applies to the two collection endpoints: `GET /agents` (3.1) and `GET /agents/:agentId/versions` (3.3).

**Terms.** The *logical result set* is every item the collection contains for this request. A *traversal* is the sequence of responses that retrieves it: the first request carries no `cursor`; each continuation carries the `nextCursor` of the previous response. A *page* is one response's items. A response may be the only page.

**Optional request parameters:** `cursor` (opaque; omitted on the first request) and `limit` (the server defines the default and maximum, and may return fewer items than requested; the frontend assumes no page size).

```json
{ "total": 5, "complete": false, "nextCursor": "cur_A" }
```

**All three fields describe the logical result set, never the number of items in one page.**

| Field | Meaning |
|---|---|
| `total` | Number of items in the **entire** logical result set (all pages together). An integer >= 0. |
| `complete` | `true` if and only if **no items remain after this response** in the traversal. It does **not** mean this response's items are the whole set; on the final page of a multi-page traversal it is `true` while the page holds only part of the set. |
| `nextCursor` | Opaque non-empty string if more items remain; `null` otherwise. |

**Invariants.** The backend must satisfy every one of them. The frontend can check only some of them, and only against what it received (a failed check is an "unexpected response", never a partial or optimistic render); the others are backend guarantees that no response can prove. The split is stated in "Who establishes each invariant" below. "Accumulated" means the number of unique items received so far in this traversal, including the current page.

| ID | Invariant |
|---|---|
| PG-1 | Types: `total` is an integer >= 0, `complete` is boolean, `nextCursor` is a non-empty string or `null`. |
| PG-2 | Agreement: `complete === (nextCursor === null)`. |
| PG-3 | A first response (no `cursor` sent) with `complete: true` is the whole set: its item count equals `total`. |
| PG-4 | If `complete` is `false`: `nextCursor` is usable, the page holds at least one item (so every page makes progress), accumulated < `total`, and `nextCursor` differs from the cursor that was just sent. |
| PG-5 | If `complete` is `true`: accumulated equals `total` exactly. |
| PG-6 | Empty set: `total: 0` implies zero items, `complete: true`, `nextCursor: null`, in a single response. |
| PG-7 | Identity and order: item identity (agent `id`; version `versionNo`) is unique across the whole traversal (no duplicates). Order is one stable total order across pages. For versions: `versionNo` strictly descending within and across pages. |
| PG-8 | No skipped items: a continuation resumes immediately after the last item of the previous page in the same order (keyset continuation, not offset). Every item that exists for the whole traversal appears exactly once. Items created during a traversal may be absent from it. |
| PG-9 | Stable total: `total` is identical on every response of one traversal. If the backend cannot hold the set stable (for example a version is published mid-traversal), a changed `total` is how that is reported, and the frontend treats it as "changed while loading". |
| PG-10 | Cursors are opaque: the frontend never constructs, parses, or alters one, and sends it back unchanged (URL-encoded). A cursor is valid only for the same collection and order. A malformed, expired, or foreign cursor is rejected with `422` and the standard error envelope (the existing documented validation status; no new error code). |

**Who establishes each invariant.** "Frontend-checkable" means the property can be tested against the responses the frontend actually received. It never means the frontend can establish what the backend did not send.

| ID | Frontend-checkable (against received responses) | Backend guarantee the frontend cannot prove |
|---|---|---|
| PG-1 | Field types and ranges: fully. | n/a |
| PG-2 | `complete` agrees with `nextCursor`: fully. | n/a |
| PG-3 | A first response with `complete: true` has an item count equal to its own `total`: internal consistency only. | That `total` is correct (BG-3). |
| PG-4 | Observable progress: cursor present, at least one item, accumulated below `total`, cursor differs from the one just sent. | That the cursor really continues the set. This shows up only by using it (BG-1, BG-2). |
| PG-5 | At the end, accumulated equals `total`: a count reconciliation. | That `total` is correct and that no omission is hidden behind a matching `total` (BG-1, BG-3). |
| PG-6 | An empty response has `total: 0`, `complete: true`, and no cursor: internal consistency only. | That the set is truly empty (BG-3). |
| PG-7 | Duplicate identities, and ordering violations **among the items received** (for example `versionNo` not strictly descending). | One stable total order that also covers items never received (BG-4). |
| PG-8 | **Not verifiable.** A skipped record can be noticed only incidentally, when the omission happens to change a count or an order the frontend can see. | **Backend guarantee BG-1.** Needs backend contract or integration coverage. |
| PG-9 | A **change** in `total` between pages of one traversal. | A consistent logical result set across pages (BG-2). A swapped set of the same size is undetectable. |
| PG-10 | The frontend's own behavior (it treats the cursor as opaque and unchanged) and its reaction to a `422`. | Which cursors are valid, and rejecting malformed, expired, or foreign ones. |

**Backend guarantees (not frontend-verifiable).**

| ID | Guarantee |
|---|---|
| BG-1 | **No silently skipped records** across continuation requests (PG-8): every item that exists for the whole traversal is returned exactly once, in keyset order. |
| BG-2 | A **consistent logical result set** across pages, under the backend's documented ordering or snapshot model (the cause behind PG-9). |
| BG-3 | **Correct `total`, `complete`, and `nextCursor`:** they truthfully describe the logical result set, and a continuation cursor continues that same set. |
| BG-4 | A **stable total order** over the whole logical result set, including items not yet received (PG-7), and cursor validity semantics (PG-10). |

**Required backend coverage.** BG-1 to BG-4 must be covered by backend contract or integration tests, reviewed independently of the frontend. At minimum those tests exercise pages of every boundary size, ties on the ordering key, and items created or removed between page requests. Frontend fixture tests cannot stand in for this coverage (frontend spec 14.1.1).

**What the frontend may claim.** It treats a collection as *logically complete* only when every response passed the frontend-checkable properties above (PG-1 to PG-7 and PG-9, and the observable parts of PG-4 and PG-10), the traversal ended with `complete: true`, and accumulated equals `total`. This is a statement that the responses are **mutually consistent**. It does **not** independently prove that the backend dataset is complete: a backend that omitted a record and reported a `total` that matches what it returned would pass every frontend check. Dataset completeness rests on BG-1 to BG-4. Until the frontend-checkable conditions hold it never presents the items as the whole set and always shows how many of `total` it holds. A failed, loading, or invalid response is never rendered as an empty collection: the empty state requires a validated response with `total: 0` (PG-6).

**Frontend reaction to a violation.** Stop the traversal and discard the offending page. For a single-response collection (the V1 directory) render no items. For a multi-page collection (version history) keep earlier pages that passed the checks visible, clearly labeled "Showing N of M" with an error and a Reload action. Never display a violation as complete or as empty.

#### Worked example: version history with 5 versions, three pages

```text
1. GET /api/v1/agents/agt_1/versions
   -> versions: [5, 4]   page: { total: 5, complete: false, nextCursor: "cur_A" }
      accumulated 2 < 5, cursor present                      (PG-4 holds)   UI: "Showing 2 of 5 versions" + Load more
2. GET /api/v1/agents/agt_1/versions?cursor=cur_A
   -> versions: [3, 2]   page: { total: 5, complete: false, nextCursor: "cur_B" }
      accumulated 4 < 5, strictly descending, no duplicates   (PG-4, PG-7)  UI: "Showing 4 of 5 versions"
3. GET /api/v1/agents/agt_1/versions?cursor=cur_B
   -> versions: [1]      page: { total: 5, complete: true,  nextCursor: null }
      accumulated 5 == total, cursor null                     (PG-2, PG-5)  UI: "5 versions", Load more removed
```

The final page reports `complete: true` while holding one of five items: `complete` and `total` describe the logical set, and the frontend checks the accumulated count against `total` (1 + 2 + 2 = 5). That reconciliation is a consistency check; it does not prove the backend returned every record (BG-1).

Single-response example (the V1 directory, 3 agents): `{ "agents": [A, B, C], "page": { "total": 3, "complete": true, "nextCursor": null } }`. Empty directory: `{ "agents": [], "page": { "total": 0, "complete": true, "nextCursor": null } }`.

#### Contradictory or invalid metadata

| Case | Violates | Frontend result |
|---|---|---|
| First response, 2 items, `total: 5`, `complete: true`, `nextCursor: null` | PG-3, PG-5 | Unexpected-response error; no list |
| `complete: false` with `nextCursor: null`, or `complete: true` with a cursor | PG-2 | Unexpected-response error |
| `complete: false`, empty items, cursor present | PG-4 | Stop; unexpected-response error |
| Continuation returns the cursor it was just given | PG-4 | Stop; unexpected-response error |
| Page 2 repeats `versionNo` 4 | PG-7 | Stop; keep checked pages labeled "Showing N of M"; Reload |
| Page 2 is `[2, 3]` (ascending) | PG-7 | Same as above |
| Pages `[5, 4]` then `[2, 1]`, final `complete: true`, `total: 5` (3 skipped; 4 accumulated). Detectable **only because** the omission leaves a count mismatch | PG-5 | Same as above; never labeled complete |
| The backend omits version 3 and reports `total: 4` consistently on every page (pages `[5, 4]`, `[2, 1]`) | BG-1 (PG-8) | **Not detectable by the frontend.** Every frontend check passes. Prevented only by backend guarantee and backend coverage |
| `total` is 5 on page 1 and 6 on page 2 | PG-9 | "History changed while loading" with Reload; never labeled complete |
| `total: 0` with non-empty items, or `total: 3` with `complete: true` and no items | PG-6, PG-5 | Unexpected-response error; not the empty state |
| Continuation answered with `422` (invalid or expired cursor) | PG-10 | Stop; keep checked pages labeled partial; Reload |
| Network error, `429`, or `5xx` on any request | n/a | Error with Retry (same request) or Reload; never complete, never empty |

## 3. Endpoints

### 3.1 `GET /api/v1/agents` - **required**

- **Purpose:** populate the Agent Directory.
- **Response:** `{ "agents": AgentSummary[], "page": AgentPage }`.
- **Includes archived agents.** The frontend hides them by default and offers a "Show archived" toggle. (Alternatively the backend may offer `?includeArchived`; D-4.)
- **Completeness rule (normative):**
  1. The frontend filters and searches client-side **only** when the first response passes the frontend-checkable properties of section 2.5 (PG-1 to PG-7 as they apply to a single response) with `complete: true` and an item count equal to `total`. That the response contains every agent that exists is a backend guarantee (BG-3), not something the frontend can prove.
  2. If the backend cannot guarantee a complete bounded result, it must provide cursor pagination (`cursor`, `limit`, `nextCursor`) **and** backend filtering (`q`, `departmentId`, archived inclusion), and this document and the frontend spec must be amended before implementation.
  3. V1 of the frontend implements only case 1 and fetches a single response. A response with `complete: false` (a continuation exists) is an explicit **incomplete-directory** error state; contradictory metadata is an **unexpected-response** error state. In neither case is a filtered or paged subset presented as the complete directory, and the warning is never suppressed.
  4. The size bound, if any, is a **backend decision** to be justified with evidence (for example the expected size of a single-owner workforce). The frontend does not specify a scale requirement.
- **Ordering:** unspecified; the frontend sorts by `name` then `id` for determinism.
- **Errors:** see section 4.
- **Frontend implication:** one request on entering the directory; all search and filtering is local; an incomplete or contradictory response is a hard, visible failure rather than a silent truncation, and a failed request is never shown as an empty directory (PG-6).

### 3.2 `GET /api/v1/agents/:agentId` - **required**

- **Purpose:** the Agent Profile screen.
- **Response:** `{ "agent": AgentSummary, "currentVersion": AgentProfileVersion | null }`.
- **Guarantees:** `currentVersion` is the same version `agent.currentVersion` summarizes (`versionNo` equal). `currentVersion` is `null` exactly when `agent.currentVersion` is `null`. The frontend treats a mismatch as an invalid response.
- **Frontend implication:** one request renders identity, department, lifecycle, archived context, and the current snapshot. The history list loads independently so its failure does not hide the profile.

### 3.3 `GET /api/v1/agents/:agentId/versions` - **required**

- **Purpose:** version-history navigation.
- **Response:** `{ "agent": AgentSummary, "versions": AgentProfileVersionSummary[], "page": AgentPage }`.
- **`AgentProfileVersionSummary`:** `versionId`, `versionNo`, `profession`, `seniority`, `createdAt`, `createdBy`, `isCurrent` (server-computed; the frontend never infers "current" from the highest number).
- **Ordering:** `versionNo` descending.
- **Pagination:** cursor pagination (`cursor`, `limit`) is acceptable here, because the history needs no client-side filtering and the frontend renders only "Load more" driven by `nextCursor`. The metadata contract and invariants of section 2.5 (PG-1 to PG-10) apply in full; the frontend loads one page at a time and reconciles the accumulated count against `total` before claiming the history is complete.
- **These are summaries by design.** Snapshot bodies (`personality`, `behavior`, `instructions`) are not repeated per list item.

### 3.4 `GET /api/v1/agents/:agentId/versions/:version` - **required for V1** (the brief lists it as optional)

- **Purpose:** the Historical Version screen. Because section 3.3 returns summaries, a separate way to retrieve an **immutable snapshot** is required.
- **Why not optional:** without it the historical screen would have to substitute current profile data for an older version, which the specification forbids ("Historical versions must never be silently replaced with current profile data").
- **Path parameter:** `:version` is the per-agent integer `versionNo` (a positive base-10 integer).
- **Response:** `{ "agent": AgentSummary, "version": AgentProfileVersion, "isCurrent": boolean }`.
- **Guarantees:** `version.agentId === agent.id === :agentId` and `version.versionNo === :version`. The frontend treats any mismatch as an invalid response and shows an error, never a fallback.
- **Not-found behavior (generic by design):** an unknown agent and an unknown version of a known agent both produce the same standard `404` envelope. The backend is **not** required to distinguish them, and the frontend **must not** try to: it branches on the HTTP status only, never on the error `code` or `message` text, and shows one generic "not found" state for this route. This follows the hidden-resource rule already documented in [API Contract](API_CONTRACT.md) and avoids revealing whether an agent exists. No new error codes are requested.
- **If the backend instead returns full snapshots from 3.3:** this endpoint could be dropped, but the list would carry large text fields for every version and the pagination bound would then need to account for payload size. Summaries plus a snapshot endpoint is the recommended design.

### 3.5 `GET /api/v1/departments` - **optional, not required for V1**

- Department data is embedded in `AgentSummary`, so V1 needs no separate request.
- Trade-off: the directory's department filter lists only departments that have at least one agent in the loaded result. Empty departments are absent from the filter. This is acceptable for V1 because filtering an agent list by an empty department can only produce no matches.
- A `GET /departments` endpoint becomes necessary when department management, hierarchy, or empty-department display is scoped.

## 4. Error behavior

The frontend maps each case as follows. Codes below are requested behavior, not existing behavior.

| Status | Meaning | Required backend behavior | Frontend behavior |
|---|---|---|---|
| 200 | Success | Body matches the schema | Render; any schema or invariant violation is an "unexpected response" error, never a partial render |
| 401 | No owner session | Standard envelope | Existing session-expiry flow (clear owner UI, show sign-in). No agent data remains on screen. |
| 403 | Authenticated but not permitted | Standard envelope; **must not** end the session | "You don't have access to this" state; the session stays valid and other routes keep working |
| 404 | Resource not found. On `/agents/:id` the agent; on `/agents/:id/versions/:version` the agent **or** the version, deliberately indistinguishable | Standard envelope; hidden-resource rule applies; one generic response for every not-found cause | Profile route: "Agent not found". Version route: a **generic** resource-not-found state that does not name or infer the missing resource (frontend spec 5.3) |
| 422 | Syntactically invalid path parameter, or an invalid/expired/foreign `cursor` (PG-10) | Standard envelope | Path parameter: treated as an invalid link (the frontend validates grammar first and should not normally send such a request). Cursor: stop the traversal, keep checked pages labeled partial, offer Reload |
| 429 | Rate/limit | Standard envelope | Non-looping error with manual Retry |
| 5xx / network | Service unavailable | Standard envelope where possible | Error state with Retry; no stale data presented as current |

The frontend sends no `POST`, `PATCH`, or `DELETE` for this feature and uses no idempotency keys or CSRF tokens (reads only).

## 5. Data completeness guarantees requested

1. `GET /agents` is logically complete in a single response (section 2.5: `complete: true`, item count equals `total`) or the contract is amended (section 3.1).
   Collection metadata obeys PG-1 to PG-10 in every response of both collection endpoints.
   The backend guarantees BG-1 to BG-4 (section 2.5), including that no records are silently skipped (PG-8), and covers them with backend contract or integration tests. The frontend can check consistency but cannot prove them.
2. A snapshot for `(agentId, versionNo)` never changes after publication.
3. `isCurrent` and `currentVersion` are computed by the server and mutually consistent in every response.
4. Embedded `agent` objects are consistent within a single response (one read, one consistent view).
5. `lifecycle`/`archivedAt` invariants in 2.2 hold in every response.
6. `lifecycle` never carries observed operational state.

## 6. Fields requiring backend validation or authorization

All of them. The frontend validates response shapes for safety but is **not** an authority. In particular the backend must:

- authorize every read as the owner before and after lookup;
- enforce text bounds and strip or reject credentials and secret-looking content at write time (the read slice assumes this is already true);
- own the vocabulary for `lifecycle`, `seniority`, and `provenance`;
- own immutability and numbering of `versionNo`;
- guarantee that `provenance: 'demo_seed'` is set for any seeded agent.

## 7. Explicitly not requested

Create/edit/archive/delete, draft-editing routes, runtime connections or bindings, runtime availability, active tasks or runs per agent, tool or skill grants, memory, teams, projects, usage, and any `Idempotency-Key` handling. Each requires its own approved scope and contract.

## 8. Open decisions for the backend owner and owner

| ID | Decision |
|---|---|
| D-1 | `API_CONTRACT.md` examples use `snake_case`; implemented contracts use `camelCase`. Confirm `camelCase` for the agent slice, and decide whether to correct the examples in `API_CONTRACT.md` separately. |
| D-2 | `available` in the lifecycle reads like observed availability. The frontend already shows it as "Published"; the backend may keep `available` or rename it (for example `published`), and only the frontend label map changes. Also confirm how `DATA_MODEL.md`'s single `agents.status` column maps to lifecycle versus derived operational state. |
| D-3 | Whether `instructions` is returned in V1 reads. The frontend can render a snapshot without it, but then a historical view is not a complete snapshot of the configuration. |
| D-4 | Whether archived agents are included by default or by `?includeArchived`. Either satisfies the frontend as long as the toggle's behavior is truthful. |
| D-5 | The size bound (or pagination plan) for `GET /agents`, with justification; and, for `GET /agents/:id/versions`, whether the backend holds `total` stable during a traversal (PG-9) or reports changes by changing `total`. |
| D-6 | How agents first come to exist before create/edit is implemented. The frontend will not seed or fabricate them; an empty directory is the correct, honest result until a backend path exists. |

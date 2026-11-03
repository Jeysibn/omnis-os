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

**V1 reads expose lifecycle only.** Observed state is out of scope and **must not** be returned in, or inferred into, `lifecycle`. The word `available` here means "published profile that can be referenced", **not** "online" or "reachable". See D-2 for the naming risk.

### 2.5 Page metadata (`AgentPage`)

```json
{ "total": 0, "complete": true, "nextCursor": null }
```

| Field | Meaning |
|---|---|
| `total` | Number of records in the full result set, independent of this response. |
| `complete` | `true` only if the response contains **every** record of the result set. |
| `nextCursor` | Opaque cursor for the next page, or `null` when none. |

## 3. Endpoints

### 3.1 `GET /api/v1/agents` - **required**

- **Purpose:** populate the Agent Directory.
- **Response:** `{ "agents": AgentSummary[], "page": AgentPage }`.
- **Includes archived agents.** The frontend hides them by default and offers a "Show archived" toggle. (Alternatively the backend may offer `?includeArchived`; D-4.)
- **Completeness rule (normative):**
  1. The frontend filters and searches client-side **only** when `page.complete === true`.
  2. If the backend cannot guarantee a complete bounded result, it must provide cursor pagination (`cursor`, `limit`, `nextCursor`) **and** backend filtering (`q`, `departmentId`, archived inclusion), and this document and the frontend spec must be amended before implementation.
  3. V1 of the frontend implements only case 1. If a response arrives with `complete: false`, the UI shows an explicit "directory is incomplete" error state. It **never** presents a filtered or paged subset as the complete directory, and never disables the warning.
  4. The size bound, if any, is a **backend decision** to be justified with evidence (for example the expected size of a single-owner workforce). The frontend does not specify a scale requirement.
- **Ordering:** unspecified; the frontend sorts by `name` then `id` for determinism.
- **Errors:** see section 4.
- **Frontend implication:** one request on entering the directory; all search and filtering is local; a `complete: false` response is a hard, visible failure rather than a silent truncation.

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
- **Pagination:** cursor pagination (`cursor`, `limit`) is acceptable here, because the history needs no client-side filtering and the frontend renders only "Load more" driven by `nextCursor`. `page.complete` and `total` must still be truthful so the UI can say "Showing N of M versions".
- **These are summaries by design.** Snapshot bodies (`personality`, `behavior`, `instructions`) are not repeated per list item.

### 3.4 `GET /api/v1/agents/:agentId/versions/:version` - **required for V1** (the brief lists it as optional)

- **Purpose:** the Historical Version screen. Because section 3.3 returns summaries, a separate way to retrieve an **immutable snapshot** is required.
- **Why not optional:** without it the historical screen would have to substitute current profile data for an older version, which the specification forbids ("Historical versions must never be silently replaced with current profile data").
- **Path parameter:** `:version` is the per-agent integer `versionNo` (a positive base-10 integer).
- **Response:** `{ "agent": AgentSummary, "version": AgentProfileVersion, "isCurrent": boolean }`.
- **Guarantees:** `version.agentId === agent.id === :agentId` and `version.versionNo === :version`. The frontend treats any mismatch as an invalid response and shows an error, never a fallback.
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
| 404 | Unknown agent or version | Standard envelope; hidden-resource rule applies | "Agent not found" / "Version not found" state with recovery link |
| 422 | Syntactically invalid path parameter | Standard envelope | Treated as an invalid link (the frontend already validates grammar and should not normally send such a request) |
| 429 | Rate/limit | Standard envelope | Non-looping error with manual Retry |
| 5xx / network | Service unavailable | Standard envelope where possible | Error state with Retry; no stale data presented as current |

The frontend sends no `POST`, `PATCH`, or `DELETE` for this feature and uses no idempotency keys or CSRF tokens (reads only).

## 5. Data completeness guarantees requested

1. `GET /agents` is complete (`page.complete === true`) or the contract is amended (section 3.1).
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
| D-2 | `available` in the lifecycle reads like observed availability. Consider a name such as `published`, or keep it with the explicit UI wording in the frontend spec. Also confirm how `DATA_MODEL.md`'s single `agents.status` column maps to lifecycle versus derived operational state. |
| D-3 | Whether `instructions` is returned in V1 reads. The frontend can render a snapshot without it, but then a historical view is not a complete snapshot of the configuration. |
| D-4 | Whether archived agents are included by default or by `?includeArchived`. Either satisfies the frontend as long as the toggle's behavior is truthful. |
| D-5 | The size bound (or pagination plan) for `GET /agents`, with justification. |
| D-6 | How agents first come to exist before create/edit is implemented. The frontend will not seed or fabricate them; an empty directory is the correct, honest result until a backend path exists. |

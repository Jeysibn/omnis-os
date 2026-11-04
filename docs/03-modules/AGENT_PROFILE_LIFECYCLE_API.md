# Agent Profile Lifecycle API V1 (backend contract)

This owner-only API adds draft identity and immutable profile publication to the existing Agent Profiles read API. Canonical schemas live in `packages/contracts/src/index.ts`. It does not enable agent execution, provider integrations, tools, or runtime permissions.

All routes require the existing owner session. Mutations additionally require the session-bound CSRF header and a UUID `Idempotency-Key`. Responses use the standard `{ error: { code, message } }` envelope. Profile validation is heuristic for credential-like content and does not guarantee secret detection.

## Routes

| Method and route | Success | Contract |
|---|---:|---|
| `POST /api/v1/agents` | 201 | `CreateAgentInputSchema` → `AgentMutationReceiptSchema`; creates a draft identity. |
| `GET /api/v1/agents/:agentId/draft-profile` | 200 | `AgentProfileDraftResponseSchema`; returns the persistent draft revision even when no draft profile is saved. |
| `PUT /api/v1/agents/:agentId/draft-profile` | 200 | `SaveAgentProfileDraftInputSchema` → `AgentMutationReceiptSchema`; requires the expected draft revision and base published version. |
| `POST /api/v1/agents/:agentId/publish` | 201 | `PublishAgentProfileInputSchema` → `AgentMutationReceiptSchema`; publishes the exact saved draft as the next immutable version. |
| `POST /api/v1/agents/:agentId/archive` | 200 | Empty body → `AgentMutationReceiptSchema`; archives a published agent and retains history. |

Agent IDs and historical profile reads continue to use the existing contracts and four GET routes. Draft revisions are monotonic across publication, so a consumed draft does not reset the optimistic concurrency token. Stale draft saves and publications return 409. A draft identity cannot be archived before its initial publication; departments must exist and be active when assigned.

Idempotency fingerprints use an authorizer-only 256-bit key and a versioned domain-separated HMAC. The database retains only the request UUID, operation/target, fingerprint, key version, and minimal mutation receipt; it never stores a plain hash or profile body in the idempotency ledger. Changing the key invalidates prior retry fingerprints, which fail closed with 409. Retain the current key version through in-flight retry windows and increment its version when rotating.

`omnis_runtime` remains SELECT-only. The authorizer has no direct access to agent identities, draft rows, or profile versions; it can invoke only the constrained lifecycle functions. Mutations and metadata-only audit records commit atomically. The independently deployed runtime, real providers, and multi-user access remain out of scope.

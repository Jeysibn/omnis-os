# AO-104 Department Management and Profile Write Prerequisites

## Scope

This backend increment adds owner-managed departments and bounded profile-input validation prerequisites. It does not add agent creation, profile publication, profile edits, or agent lifecycle APIs. Runtime execution, real providers, and multi-user authorization remain disabled.

## API contract

Canonical Zod request and response schemas are in `packages/contracts`.

| Method and path | Contract |
|---|---|
| `GET /api/v1/departments?includeArchived=true\|false` | Returns a complete `{ departments, total }` response. Defaults to active departments. Fails closed if the 500-record bound is exceeded. |
| `POST /api/v1/departments` | Accepts `{ slug, name }`; creates a department and returns its stable ID and UTC timestamps. |
| `PATCH /api/v1/departments/:departmentId` | Accepts the full `{ slug, name }` pair. Archived departments cannot be renamed. |
| `POST /api/v1/departments/:departmentId/archive` | One-way archive for an unreferenced department. Hard delete and unarchive are not exposed. |

Mutations require the existing owner session, same-origin check, and session-bound CSRF token. The API forwards fixed department operations over the existing authorizer Unix socket. The authorizer independently validates every request.

Malformed requests return 422; missing owner authentication returns 401; invalid origin or CSRF returns 403; duplicate slugs and invalid lifecycle transitions return 409; missing IDs return 404. Uncertain transport outcomes return a generic 503 and direct the owner to read state before retrying.

## Database authority and integrity

- `omnis_runtime` remains `SELECT` only on department, agent, and profile tables. It has no department audit access.
- The existing `omnis_authorizer` process is the department write boundary. Its DB grants are limited to department `SELECT`, column-scoped department insert/update, metadata-only audit inserts, and execution of `omnis.archive_department(text,text)`.
- The authorizer receives no read or write grant on agent/profile tables. The archive routine is `SECURITY DEFINER`, fixes `search_path`, checks `session_user`, locks the department, checks references, archives, and appends the audit record atomically.
- An agent department trigger locks the target department `FOR SHARE` and rejects assignments to archived departments. The archive path takes a conflicting row lock and rejects referenced departments, preventing concurrent archive/assignment races.
- Department rows are archive-only. The existing hard-delete rejection and FK `ON DELETE RESTRICT` remain. Archived rows are immutable.
- Audit records contain only actor, action, department ID, request ID, and timestamp. They are append-only; no request body or profile text is stored.
- Restore ACL reconstruction and policy tests include the exact grants and definer routine.

## Issue #18 validation prerequisite

`AgentProfileWriteInputSchema` validates every profile field and preserves the existing 16,384-character instructions cap. `validateAgentProfileWriteInput` runs schema bounds before recursive credential scanning and escape normalization. A synthetic near-limit backslash-heavy fixture was processed in approximately 1.3 ms in the local test run. The normalizer uses a fixed number of passes and the scanner uses a fixed pattern set against bounded fields. This is a bounded-input mitigation and performance check, not a formal guarantee of secret detection or a complete secret scanner.

No profile write route calls this validator yet; profile writes remain disabled pending a separate reviewed increment. Department name and slug inputs are also checked with the same heuristic scanner before database work.

## Verification

Base: `a5a29325d8bb3187c1601b82e799ca54b2810d37`.

Local formatting, lint, serialized workspace typecheck/build, API, authorizer, contracts, database unit, and database-recovery policy checks passed. The test suites cover owner/CSRF handling, request schemas, department audit events, archive and assignment rules, least-privilege grants, nested credential-like values, and the 16 KiB input bound.

Local PostgreSQL integration, backup/restore execution, Docker sandbox verification, and disposable systemd verification were not run: Docker socket access was denied and a local PostgreSQL client was unavailable. Exact PR CI results will be recorded after the Draft PR run completes. A skipped local PostgreSQL suite is not counted as a pass.

### PR #17 post-merge CI gap

The current workflow declares a `push` trigger for `main`. PR #17 was merged by the repository owner at `2026-11-04T10:48:03Z` into `a5a29325d8bb3187c1601b82e799ca54b2810d37`; the merge message has no skip-CI marker. The latest recorded `main` push run is `41810067808` on the prior base `af2d7cab4d43537ddff9eddb1dd86a8e8ad56a26`, created at `09:48:57Z`, and the Actions run history contains no run for the PR #17 squash SHA. The repository evidence does not expose why GitHub did not dispatch or retain that push run. This is an unverified post-merge event gap, not evidence of a source failure. The PR's successful exact-head CI remains the last validation of PR #17; this development branch is being validated by its own exact-head CI.

## Frontend coordination

The contract summary was sent to the PR #13 frontend specification thread before integration: https://github.com/Jeysibn/omnis-os/pull/13#issuecomment-6629512633. No `apps/web` files or frontend-owned worktrees were changed.

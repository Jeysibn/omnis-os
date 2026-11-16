# Omnis OS Frontend — Phase 1 Restricted-Mode Acceptance Record

Status: **frontend locally verified for the restricted, execution-disabled profile.**
Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**. This record does not report the full mock-agent
owner journey as operational: it is gated, and a passing disabled-mode UI does not change that.

Scope: `apps/web` only. No backend, Docker, database, provider or infrastructure change.
The OMNIS NEXUS V2 specification was absent from the reviewed commit; only
`docs/04-design/UI_UX_SPEC.md` and the existing frontend conventions were used.

## 1. Session-lifecycle design

`sessionScope.ts` holds a synchronously bumped generation counter (`rotateSession` on boot,
sign-in, sign-out and expiry). Every asynchronous operation captures the generation when it is
dispatched and re-checks it before **every** side effect: success, failure and `finally`.

Rules applied everywhere:

1. A response for a replaced session changes nothing: no data, error, loading or busy state.
2. A stale 401 never expires, and a stale success never authorizes, the replacement session.
3. A session end releases the flags it owned itself (`busy`, loading flags, in-flight guards),
   because the old operations' guarded `finally` blocks no longer will.
4. Child results reach parent state only through `bindToSession`, so a closure from an old
   session cannot push data into the new one (defence in depth with the child's own check).

## 2. Authenticated request coverage matrix

| Request / path                           | Session captured at     | Stale success                    | Stale failure / 401           | Cleanup guarded         | Regression test                                    |
| ---------------------------------------- | ----------------------- | -------------------------------- | ----------------------------- | ----------------------- | -------------------------------------------------- |
| `GET /me` (boot)                         | boot (once, StrictMode) | ignored                          | ignored                       | yes                     | StrictMode boot test; see note A                   |
| `GET /me` (sign-in)                      | after login rotation    | ignored                          | ignored                       | yes                     | sign-in tests; see note A                          |
| `GET /auth/csrf`                         | dispatch                | token not stored                 | no error state, no clear      | yes                     | see note A                                         |
| `POST /auth/login`                       | dispatch                | n/a                              | shown only if live            | yes                     | login / expiry tests                               |
| `POST /auth/logout`                      | dispatch                | cannot clear replacement         | cannot expire replacement     | yes                     | stale logout (ok, 401)                             |
| `GET /tasks`, `/runs`, `/projects`       | dispatch                | not applied                      | cannot expire replacement     | yes                     | stale Tasks / Runs / Projects tests                |
| quiet task refresh, 409 refresh          | dispatch (+ sequence)   | not applied                      | cannot expire replacement     | yes                     | refresh-held-across-session test                   |
| `GET /runs/:id` (reconcile, probe)       | dispatch / abort signal | not applied                      | cannot expire replacement     | yes                     | stream-session and reconcile tests                 |
| `POST /tasks`                            | dispatch                | not applied                      | not shown                     | yes                     | old-operation busy-state test                      |
| `POST synthetic-runs`                    | dispatch                | not admitted into new session    | not shown                     | yes                     | stale synthetic Run test                           |
| `PUT execution-assignment`               | dispatch                | not applied                      | not shown                     | yes                     | stale assignment test                              |
| `GET runtime-capabilities`               | per request + session   | superseded result fails closed   | cannot expire replacement     | yes                     | capability ordering tests (A–E)                    |
| Run SSE messages / `onerror`             | stream open             | ignored                          | ignored                       | n/a                     | stream revocation / reconnect tests; see note B    |
| Stop, approve, revoke, accept            | dispatch                | not applied                      | not shown                     | yes                     | revoke: stale-revoke test; others existing tests   |
| Agents / Departments / Projects pages    | n/a (unmount + abort)   | writes only to unmounted state   | `sessionBoundExpire` is inert | n/a                     | existing page specs; see note C                    |
| `AcceptResultAction` (accept result)     | generation at submit    | not applied                      | cannot expire replacement     | yes                     | accept-result stale-session tests                  |

Note A — `/me` and CSRF staleness are guarded in code but **cannot be driven through the UI**:
the sign-in control is disabled while CSRF loads and sign-out is unreachable while sign-in is in
flight, so no second session can start while those requests are pending. They are therefore not
covered by a UI regression test and should not be read as one.

Note B — the SSE session guards (message, `onopen`, `onerror`, and the recovery `recreate` and
`onExhausted` callbacks) have no dedicated test: a callback delivered in the instant between session
rotation and the stream's teardown cannot be forced deterministically. The same applies to the
connector authorization lookup that returns 404 for a replaced session (the follow-up create is
guarded): session 2 legitimately re-recovers the same stored operation, so a stale POST cannot be
told apart from it. Both were found by independent review of 0d8b81b and are guarded but untested.
Independent review of cb12deb found two more: the stream recovery probe now carries the stream's own
session scope (a retry timer firing after rotation no longer probes under the replacement; guarded,
untested for the same timing reason), and the connector revoke hook is session-scoped (covered by
`a late revoke success from a replaced session cannot clear the replacement operation`, verified to
fail with the guard removed).
The existing revocation and reconnect tests continue to pass.

Note C — these pages push no results into App state; their requests abort on unmount, and their
only App-level hook is `sessionBoundExpire`. A stale page calling the shared `refreshCsrf` late would
fetch the live session's own token, which is harmless. Reviewed by reading, not by a dedicated test.

Backend dependency for Codex #1: none found. The frontend assumes only that a replaced session's
cookie is rejected with 401 and that mutations remain idempotent under the documented keys.

## 3. Verified restricted-mode behaviour (local, mocked API)

- Owner login, protected routes, CSRF refresh after 401, sign-out and re-sign-in.
- Capability contract `omnis.runtime-capabilities.v3` drives an explicit gate: loading, load
  failed, disabled, worker unavailable, authorizer unavailable, mode mismatch, mock-ready.
  Loading and error states fail closed; Run and approval controls are disabled with a reason.
- Execution-disabled copy states that nothing is simulated, queued or approved.
- Only the Tasks page requests capabilities.
- Historical Tasks and Runs keep their recorded statuses; an `in_review` task is not "Completed".
- SSE: Last-Event-ID resume, replay de-duplication, ordering, bounded retry, revoked-session
  recovery, terminal reconciliation.
- Responsive containment and keyboard / axe coverage across the shell, approval dialog, banner
  and review panel.

## 4. Not verified here (unexecuted)

- Any live backend, Docker, database or provider integration: `test:e2e:integration`,
  `integration:*` scripts, compose smoke. These require services this milestone is not
  authorized to start.
- Repository-wide `pnpm check` and the root workspace test scripts: `pnpm` is not installed in
  this environment. Equivalent lint, format and type checks were run directly; see the PR for
  exact counts.
- The full mock-agent owner journey (gated).
- The OMNIS NEXUS V2 specification (not present in the reviewed commit).

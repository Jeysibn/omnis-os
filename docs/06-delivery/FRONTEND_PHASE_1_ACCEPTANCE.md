# Omnis OS Frontend — Phase 1 Restricted-Mode Acceptance Record

Status: **frontend locally verified for the restricted, execution-disabled profile.**
Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**. This record does not report the full mock-agent
owner journey as operational: it is gated, and a passing disabled-mode UI does not change that.

Scope: `apps/web` only. No backend, Docker, database, provider or infrastructure change.
The OMNIS NEXUS V2 specification was absent from the reviewed commit; only
`docs/04-design/UI_UX_SPEC.md` and the existing frontend conventions were used.

## 1. Session-lifecycle design

`sessionScope.ts` holds a synchronously bumped generation counter (`rotateSession` on boot,
sign-in, sign-out and expiry). Owner-session operations that send requests, write shared state,
write storage, change the URL hash or call parent callbacks capture the generation (directly, or via
the session context or `useMountedInSession`) when dispatched and re-check it before every such
side effect: success, failure and `finally`. The deliberate exception is the set of abort-only read
effects (see "Abort-only read effects" below), which rely on an abort signal or a local `active`
flag and can only write state into a component instance that is being unmounted.

Rules applied everywhere:

1. A response for a replaced session changes nothing the replacement session can observe and no
   shared state: no data, error, loading or busy state. The one exception is the abort-only read
   effects (below), which may still write local state into a component instance that is being
   unmounted.
2. A stale 401 never expires, and a stale success never authorizes, the replacement session.
3. A session end releases the flags it owned itself (`busy`, loading flags, in-flight guards),
   because the old operations' guarded `finally` blocks no longer will.
4. Child results reach parent state only through `bindToSession`, so a closure from an old
   session cannot push data into the new one (defence in depth with the child's own check).

## 2. Authenticated request coverage matrix

| Request / path                       | Session captured at                | Stale success                  | Stale failure / 401        | Cleanup guarded | Regression test                                                                                                                       |
| ------------------------------------ | ---------------------------------- | ------------------------------ | -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me` (boot)                     | boot (once, StrictMode)            | ignored                        | ignored                    | yes             | StrictMode boot test; held-`/me` boot tests (invariant); see note A                                                                   |
| `GET /me` (sign-in)                  | after login rotation               | ignored                        | ignored                    | yes             | a stale Tasks 401 released while the replacement `/me` is pending (guard-proving); no stale `/me` response is delivered; see note A   |
| `GET /auth/csrf`                     | dispatch                           | token not stored               | no error state, no clear   | yes             | a stale Tasks 401 released while the replacement CSRF refresh is pending (invariant); no stale CSRF response is delivered; see note A |
| `POST /auth/login`                   | dispatch                           | n/a                            | shown only if live         | yes             | login / expiry tests                                                                                                                  |
| `POST /auth/logout`                  | dispatch                           | cannot clear replacement       | cannot expire replacement  | yes             | stale logout (ok, 401)                                                                                                                |
| `GET /tasks`, `/runs`, `/projects`   | dispatch                           | not applied                    | cannot expire replacement  | yes             | stale Tasks / Runs / Projects tests                                                                                                   |
| quiet task refresh, 409 refresh      | dispatch (+ sequence)              | not applied                    | cannot expire replacement  | yes             | refresh-held-across-session test                                                                                                      |
| `GET /runs/:id` (reconcile, probe)   | dispatch / abort signal            | not applied                    | cannot expire replacement  | yes             | stream-session and reconcile tests                                                                                                    |
| `POST /tasks`                        | dispatch                           | not applied                    | not shown                  | yes             | old-operation busy-state test                                                                                                         |
| `POST synthetic-runs`                | dispatch                           | not admitted into new session  | not shown                  | yes             | stale synthetic Run test                                                                                                              |
| `PUT execution-assignment`           | dispatch                           | not applied                    | not shown                  | yes             | stale assignment test                                                                                                                 |
| `GET runtime-capabilities`           | per request + session              | superseded result fails closed | cannot expire replacement  | yes             | capability ordering tests (A–E)                                                                                                       |
| Run SSE messages / `onerror`         | stream open                        | ignored                        | ignored                    | n/a             | stream revocation / reconnect tests; held-events and probe tests (invariant); see note B                                              |
| Stop, approve, revoke, accept        | dispatch                           | not applied                    | not shown                  | yes             | revoke: stale-revoke test; others existing tests                                                                                      |
| Agent create / archive               | dispatch (context)                 | not applied, storage kept      | not applied                | n/a             | stale-create and late-archive tests (guard-proving)                                                                                   |
| Planning writers (`useWriter`)       | dispatch (context)                 | distinct `stale` outcome       | same, no CSRF refresh      | n/a             | guarded, untested; see note C                                                                                                         |
| Departments / Projects forms         | `useMountedInSession` + bound CSRF | gated by mounted-in-session    | `sessionBoundExpire` inert | n/a             | project create: invariant test; department writes untested; see note C                                                                |
| `AcceptResultAction` (accept result) | generation at submit               | not applied                    | cannot expire replacement  | yes             | accept-result stale-session tests                                                                                                     |

Note A — the in-code `/me` and CSRF staleness guards still **cannot be driven through the UI**: the
sign-in control is disabled while CSRF loads and sign-out is unreachable while sign-in is in flight,
so no second session can start while those requests are pending. What IS reachable is now tested
(see "Guard evidence" below): a held boot `/me` ending in 401 or success with a single bootstrap
(StrictMode), a stale 401 arriving while the replacement sign-in's `/me` is pending, and a stale 401
arriving while the replacement CSRF refresh is pending.

Note B — the SSE session guards (message, `onopen`, `onerror`, the recovery `recreate` and
`onExhausted` callbacks, and the probe's stream scope) protect the instant between session rotation
and the stream's teardown, which cannot be forced deterministically. Teardown also closes the old
EventSource, so end-to-end tests pass with or without those individual checks. They are covered only
by invariant tests (see below), not by tests proven to fail when the guard is removed.

Note C — correction history. An earlier version of this record said the Agents, Departments and
Projects pages needed no session guard because they unmount and abort. Independent review (five
rounds on this branch) showed that "unmount" is not a synchronous session gate: React's cleanup runs
after the session generation has rotated, and a continuation can run in between or can touch shared
`sessionStorage`, the URL hash, a parent callback or a follow-up request. Final design:

- `SessionScopeContext` / `useBeginSession` (sessionContext.ts): nested writers capture the owner
  session at dispatch and check it after every await.
- `useMountedInSession`: replaces the plain `mounted` ref in `ProjectForm`, `ProjectDetail`,
  `DepartmentsWorkspace` and the planning `useWriter`. It is true only while mounted AND the session
  the component mounted under is still live, so every existing `mounted.current` gate is now also a
  synchronous session gate.
- `useWriter` returns a distinct `stale` outcome for a replaced session. Every caller (the two
  `RecordEditor` paths, `ArchiveDialog`, `TaskEpicDialog`) does nothing for it. It never retires the
  idempotency key (the key is retired only after the CSRF refresh and a live check) and never
  refreshes CSRF for a replaced session. An earlier revision reused `unauthorized`, which let a
  first-attempt epic or milestone create clear its persisted pending record.
- Scoped at dispatch: `AgentCreateForm`, `AgentArchiveAction`, `AgentProfileEditor`,
  `AgentIdentityEditor`, the revoke hook, and the `inspect` / `explainInvalidTransition` /
  `checkCreate` read-backs in `RecordEditor`, `ArchiveDialog` and `TaskEpicDialog`.
- The `refreshCsrf` given to Departments and Projects rejects for a replaced session.

- Deliberately NOT session-scoped: read effects that use an abort signal or a local `active` flag
  (agent directory, history and draft reads, department list and choices, project reads and task
  lists, planning paged lists, the assignment editor's agent list, synthetic audit history). Between
  session rotation and React's cleanup of the old tree they can still write state into that retiring
  component instance. A replacement session gets fresh instances, so nothing observable reaches it,
  and these reads send no request, touch no storage or hash and call no parent callback (a stale 401
  may reach the old session-bound expiry handler, which is inert after rotation). This is a
  recorded decision, not an oversight; it was raised by independent review (finding 2 of 451e50d)
  and answered on consequences. If the owner wants a purely mechanical guard there, it is a
  contained follow-up.
- A stale runtime-capabilities check no longer re-reads on its own; the hook's effect re-reads when
  the owner changes. The project form and project detail 403 paths re-check the session after the
  CSRF refresh before writing a notice.

Regression tests whose guard was removed to confirm the test fails (**guard-proving**): stale Run,
stale assignment, busy-flag release, late revoke success, late agent create, late agent archive,
a 404 authorization lookup for a replaced session (no follow-up create), and a stale Tasks 401 during the replacement sign-in.
Everything else listed in this note is guarded in code but not separately guard-proven. Part of it
has invariant tests only (held boot `/me`, CSRF timing, SSE, recovery probes, stale Agents and
Departments reads, late project create; see the table above). The rest has no session-replacement
test at all, because the needed flows have no session-replacement mock (planning writers, department
writes, profile and identity editors) and the timing windows cannot be forced deterministically.

Backend dependency for Codex #1: none found. The frontend assumes only that a replaced session's
cookie is rejected with 401 and that mutations remain idempotent under the documented keys.

### Guard evidence added in the regression-hardening milestone

| Test (App.spec.ts, `session guards: …`)         | What it pins                                                                             | Guard-proving?                                                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| boot: held `/me` then 401                       | no sign-in/error while pending, clean sign-in after, one bootstrap read                  | invariant                                                                                                                                                                                                    |
| boot: held `/me` then success                   | owner restored once                                                                      | invariant                                                                                                                                                                                                    |
| stale 401 while replacement `/me` pending       | a stale Tasks 401 cannot derail the replacement sign-in                                  | **yes** (remove the Tasks-load session check)                                                                                                                                                                |
| stale 401 while replacement CSRF pending        | CSRF and sign-in stay intact                                                             | invariant                                                                                                                                                                                                    |
| 404 authorization lookup for a replaced session | no follow-up create is sent (session 2 is a different owner, so a create is session 1's) | **yes** (remove the 404-branch check)                                                                                                                                                                        |
| late agent archive                              | shared pending archive key is not cleared                                                | **yes**                                                                                                                                                                                                      |
| late project create                             | the replacement session is not navigated                                                 | invariant for the session check: removing the whole `useMountedInSession` getter fails it, but the old form is already unmounted when the response lands, so it does not isolate the session-generation half |
| stale Agents / Departments read 401             | cannot expire the replacement session                                                    | invariant: the read is already aborted on unmount, so the session-bound expiry wrapper is redundant here                                                                                                     |
| SSE events held across replacement              | none enter the replacement session; its own stream still delivers                        | invariant                                                                                                                                                                                                    |
| recovery probe in flight across replacement     | cannot expire or change the replacement                                                  | invariant                                                                                                                                                                                                    |

Abort-only read effects (reviewed in this milestone): the agents and departments reads are aborted
on unmount, so an aborted request never reaches the expiry handler; the projects read has an
existing stale-401 test; the assignment editor's agent list checks an `active` flag. No path was
found that expires a replacement session, changes shared busy or loading flags, or sends a
follow-up request, so no production change was made.

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

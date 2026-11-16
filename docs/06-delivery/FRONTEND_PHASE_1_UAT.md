# Frontend Phase 1 — Restricted-Mode UAT, Mock-Journey UAT and Readiness Matrix

**Status:** Source and test audit only. **Phase 1 R1 remains BLOCKED / NOT ACCEPTED.** Nothing in
this document was executed on the target WSL2 host, and nothing here authorizes starting Docker,
enabling mock execution, contacting a provider, or deploying.

**Baseline audited:** `main` at `5f8094cb07c2300d9d1d820e07ffee265ca18728` (PR #125) plus the fix in
section 5 of this change. Companion records: `FRONTEND_PHASE_1_ACCEPTANCE.md` (session-security
evidence), `RESTRICTED_WSL2_RUNTIME_READINESS.md` (target-host plan),
`PHASE_1_COMPLETION_MATRIX.md` (AO-101–AO-113), `PHASE1_BACKEND_FRONTEND_HANDOFF.md` (API contract).

## 1. How to read this document

Evidence levels used below:

- **L** — frontend Playwright against a contract-validated mock API (`apps/web/src/ui/*.spec.ts`).
  Runs locally and in the PR `frontend-browser` job. Proves UI behaviour for the contract the mock
  implements; does not prove the real backend behaves that way.
- **H** — hosted CI disposable integration (`apps/web/integration/tasks.integration.spec.ts`,
  added by PR #124). Real API/Worker/PostgreSQL in disposable CI. Not the restricted profile, not WSL2.
- **T** — target WSL2 browser acceptance. **Not executed for any item in this document.**

Readiness statuses: `IMPLEMENTED AND TESTED` (covered by L, and by H where applicable),
`IMPLEMENTED, RUNTIME UNVERIFIED` (depends on real backend/Authorizer behaviour not covered by L or
H), `SOURCE FIX REQUIRED`, `BLOCKED BY BACKEND`, `BLOCKED BY PLATFORM`,
`OWNER AUTHORIZATION REQUIRED`.

## 2. Restricted-mode UAT checklist (execution-disabled, Authorizer-free)

**Preconditions.** Run only after the owner separately authorizes the target operation described in
`RESTRICTED_WSL2_RUNTIME_READINESS.md`. Use only the web UI at the loopback origin plus read-only
browser devtools. Do not enable mock execution, do not supply provider credentials, do not run
Compose from this checklist. Record UTC and Asia/Manila time with each result.

### U1 — Owner login and logout

- **Expected:** the sign-in form is disabled while the CSRF token loads; a correct owner password
  signs in; sign-out returns to sign-in and clears Tasks, Runs, Projects and events from the screen.
- **Procedure:** load the web origin signed out; sign in; open each page; sign out; press Back.
- **Evidence:** L — `signed-out route preserves owner authentication and CSRF workflow`; `boot:
held /me…` tests; shell specs for a reachable sign-out at every width. H — every hosted journey
  signs in as the owner.
- **Pass/fail:** pass if sign-in and sign-out behave as expected and no owner data is visible after
  sign-out. Fail on any data visible when signed out, or a sign-in button enabled with no CSRF token.
- **Status:** IMPLEMENTED AND TESTED (L, H). T not executed.

### U2 — Session expiry and replacement

- **Expected:** an expired session shows "Your owner session expired. Sign in again to continue."; no
  stale data stays on screen; signing in again works; responses that belong to the ended session
  never change the new session.
- **Procedure:** sign in; end the session from a second tab by signing out there (restarting the API
  is not part of this checklist); trigger a read or mutation in the first tab; sign in again; confirm
  no leftover state.
- **Evidence:** L — the stale-session suites from PRs #122 and #125 (stale Tasks/Runs/Projects 401,
  stale logout, stale Run, stale assignment, busy-flag release, late revoke, late agent
  create/archive, 404 authorization lookup, stale Tasks 401 during sign-in). See
  `FRONTEND_PHASE_1_ACCEPTANCE.md` for which are guard-proving and which are invariant-only.
- **Pass/fail:** pass if the expiry message appears once and the new session shows only its own
  data. Fail if old data reappears or the new session is signed out by the old one.
- **Status:** IMPLEMENTED AND TESTED (L). Several in-code guards are untested; see section 4.

### U3 — CSRF and protected routes

- **Expected:** every hash route shows sign-in when signed out; a mutation with a rejected CSRF
  token (403) does not end the session; a 401 refreshes CSRF and sign-in still works.
- **Procedure:** open `#tasks`, `#runs`, `#projects`, `#agents`, `#departments` signed out; sign in;
  repeat a mutation after the session is replaced.
- **Evidence:** L — `a mutation 401 refreshes CSRF and allows sign-in again without reloading`;
  `a mutation 403 does not expire the owner session`; `expired-session CSRF bootstrap failure has a
usable recovery action`; `fixture rejects mutation requests with missing CSRF or invalid UUID
idempotency keys`.
- **Pass/fail:** pass if no protected content shows signed out and a 403 leaves the session intact.
- **Status:** IMPLEMENTED AND TESTED (L). Real header/Origin enforcement is backend-owned (T).

### U4 — Agent, Department and Project navigation

- **Expected:** Agents, Departments and Projects open from the primary navigation and from deep
  links; the browser Back and Forward buttons keep the route; unavailable data shows an explicit
  error, never an empty list.
- **Procedure:** open each page; open an agent profile and a project; reload on each deep link.
- **Evidence:** L — `agents.spec.ts` (57), `departments.spec.ts` (97), `projects.spec.ts` (71),
  `planning.spec.ts` (100), `shell.spec.ts` navigation tests.
- **Pass/fail:** pass if each page renders the backend data it is given and Back/Forward restore the
  route. Fail on a blank page or a false empty state.
- **Status:** IMPLEMENTED AND TESTED (L). Restricted-profile backend responses are T.

### U5 — Historical Tasks and Runs

- **Expected:** Tasks and Runs from earlier work keep their recorded status; `in_review` is not shown
  as Completed; an unknown outcome is never shown as completed or failed; failed loads say so.
- **Procedure:** open Tasks, Runs and Command Center; compare statuses with the database through the
  owner-approved read path; reload on `#runs/<id>`.
- **Evidence:** L — `every task status has its own label and in_review is not Completed`;
  `the system state never calls an unknown outcome idle or completed`; `loads tasks and runs
independently and retries without false empty states`; `deep-linked historical run survives reload
and browser back/forward`; `unknown run links explain the missing run…`; `successful empty task
and run resources show their own empty states`.
  Usage readout: `Run usage readout` tests (every field reads `Unknown`, never zero; switching runs;
  no readout without a run, while loading or after a failed load; restricted mode; 320–1280 px
  overflow and axe) and `usageReadout.logic.spec.ts`.
- **Pass/fail:** pass if every status label matches the record and every Run shows a Usage section
  whose fields read `Unknown`. Fail on any fabricated status, or any usage field shown as `0` or as
  a value the backend did not report.
- **Status:** IMPLEMENTED AND TESTED (L). T not executed.

### U6 — Events and SSE replay

- **Expected:** opening a run replays its recorded events in order without duplicates; a dropped
  connection reconnects with the last event id; a rejected reconnect is confirmed through the API
  before signing out; retries are bounded.
- **Procedure:** open a historical run; observe the event list; interrupt the browser network briefly
  (devtools offline) and restore it; sign out in a second tab and watch the first.
- **Evidence:** L — `runStreamSession.spec.ts` (33), plus App.spec: `event stream retries with the
last delivered event sequence`, `native EventSource reconnect after a delivered event sends
Last-Event-ID and dedupes the replay`, `event replay sorts out-of-order frames and ignores duplicate
sequences`, `replays 600 events in order…`, `a session revoked while streaming returns to sign-in…`.
- **Pass/fail:** pass if the event list has no gaps or duplicates and the session check does not
  sign out on a mere network drop. Fail on duplicated events or an unbounded retry loop.
- **Status:** IMPLEMENTED AND TESTED (L). Backend replay is single API replica only (AO-109); T.

### U7 — Runtime capability indicators

- **Expected:** capabilities (`omnis.runtime-capabilities.v3`) are read on the Tasks page. Loading,
  load failure, disabled execution, worker unavailable, Authorizer unavailable, mode mismatch and
  generic unavailable each show their own banner; only `mock_ready` can enable a Run control.
- **Procedure:** open Tasks; read the banner and the capability response; use "Check again".
- **Evidence:** L — `executionCapability.spec.ts` (5); App.spec `execution capability states`
  (banner shown, controls disabled, navigation intact; pending then mock-capable; "Check again"
  recovers; narrow-width reflow) and `capability refresh ordering` (older results never authorize).
- **Pass/fail:** pass if the restricted profile shows "Execution is disabled" and no control implies
  execution. Fail if any state other than `mock_ready` enables a Run control.
- **Status:** IMPLEMENTED AND TESTED (L). The indicator appears on the Tasks page only (by design);
  other entry points re-check capabilities before acting (see U8). T not executed.

### U8 — Execution-disabled controls and messages

- **Expected:** Run and approval controls are disabled with a reason; the approval dialog does not
  open; Command Center "Review approval" performs a live capability re-check and refuses with an
  explanation; the UI never says a Run was simulated, queued or approved.
- **Procedure:** from Tasks and from Command Center try to start or approve a Run; try the synthetic
  connector (it must be absent or blocked).
- **Evidence:** L — `execution disabled after page load blocks the run before any POST`; the
  `synthetic connector capability refresh` tests (disabled after load / after preparation / after
  approval blocks the next step); `Review approval opens the existing approval dialog and changes
nothing on cancel` (Command Center). Source: `openApproval` re-checks capabilities and shows
  "…, so no approval was opened."
- **Pass/fail:** pass if no Run request is sent and the message is truthful. Fail on any request to
  start a Run or any message implying execution happened.
- **Status:** IMPLEMENTED AND TESTED (L). T not executed.

### U9 — Authorizer-dependent operations unavailable

- **Expected:** with no Authorizer, owner approvals, connector authorization and **result
  acceptance** cannot succeed, and the UI says so plainly. When the backend reports the Authorizer
  unavailable (`authorization.availability: unavailable`, which the restricted profile always does),
  the Runs page shows an advisory beside Accept Result and Reconcile ("likely to be refused; you can
  still try; the server decides"). The control stays usable: the reading is a health probe, not the
  accept route's answer, so it never blocks anything. If the owner confirms, the API answers `503
authorizer_unavailable` and the owner is told acceptance is unavailable and the result is **not**
  accepted, never that the outcome is unknown.
- **Procedure:** if a historical task is `in_review`, open its completed run on the Runs page; read
  the Owner review section; activate the control and confirm; read the message; use "Check again".
- **Evidence:** L — `Authorizer advisory on Accept Result` tests (restricted; Authorizer unavailable;
  the reconcile control; authorized mock mode shows no advisory and still needs confirmation; a late
  `unavailable` never closes an open confirmation and acceptance can still succeed; a failed
  capability read claims nothing; "Check again"; moving to another completed run re-reads; an answer
  for the ended session never shows an advisory in the replacement; a run that completes on its own
  is never accepted automatically) and `a definitive authorizer_unavailable is reported as
unavailable, never as an unknown outcome` (PR #128). Ambiguous 5xx cases stay "uncertain".
- **Pass/fail:** pass if the advisory is shown, the control stays usable, nothing is sent until the
  owner confirms, and the refusal is truthful. Fail if the reading alone blocks or closes the
  control, or if any success state or "may or may not have been accepted" appears for this case.
- **Status:** IMPLEMENTED AND TESTED (L) as advice. T not executed. Authoritative disabling is BLOCKED
  BY BACKEND (section 9).

### U10 — Loading, empty and error states

- **Expected:** loading is announced and never shows a zero; a failed request is reported once, never
  as zero or empty, and can be retried; a confirmed empty list says it is empty.
- **Procedure:** open each page with the API slow, with one endpoint failing, and with no data.
- **Evidence:** L — `shows a real loading state until the delayed task request resolves`; Command
  Center `loading never shows zero and is announced`, `a failed request is reported once, never as
zero or empty…`, `a confirmed zero is shown as 0…`; Departments, Projects and Agents specs cover
  their own load/error/empty states.
- **Pass/fail:** pass if no state is shown as zero or empty while loading or failed.
- **Status:** IMPLEMENTED AND TESTED (L). T not executed.

### U11 — Responsive design

- **Expected:** no horizontal overflow, a reachable sign-out and working navigation from 320 px to
  1440 px, at 200% and 400% browser zoom, and with a 16 px minimum browser font.
- **Procedure:** resize the window across the widths; zoom to 200% and 400%; open the approval
  dialog and the run inspector at each width.
- **Evidence:** L — `shell.spec.ts` (containment at 320/390/720/820/1024/1440, genuine zoom 200% and
  400%, disclosed menu and focus continuity); App.spec `approval dialog stays centered and contained
at desktop, tablet, mobile, and narrow widths`; `banner reflows at phone width without horizontal
scroll`.
- **Pass/fail:** pass if nothing overflows and every control stays reachable.
- **Status:** IMPLEMENTED AND TESTED (L, Chromium only). Other browsers and real devices: not run.

### U12 — Keyboard and accessibility

- **Expected:** every control is reachable by keyboard with a visible focus ring; the skip link moves
  focus to `main`; dialogs trap and restore focus; Escape closes only what is safe to close; no
  serious or critical axe violations.
- **Procedure:** operate each page with the keyboard only; run axe on each route.
- **Evidence:** L — App.spec `axe reports no serious or critical violations on key routes at all
target widths`, `axe scans populated and empty run inspectors…`, `navigation and skip link support
keyboard operation`; `shell.spec.ts` disclosed-menu keyboard tests and landmarks/axe; Command
  Center `controls are reachable by keyboard with a visible focus indicator`; acceptance
  `keyboard focus stays on Confirm while acceptance is pending…`.
- **Pass/fail:** pass if every task is operable without a pointer and axe reports no serious/critical
  violation. Automated axe is not a screen-reader test.
- **Status:** IMPLEMENTED AND TESTED (L). Manual screen-reader testing: not run.

## 3. Mock-only owner-journey UAT (future, separately authorized)

**Not authorized now.** This checklist needs the mock-enabled profile (`docker-compose.mock-execution.yml`,
Authorizer and launcher present) on the target host, which the owner has not authorized. Hosted CI
evidence from PR #124 (`apps/web/integration/tasks.integration.spec.ts`) is **H**, not **T**, and is
not a substitute for target acceptance.

Journey: **Owner login → Agent → Project → Task → authorized mock Run → event streaming → review →
explicit acceptance → completed Task → persisted receipt.**

| #   | Check                                    | Expected                                                                                                                                 | Existing evidence                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | Run admission and idempotency            | One approval and one Run per exact operation; a retry reuses the keys; an uncertain decision is never repeated                           | L: `reviews an exact synthetic operation, explicitly approves it, and starts one persisted Run`; `safe retries reuse authorization and run idempotency keys`; `an uncertain owner decision is not repeated…`. H: `Compose owner creates an authorized mock Run through the web gateway` |
| J2  | Queued, running and terminal states      | Each status has its own label; unknown is never completed or failed                                                                      | L: Command Center `every run status has a distinct text label`; H: the synthetic broker journey                                                                                                                                                                                         |
| J3  | Cancellation and stopping                | Stop targets the selected run, ignores rapid duplicate clicks, and a failed stop can be retried                                          | L: `Stop targets the selected run…`; `Command Center Stop ignores rapid duplicate clicks and can retry after failure`                                                                                                                                                                   |
| J4  | Event replay                             | Ordered events, no duplicates, replay after reconnect                                                                                    | L: see U6. H: ordered events asserted in the synthetic broker journey                                                                                                                                                                                                                   |
| J5  | Browser reload                           | Run, events and receipt survive reload and Back/Forward                                                                                  | L: `deep-linked historical run survives reload…`. H: `owner sees an authorized synthetic broker Run, ordered events, result and usage provenance` and `Compose recovery preserves the committed Task, Run and event identities`                                                         |
| J6  | Owner acceptance                         | `in_review` is shown as awaiting review; acceptance needs a deliberate second step; success uses the returned task and shows the receipt | L: the `R1 owner result acceptance` suite (about 40 tests). H: `Compose reconciles a restored accepted task through the owner API`                                                                                                                                                      |
| J7  | Duplicate-acceptance prevention          | Rapid clicks send one request; a repeat returns the original receipt; only the latest eligible run can be accepted                       | L: `rapid repeated clicks submit one acceptance and show progress`; `after a mock rerun only the latest run can be accepted…`; reconcile tests                                                                                                                                          |
| J8  | Session expiry during operations         | An expiry during approve, start, stop or accept signs the owner out, keeps the same idempotency key, and shows no success                | L: `a lost session signs the owner out without reporting acceptance, and keeps the key`; the stale-session suites                                                                                                                                                                       |
| J9  | Backend restart and recovery             | Committed Task, Run and event identities survive; an uncertain run stays `unknown`; no automatic replay                                  | H only: `Compose recovery preserves the committed Task, Run and event identities`. L cannot show backend restart. T not executed                                                                                                                                                        |
| J10 | Usage reporting including unknown values | The Run inspector shows a Usage section; every field reads `Unknown` (never zero) and nothing is fabricated                              | L: `Run usage readout` tests and `usageReadout.logic.spec.ts`. H: the API returns `usage` as unknown. Real usage values cannot be shown: the Phase 1 contract carries none (section 9)                                                                                                  |

**Pass criteria for the whole journey:** every row passes on the target host with the owner present,
the persisted receipt matches the accepted run, and nothing in the UI is presented as provider
activity. **Status:** OWNER AUTHORIZATION REQUIRED (and BLOCKED BY PLATFORM for target-host access).

## 4. Frontend readiness matrix

| Area                                                          | Status                          | Evidence and notes                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner login/logout, session, CSRF, protected routes           | IMPLEMENTED AND TESTED          | L (U1–U3).                                                                                                                                               |
| Session replacement and stale asynchronous work               | IMPLEMENTED AND TESTED          | L; see the proof-level split in `FRONTEND_PHASE_1_ACCEPTANCE.md`.                                                                                        |
| OMNIS NEXUS Command Center                                    | IMPLEMENTED AND TESTED          | `command-center*.spec.ts` (90 tests across three files).                                                                                                 |
| Agents and Profiles                                           | IMPLEMENTED AND TESTED          | `agents.spec.ts`; identity/profile editor session guards are untested (below).                                                                           |
| Departments                                                   | IMPLEMENTED AND TESTED          | `departments.spec.ts`; department-write session guards are untested (below).                                                                             |
| Projects and planning                                         | IMPLEMENTED AND TESTED          | `projects*.spec.ts`, `planning*.spec.ts`; planning-writer session guards are untested (below).                                                           |
| Tasks (create, assign, list, detail)                          | IMPLEMENTED AND TESTED          | App.spec task, assignment and idempotency tests.                                                                                                         |
| Run inspector, history, SSE and replay                        | IMPLEMENTED AND TESTED          | L (U5, U6). Backend replay is single API replica only.                                                                                                   |
| Runtime capability reporting                                  | IMPLEMENTED AND TESTED          | L (U7). Banner on the Tasks page only.                                                                                                                   |
| Execution-disabled controls and messages                      | IMPLEMENTED AND TESTED          | L (U8).                                                                                                                                                  |
| Result acceptance when the Authorizer is unavailable          | IMPLEMENTED AND TESTED          | Truthful refusal (PR #128) plus an advisory from `authorization.availability` that never blocks (section 9).                                             |
| Authoritative gating of Accept Result (disable the control)   | BLOCKED BY BACKEND              | The capability contract has no field about acceptance; `authorization.availability` is a health probe. Needs `ownerAcceptance.availability` (section 9). |
| Mock owner approval and result acceptance (Authorizer-backed) | IMPLEMENTED, RUNTIME UNVERIFIED | L and H only; needs the mock-enabled profile on the target host.                                                                                         |
| Run usage readout ("basic readout, `unknown` when absent")    | IMPLEMENTED AND TESTED          | Truthful `Unknown` readout for the only usage the contract can express. Real usage values are BLOCKED BY BACKEND (no contract for them).                 |
| Full mock-agent owner journey on the target host              | OWNER AUTHORIZATION REQUIRED    | Section 3. Also BLOCKED BY PLATFORM for target access.                                                                                                   |
| Backend restart/recovery and multi-replica session behaviour  | BLOCKED BY BACKEND              | Session state is process-local; only a single API replica is established (AO-109).                                                                       |
| Responsive and accessibility behaviour                        | IMPLEMENTED AND TESTED          | L, Chromium only; no screen-reader or other-browser run.                                                                                                 |
| Real provider execution (R1)                                  | BLOCKED BY BACKEND              | AO-107 / AO-113 stay BLOCKED; out of scope here.                                                                                                         |

### Residual test limitations, evaluated

| Limitation                         | Assessment                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning and department writes     | Functionally tested; their session guards have no session-replacement test because the mock has no such fixture. No defect found. A fixture is the next test milestone.                |
| Agent profile and identity editors | Same as above. Guarded at dispatch; no defect found.                                                                                                                                   |
| SSE per-callback guards            | Cannot be forced from outside (the window is between session rotation and React cleanup, and teardown also closes the stream). Covered by invariant tests only. Non-blocking.          |
| Stale `/me` and stale CSRF guards  | Not reachable through the UI (sign-in is disabled while CSRF loads and sign-out is unreachable during sign-in). Reachable neighbours are tested. Non-blocking.                         |
| Abort-only read effects            | Can still write local state into a component that is being unmounted; no request, storage, hash or parent-callback effect. Consequence-free for the replacement session. Non-blocking. |

## 5. Genuine gaps found by this audit

1. **Accept Result under `authorizer_unavailable` was mis-framed — FIXED in this change.** The
   restricted API answers `503 authorizer_unavailable` ("Authorizer-backed functionality is
   unavailable in this configuration.") without reaching any Authorizer. The frontend treated every
   5xx as an unknown outcome and told the owner "The result may or may not have been accepted.
   Retrying uses the same request…". The backend has a separate code, `task_acceptance_outcome_unknown`,
   for the genuinely uncertain case. Fix: `classifyAcceptanceFailure` now returns a distinct
   `unavailable` outcome for `503` with code `authorizer_unavailable`; the UI says the approval
   service is unavailable and the result is not shown as accepted, keeps the idempotency key, and
   re-reads the task. Regression test added; with the classification removed the test fails with the
   old text. All other 5xx handling is unchanged.
2. **No Run usage readout — IMPLEMENTED in the usage-readout milestone.** See section 9. The Phase
   1 contract can express only unknown usage, so the readout is a truthful `Unknown` display and is
   not a Cost & Usage Center.
3. **Accept Result was not pre-gated on the Runs page — advisory IMPLEMENTED; authoritative gating
   BLOCKED BY BACKEND.** An isolated check reads `authorization.availability` while a completed run
   is open and shows an advisory when it is `unavailable`. It cannot disable the control: outside the
   restricted profile that value comes from a separate health request, and the accept route only
   refuses at its feature guard in the restricted profile, so a failed probe does not prove
   acceptance would fail. Command Center "Review approval" and the connector action still re-check
   capabilities before acting, so they fail closed.

## 6. Backend and platform dependencies

- Target WSL2 browser acceptance needs owner authorization and platform access (Codex #3 / owner).
- Approvals, connector authorization and result acceptance need the Authorizer; the restricted
  profile has none by design.
- The mock-journey checklist needs the mock-enabled profile, which is not authorized.
- Multi-replica session revocation and SSE replay are not established (AO-109).
- Two optional backend contract extensions are proposed for Codex #1 in section 9; neither is
  required for the current behaviour and none was made here.

## 7. CI reliability evidence for Codex #3

The `frontend-browser` job in `.github/workflows/ci.yml` has `timeout-minutes: 15` (line 58). It runs
the full Playwright suite on pull requests. Observed on PRs #122 and #125:

| Run (PR)                                 | Job duration | Result                                                                  |
| ---------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| 43921138236 (#122)                       | 9 min 51 s   | success                                                                 |
| 43933717645 (#125)                       | 11 min 32 s  | success                                                                 |
| 43936060582 (#125, first attempt)        | 15 min 02 s  | **cancelled at the timeout**, which made the required `checks` job fail |
| 43936060582 (#125, rerun of failed jobs) | 14 min 14 s  | success                                                                 |

The suite grew from 802 to 813 tests between these runs; local full runs took 7 to 11.5 minutes.
The margin is under one minute at worst. This document does not change CI. Suggested options for
Codex #3: raise `timeout-minutes`, or shard the suite. Without a change, a slow runner will fail the
required check on an unchanged commit and force a rerun.

## 8. Retrospective review of PR #125 (evidence record)

This is a read-only retrospective by the independent Codex reviewer of the exact merged revision. It
does **not** change the pre-merge approval history: the approval was issued for branch revision
`155e5ca`, and the merged branch head was `32a159c`.

- **Reconciliation.** `App.spec.ts` is byte-identical between `155e5ca` and `32a159c`. The only
  difference in `FRONTEND_PHASE_1_ACCEPTANCE.md` is two wording edits (the generation counter is
  owned by `App.tsx`, with `sessionScope.ts` providing the helpers; and a dangling commit reference
  was replaced). The extra commit was documentation-only and not substantive. The squash `5f8094c`
  adds regression tests and updates the record and changes no production code. Both were verified
  against Git.
- **Production code on `5f8094c`.** No path was found where a replaced owner session's continuation
  can expire or authorize the replacement session, write shared state or storage, change the hash,
  send a request, call a parent callback, or leave a shared busy or loading flag stuck.
- **Proof levels.** The proof levels in `FRONTEND_PHASE_1_ACCEPTANCE.md` match the tests; no
  over-claim was found. The reviewer read the tests and did not execute them.
- **Non-blocking:** several guards are not individually guard-proven (already documented); and the
  `finally` blocks in `agents/AgentProfileEditor.tsx` and `agents/AgentIdentityEditor.tsx` clear a
  component-local `busy` flag without a session check. That flag is local, and the owner subtree is
  torn down and recreated on sign-out, so it cannot release a replacement session's shared state.
- **Verdict:** NON-BLOCKING FINDINGS ONLY. The reviewer ran no tests, CI, backend or Docker; the
  validation figures quoted elsewhere are the author's.

## 9. Usage readout and acceptance gating (milestone record)

**Contract evidence (read from source, not assumed).**

- `packages/contracts/src/index.ts`: `Run.usage` is `UsageSchema` = `{quality: 'unknown', inputTokens:
null, outputTokens: null, cost: null}`. There is no measured or estimated variant, no currency, and
  no run event that carries usage (`RunEventTypeSchema` has none). A Run with any other usage fails
  to parse. `usageReadout.logic.spec.ts` pins this with a tripwire test: if the contract is
  extended, that test fails and the readout and its tests must change with it.
- `packages/contracts/src/runtime-capabilities.ts` and `apps/api/src/server.ts`:
  `authorization.availability` is produced by `checkAuthorizerAvailability()`, which is `false` in the
  restricted profile and otherwise a health request through the same `authorizerRequest` that result
  acceptance uses. The accept route is guarded by `requireAuthorizerFeature` and calls the Authorizer
  through the same client. So `unavailable` means the Authorizer acceptance needs is not reachable;
  `available` does not promise acceptance will succeed.

**Usage readout.** `RunUsageReadout` adds a compact "Usage" section to the Run inspector: Input
tokens, Output tokens and Cost, each `Unknown`, with the note "No usage was reported for this run.
Unknown does not mean zero." Nothing is computed, estimated or priced. `formatUsageCount` shows `null`
as `Unknown` and `0` as `0` so a future contract extension cannot turn missing data into zero; cost is
never formatted because the contract carries no currency. The design spec's collapsible usage
inspector belongs to AI Chat, which is outside Phase 1, so the section is always visible and small.
`docs/04-design/OMNIS_NEXUS_UI_UX_SPEC_V2.md` is not in the repository; `UI_UX_SPEC.md` and
`NEXUS_DESIGN_SYSTEM.md` were used.

**Acceptance control (advisory only).** `useAcceptanceAvailability` reads `authorization.availability`
only while a completed run is open on the Runs page, re-reads when the selected run changes, and
keeps its own state so the Tasks page execution gate is untouched. When it reads `unavailable`, the
Accept Result and Reconcile controls get an advisory note (associated with the button, with a "Check
again" action). **Nothing is disabled, blocked or closed.** While loading, after a failed read, or
when `available`, nothing changes. The accept route stays the authority, and Origin/CSRF, exact run
identity and idempotency are untouched.

**Why it is not a hard gate (found by independent review).** An earlier revision disabled the
control. Review showed that is unjustified: outside the restricted profile `authorization.availability`
comes from a separate `/internal/v1/health` request (`apps/api/src/server.ts`, any probe error maps to
`false`), while the accept route only refuses at its feature guard in the restricted profile
(`apps/api/src/auth.ts`) and otherwise calls the acceptance endpoint (`task-routes.ts`). A failed
health probe with a working acceptance endpoint would have blocked an action that could succeed.
Deriving a rule from restricted-profile field combinations would invent an authority the contract
does not state, so the hard gate was removed. This is the documented blocker: the contract has no
field that authoritatively states acceptance availability.

**Proposed contract extensions for Codex #1 (not made here, not required):**

1. A dedicated field such as `ownerAcceptance: { availability }` in the capability response that is
   computed from what the accept route itself requires. With it the frontend could disable the
   control authoritatively; without it the frontend can only advise.
2. If real usage is to be shown, a versioned `Usage` variant with `quality` (`measured` | `estimated`
   | `unknown`), token counts, and a cost with an explicit currency and source, plus the run event or
   field that delivers it. The frontend and shared contracts must change together.

**Evidence level.** Everything above is L (mock-API Playwright, plus pure-logic tests). The restricted
profile's real responses are T and were not executed; no UAT item is marked passed on the target host.

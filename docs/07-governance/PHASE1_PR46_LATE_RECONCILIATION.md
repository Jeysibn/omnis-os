# PR #46: late authoritative Run projection

## Root cause

The worker's bounded broker recovery window ends by persisting Run `unknown` and releasing its execution lease. Ordinary job startup accepts only queued Runs, and ordinary completion requires a running/stopping Run with its current worker lease and generation. Broker restart recovery can later resolve the authoritative connector attempt, but the original job has finished and no component previously discovered the stale unknown projection. Normal terminal-state protection therefore correctly rejected an ordinary worker completion, while the projection remained stale.

## Read-only reconciliation boundary

Only the explicit synthetic test mode enables the worker's periodic projection pass. Each pass discovers at most 20 unknown synthetic Runs from the existing runtime-owned Run table. An in-memory cursor advances across pages and wraps; a nonoverlap guard bounds each process to one pass. Restart begins discovery again from durable unknown rows. No additional queue, service, attempt store or approval system is introduced.

The worker sends the persisted immutable request binding, authorization ID and request ID to the separately authenticated broker projection route. No rendered prompt is sent. That route uses an authenticated, read-only authorizer lookup, which verifies the grant fingerprint and finds the existing attempt by authorization/request identity. It cannot admit, claim, begin or submit an operation. The broker verifies the existing signed decision envelope and all immutable request fields before returning the persisted attempt outcome and signed correlation ID. Historical envelope verification permits reading an already-submitted outcome after grant expiry; it does not confer execution authority. Both existing socket gateways allow only the additional exact projection path. No database credentials or grants change.

A runtime transaction locks the Run and validates its unknown status, captured execution generation, absent worker lease, task, authorization, request, correlation/Run ID and any already-bound attempt ID. Contradictory evidence is rejected. The exceptional repair increments the Run generation, projects output only for completion, updates task status, and appends the definitive Run event in the same transaction. Concurrent/repeated repair is a no-op after the first transaction. Attempt lifecycle and usage accounting remain solely authoritative in the authorizer; reconciliation never writes either.

## Allowed transitions

| Existing Run | Authoritative attempt | Result |
| --- | --- | --- |
| unknown | completed with validated output | completed, one run.completed event |
| unknown | failed | failed, one run.failed event |
| unknown | interrupted with durable owner stop event | cancelled, one run.cancelled event |
| unknown | interrupted without owner stop event | interrupted, one run.interrupted event |
| unknown | admitted/submitting/accepted/running/unknown or unavailable/conflicting evidence | unchanged and eligible for another pass |
| any other status, stale Run generation, or active lease | any | no repair |

An owner stop request alone never proves provider termination. Only the authoritative interrupted attempt permits cancelled projection. Completion and cancellation races retain the authoritative attempt's terminal outcome. Unknown continues to block admission until a definitive projection is validated. Ordinary execution terminal protections remain intact. Earlier unknown events remain in history; SSE keeps streaming through uncertainty and replays the later definitive event after browser refresh. An owner tab may keep its event connection open while the outcome is unknown, just as for other ongoing Runs; normal disconnect/navigation cleanup closes it. This does not keep an execution job alive or cause provider I/O. Projection requests have an absolute 10-second deadline, each pass examines at most 20 rows, and overlapping passes are suppressed.

## Regression evidence

The focused tests cover read-only broker lookup, query-string routing, service authentication, unavailable evidence, retry without admission, generation fencing, forged attempt identity, concurrent/idempotent Run repair, durable cancellation, stale worker completion rejection, and unknown followed by definitive SSE replay. PostgreSQL tests execute the transaction against restricted runtime credentials.

The separate-process browser harness kills the broker after durable provider acceptance, waits beyond the actual worker recovery window until Run unknown is persisted, and only then restarts the broker. It requires both attempt and Run completed, exactly one submission audit record, and exactly one Run completion event. The existing browser journey verifies persisted output/history and refresh. Browser time budgets account for the real 45-second failure boundary rather than shortening it for the test. Existing lost-ack, cancellation/restart, duplicate provider event, canary, backup/restore and container isolation tests remain required.

Local database/browser verification requires explicitly configured disposable PostgreSQL roles; absent configuration is NOT RUN, not PASS. Final exact commit, CI link/job outcomes and independent review findings are recorded in PR #46 so later documentation updates do not mislabel earlier CI as verification of a newer head.

## Remaining gates

This is a synthetic-only projection repair. Real-provider activation remains blocked by provider policy, credential custody, entitlement, consent and independent activation review. Target-host egress, socket identity/permissions, rootful Docker trust and host recovery validation remain BLOCKED — HOST VALIDATION REQUIRED. Synthetic CI does not establish production readiness. PR #46 remains Draft and unmerged.

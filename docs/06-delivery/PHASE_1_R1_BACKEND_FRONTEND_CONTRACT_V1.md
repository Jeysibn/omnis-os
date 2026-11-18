# Phase 1 R1 Backend/Frontend Contract v1

**Contract version:** `omnis.phase1-r1-backend-frontend.v1`  
**Source baseline:** `2c074c41c2178e7f7ee6d8d355c7d6c07f9e34c9` (`main`, 2026-11-18)  
**Scope:** Existing owner-facing API contracts and the synthetic-only UI integration boundary.  
**Decision:** R1 remains **BLOCKED / NOT ACCEPTED**. This document does not authorize real-provider execution.

This is an interface handoff, not a new runtime contract or an approval gate. The `v1` label versions this document's statements about the existing schemas and endpoints at the source baseline above. Any incompatible API/schema change requires a new contract version and review.

## 1. Implemented boundary

The ordinary Run API is mock-only. Its `RunSchema` carries `runtimeKind: "mock"`, `synthetic: true`, and usage `{ quality: "unknown", inputTokens: null, outputTokens: null, cost: null }`. Run states are `queued`, `running`, `stopping`, `completed`, `cancelled`, `failed`, `interrupted`, and `unknown`.

The synthetic connector harness is separately versioned as `omnis.synthetic-task-run.v1`. Its response reports `status` (`admitted`, `submitting`, `accepted`, `running`, `completed`, `failed`, `interrupted`, or `unknown`), `submitted`, correlation/request/attempt IDs, synthetic usage provenance, and response text only when completed. These two status sets describe different records; clients must not collapse them into one state machine.

All of these paths are owner-authenticated and scoped to the task/run. Synthetic authorization is bound to the exact task, project and immutable profile version, request identity and prompt digest. Authorization is one-use; the server rejects replay or mismatched binding. Raw prompts do not cross the broker boundary as part of its persisted audit event.

## 2. Run lifecycle and cancellation

For ordinary mock runs, `stopping` means a stop was requested and is awaiting worker acknowledgement. `cancelled` is persisted only after the mock worker owns the run and acknowledges cancellation (or the queue-terminal cancellation path records the terminal result). `interrupted` and `unknown` remain distinct outcomes; neither implies success.

For the synthetic connector endpoint, `POST /api/v1/tasks/:taskId/synthetic-runs/:authorizationId/cancel` returns the strict shape `{ requested: true, confirmed: false, authorizationId, taskId }`. That response means only that cancellation/revocation was requested. It is never a termination receipt. The client may read `GET /api/v1/tasks/:taskId/synthetic-runs/:authorizationId` for the persisted run/attempt status and usage.

UI rule: show a request as pending until a persisted terminal status is read. Do not set `cancelled` because an HTTP request succeeded, an abort signal was sent, a stream closed, or the UI stopped waiting. If the outcome is uncertain, retain `unknown` (or the current nonterminal state while reconciliation is pending).

This evidence is specific to the mock/synthetic worker and fixture. It is not evidence that a real upstream provider terminated execution.

## 3. Events, provenance, and replay

Ordinary Run events conform to `RunEventSchema`: `id`, `runId`, monotonically increasing `sequence`, `at`, `type`, `source: "mock"`, `synthetic: true`, and `message`. Event types are `run.queued`, `run.started`, `run.provider_submission_requested`, `run.output`, `run.stop_requested`, `run.completed`, `run.cancelled`, `run.failed`, `run.interrupted`, and `run.outcome_unknown`. The `provider_submission_requested` name is a lifecycle event in this synthetic contract; it does not establish real-provider activity.

`GET /api/v1/runs/:runId/events` is owner-authenticated SSE. The client may send `Last-Event-ID` as a nonnegative safe-integer sequence cursor. The API validates each event, checks the run binding and strict sequence increase, and emits SSE `id`, `event`, and `data`. Persisted run events permit replay after a reconnect. The current session/stream registry is process-local, so deployment supports one API replica; this is not a cross-replica recovery guarantee.

The synthetic audit-history API is `GET /api/v1/tasks/:taskId/synthetic-runs/:authorizationId/events`; it returns `omnis.synthetic-task-run-events.v1` pages with ordered persisted synthetic audit events and a continuation page. It is not the Run SSE stream.

UI rule: render provenance only from validated fields. In v1, `source: "mock"` plus `synthetic: true` means synthetic. No event in this contract means authentic provider output. Clients must not infer provider provenance from event type, response text, model labels, or request success.

## 4. Submission uncertainty and restart recovery

Synthetic admission is idempotently bound to request identity. If the API loses the worker-admission reply, it reports `503 synthetic_run_admission_unknown`; the client must query the existing request/run state or retry with the same request identity. It must not create a new identity to force a second submission.

Persisted runs/events and connector attempt records are the recovery source. Unknown synthetic submissions are reconciled against the existing attempt identity/generation and terminal evidence. Queue/worker recovery does not automatically resubmit an uncertain operation. A process restart or lost reply does not prove that no execution occurred.

SSE reconnect uses the last received persisted sequence. This supports event replay within the single-API-replica deployment boundary above. It does not promise that an already-open stream is closed immediately on revocation across API replicas.

## 5. Usage

Ordinary Run usage is unknown-only in v1: `quality: "unknown"`, with token and cost values `null`. Null means unavailable/unknown; it is never zero.

Synthetic connector usage uses the existing `UsageProvenanceSchema` union:

| `kind` | Evidence carried | Billing exposure |
| --- | --- | --- |
| `measured` | `source: "synthetic-provider"`, nonnegative `inputUnits` and `outputUnits` | `synthetic-only` |
| `estimated` | named estimation `method`; optional positive input/output units | `unknown` |
| `unknown` | reason: `submission_uncertain`, `provider_unavailable`, or `not_reported` | `unknown` |

The synthetic fixture's `measured` value is not a real provider report. The UI may show the given kind and provenance, but must not relabel fixture values as real usage. Unknown/null must not render as zero or as proof of no billing.

Real-provider measured/estimated/unknown provenance fields, provider billing semantics, and run-level provider usage are **not implemented** by this v1 contract.

## 6. Owner acceptance and capability gates

Owner acceptance remains `POST /api/v1/tasks/:taskId/accept-result` with the existing mutation protections, CSRF, and idempotency request ID. The request is `{ runId }`; the validated response is `{ task, acceptance, created }`, where acceptance records `runId`, `acceptedBy: "owner"`, `acceptedAt`, and `requestId`. Acceptance records an owner's review of a result; it does not authorize provider execution.

The runtime capability response exposes the current synthetic fixture availability/authorization state. There is no real-provider Authorizer gate state in the current API contract. UI controls for real-provider approval must therefore remain absent or nonfunctional; a frontend must not infer a gate from environment, profile text, mock capability, or acceptance state.

## 7. Proposed real-provider contract (not implemented or approved)

Future real-run UI integration requires a separately reviewed and versioned schema. At minimum it must provide:

1. An explicit validated provenance discriminator distinguishing authentic provider events from synthetic events, with durable order, deduplication identity, and replay cursor.
2. A cancellation request distinct from independently evidenced terminal interruption/termination. A request, timeout, stream close, or local process exit is not confirmation; uncertain remains `unknown`.
3. Usage quality `measured | estimated | unknown`, with authoritative source for measured data, named method for estimates, and explicit unknown/null semantics.
4. Exact-run Authorizer gate state and owner-approval binding, without changing owner result-acceptance semantics.
5. Restart reconciliation that preserves original submission identity and never silently repeats an uncertain/billable request.

These are requirements for future design, not fields that a client may assume today. Implementation and activation remain gated by M-3 and M-4, Windows-local ingress, credential custody, owner-to-Authorizer trust, and host confinement decisions. Those controls remain unresolved or blocked. Real-provider execution is not authorized; Stages 2–4 are not authorized.

## 8. Frontend handoff

Claude #2 may integrate lifecycle display, mock/synthetic labeling, pending cancellation, unknown usage, persisted event replay, and unchanged owner result acceptance using the APIs and schemas in Sections 1–6. The current PR #137 implementation is directionally consistent with this boundary.

Claude #2 must not build or enable real-provider run controls, claim authentic provider provenance, present synthetic fixture metrics as provider usage, treat cancellation request as termination, or infer real-run gate availability. Those integrations wait for the future contract and security approvals in Section 7.

## 9. Source map

- `packages/contracts/src/index.ts`: Run, RunEvent, usage and owner acceptance schemas.
- `packages/contracts/src/synthetic-task-run.ts`, `connector-broker.ts`, and `synthetic-audit-history.ts`: synthetic request, response, cancellation, usage provenance, and audit-event schemas.
- `apps/api/src/synthetic-task-run-routes.ts` and `run-events-route.ts`: synthetic connector routes and Run SSE/replay.
- `apps/api/src/task-routes.ts`: owner result-acceptance route.
- `packages/db/src/run-store.ts`: durable sequencing, cancellation evidence, unknown submission reconciliation.
- `docs/06-delivery/PHASE_1_BACKEND_CONNECTOR_READINESS.md`: R1 readiness evidence and blocked real-runtime design.


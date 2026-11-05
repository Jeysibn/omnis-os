# Phase 1 Backend Connector Readiness

**Baseline:** `7bb6e9d3a79e749b5dfaf63561bb442fde188d9`
**Assessment date:** 2026-11-05
**Scope:** Backend readiness and credential-free synthetic protocol harness
**Decision:** Keep real connector implementation and real inference blocked.

This document records a source-based assessment and defines a future boundary. The test harness added with this document is an in-process simulation. It does not start Codex, authenticate to a provider, or make a network request. Its passing tests are not evidence of real app-server security.

## Phase 1 gate matrix

| Gate                                           | Status                                 | Existing evidence                                                                                                              | Remaining work                                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AO-101 — workspace and quality                 | VERIFIED                               | Strict TypeScript workspace, format/lint/typecheck/tests/build; baseline CI run `42035209557` passed.                          | Keep new integration fixtures credential-free and preserve clean CI.                                                                                                |
| AO-102 — PostgreSQL and migrations             | VERIFIED for mock scope                | Migrations `0001`–`0020`, PostgreSQL role, recovery, legacy upgrade and backup/restore checks.                                 | Independently review any provider provenance or usage schema and its ACLs.                                                                                          |
| AO-103 — owner authentication and policy       | VERIFIED for mock scope                | Owner session, CSRF, authorization read/decision/revocation and run-scoped `mock.execute`.                                     | Add provider/model/run-specific consent, signed admission, revocation and replay protection.                                                                        |
| AO-104 — Agent Profiles                        | VERIFIED for current profile lifecycle | Owner-managed profile versions and input validation are implemented.                                                           | Bind any future run to an immutable profile version; profile data conveys no execution authority.                                                                   |
| AO-105 — project/task/run foundation           | VERIFIED for mock scope                | Project-aware task association, archive-aware run admission, durable run storage.                                              | No project or task permission expansion in this increment.                                                                                                          |
| AO-106 — runtime adapter and mock              | VERIFIED for mock scope                | `RuntimeAdapter` is `kind: 'mock'`; sandboxed mock is constructed directly by worker startup.                                  | No production connector selector or non-mock adapter is introduced here.                                                                                            |
| AO-107 — real runtime adapter                  | BLOCKED                                | Adapter, authorization schema and DB checks only accept mock/synthetic execution; no credential broker or connector isolation. | Policy/consent, trusted connector identity, broker, egress controls, tool-denial proof and exact-operation authorization.                                           |
| AO-108–109 — durable runs and events           | VERIFIED for mock scope                | PostgreSQL admission, idempotency, queue, leases, recovery, sequence-persisted events and SSE replay.                          | Persist provider provenance only after separately reviewed external-submission and uncertainty semantics. Never automatically replay uncertain provider submission. |
| AO-110 — functional UI                         | PARTIAL                                | Owner task/run flow, event inspector, cancellation and reload exist; frontend readiness is separate.                           | Profile selection and truthful real/mock provenance require frontend-owned work after the backend contract is approved.                                             |
| AO-111 — approvals, tools, cancellation, audit | PARTIAL                                | Current one-run approval and cancellation apply to `mock.execute`.                                                             | Exact provider/model/profile/task/prompt/tool/limit-bound approval, deny-all tool policy, auditable revocation and observed provider termination.                   |
| AO-112 — usage reporting                       | PARTIAL                                | Mock usage is forced to unknown.                                                                                               | Per-run measured usage only where the provider returns reliable fields; otherwise unknown/unavailable. Account-level usage is not per-run usage or cost.            |
| AO-113 — end-to-end acceptance                 | BLOCKED                                | CI and browser tests exercise synthetic execution only.                                                                        | Separately authorized real request after all policy, host, credential, tool, lifecycle, UI and reviewer gates pass.                                                 |
| G4-3 — host/process/credential isolation       | PARTIAL                                | Restricted rootful launcher and disposable-host mock verification.                                                             | Signed assertions, replay protection, coordinated token rotation, broker and connector host boundary remain open.                                                   |
| R1-G5 — host authorizer isolation              | PARTIAL                                | Mock-only service identities and protected launcher path have disposable Ubuntu evidence.                                      | Codex #3 connector identity, authenticated IPC, egress, process confinement, credential custody and crash/restart validation.                                       |

## Existing execution path and attachment boundary

| Stage               | Existing implementation                                                                                                                          | Missing for real runtime                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner authorization | API owner session and CSRF; authorizer persists owner approval.                                                                                  | Approval is only `mock.execute`, not an exact provider operation.                                                                                           |
| Run admission       | `RunCoordinator.startRun` checks the authorization and `PostgresRunStore.admitRun` serializes task, grant and idempotency.                       | Signed and replay-resistant provider-specific admission is absent.                                                                                          |
| Persistence         | `runs` and `run_events` are PostgreSQL-backed. Migration `0001` constrains runtime to mock, synthetic=true, usage unknown and event source mock. | Non-synthetic provider provenance, provider submission identity and truthful usage schema are absent.                                                       |
| Worker              | `apps/worker/src/server.ts` constructs `SandboxedMockRuntimeAdapter` directly.                                                                   | No isolated connector process or API-to-connector authenticated IPC. Do not add credentials to this worker.                                                 |
| Adapter             | `RuntimeAdapter` exposes abortable execute and event callback, but literal kind is `mock`.                                                       | A future connector must be a separately authorized service boundary; adding a class in the current worker would inherit worker/launcher/DB authority.       |
| Events and SSE      | Run store sequences persisted output and SSE fills replay before live delivery.                                                                  | External event IDs, duplicate provider event handling and provenance-safe event mapping.                                                                    |
| Cancellation        | Worker aborts mock process and records stop/interruption state.                                                                                  | Provider interruption request/acknowledgement and independent observation that execution actually stopped.                                                  |
| Recovery            | Lease recovery does not automatically replay uncertain queue submissions.                                                                        | Provider-side request outcome reconciliation without a duplicate or billable resubmission.                                                                  |
| Usage               | Mock is unknown; no synthetic metrics are represented as provider values.                                                                        | Per-turn usage is not yet proven. Treat absent or aggregate-only metrics as unknown.                                                                        |
| Audit               | Metadata-only authorizer/run audit for mock operations.                                                                                          | Provider grant version, runtime/model, immutable profile revision, prompt digest, external IDs and terminal provenance. Never audit raw prompt or response. |

## Codex app-server protocol feasibility

### Documented

- Current documented app-server uses a client/server transport with initialization followed by `initialized`; local documentation describes stdio newline-delimited JSON. The installed CLI `0.166.0` help lists experimental `stdio://`, Unix socket and WebSocket transports and protocol-generation commands.
- The documented lifecycle includes `thread/start`, `turn/start`, server notifications such as `item/agentMessage/delta`, and `turn/completed`. Success requires a completed status; failed and interrupted are not success.
- The current app-server protocol documents `turn/interrupt`; the terminal turn notification reports interrupted status. A request to interrupt is not proof that the upstream provider stopped processing.
- SIWC configuration sends the access token to app-server in a child-process environment variable, then app-server sends it to the Responses endpoint. This makes a credential broker and separate OS identity mandatory for any future use.
- SIWC preview requirements include streaming and `store:false`. Its documented app-server can execute local shell and MCP tools, and can coordinate child agents. It exposes filesystem, command, tool and approval-related protocol surfaces.
- The docs expose account-level token/activity and rate-limit reads. Those values do not establish per-run token usage or cost. Until per-turn metrics are independently proven, Omnis must record usage as unknown.
- Model catalogs may be bundled or cached and are not an entitlement check. Only a completed request would establish access, and that request is not authorized in this assignment.

### Source/installation inspected

- `codex --version` returned `codex-cli 0.166.0`.
- `codex app-server --help` and `codex app-server generate-ts --help` were inspected. No app-server process was started; no generated schema command was run, because the CLI may load local configuration and the exact installed schema is not required for this synthetic contract.
- No login status, token store, auth file, or native credentials were read. No provider endpoint was contacted.

### Not established

- The exact `0.166.0` schema and runtime behavior were not source-inspected or exercised. Public protocol docs can change independently of the installed CLI.
- The reviewed official documentation does not establish a trusted, complete no-tool switch. Protocol prompts or sandbox settings cannot be treated as proof that shell, filesystem, MCP, plugins or child-agent execution are impossible.
- Provider policy/entitlement for an Omnis-managed interactive or background request, model availability, token refresh/revocation notification, per-run usage, and external submission idempotency remain unverified.
- No authenticated app-server was started and no inference was performed.

Official sources: [Codex app-server SIWC guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [SIWC overview and consent flow](https://developers.openai.com/siwc/token-sharing-open-source), [Codex app-server protocol reference](https://learn.chatgpt.com/docs/app-server).

## Future backend connector contract (design only)

This is an integration contract proposal, not a runtime adapter enabled by this change.

1. **Admission:** A trusted authorizer issues one short-lived decision bound to owner, runtime/version, provider, model, task, project, immutable profile version, prompt digest, empty tool set, output/time/network limits, idempotency identity and revocation generation. Missing, expired, mismatched or unverifiable decisions deny execution.
2. **Boundary:** The worker sends a minimal run envelope to a dedicated unprivileged connector over authenticated local IPC. The connector has no runtime DB, authorizer, launcher or Docker socket, developer home, task filesystem or inherited credentials. Codex #3 must independently prove identity and confinement.
3. **Credential:** A separately reviewed app-owned OAuth flow and broker hold refresh credentials outside Omnis DB, worker, events, logs and artifacts. Only a minimum short-lived token reaches the connector process via an OS-protected channel. Never reuse installed CLI login or proxy a subscription token.
4. **Tools:** Initial operation allows no tools. Backend must reject any tool/control event. Host policy must make shell, child process, file access, MCP, browser, arbitrary network and external writes impossible; app-server’s own settings are insufficient evidence by themselves.
5. **Events:** Parse all frames against bounded schemas. Persist provider-origin events with explicit non-synthetic provenance, provider thread/turn IDs, deduplicated upstream event identity and deterministic sequence. Preserve actual failed/interrupted terminal status; no prose or tool output can grant authority.
6. **Cancel/recovery:** Request provider interruption and distinguish request from observed terminal completion. If submission or termination outcome is unknown, transition to an explicit uncertain/interrupted state and require readback/reconciliation; never automatically issue another inference request.
7. **Usage:** Accept only measured per-run provider fields. Account-level quota/usage does not map to a run. Missing metrics and monetary cost remain unknown; never estimate a subscription charge.
8. **Selection:** Any future real adapter stays disabled by default and cannot be selected by profile text, task content, environment discovery or an untrusted event. Enabling it requires a separately reviewed capability gate and an explicit owner-approved exact run.

## Synthetic harness

`apps/worker/src/test-support/fake-codex-app-server.ts` is an in-process fixture, imported only by worker tests. It implements a bounded subset of request/response and notification shapes to exercise correlation, streaming, terminal failure, cancellation, timeout, crash, oversized frames and denied tool/control requests through the injected worker adapter boundary.

The fixture has no process-launch, network or credential API and keeps `RuntimeAdapter.kind = 'mock'`, `synthetic = true`, and usage unknown. Worker startup still directly constructs the existing sandboxed mock adapter. The fake cannot be selected through runtime configuration and is not a Codex app-server conformance test. It does not alter schemas, migrations, database grants, authorization, event provenance, run admission or CI gates.

## Codex #3 platform dependency

The requested `PHASE_1_CONNECTOR_HOST_BOUNDARY_FEASIBILITY.md` was not present in the inspected Codex #3 worktree at its observed commit. This backend change assumes no platform control has passed. Required future interface evidence includes dedicated service identity, authenticated IPC, broker-to-connector secret delivery, deny-by-default provider egress, OS-enforced no-tool confinement, resource/output limits, cancellation/crash semantics, and disposable-host negative tests. Codex #3 owns those controls; Codex #1 must not emulate them in backend code.

## Review dispositions and remaining gates

- Independent architecture reviewer: documentation/protocol assessment **APPROVE**; synthetic-only contract/harness **CONDITIONAL** with the restrictions above; real connector implementation **BLOCK**; real-provider activation **BLOCK**.
- G4-3 remains **Partially Fixed**. R1-G5 remains **Partially Complete**. ADR-0010 and ADR-0011 remain Proposed.
- A future real request additionally requires current host feasibility approval, provider-policy/consent decision, exact app-server/toolless behavior verification, backend authorization/credential architecture review, implementation review, exact-head CI and a separate owner authorization packet for that exact synthetic prompt.
- The first actual inference call remains blocked. No deployment, real-provider integration, frontend work or platform work is included here.

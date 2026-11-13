# Phase 1 Backend Connector Readiness

**Original baseline:** `7bb6e9d3a79e749b5dfaf63561bb442fde188d9`
**Latest source reassessment:** `3d37b9f0b645e86963b6174de0e3c7ff2771dbcf` (main after PRs #114, #110, and #116)
**Assessment date:** 2026-11-14
**Post-merge main CI:** [run 43487487274](https://github.com/Jeysibn/omnis-os/actions/runs/43487487274) is the post-#116 main CI run and remains in progress.
**Scope:** Backend readiness and credential-free synthetic protocol harness
**Decision:** Keep real connector implementation and real inference blocked.

This document records a source-based assessment and defines a future boundary. The test harness added with this document is an in-process simulation. It does not start Codex, authenticate to a provider, or make a network request. Its passing tests are not evidence of real app-server security.

## AO acceptance status

The only AO-101–AO-113 matrix is [PHASE_1_COMPLETION_MATRIX.md](./PHASE_1_COMPLETION_MATRIX.md), assessed at the current source SHA above. The backend detail below explains implementation boundaries and future connector requirements; it is not a second acceptance matrix. Real connector implementation and real inference remain blocked.

## Existing execution path and attachment boundary

| Stage               | Existing implementation                                                                                                                                                 | Missing for real runtime                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner authorization | API owner session and CSRF; authorizer persists owner approval.                                                                                                         | Approval is only `mock.execute`, not an exact provider operation.                                                                                                                      |
| Run admission       | `RunCoordinator.startRun` checks the authorization and `PostgresRunStore.admitRun` serializes task, grant and idempotency.                                              | Signed and replay-resistant provider-specific admission is absent.                                                                                                                     |
| Persistence         | `runs` and `run_events` are PostgreSQL-backed. Migration `0001` constrains runtime to mock, synthetic=true, usage unknown and event source mock.                        | Non-synthetic provider provenance, provider submission identity and truthful usage schema are absent.                                                                                  |
| Worker              | `apps/worker/src/server.ts` constructs `SandboxedMockRuntimeAdapter` directly.                                                                                          | No isolated connector process or API-to-connector authenticated IPC. Do not add credentials to this worker.                                                                            |
| Adapter             | `RuntimeAdapter` exposes abortable execute and event callback, but literal kind is `mock`.                                                                              | A future connector must be a separately authorized service boundary; adding a class in the current worker would inherit worker/launcher/DB authority.                                  |
| Events and SSE      | Run store sequences persisted output and SSE fills replay before live delivery. Session storage and stream registry remain process-local; support one API replica only. | External event IDs, duplicate provider event handling, provenance-safe event mapping, and shared session/revocation with cross-replica closure of already-open streams before scaling. |
| Cancellation        | Worker aborts mock process and records stop/interruption state.                                                                                                         | Provider interruption request/acknowledgement and independent observation that execution actually stopped.                                                                             |
| Recovery            | Lease recovery does not automatically replay uncertain queue submissions.                                                                                               | Provider-side request outcome reconciliation without a duplicate or billable resubmission.                                                                                             |
| Usage               | Mock is unknown; no synthetic metrics are represented as provider values.                                                                                               | Per-turn usage is not yet proven. Treat absent or aggregate-only metrics as unknown.                                                                                                   |
| Audit               | Metadata-only authorizer/run audit for mock operations.                                                                                                                 | Provider grant version, runtime/model, immutable profile revision, prompt digest, external IDs and terminal provenance. Never audit raw prompt or response.                            |

## Codex app-server protocol feasibility

### Documented

- Current documented app-server uses a client/server transport with initialization followed by `initialized`; local documentation describes stdio newline-delimited JSON. The current installed Codex CLI `0.169.0` was checked with `codex --version` and `codex app-server --help`; no app-server was started. The reviewed public contract is linked below.
- The documented lifecycle includes `thread/start`, `turn/start`, server notifications such as `item/agentMessage/delta`, and `turn/completed`. Success requires a completed status; failed and interrupted are not success.
- The current app-server protocol documents `turn/interrupt`; the terminal turn notification reports interrupted status. A request to interrupt is not proof that the upstream provider stopped processing.
- OpenAI's current SIWC documentation supports app-owned OAuth registration and consent for eligible open-source/local applications. Validate granted scopes, use the documented loopback state/nonce/PKCE flow, protect app-owned credential storage, and handle token refresh/rotation. This support does not prove any particular owner's entitlement or approval. See [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and the [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference).
- SIWC configuration sends the access token to app-server in the child process environment, after which app-server sends it to the Responses endpoint. SIWC preview requests require streaming and `store:false`. A credential broker and separate OS identity are mandatory for any future use.
- The documented app-server can execute local shell and MCP tools and coordinate child agents. It exposes filesystem, command, tool and approval-related protocol surfaces. No prompt or unverified app-server setting proves that tools are unavailable; enforce the boundary in the local host harness.
- The docs expose account-level token/activity and rate-limit reads. Those values do not establish per-run token usage or cost. Until per-turn metrics are independently proven, Omnis must record usage as unknown.
- Model catalogs may be bundled or cached and are not an entitlement check. Only a completed request would establish access, and that request is not authorized in this assignment.

### Source/installation inspected

- `codex --version` returned `codex-cli 0.169.0`; `codex app-server --help` was inspected.
- No app-server process was started and no generated schema command was run. No login status, token store, auth file, or native credentials were read. No provider endpoint was contacted.

### Not established

- The exact `0.169.0` schema and runtime behavior were not source-inspected or exercised. Public protocol docs can change independently of the installed CLI.
- The reviewed official documentation does not establish a trusted, complete no-tool switch. Protocol prompts or sandbox settings cannot be treated as proof that shell, filesystem, MCP, plugins or child-agent execution are impossible.
- This owner's account entitlement, exact-model access, owner consent, token refresh/revocation behavior, per-run usage, and external submission idempotency remain unverified. No live request is authorized. Keep real execution disabled and paid fallback off.
- No authenticated app-server was started and no inference was performed.

Official sources: [Codex app-server SIWC guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [SIWC overview and consent flow](https://developers.openai.com/siwc/token-sharing-open-source), [Codex app-server protocol reference](https://learn.chatgpt.com/docs/app-server).

## Future backend connector contract (design only)

This is an integration contract proposal, not a runtime adapter enabled by this change.

1. **Admission:** A trusted authorizer issues one short-lived decision bound to owner, runtime/version, provider, model, task, project, immutable profile version, prompt digest, empty tool set, output/time/network limits, idempotency identity and revocation generation. Missing, expired, mismatched or unverifiable decisions deny execution.
2. **Boundary:** A future connector receives a minimal authorized run envelope over authenticated local IPC. It has no runtime DB, authorizer, launcher or Docker socket, developer home, task filesystem or inherited credentials. The Docker-on-WSL confinement and identity boundary requires independent verification.
3. **Credential:** A separately reviewed app-owned OAuth flow and broker hold provider credentials outside the database, worker, connector, task workspace, events, logs and artifacts. The broker performs authorized provider requests itself; no credential reaches the execution sandbox. Never reuse installed CLI login or proxy a subscription token.
4. **Tools:** Initial operation allows no tools. Backend must reject any tool/control event. Host policy must make shell, child process, file access, MCP, browser, arbitrary network and external writes impossible; app-server’s own settings are insufficient evidence by themselves.
5. **Events:** Parse all frames against bounded schemas. Persist provider-origin events with explicit non-synthetic provenance, provider thread/turn IDs, deduplicated upstream event identity and deterministic sequence. Preserve actual failed/interrupted terminal status; no prose or tool output can grant authority.
6. **Cancel/recovery:** Request provider interruption and distinguish request from observed terminal completion. Loss of a local response does not prove the provider never executed the request; timeout, cancellation, connection loss or process termination alone cannot establish non-execution. Persist an uncertain submission as `unknown` or `interrupted` until reliable evidence supports a more specific outcome. Never automatically retry it; any later reconciliation must preserve the original submission identity and audit trail.
7. **Usage (future contract):** Label usage `measured` only when supported by an identifiable provider report or other authoritative per-run measurement; label it `estimated` only when calculated using an identified estimation method; otherwise use `unknown`. Future durable usage records must retain appropriate provenance metadata, including the measurement source for measured values and the method for estimates. Account-level quota/usage does not establish a run's usage. Unknown usage cannot automatically be recorded as zero, and unknown provider execution cannot automatically be labeled unbilled. Never estimate a subscription charge. These reporting states are not implemented by this fixture.
8. **Selection:** Any future real adapter stays disabled by default and cannot be selected by profile text, task content, environment discovery or an untrusted event. Enabling it requires a separately reviewed capability gate and an explicit owner-approved exact run.

## Synthetic harness

`apps/worker/src/test-support/fake-codex-app-server.ts` is an in-process fixture, imported only by worker tests. It implements a bounded subset of request/response and notification shapes to exercise correlation, streaming, terminal failure, cancellation, timeout, crash, oversized frames and denied tool/control requests through the injected worker adapter boundary.

The fixture has no process-launch, network or credential API and keeps `RuntimeAdapter.kind = 'mock'`, `synthetic = true`, and usage unknown. Worker startup still directly constructs the existing sandboxed mock adapter. The fake cannot be selected through runtime configuration and is not a Codex app-server conformance test. It does not alter schemas, migrations, database grants, authorization, event provenance, run admission or CI gates.

Malformed frames fail the in-process fake exchange; a missing matching response or terminal notification fails the fake interruption rather than confirming it. Its synthetic asynchronous exchange failures model failure propagation only: they do not exercise a real process, stream transport, parser, or disconnect timing.

## Codex #2 platform dependency

PR #38's host-boundary feasibility assessment is on main at squash commit `513ff457c8a1645e71db8f55ea643bd1e40b8b17`: `docs/06-delivery/PHASE_1_CONNECTOR_HOST_BOUNDARY_FEASIBILITY.md`. It selects the owner's Docker-on-WSL deployment target and retains **BLOCK for real-runtime readiness**. An independently proven host-enforced no-tool boundary, credential custody, admission, egress, process/filesystem isolation, and lifecycle controls remain unimplemented or unverified. Rootful Docker and the existing launcher remain part of the trusted computing base.

Docker Compose on WSL2 Ubuntu remains the intended deployment target. A separate VM is an optional architecture requiring a separate owner decision; KVM and VMM prerequisites have not been verified for that target. A Docker container is not automatically equivalent to a VM isolation boundary, and missing required host-isolation controls must fail closed.

No platform control is treated as passed by this backend assessment. Required future evidence includes dedicated service identity, authenticated IPC, broker-mediated provider requests without credential delivery to the sandbox, deny-by-default provider egress, OS-enforced no-tool confinement, resource/output limits, observed cancellation and crash/restart semantics, and disposable-host negative tests. Codex #2 owns the Docker/gateway/WSL2 platform controls; Codex #1 owns the authorization and broker contracts.

## Review dispositions and remaining gates

- Historical independent architecture review: documentation/protocol assessment **APPROVE**; synthetic-only contract/harness **CONDITIONAL** with the restrictions above; real connector implementation **BLOCK**; real-provider activation **BLOCK**. This is not an approval of a current provider operation or host boundary.
- G4-3 remains **Partially Fixed**. R1-G5 remains **Partially Complete**. ADR-0010 and ADR-0011 remain Proposed.
- A future real request additionally requires current host feasibility approval, provider-policy/consent decision, exact app-server/toolless behavior verification, backend authorization/credential architecture review, implementation review, exact-head CI and a separate owner authorization packet for that exact synthetic prompt.
- The first actual inference call remains blocked. No deployment, real-provider integration, frontend work or platform work is included here.

The latest main-based source audit, current app-server feasibility evidence, offline fixture contract, Stage A review disposition, and Codex #2 / Claude handoffs are documented in [P0-R1 Codex App-Server Offline Contract and Feasibility](P0_R1_CODEX_APP_SERVER_OFFLINE_CONTRACT.md). That document is the current P0-R1 contract; it does not enable or authorize inference.

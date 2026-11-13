# Phase 1 Real-Run Readiness and Runtime Gate

**Assessment date:** 2026-11-14
**Reviewed main:** `c8a168bfd12801f8b5ab374af2d79d91ea4bfee5` (PRs #114 and #110 merged)
**Post-merge main CI:** [run 43483785571](https://github.com/Jeysibn/omnis-os/actions/runs/43483785571) — passed all ten required jobs.
**Decision:** No real runtime is approved. Keep provider execution disabled and paid fallback off. Docker-only WSL2 remains the final target.

This is a source-and-policy review, not runtime acceptance. Mock integration, disposable-host CI, and an installed CLI version do not establish account entitlement, provider safety, or authorization to submit a request. The single AO-101–AO-113 acceptance matrix is [PHASE_1_COMPLETION_MATRIX.md](./PHASE_1_COMPLETION_MATRIX.md).

## R1 real-runtime gate

R1 remains blocked. The application production path is still constrained to mock/synthetic execution. Before any live request, resolve the policy, consent, credential, tool, host-boundary, event, cancellation, recovery, and owner-acceptance gates below. This document records their evidence; the canonical AO status and exact source SHA remain in the matrix.

### Source-level runtime gates

- `packages/runtime-adapters/src/index.ts:3-5` types the adapter kind as only `'mock'`.
- `packages/db/migrations/0001_initial.sql:14-23,43-54` constrains runs to `runtime_kind = 'mock'`, `synthetic IS TRUE`, unknown usage, and events with `source = 'mock'` and `synthetic IS TRUE`.
- `packages/contracts/src/index.ts` keeps run, event, and authorization contracts synthetic/mock-only.
- `apps/worker/src/run-coordinator.ts` admits only an owner authorization for `runtimeId === 'mock'` and `mock.execute`, then checks the same authorization before execution.
- `packages/db/migrations/0011_authorized_mock_sandbox_launch.sql` grants the Docker-capable launcher one constrained mock launch. This is not a generic provider connector or safe place to store provider credentials.

These are deliberate fail-closed constraints. Do not relax them as part of a documentation or compatibility change.

## Codex app-server candidate and current policy evidence

The current WSL Codex CLI reports version `0.169.0` (`codex --version`); `codex app-server --help` was inspected. No app-server process was started. No login status, token store, auth file, or native credential was read; no provider endpoint was contacted and no inference was sent. The prior 2026-11-05 inventory reported CLI `0.166.0`; that version is historical.

Current official OpenAI documentation supports an app-owned Sign in with ChatGPT flow for eligible open-source/local applications. It describes dynamic client registration for first use, user-visible permission consent, validation of the granted scope (including `chatgpt.tokens.use.direct` for direct token use), loopback callback with state/nonce/PKCE, and protected app-owned token custody. The current token reference describes roughly one-hour access tokens and 30-day rotating refresh tokens. This documents a supported integration path; it does not prove this account's entitlement, model access, or owner consent. See [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

The app-server can use local shell and MCP tools and can coordinate agents; a prompt or app-server setting is not proof that tools are unavailable. SIWC preview requests require streaming and `store:false`. Credential custody would send the access token only to the isolated app-server child process, never to Omnis logs, task workspaces, events, source control, or the synthetic worker. No third-party token tunnel or native CLI credential reuse is allowed. App-server thread history is not Omnis durable run state. Model lists, account quota, and sign-in status do not prove per-run entitlement or usage. Until authoritative per-run usage is demonstrated, record usage as unknown.

**Disposition:** Codex app-server is the first feasibility candidate, not an approved runtime. Keep real execution disabled by default and paid fallback off. The owner's account entitlement, exact model/request eligibility, app registration/consent, credential custody, and enforceable no-tool/access restriction remain unverified. Claude background execution remains disabled pending current plan/Agent SDK policy review and approval. Hermes is not selected. The next work is offline contract/fixture validation, then authorized Linux VM feasibility; neither permits a provider request.

## Required security closure before any provider call

1. **Provider policy and consent:** Record the selected runtime/version/model, applicable terms, OAuth client registration, account/workspace eligibility, plan-usage disclosure, retention/data controls, and the owner’s explicit consent to use Omnis OS. Never reuse a CLI’s native OAuth store.
2. **Authorization:** Add a provider-specific, single-run operation and approval receipt bound to the exact runtime/model, immutable profile version, project/task, prompt or prompt digest, allowed tools (empty for first run), output/time limits, expiry, and idempotency ID. Sign/bind the API-to-authorizer decision; prevent replay; exercise key rotation and revocation. Failure or uncertainty must deny/stop and require authenticated readback, not a fresh inference retry.
3. **Credential custody:** Implement an independently reviewed broker that holds SIWC refresh credentials outside Omnis PostgreSQL, events, logs, artifacts, task workspaces, worker env and launcher env. Deliver only the minimum short-lived access token to the isolated connector child using an OS-protected channel; scrub crash reports and diagnostics.
4. **Host boundary:** Connector has its own unprivileged OS identity, root-owned executable/dependencies, isolated home and temporary workspace, no Docker/launcher/authorizer sockets or database credentials, no access to developer home, and bounded provider-only egress. A failure of policy check, broker, isolation, egress enforcement or revocation fails closed.
5. **Tool-free guarantee:** Prove with negative tests and host controls that a model tool call cannot spawn shell, access files, MCP, browser, network destinations, or mutate anything. Do not rely on system prompt, a prompt to “not use tools,” CLI UI settings, or the model’s compliance.
6. **Durable truthful events:** Add non-synthetic provider provenance with external run/session mapping, deduplicated streaming events, terminal reconciliation, bounded output, cancellation, and recovery that never duplicates an uncertain provider submission. Preserve mock-only tests and migrations.
7. **Usage and acceptance:** Parse vendor-reported usage if exposed; otherwise store `unavailable`/`unknown`. Do not invent costs. Validate the run via the approved synthetic task, refresh/restart recovery, cancellation, audit, credential canaries, and exact-head CI.

The first provider request itself remains a separate approval gate. It must identify the exact provider, runtime, version, model, prompt, isolated environment, limits, tool policy, and usage/cost disclosure. This readiness PR authorizes no provider call.

## Shortest safe next steps

1. Codex #3 completes the [host/connector feasibility handoff](CODEX_3_PHASE_1_CONNECTOR_BOUNDARY_HANDOFF.md) and returns evidence for the proposed service identity, secret channel, egress and isolation on a disposable environment.
2. Codex #1 performs a Codex app-server no-tool feasibility design using stubs/local protocol fixtures only; no user token and no inference. Confirm SIWC registration/policy requirements with the owner before implementing auth.
3. Independent reviewer re-checks the resulting provider-scoped authorization and credential path before executable provider code is added.
4. Implement one disabled-by-default adapter and deterministic provider-stub tests only after those reviews pass. Keep `mock` the default and add a database/API flag that cannot be enabled by profile content.
5. Run full exact-head CI and independent implementation review. Then prepare a separate owner packet for one real synthetic request; do not send it until the owner authorizes that exact request.

## Review and scope

- Architecture checkpoint verdict: **BLOCK** for implementing or activating a real runtime on this baseline. The reviewer separately stated that a readiness matrix, documentation, and platform handoff can proceed as safe scope; this is not runtime approval.
- No executable provider integration, schema relaxation, CI change, frontend change, or provider inference is part of this increment.
- Keep **G4-3: Partially Fixed** and **R1-G5: Partially Complete**. ADR-0010 and ADR-0011 remain Proposed.
- Current open workstreams inspected: PR #25 and #31 are frontend; PR #36 and #26 are platform/integration/tooling. No files from those workstreams are changed by this assessment.

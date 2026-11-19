# AO-107 Real-Runtime Provider Decision Comparison

**Status:** Decision package; no real provider is enabled.  
**Prepared:** 2026-11-19  
**Scope:** Provider authentication and first bounded read-only model operation under the existing local WSL2/Docker-only Phase 1 design.

## Decision requested

Choose whether to resolve eligibility for **OpenAI Sign in with ChatGPT (SIWC), direct Responses API** as the OAuth-first candidate. This is not approval to implement OAuth, register a client, access credentials, activate a provider, make a provider request, or run on the target host.

The recommendation is conditional because it is the only evaluated option with official end-user OAuth consent specifically documented for an open-source agent client using the user's ChatGPT plan. Eligibility of the Omnis OS app, the owner's account/workspace, and the planned read-only task has not been established. Keep the runtime disabled until those are answered and Codex #3 independently accepts the host boundary.

## Existing Omnis OS controls and gaps

The current backend has synthetic fixtures for immutable task/profile/prompt binding, a fixed synthetic connector identity/version/operation, an empty tool/capability set, bounded limits, one-use grant consumption, expiry/revocation, and preservation of unknown outcomes. Those fixtures verify backend behavior; they do not establish host-enforced production controls or provider evidence. Ordinary Runs remain `runtimeKind: "mock"`, `synthetic: true`, and unknown for token/cost usage.

The current runtime authorization and host-boundary documents identify missing production controls: durable real-operation authorization fencing, credential brokerage and revocation, trusted connector process identity, effective cancellation evidence, network egress enforcement, and independently verified containment. Docker daemon access remains host-equivalent authority. This memo does not change those controls or the platform-owned documents.

## Candidate comparison

| Candidate | Official consent and credential authority | No-tool, scope, and network constraints | Cancellation, events, usage, and billing | WSL2/Docker fit and disposition |
|---|---|---|---|---|
| **OpenAI SIWC + direct Responses API** | OpenAI documents a public-client OAuth flow for open-source and locally hosted apps: first registration uses `dynamic_agent_client`, returns an issued client ID, uses a system browser and loopback callback, and requires fresh state, nonce, and PKCE. The user reviews requested permissions; inference requires the granted `chatgpt.tokens.use.direct` scope. No client secret or partner API key is required. Tokens must be stored in protected local/self-hosted runtime storage. Refresh tokens rotate; sign-out can revoke the renewable session through the documented OIDC revocation endpoint. This is app-owned consent, distinct from reading or reusing Codex CLI state. **Omnis eligibility is unverified:** the repository is public, but this checkout has no root `LICENSE` file or package license declaration, so public availability alone does not establish open-source eligibility. OpenAI says paid or remotely hosted apps should use its interest form. Owner-account eligibility is also unverified. | Direct Responses API uses the public `/v1/responses` endpoint, `store:false`, and streaming. Its documented SIWC route accepts function/custom tools and `additional_tools`; therefore Omnis must omit all tools and validate upstream requests/events itself. The docs do not establish that the API can enforce Omnis' host isolation or operation grant. The connector must have egress only to the approved OpenAI auth/API endpoints and no API/Worker access. | Success requires terminal `response.completed`; `response.failed`, incomplete streams, lost responses, and usage-limit errors must remain distinct. The reviewed SIWC docs do not establish a provider-side cancellation receipt or a per-operation idempotency/readback mechanism. Model catalog is not proof of entitlement; successful completed inference proves access for that request. Account limits are shared with other apps for at least some subscription plans, and app-level quotas/allowances vary. Do not claim per-run measured usage unless an authoritative response field is received and validated; otherwise usage stays unknown. | Potentially compatible if the app is confirmed eligible and the API call and credential broker run inside Codex #3's independently isolated connector boundary with bounded egress and no token in API, Worker, task container, logs, or artifacts. Direct Responses is preferable to Codex app-server for this initial no-tool operation: app-server can execute local shell/MCP tools and child agents. **Conditional candidate**, not approved; eligibility is a blocker to implementation. |
| **Google Gemini via Agent Platform / Vertex AI** | Official authentication supports Google Cloud ADC, gcloud user credentials, service-account impersonation, attached service accounts, and workload identity federation. These are Google Cloud principals/credentials, not the user's Google consumer OAuth consent for a Gemini subscription. Never import an existing `gcloud`/ADC login. A separately provisioned GCP project, IAM principal, billing relationship, and owner-authorized credential flow would be needed. | IAM scopes access to cloud resources and is not the Omnis one-operation grant. Omnis still needs its own immutable one-use operation authorization. A single model-generation request can be submitted without tools, but no-tool behavior must be enforced by the Omnis connector and host boundary. Network egress must be restricted by the platform. | Provider request cancellation/terminal proof and request-level idempotency/readback were not established in this review; an interrupted request must remain unknown. Pricing is billed to the Google Cloud project and varies by model/region/usage. Any provider-reported usage must be validated; otherwise Omnis remains unknown. | Technically possible only with a separately approved cloud project and credentials. Adds project/IAM/billing setup and is not the best match for OAuth-first per-user consent. **Fallback candidate** if SIWC is unavailable and the owner explicitly accepts operator/project billing. |
| **Anthropic Claude Agent SDK / Claude Code** | Anthropic's current legal guidance says third-party Agent SDK users should use Claude API or supported cloud-provider credentials; Claude subscription credentials are not a permitted credential source for an independent third-party SDK integration absent an agreement. Do not reuse `claude login` or CLI OAuth state. A supported API key or provider-owned cloud identity would be a different, paid/commercial path, not OAuth-first. | The Agent SDK includes Claude Code capabilities such as built-in tools, permissions, sessions, and hooks. That is broader than the required fixed no-tool operation and would require additional host enforcement. Omnis operation authorization remains necessary. | SDK exposes cost/usage tracking hooks, but no provider cancellation receipt or idempotent re-read contract was confirmed for this comparison. The chosen API/cloud agreement determines billing. | Not recommended for the OAuth-first objective. Revisit only with a separately approved commercial/API-key or cloud-provider arrangement and a narrower no-tool integration. |
| **OpenAI Platform API key (fallback)** | Official API-key auth is provider-supported but does not provide user OAuth consent and is billed under the API account/project. Key custody would require a dedicated secret broker and explicit owner-approved budget. A ChatGPT/Codex login cannot substitute. | Direct Responses without tools can fit a bounded call, but API-key authority is broader than one operation; Omnis must enforce the immutable grant, exact endpoint/model, empty tool list, and host egress. | Use provider response IDs and validated usage only where documented; a timeout after submission remains unknown unless authoritative readback resolves the same request. Billing is metered API project usage, not a ChatGPT subscription allowance. | Plausible technically if the owner accepts separate API billing and Codex #3 accepts the egress/secret boundary. It is not the preferred OAuth-first path. |

## Recommended first-operation shape (proposal, not implemented)

If the owner chooses SIWC, the first real operation should be a single direct Responses API request from a dedicated connector process. Do not place the OAuth token in API or Worker memory, connector arguments, environment inherited by an agent/tool runtime, task workspace, database, event, log, or artifact. The credential broker should release a short-lived access token only to the connector's provider-call boundary, after atomically consuming the exact operation grant. The broker/connector must not be a general-purpose token proxy.

The grant and audit record should bind, at minimum:

- Owner identity, affirmative consent record, and consent timestamp.
- Immutable task ID/version, profile ID/version, exact prompt digest, input digest, and requested output boundary.
- Connector ID/version, provider, account/client registration identity, model, endpoint, and exact permitted operation.
- Unique authorization ID, operation/submission ID, audience, policy version, short expiry, revocation generation, resource limits, and a durable one-use consume-before-network-call state transition.
- `tools: []`, no MCP, shell, browser, file-system, child-agent, or other tool capabilities; request schema rejects unknown tool fields.
- Hard duration/output limits, one active operation, one provider request, and host-enforced provider-only egress.
- Provider stream/event identifiers, terminal status, and only provider-sourced usage fields with explicit provenance.

A local stop click or closed HTTP stream is only a cancellation request. Until the provider documents and returns authoritative interruption evidence, mark an interrupted submission `unknown`, preserve its original operation ID and audit, and never automatically resubmit. Recovery may read back only that same provider operation if the provider provides an authenticated lookup; otherwise owner reconciliation is required.

## Synthetic verification versus platform-dependent acceptance

| Can be verified without a provider or privileged host | Requires Codex #3 platform evidence and/or owner approval |
|---|---|
| Strict grant schema and binding rejection; atomic one-use consume/expiry/revoke races; no re-consumption on retry; synthetic callback fixtures; empty-tool payload construction; unknown outcome preservation; no automatic resubmit; event provenance and usage-null behavior; redaction tests; credential-broker interface tests using fake credentials only. | Host/process identity and generation; protected credential storage and scoped delivery; provider-only network egress; no route from API/Worker or tools to token/API; Docker/WSL2 isolation; trusted termination and descendant absence; durable anti-rollback authorization fence; actual provider consent, scope, entitlement, renewal/revocation, cancellation, response usage provenance, and billing behavior. |

Do not treat synthetic tests as acceptance evidence for the second column.

## Decisions and blockers

### Owner decisions

1. Authorize an eligibility check for **OpenAI SIWC direct Responses API**, or decline it and select a paid API/cloud option for further comparison. No provider is ready for implementation until this eligibility question is resolved.
2. Resolve app eligibility before any SIWC implementation: determine whether Omnis OS qualifies as an open-source, locally hosted app under OpenAI's published terms (including licensing the public repository if appropriate), or submit the official interest form if the planned distribution is paid or remotely hosted. Confirm that the owner-controlled ChatGPT account/workspace is eligible and accepts plan usage by this app; explicitly consent to the named app and scope in OpenAI's own authorization UI. No CLI credentials may be reused.
3. Approve exact read-only task, prompt, profile, model, maximum input/output, maximum duration, one-request concurrency, and any shared-plan usage/billing impact.
4. Approve a credential-custody/revocation policy and identify the dedicated secret-broker owner. This does not authorize live OAuth or provider calls by itself.
5. After independent platform acceptance, issue a separate exact-scope authorization for a single real read-only run. No standing authorization is implied.

### Codex #3 platform dependencies

- Name the trusted connector and credential-broker processes, identities, lifecycle, and authenticated local IPC contract.
- Prove API/Worker cannot access the Docker socket, provider token, broker secret store, or provider endpoint.
- Prove only the fixed connector can reach named authentication/API endpoints, with DNS/IP/TLS behavior and redirect policy defined.
- Prove hard time, output, memory/CPU, and concurrency limits; admission fencing; revocation propagation; and independent process/descendant termination evidence.
- Define durable authorization journaling/anti-rollback and recovery after service, database, or host restart.
- Provide accepted target WSL2/Docker evidence under the separately approved platform procedure. This memo modifies no platform-owned documents.

### Provider questions still unverified

- Whether SIWC currently accepts Omnis OS for dynamic app registration and the owner's account/workspace for requested direct-plan scope.
- Whether this public repository qualifies as open source for SIWC; no repository license is present in the inspected baseline.
- Exact credential custody allowed for this local WSL2 product and whether the selected storage mechanism meets OpenAI's published expectations.
- Whether SIWC's direct Responses API provides a provider-confirmed cancellation or same-operation readback primitive suitable for recovery.
- Which final response fields constitute authoritative per-run usage for this route and how plan-credit/limit outcomes are represented.
- Whether the app's read-only task and data handling meet current provider terms and plan/workspace controls.

## Recommendation

No provider is ready for implementation. SIWC direct Responses is the only evaluated OAuth-first candidate, but Omnis' eligibility is not established because the inspected repository has no license declaration. Resolve that eligibility first. If eligible, keep any future design single-request, direct, stateless, streaming, and tool-free. If it is not eligible, require a separate owner decision for the OpenAI interest process or metered API-key/cloud-project billing rather than falling back silently. No live integration is enabled.

## Sources

- OpenAI, [SIWC registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- OpenAI, [SIWC accounts, sessions, revocation, and credential security](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- OpenAI, [SIWC direct Responses API and completion handling](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- OpenAI, [SIWC preview limitations and app-server capabilities](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- Google Cloud, [Agent Platform authentication](https://docs.cloud.google.com/gemini-enterprise-agent-platform/machine-learning/authentication)
- Google Cloud, [Generative AI model pricing](https://cloud.google.com/model-garden/pricing)
- Anthropic, [Claude Code legal and commercial terms](https://code.claude.com/docs/en/legal-and-compliance)
- Anthropic, [Agent SDK authentication requirements and tool model](https://code.claude.com/docs/en/agent-sdk/quickstart)
- Anthropic, [Agent SDK overview and built-in capabilities](https://code.claude.com/docs/en/agent-sdk/overview)
- Omnis OS, [Runtime authorization architecture](../02-architecture/RUNTIME_AUTHORIZATION.md)
- Omnis OS, [Runtime authentication policy](../02-architecture/RUNTIME_AUTH.md)
- Omnis OS, [Backend Phase 1 workstream audit](./PHASE1_BACKEND_WORKSTREAM_2026-11-19.md)

# AO-107 Codex #3 Handoff — SIWC Local Runtime Contract

- **Contract revision:** `omnis.ao107.local-runtime-handoff.v1`
- **Owner:** Backend/Security (Codex #1)
- **Status:** Proposed interface contract for platform review; no real provider, OAuth flow, credential store, or host integration is enabled.
- **Boundary:** Codex #3 owns host isolation, identity establishment, egress, process registration, and termination evidence. This document does not alter Codex #3's platform-owned documents.

## Why this handoff exists

OpenAI's November 4, 2026 SIWC Terms require local persistent credential storage under the user's control, a runtime controlled by the user, requests tied to that authenticated user, and express consent before background use. OpenAI's SIWC overview says `ext_agent_host_id` identifies a host for usage attribution but is not an authentication credential; OpenAI does not verify possession of a public key from which the ID was derived.

Omnis OS currently targets a single-owner local WSL/Linux install. Its current API, Worker, Authorizer, and synthetic broker are not separate host trust principals: the authorization architecture records that local processes share a Unix identity and the Worker has root-equivalent Docker authority. There is no real SIWC token store or credential broker. Company-management status of the Windows/WSL machine is unknown. These facts prevent us from asserting that today's WSL2 installation satisfies the user-control and token-storage terms.

## B2 identity-continuity contract

A real operation must preserve one identity chain from owner consent to the exact provider submission. Every boundary must compare authoritative values; a caller-supplied string, database field alone, `ext_agent_host_id`, Docker label, or process-local session is not proof of identity.

| Identity layer                        | Required immutable binding                                                                                                                                                                                                     | Evidence source and rules                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner principal**                   | The existing single local owner principal that requested and explicitly approved this operation.                                                                                                                               | Derived from the authenticated owner session and CSRF-protected route. Never accept an actor from the browser or worker. Do not persist cookies or session secrets. Reauthentication/account change invalidates pending approvals.                                                                                            |
| **SIWC account and app registration** | Verified OpenAI `sub`, the issued `client_id`, and the account/workspace registration represented by that client. Bind these to one opaque Omnis `credentialConnectionId`.                                                     | Broker completes OpenAI's documented OAuth flow and validates signature, issuer, audience/client ID, nonce, expiry, selected account, and granted `chatgpt.tokens.use.direct` scope. Email is not an account/workspace identity. Do not use a Codex CLI token or undocumented endpoint. Tokens stay in the credential broker. |
| **Local host**                        | A stable Omnis `hostPrincipalId` for one installation plus a monotonic `hostGeneration`/registration revision. The selected SIWC `ext_agent_host_id` is separately stored for OpenAI usage attribution.                        | Codex #3 must authenticate possession/control of the platform host identity across IPC and restarts. `ext_agent_host_id` is metadata only and cannot authenticate the host. Restored/cloned state that cannot prove continuity must be quarantined and require fresh registration/authorization.                              |
| **Process/runtime**                   | The platform-authenticated role (`authorizer`, `credential-broker/connector`, `terminator`), process-instance identity, host generation, and registered execution scope.                                                       | Codex #3 establishes peer identity and process registration outside API/Worker control. A PID, container ID, Unix UID, Docker label, or signed envelope alone is insufficient. Restart changes process-instance identity; recovery must prove the same persisted attempt and current host registration.                       |
| **Task and operation**                | Owner, project/task IDs and revisions, assignment/agent ID, profile version, exact rendered prompt/input digest, connector ID/version, provider/account registration, model, exact operation, limits, and tool/capability set. | Backend's authorizer signs the exact immutable binding and consumes one authorization/attempt before provider contact. Changed content, identity, host generation, connector, credential connection, model, operation, policy, or limits requires fresh owner approval.                                                       |

The current synthetic signed envelope already binds owner principal/decision, task/project revisions, immutable profile version, prompt digest, fixed connector/provider/model/operation, empty capabilities, bounded limits, one-use attempt, expiry, and nonce. It intentionally fixes the audience and provider to the synthetic broker. It does **not** prove the host/IPC peer or process generation. Platform identity is therefore a missing integration dependency, not something an `ext_agent_host_id` can fill.

## Credential broker boundary

1. For the first operation, the credential broker and connector are one dedicated process. It is the only process that completes SIWC OAuth, persists/refreshes/revokes tokens, and sends the narrowly defined provider request internally; it never returns or hands a token to a separate connector. OAuth callback handling is local loopback and bound to the exact pending state/nonce/PKCE/client registration.
2. Persistent tokens remain in an OS-protected local store owned by the confirmed user-controlled environment. Do not store them in PostgreSQL, Compose/Docker volumes shared with application services, app/worker environment, task files, artifacts, logs, browser storage, or support output. If the device is managed or backed up by an employer, stop until the owner confirms the Terms permit the custody model or OpenAI clarifies it.
3. The broker exposes a typed, one-operation interface. It does not return a token to API, Worker, task runtime, agent, tool, or arbitrary caller; it does not accept arbitrary URLs, headers, models, or tool definitions. This is not a general-purpose token proxy.
4. Account selection and refresh rotation are serialized per connection. Revocation first fences new use and updates the durable revocation generation, then attempts the documented remote revocation and stops local use. Unconfirmed remote revocation is reported as unconfirmed; no new request is admitted.
5. The synthetic broker remains fake-only. No change to existing OAuth state or importing CLI credentials is permitted.

## Egress, operation, and tool restrictions

- The first proposal is one direct OpenAI Responses API text request, `store:false`, streaming through its terminal event, with the exact approved model and no `tools`, `additional_tools`, MCP, browser, shell, filesystem, child-agent, or external-write capability.
- Reject unknown provider request fields and any tool/function/control event. Do not rely on a system prompt or UI configuration to enforce an empty tool set.
- API, Worker, task/sandbox containers, and frontend cannot reach the SIWC token endpoint or Responses API. Only the single credential-broker/connector process principal may egress to the exact OpenAI authorization metadata/JWKS/token endpoints needed for the approved OAuth lifecycle and `api.openai.com/v1/responses`; Codex #3 must define and verify DNS, TLS, redirect, proxy, and IP policy without broad internet access.
- OAuth sign-in is a separate user-initiated flow. During execution, only the single provider call is allowed. No provider failover, retries after a potentially sent request, recurring task, scheduler, or user-to-user plan sharing.

## Execution, termination, revocation, and unknown outcomes

1. A grant records a durable unique authorization ID, operation/submission ID, audience, policy version, owner consent, host principal/generation, process role, credential connection ID, immutable task/profile/prompt/connector binding, expiry, revocation generation, and hard request/time/output/concurrency/usage limits.
2. PostgreSQL atomically consumes the exact grant and creates one attempt before a provider request can be sent. The platform authenticates the connector IPC peer independently of the signature and confirms its current host/process registration. Failure at either check means no provider contact.
3. Platform registration binds the attempt to an exact process scope and deadline. Codex #3 supplies start and termination evidence from a terminator independent of API, Worker, connector, Gateway, and Engine control. The evidence must identify the registered process generation and establish that all descendants are absent. A Run state, HTTP close, timeout, `docker stop` response, container removal, missing PID, or local abort is not proof of provider cancellation or process termination.
4. Revocation fences future dispatch at a durable monotonic revision. If a provider operation may already have been submitted, persist `unknown` against the same attempt/submission ID until authenticated same-operation evidence resolves it. Never resubmit automatically. Reconcile only through provider-supported readback for that same operation, if available; otherwise require owner reconciliation.
5. Cancellation is two distinct facts: owner requested cancellation, and provider/host reported a terminal interruption. Do not report `cancelled` until the required provider result and local process termination evidence are both known. If either is missing or contradictory, preserve `unknown` and fence replacement work.
6. Provider events must be strictly schema-validated, ordered, idempotently deduplicated, and auditable with provider source/response ID. Redact payloads and secrets. Per-run usage is measured only from an authoritative response field; ChatGPT Settings app-level usage, account quota, partial stream, or absence of a usage field is not per-run evidence and remains `unknown`.

## Synthetic checks versus platform acceptance

**Backend/provider-neutral checks already covered synthetically:** owner/session/CSRF gate; immutable task/project/profile/prompt binding; fixed connector identity/version and operation; empty capability tuple; one-use consume, expiry, revocation; replay/duplicate protection; redacted audit; cancellation request versus interruption; unknown outcome persistence; and no automatic submission retry.

**Still requires a backend change once the platform interface is agreed:** binding a verified host principal, host generation, process role/instance, and opaque SIWC credential-connection identity into the authorization/dispatch/audit path. Adding caller-supplied identity fields now would not prove identity, so this should follow Codex #3's authenticated IPC and registration contract rather than pretend the synthetic backend can attest to platform state.

**Codex #3 acceptance evidence:** demonstrate identity continuity across start/restart/restore; raw socket and direct egress denial from API/Worker/tools; token unreadability outside the broker identity; exact egress allowlist and redirect denial; process registration and independent descendant termination; revocation ordering; stale/cloned host rejection; rollback/quarantine behavior; and credential-canary absence from guest-visible logs, outputs, and events. Target WSL2 tests remain subject to separate exact-scope authorization.

## Immediate questions for platform review

1. What platform-generated host principal and generation are authoritative, and how are they protected against WSL snapshot/clone/restore?
2. How does the platform authenticate the single SIWC credential-broker/connector process over IPC, and what prevents API/Worker/Docker-daemon principals from impersonating it?
3. Can the broker's protected token store remain local and outside employer-managed/remote backup on the actual Windows/WSL installation? What evidence establishes that?
4. What independent terminator can prove both connector descendants are gone and what provider operation state is known?
5. Which exact read-only operation and event/usage fields can the platform safely return to the backend without exposing credentials or raw provider payloads?

## References

- OpenAI, [SIWC Terms effective November 4, 2026](https://openai.com/policies/sign-in-with-chatgpt-terms/)
- OpenAI, [SIWC cookbook: personal local projects, open-source projects, and selected private apps](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- OpenAI, [SIWC host identity overview](https://developers.openai.com/siwc/token-sharing-open-source)
- Omnis OS, [Runtime authorization architecture](../02-architecture/RUNTIME_AUTHORIZATION.md)
- Omnis OS, [Synthetic broker contract](../07-governance/PHASE1_PR_B_BROKER_CONTRACT.md)
- Omnis OS, [Phase 1 backend workstream audit](./PHASE1_BACKEND_WORKSTREAM_2026-11-19.md)

# Docker-Only Execution-Disabled Backend Contract

This contract defines the restricted application mode used for non-execution development. It does not authorize host execution, real providers, deployment, or Phase 1 R1 acceptance.

## Configuration

`OMNIS_EXECUTION_MODE` accepts `disabled` or `mock`.

- Missing or empty configuration resolves to `disabled`.
- Any other value fails API or Worker startup.
- The API and Worker modes must match. A mismatch reports execution as unavailable; the API rejects Run admission.
- `mock` requires an absolute `OMNIS_SANDBOX_LAUNCHER_SOCKET` and an explicit, separately configured launcher socket mount. The base Compose file remains `disabled`; the explicit `docker-compose.mock-execution.yml` overlay opts both API and Worker into `mock`.
- `OMNIS_COMPOSE_PRIVATE` controls private network binding only. It does not enable or disable execution.

## Service behavior

### API

The API remains available for ordinary owner-authenticated application operations subject to their existing dependencies. `/api/v1/health` is a liveness response for the API process; it does not claim Worker, Authorizer, queue, launcher, or execution readiness.

`POST /api/v1/runs` retains owner authentication and CSRF/mutation protection. In `disabled` mode it returns `503 execution_disabled` before Authorizer probing, Worker forwarding, Run admission, or grant consumption. In `mock` mode it checks Authorizer health and returns `503 authorization_unavailable` if the Authorizer is unavailable, before forwarding the request.

### Worker

The Worker continues to serve ordinary persistence-backed application functions.

In `disabled` mode:

- No launcher client or runtime adapter is created.
- No pg-boss instance is constructed, started, or asked to create a queue.
- No execution queue consumer or execution recovery timer is started.
- Startup does not read or mutate pending/in-flight Run state.
- Run admission returns `503 execution_disabled` before authorization lookup, enforcement-denial recording, Run admission, queue insertion, or launcher invocation.
- A direct stale queue callback is a no-op; the disabled process never consumes the queue.

Pending and in-flight records retain their persisted state while disabled. A stored `running` state is not proof that its former process stopped. When an explicitly enabled mock Worker starts, its normal recovery runs; queued jobs from older Worker sessions are interrupted before Run lookup, authorization lookup, or execution. They are not replayed automatically. A mode transition requires stopping all earlier enabled Worker consumers; the session fence is process-local and is not a multi-worker global revocation mechanism.

In `mock` mode, the existing persisted owner authorization, task/scope checks, queue admission, session fencing, sandbox launcher boundary, and synthetic result rules remain in force. A healthy capability report does not authorize any individual Run; each Run still requires its valid persisted owner grant.

## Capability and health semantics

The owner-protected `GET /api/v1/runtime-capabilities` returns strict schema `omnis.runtime-capabilities.v3`. It does not create a Run.

- `services.api` means this capability request reached the API.
- `services.worker` reports Worker/database service readiness; if the Worker status endpoint is unavailable, its mode is unknown and execution is unavailable.
- `execution.configuredMode` reports API configuration; `execution.workerMode` reports Worker configuration. A mismatch is unavailable.
- `execution.capability` is `disabled`, `mock_synthetic`, or `unavailable`.
- `execution.availability` is `disabled`, `available`, or `unavailable`.
- `execution.queueAvailability` and `execution.launcherAvailability` report dependency state without exposing paths, credentials, or host details.
- `authorization.availability` is a read-only Authorizer health result. `available` means the Authorizer health endpoint responded; per-Run approval is still required.
- `syntheticConnectorFixture.enabled` is true only when its test-only switch is enabled and mock execution dependencies are available.

`available` means the configured mock execution dependencies responded to health checks. It is not a host containment/security acceptance result, a valid Run grant, a production/provider capability, or evidence that an earlier in-flight process terminated.

The Worker’s authenticated `/internal/v1/health` is a liveness check for Compose. It does not establish execution capability. The capability API is the readiness contract for downstream UI and integration decisions.

## Downstream integration

### Codex #3 — Compose

- Keep the API and Worker services present; do not omit the Worker to obtain a healthy-looking API.
- Keep the base Compose mode `disabled` and do not mount the launcher socket in that configuration.
- Use the explicit mock overlay only for a separately authorized mock-execution configuration. It sets both API and Worker to `mock` and adds only the existing launcher UDS mount.
- Treat Compose health checks as process liveness. Read the owner-protected capability endpoint for effective service, authorization, queue, launcher, and execution status.
- Do not add Docker socket mounts, privileged containers, host configuration, or provider credentials.

### Claude #2 — Frontend

- Parse the v3 response with `RuntimeCapabilitiesSchema`.
- Disable or hide Run controls when `execution.availability` is `disabled` or `unavailable`; show a truthful reason based on the non-sensitive capability fields.
- Keep ordinary project/task/profile views available when their API dependencies are healthy.
- Treat `authorization.availability` separately from execution availability. A healthy Authorizer does not constitute approval for a Run.
- Keep synthetic connector controls gated by `syntheticConnectorFixture.enabled`; do not infer execution availability from the word `mock`.

## Verification boundary

Offline API, Worker, and contract tests may verify these contracts. Docker lifecycle, database-mutating integration, privileged host, WSL2 ingress/termination, and real-provider checks remain separately gated. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

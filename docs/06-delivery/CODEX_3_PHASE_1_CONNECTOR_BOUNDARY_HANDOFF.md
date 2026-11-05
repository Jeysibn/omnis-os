# Codex #3 Handoff — Phase 1 Provider Connector Host Boundary

**Requested by:** Codex #1, backend/security integration owner
**Baseline:** `7bb6e9d3a79e749b5dfaf63561bb442fde188d9b`
**Status:** Design/feasibility request only. Do not provision the developer host, start a provider, or enable inference.

## Objective

Assess a separate, unprivileged connector service boundary for a future single-owner, text-only Codex app-server request. This is a platform feasibility handoff, not authorization to implement or run the provider. Return evidence and blockers before Codex #1 changes runtime authorization or database contracts.

## Non-negotiable boundaries

- Do not grant provider credential access to `omnis_runtime`, the worker, sandbox launcher, Docker daemon, or task workspace.
- Connector identity must not belong to Docker, `omnis-authorizer-socket`, `omnis-launcher-socket`, or database administration/runtime groups.
- Do not pass provider credentials in Omnis database records, environment files, job payloads, SSE, event messages, logs, crash reports, artifacts, or test fixtures.
- Do not read or copy Hermes/Codex/Claude native credential stores. Any future credential must come through a distinct app-owned, owner-consented supported OAuth flow and reviewed broker.
- No general shell, MCP, browser, filesystem, plugin, child-agent, scheduler, or arbitrary tool authority for the first provider request.
- Provider egress is not currently approved. Only propose a narrowly allowlisted network boundary; do not enable it on an existing host.
- No host mutation, deployment, real provider authentication, or inference in this handoff.

## Feasibility questions

1. Can a dedicated systemd `omnis-connector` identity run a pinned, root-owned connector/app-server binary with a private primary group and isolated home/workspace?
2. Can that identity be proven to lack Docker, authorizer, launcher, runtime DB, host home, and unrelated service access, while retaining only the minimum local API-to-connector channel?
3. What supported OS credential facility can hold refresh credentials and deliver a short-lived access token to one child process without exposing it to other services, process inspection, logs, environment dumps, or core files? Document threat assumptions and residual risk. Do not implement the broker yet.
4. What host firewall/proxy design can permit only the selected provider authentication/token endpoints and inference origin, with DNS/TLS behavior constrained, while denying loopback service discovery, metadata services, private networks and all other egress? Identify endpoint churn and fail-closed behavior.
5. Can systemd/cgroup controls enforce process, memory, CPU, file-size, open-file, runtime, output, and concurrency limits for an app-server child that streams a text response?
6. Can a killed/restarted connector resolve external request uncertainty without automatically resubmitting a potentially billable request? Identify what provider request IDs/idempotency exist and what cannot be guaranteed.
7. Which controls can be verified in disposable Ubuntu CI, and which require an owner-controlled target environment? State clearly that disposable CI does not establish production/homelab assurance.

## Required deliverable

Return a platform design and an executable disposable-environment verification plan, including:

- Proposed service user/group, socket ownership, systemd hardening directives and file ownership.
- Explicit allowed/denied filesystem paths, sockets, capabilities, devices and supplementary groups.
- Credential broker-to-connector handoff proposal and leakage tests (synthetic canaries only).
- Outbound destination policy and negative reachability test matrix.
- Resource, timeout, cancellation, restart and failure-closed controls.
- Required changes to host-security CI or systemd units, if any, with files owned by Codex #3.
- Evidence that does not rely on running a real model or handling a real token.
- Open questions and controls that remain impossible to prove.

Keep G4-3 Partially Fixed and R1-G5 Partially Complete. If this boundary cannot be enforced for the intended host, report BLOCK and recommend the minimum remediation. Codex #1 will integrate only after separate backend/security architecture review.

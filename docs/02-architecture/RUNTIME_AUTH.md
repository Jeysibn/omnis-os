# Runtime Integrations, OAuth and Provider Policy

**Critical:** This document distinguishes (a) signed-in local applications, (b) authorized interactive access, (c) permission to build automation around those apps, and (d) API billing. These are not interchangeable.

## Supported target runtimes

| Runtime | Preferred integration | Login type | Status |
|---|---|---|---|
| Hermes Agent | Authenticated local HTTP runs API / gateway, capability-probed | Provider login in Hermes | PROPOSED, Phase 0 smoke test |
| Codex CLI | Official CLI or SDK through isolated supported process | ChatGPT/Codex sign-in when allowed | GATED: automated usage and event shape |
| Claude Code | Unmodified native CLI with supported interaction | Claude subscription login when allowed | GATED: policy constraints for third-party orchestration |

A user's existing login **does not establish** authorization to extract tokens or route traffic as a different application. Do not copy OAuth credentials or use undocumented token endpoints.

## Provider policy guardrails (verify again before release)

- **Anthropic:** Claude subscriptions support native Claude applications/Claude Code. Anthropic's current documentation says third-party tools should prefer API billing; custom third-party programmatic routing using subscription credentials may be restricted. Therefore **do not** create a direct Claude subscription OAuth proxy, nor assume unattended custom automation is covered. Support a native, user-directed Claude Code path only if the intended usage is permitted; feature-flag unattended Claude until legal and technical verification. This is a requirement, not a workaround hint.
- **OpenAI Codex:** ChatGPT sign-in supports local Codex clients where eligible. Official guidance distinguishes local subscription use from programmatic CI/CD and enterprise access-token entitlement. Validate permitted automation, account plan and rate limits before enabling scheduled Codex work; do not silently fall back to API key usage.
- **Hermes:** Hermes documents Codex OAuth and several provider options. A Hermes gateway exposes HTTP run lifecycle events; its direct Anthropic OAuth path may require a particular plan and extra credits. Validate *selected underlying provider* and its billing mode separately from Hermes availability.
- **All:** Provider terms, features, prices and quotas change. Treat documentation checked on 2026-11-02 as an initial baseline, not permanent permission.

Authoritative links and dates: `../07-governance/REFERENCES.md`.

## Runtime connection properties

`id`, `runtime_kind`, `host_ref` (never arbitrary client URL), `profile_scope`, `status`, `last_probe_at`, `capabilities`, `auth_method_label`, `billing_mode` (`subscription|api|local|unknown`), `allowed_use` (`interactive|background|both|disabled`), `concurrency_limit`, `health_error`, `policy_reviewed_at`, `version_observed`.

Credentials remain in the native runtime store or host secret store. Database stores only opaque references and access policy. UI must never expose refresh/access tokens, CLI config file, or whole process environment.

## Adapter capability discovery

Query runtime features and record per-version capability flags rather than assuming parity:
- `interactive_chat`, `start_task`, `stream_events`, `cancel`, `approve`, `steer`, `model_catalog`, `token_usage`, `file_attachment`, `headless`, `session_resume`, `tool_policy_control`.
- Unsupported capability => disabled UI action and meaningful explanation, not a fake success state.
- Upgrades require re-probe and contract tests.

## Hermes reference surface (version-dependent)

Official Hermes documentation describes `POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/stop`, `POST /v1/runs/{id}/approval`, and `/v1/capabilities`. It also documents an authenticated `/api/model/options` picker. Use only endpoints confirmed by the installed version, bearer auth, narrow CORS, and per-profile keys. Distinguish runtime terminal status `completed`, `failed`, `cancelled`, `interrupted`, and unknown. No claim that a completed HTTP response means a task's human acceptance criteria passed.

For Hermes-generated recurring jobs, **Omnis OS scheduling is canonical**. Do not activate a parallel Hermes cron entry for the same automation, or two schedulers may duplicate work.

## Authentication and billing flow

1. User authenticates to provider through native CLI/runtime mechanism (outside web UI).
2. Omnis OS asks only for capability/health status; never captures credentials.
3. User chooses runtime, effective model and allowed-use scope.
4. Before each run: check grant, project scope, policy-review state, concurrency, account quota signal if available, billable-cost budget.
5. Runtime executes and emits supported usage; ledger records measured/estimated/unknown separately.
6. If subscription exhausted, pause or queue; do **not** switch to metered provider automatically.

## First integration test matrix

| Test | Hermes | Codex | Claude |
|---|---|---|---|
| Native login probe without printing secret | Required | Required | Required |
| Read-only request in isolated workspace | Required | Required | Conditional |
| Streaming and structured terminal event | Required | Confirm | Confirm |
| Cancellation does not claim rolled-back side effects | Required | Confirm | Confirm |
| Token usage and model ID | Record or unknown | Record or unknown | Record or unknown |
| Separate private chat and operational sessions | Required | Required | Required |
| Unattended automation permission | Verify provider | Verify provider | Gated/policy review |

## Fallback strategy

When a provider cannot legally or technically support the intended task:
- Show `Unavailable: policy/entitlement` and preserve queued task without execution.
- Offer another **already authorized** runtime or optionally a local model if configured.
- Do not interpret 'OAuth-first' as prohibition on all future API access; metered API keys remain **disabled and require separate explicit user opt-in with a budget and warning**.

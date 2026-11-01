# Module - Cost & Usage Center

## Terms

- **Measured Tokens:** reported counts from runtimes, split into input, output, cached input, and optional reasoning as supported. Fields may be `null`.
- **API-equivalent Value:** an estimate at versioned published token prices, **not** an actual charge.
- **Actual Charge:** verified invoice/receipt, separately entered subscription cost or metered API bill.
- **Provider Quota:** provider-reported limit/remaining value where available, otherwise unknown.

## Collection

Runtime-specific collector normalizes usage events into deduplicated ledger. Preserve source runtime, model ID, billing mode, run/chat/agent/project correlation, token categories, currency and measurement quality (`provider_reported|derived|unknown`). Do not guess token count from text length unless marked explicitly as an estimate and excluded from measured totals.

## Cost formula

For each model token category with a source price effective at time of execution:

`reference_value_usd = sum(tokens_by_category / price_unit_tokens * unit_price_usd)`

No rate => `unpriced`. No usage => `unknown`. Cached tokens and reasoning tokens need model-specific handling; never double count categories (e.g. cached tokens may already be included in reported input, depending on provider). Store calculation version, price version, price source URI, observed date and exchange-rate snapshot for PHP display.

## Actual expense accounting

- Subscription payment is one recorded monthly/periodic expense, not allocated as an incremental charge per request without an explicitly declared allocation method.
- If metered API billing is separately allowed, import/record actual charge from provider report; distinguish unreconciled estimated invoice from confirmed one.
- No false `$0.00 billed` for OAuth sessions unless the system knows the charge is included with no extra usage; use `unknown` or `covered by subscription` where justified.
- Other tools/cloud/hosting costs tracked independently if data available.

## Budget dimensions

Per-agent, per-project, per-department, per-runtime/model, per-schedule, and overall spending windows. Monitor max new billable exposure as well as activity caps (concurrency, daily runs, maximum output tokens if supported). On threshold: notify, pause new work, or require approval depending on policy. Cannot enforce an external provider quota that is not exposed.

## Dashboard

Filters: date/time PHT, agent, department, project, model, runtime, task/run/chat, cost type. KPIs: tokens, usage quality/coverage, API-equivalent value, confirmed actual spend, subscriptions, potentially billable work, estimated variance, error/rate-limit events. Drill-down always links to source events.

## Controls

- No automatic paid fallback.
- Treat pricing changes as versioned rates; never rewrite historic calculations without explicit recalculation record.
- No raw prompts or secrets in cost events; source IDs and counts are sufficient.
- Currency conversions: record UTC rate timestamp, rate source and original currency; never silently restate historical actual charges.

## Acceptance

- Same source usage event replayed twice appears once in total.
- OAuth session with known tokens and unknown invoice shows reference value but **not** as actual cost.
- Subscription fixed cost counted once for its billing period, not once per agent.
- Missing token telemetry remains unknown and visible in coverage metric.
- Budget exhaustion rejects only new permitted billable operations, not read-only viewing or audit.

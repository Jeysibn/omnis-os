# Module - Automations & Scheduler

## Purpose

Unattended work triggered by time/events, without duplicating the manual execution engine or bypassing permissions. Scheduled work should eventually run even while the dashboard is closed, provided the host, scheduler and authorized runtime remain available.

## Domain distinction

- Automation = trigger definition + policy + task template.
- Occurrence = one due trigger and its disposition.
- Task = work item with objective and acceptance criteria.
- Run = one actual runtime execution attempt.

## Trigger types

- **R1:** one-time date/time, recurring 5-field cron, manual `Run now` and pause/resume.
- **R2:** RRULE, GitHub/webhook events, dependency-completion events and condition checks.
- **Later:** multi-step workflow templates and conditional branches across agents.

Store `Asia/Manila` as owner default, with per-automation timezone override; UTC instants for occurrences. Use timezone database and test DST even though Manila does not observe DST.

## Scheduler design

- Proposed pg-boss worker/cron; durable PostgreSQL-backed occurrences with uniqueness `(automation_id, schedule_key)`.
- Enforce overlap policy: `skip`, `queue_one`, or `allow_with_cap` (explicit max).
- Missed run policy: `skip` or `once` catch-up, not automatically every missed period.
- Retry: exponential backoff with configured attempts and dead-letter/history on exhaustion.
- Re-evaluate authentication, approvals, grants and budgets at **each occurrence**; a schedule is not persistent permission for all future writes.
- Owner may pause, delete, change schedule, run now, and inspect execution history.
- No duplicate schedule configured inside Hermes or OS cron for a control-plane-owned automation.

## Execution controls

- Run only with `allowed_use=background` runtime connection and verified provider policy.
- Timeouts, concurrency caps, quota windows, max token policy where telemetry supports it.
- Never permit 'silent paid API fallback'.
- For read-only high-frequency monitoring, bounded auto-run is fine after approval; write/deploy operations default require fresh human authorization unless a narrowly scoped owner-approved policy explicitly permits them.
- Notify owner of pending approvals or service outage; do not treat failure to deliver notification as permission to proceed.

## UI

Automation list (enabled, paused, last/next run, assignee, status), calendar schedule view, editor (trigger, timezone, task instructions, project, employee, Skills, MCP scope, overlap/missed policy, budget, approvals), occurrence history and failed-run details.

## Sample behavior

Health check daily 08:00 PHT -> due occurrence -> policy check -> queued read-only project task -> Sentry/Hermes run -> evidence and usage -> status/Second Brain proposal. If host offline at 08:00 and policy `once`, create exactly one recovery occurrence, not 20 duplicate checks.

## Acceptance

1. Restart scheduler at scheduled boundary: occurrence stays unique and run is not duplicated.
2. Change schedule from 08:00 to 09:00 PHT: only future occurrences affected.
3. Provider login expires: occurrence is blocked with `requires_reauthentication`; no API fallback.
4. Rate-limit encountered: policy and backoff visible; subscription usage not assumed to be billed.
5. Scheduled tool requests restricted write: pending approval, no silent execution.

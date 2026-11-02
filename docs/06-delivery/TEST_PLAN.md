# Test Strategy and Quality Gates

## Testing layers

| Layer | Scope | Frequency |
|---|---|---|
| Unit | domain transitions, policy evaluation, cost math, permission intersection | every PR |
| DB integration | migrations, constraints, transactions, queue admission, event replay and ACL | every PR CI |
| Adapter contract | mock Hermes/Codex/Claude interfaces, cancellation, token mapping | every adapter change |
| Real runtime smoke | read-only task, stream, stop, auth state, provider policy | manual/controlled opt-in |
| UI e2e | agent creation, project task, run history, isolated chat, approvals | PR and release |
| Security | credential leakage, SSRF, untrusted Skills/MCP, unauthorized knowledge and native tools | security-sensitive PR |
| Performance | DB p95, queue lag, renderer memory/FPS, inference contention | stage gate/release |
| Recovery | API, worker, DB and runtime restart; backup/restore | pre-production |

## Core deterministic test cases

### State and reliability

- Invalid run transition from cancelled -> running rejected.
- Task accepted only on accepted verification evidence, not runtime text alone.
- Duplicate HTTP start with same idempotency key returns same run; conflict on changed body.
- Worker crash during pending tool action -> unknown/reconciliation, no naive automatic retry.
- Run event retransmission deduplicated; SSE reconnection reconstructs correct terminal state.
- Stop requested while runtime unavailable -> honest `unknown` or pending state.
- Agent concurrency cap prevents second simultaneous run.

### Security and isolation

- Read-only run cannot create files outside workspace or read login caches.
- Private Chat profile snapshot cannot read operational session or emit agent-control events.
- Project B knowledge never appears in Project A semantic/keyword search or event feed.
- MCP tool schema change revokes sensitive grants until reviewed.
- Malicious SKILL.md/README tool instructions cannot override app authorization.
- External MCP URL to forbidden address or redirect is rejected.
- Unauthorized approval or expired/changed action digest is denied.

### Usage and cost correctness

- Missing token telemetry is `null/unknown`, not zero.
- Cached input counted according to source semantics, no double counting.
- API-equivalent reference value and confirmed invoice actual are separate tiles and totals.
- Subscription expense counted once per billing period.
- FX historic reporting pins rate timestamp and source.
- Replayed source token events deduplicated.

### Automations

- Cron schedule in PHT fires at expected UTC instant.
- Missed run `skip` vs `once` gives correct occurrence count after outage.
- Duplicate webhook/cron event creates at most one occurrence.
- Overlap `queue_one` never starts two concurrent runs for same agent.
- Expired OAuth/disabled background entitlement blocks task.

### 3D office

- Fake fixture events produce stable avatar poses and room placement.
- Real offline state does not animate continued working.
- Snapshot after refresh matches server state.
- 2D fallback supports same inspector/action path.
- 30 FPS cap and hidden-tab pause actually work on target hardware.

## Data/fixtures

Use fictional users, projects, repositories and redacted credentials only. Tests requiring real subscriptions are disabled in CI and executed locally against read-only sandbox with explicit human opt-in. Do not consume paid APIs as part of default CI.

## Release quality gates

- Static checks, unit/integration/e2e tests green.
- Schema migration forward and tested rollback/data backup plan.
- Redacted logs and error paths verified.
- Security checklist passed for new privileges and integration.
- Observable run/event/traces and usage source quality.
- Accessible keyboard/reduced motion and responsive layouts.
- Stage-specific acceptance from `ROADMAP.md` checked with evidence.

## R1-G1 verification record

On 2026-11-02, the local PostgreSQL-backed mock suite passed using Node 24.22.1, pnpm 12.16.1, and PostgreSQL 17.6. It covered migration execution, transactional rollback, concurrent/idempotent admission, ordered event replay, lease ownership, cancellation acknowledgement, no automatic replay after interruption, and API/worker process restart. The browser smoke covered owner sign-in, task creation, run completion and stop, SSE events, reload recovery, and desktop/mobile layouts. See `../07-governance/evidence/R1_G1_PERSISTENCE.md`.

## R1-G2 local sandbox verification

The mock workload runs inside a digest-pinned Docker container. On the WSL2 host, the actual-container suite verified non-root execution, read-only root, run-scoped workspace permissions, dummy host-file/credential isolation, Docker socket denial, no-network behavior against public/private/metadata/test services, dropped capabilities, process/CPU/memory/time limits, cancellation, crash/output handling, and orphan cleanup that preserves active runs. PostgreSQL-backed tests and API/worker integration retained R1-G1 persistence and SSE replay. Browser smoke covered sign-in, task/run, cancel, reload, and desktop/mobile layouts. Commands and individual results are recorded in `../07-governance/evidence/R1_G2_SANDBOX_SECURITY.md`. This does not verify rootless Docker, AppArmor, remote CI, production deployment, or arbitrary real-runtime tooling.

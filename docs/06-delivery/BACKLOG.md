# Prioritized Engineering Backlog

Tasks are ordered and suitable for individual GitHub issues. Every issue must include acceptance evidence; no 'done' from code generation alone. Labels: `P0 = blocking`, `P1 = essential`, `P2 = later`. Dependencies are issue IDs.

## Phase 0 - Discover before coding

| ID | Pri | Work | Depends on | Acceptance |
|---|---|---|---|---|
| AO-001 | P0 | Host/runtime inventory and network boundaries | - | Sanitized report with exact installed versions |
| AO-002 | P0 | Provider policy and OAuth usage-mode review | AO-001 | Clear interactive/background/policy matrix per runtime |
| AO-003 | P0 | Hermes gateway smoke and capabilities probe | AO-001 | Redacted read-only run/events/stop trace, no token dump |
| AO-004 | P0 | Codex native CLI/SDK feasibility spike | AO-001,AO-002 | Auth, events, model picker, cancellation and automation policy recorded |
| AO-005 | P0 | Claude Code native CLI feasibility/policy spike | AO-001,AO-002 | Allowed usage documented; no subscription-token relay |
| AO-006 | P0 | Choose exact dependency versions, schema tooling, security baseline | AO-001..005 | Approved architecture notes and R1 runtime choice |

## Phase 1 - Foundation and one real run

| ID | Pri | Work | Depends on | Acceptance |
|---|---|---|---|---|
| AO-101 | P0 | Initialize pnpm monorepo, strict TS, quality commands | AO-006 | Clean install/build/lint from clone |
| AO-102 | P0 | PostgreSQL Compose, migrations, CI DB test | AO-101 | Clean DB migration and integration test |
| AO-103 | P0 | Director authentication + permission/policy module | AO-102 | Unauthorized calls denied, CSRF/session validated |
| AO-104 | P0 | Agent profile version + department CRUD | AO-102,AO-103 | Old snapshot preserved on edit |
| AO-105 | P0 | Project/task/run core schema and state transitions | AO-102,AO-103 | Invalid transition = 409; task vs run independent |
| AO-106 | P0 | Runtime adapter interface + deterministic mock | AO-105 | Contract tests start/events/cancel/fail/unknown |
| AO-107 | P0 | Real first safe runtime adapter | AO-003,AO-006,AO-106 | Approved real read-only run and redacted trace |
| AO-108 | P0 | pg-boss admission/idempotency/lease | AO-105,AO-106 | Retries/restart do not duplicate run admissions |
| AO-109 | P0 | Event persistence + SSE reconnection | AO-105,AO-108 | Refresh recovers event order and state |
| AO-110 | P1 | Agent Directory, project/task forms, run inspector UI | AO-104,AO-105,AO-109 | Playwright owner journey passes |
| AO-111 | P0 | Tool policy, cancellation, approval preview and audit | AO-103,AO-107,AO-109 | No unapproved write or false stop terminal status |
| AO-112 | P1 | Basic usage event ingestion with unknown handling | AO-107,AO-105 | Usage reported or unknown; no fabricated zero |
| AO-113 | P0 | R1 integration/E2E/security smoke and handoff | AO-101..112 | Stage 1 acceptance with evidence |

## Phase 2 - Isolated chat and runtime plurality

| ID | Pri | Work | Depends on | Acceptance |
|---|---|---|---|---|
| AO-201 | P0 | Chat threads and per-chat runtime sessions | AO-113 | Two chats isolated through restart |
| AO-202 | P0 | No-tool chat sandbox and profile snapshot | AO-201 | Chat cannot read operational work/memory |
| AO-203 | P1 | Authenticated model/runtime picker and chat usage | AO-201,AO-112 | Unavailable/paid choices honestly labeled |
| AO-204 | P1 | Codex adapter if AO-004 permitted | AO-113,AO-004 | Contract suite and user opt-in tests |
| AO-205 | P1 | Claude adapter if AO-005 permitted | AO-113,AO-005 | Provider-policy and native CLI tests |
| AO-206 | P1 | Chat-to-task handoff confirmation | AO-201,AO-105 | Explicit approval, scoped created task |

## Phase 3 - Skills, MCP and knowledge

| ID | Pri | Work | Depends on | Acceptance |
|---|---|---|---|---|
| AO-301 | P0 | Skill import/quarantine/hash/approval | AO-113 | Tampering blocked, pinned version preserved |
| AO-302 | P0 | MCP connection registry and tool discovery | AO-113 | Registered safe connection only; health visible |
| AO-303 | P0 | Tool gateway permission enforcement + audit | AO-301,AO-302,AO-111 | Unauthorized tool use prevented in worker |
| AO-304 | P1 | Markdown knowledge vault, proposals and revisions | AO-113 | Reviewed document published with provenance |
| AO-305 | P0 | Knowledge ACL and keyword search | AO-304 | Cross-project search denied |
| AO-306 | P2 | pgvector/local embedding opt-in | AO-305 | Semantic search without privacy leakage |

## Phase 4 - Projects and automations

| ID | Pri | Work | Depends on | Acceptance |
|---|---|---|---|---|
| AO-401 | P1 | Milestones/epics/task dependency graph | AO-113 | Cyclic dependency rejected |
| AO-402 | P0 | Scheduled occurrences, missed/overlap rules | AO-108,AO-111 | Crash/restart produces unique occurrence |
| AO-403 | P1 | Automation editor/history and manual trigger | AO-402 | Pause/resume, PHT timezone display |
| AO-404 | P0 | Usage ledger dedup, rate versioning, actual vs estimate | AO-112 | Totals reconcile; unknown separate |
| AO-405 | P1 | Budgets/alerts and high-risk approval UX | AO-404,AO-111 | Paid fallback always off by default |
| AO-406 | P2 | Event/webhook conditional triggers | AO-402,AO-303 | Signed/replayed webhook dedup and permission gated |

## Phase 5 - Team collaboration and office

| ID | Pri | Work | Depends on | Acceptance |
|---|---|---|---|---|
| AO-501 | P1 | Team membership/delegation with caps | AO-401,AO-303,AO-404 | Bounded DAG and separate run provenance |
| AO-502 | P1 | Mock-only 3D office POC and performance benchmark | AO-101 | Demo label, FPS cap, 2D fallback |
| AO-503 | P1 | Live office backend snapshot/event mapping | AO-109,AO-502 | Refresh/transport outage truthfully reflected |
| AO-504 | P2 | Departments, room placement, avatar/inspector editor | AO-503,AO-104 | UI changes do not modify task state |

## Phase 6 - Production gate

| ID | Pri | Work | Depends on | Acceptance |
|---|---|---|---|---|
| AO-601 | P0 | Security audit incl. tools, MCP, memory and OAuth | AO-303,AO-501 | Critical findings remediated/reviewed |
| AO-602 | P0 | DB/vault/artifact backup + restore drill | AO-304,AO-404 | Verified isolated restore and audit |
| AO-603 | P0 | Private Linux Docker Compose/TLS/secret deployment | AO-601,AO-602 | No public ports, rollback verified |
| AO-604 | P1 | Observability, perf/load/3D resource tests | AO-503,AO-603 | Benchmarked on target hardware |

## Issue format

For each ID: link spec, state precise user behavior, list dependencies, avoid secrets, add acceptance with executable tests and negative cases, document resource impact and rollback. Use `docs/08-templates/ISSUE.template.md`.

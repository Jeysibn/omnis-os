# Omnis OS - Phase 0 and Phase 1 Coding Agent Handoff

**Use this as the initial implementation brief.** Focus on a vertical slice with real evidence, not ten disconnected screens. Every action below is ordered. Stop on policy/security blockers; continue safe scaffold work only.

## 0. Repository setup

- Repository slug: `omnis-os`; preserve this documentation pack and commit it first. Keep the selected Omnis OS identity in readmes, apps, and user-facing navigation.
- Proposed package manager: pnpm workspaces (version to pin after environment inventory).
- Proposed layout:

```text
omnis-os/
  apps/
    web/                  # React/Vite/Tailwind
    api/                  # Fastify REST/SSE
    worker/               # queue admission/execution
  packages/
    db/                   # schema/migrations
    contracts/            # types and schemas
    runtime-adapters/     # interfaces + mock/Hermes adapters
    policy/               # permission evaluation
    ui/                   # optional shared UI primitives
  infra/
    compose/
  docs/                   # existing documentation
  tests/
    integration/
    e2e/
  AGENTS.md
  CONTEXT.md
  README.md
```

Use `strict` TypeScript and schema validation for all inputs/events; test new module interfaces in isolation. Avoid introducing five frameworks per concern. Keep runtime adapters swappable and process-level privilege boundaries explicit.

## Phase 0 - acceptance gate checklist

- [ ] Inventory actual host/WSL, Node/pnpm/Docker, available memory/disk/ports.
- [ ] Record installed Hermes/Codex/Claude versions and signed-in/connection status without showing secrets.
- [ ] Verify Hermes API server with bearer auth/capabilities, isolated read-only request, SSE, stop. Record redacted transcripts and version.
- [ ] Verify Codex native client API/CLI non-interactive support, token events, session isolation and plan/policy for the intended mode.
- [ ] Verify Claude native CLI integration and current subscription/Agent SDK policy. Do not create any third-party token tunnel. Default background Claude `disabled` until policy review.
- [ ] Confirm authentication strategy for web (single-owner first), runtime secret storage, sandbox constraints and network boundaries.
- [ ] Establish one supported runtime for R1, with exact working command/endpoint and current version in integration notes.
- [ ] Validate proof-of-concept build on actual environment. Record known limitations and no-cost guarantees only when confirmed.

Deliverable: `docs/07-governance/DECISIONS_RISKS.md` updated, one redacted integration proof, owner-approved technology versions.

## Phase 1 - implementation checklist

### Step 1: Skeleton

- [ ] Create pnpm workspace, basic web/API/worker packages and scripts.
- [ ] Docker Compose PostgreSQL with persistent named volume and health check; optional app containers after local dev established.
- [ ] `/api/v1/health`, `/api/v1/me`, secure session auth and CSRF/secure-cookie policy.
- [ ] ESLint, Prettier, TypeScript check, unit tests, pre-commit checks and GitHub Actions CI.

### Step 2: Domain and storage

- [ ] Migrations: director user, department, agent, immutable profile version, runtime connection (metadata), project, task, run, run events, basic audit.
- [ ] Deterministic factories/fixtures; minimal seed with fictional demo employees only under explicit demo command.
- [ ] Implement state transitions and checks; invalid transitions => structured 409.

### Step 3: Mock adapter

- [ ] Implement a **mock runtime** producing deterministic queued/running/terminal events, cancellation, optional usage unknown.
- [ ] Contract tests for adapter interface using mock; fake run cannot appear as real in UI.
- [ ] Runtime capability discovery and `allowed_use` policy.

### Step 4: Real authorized runtime

- [ ] Add Hermes-first adapter if Phase 0 passed; otherwise first verified permitted native runtime.
- [ ] Authenticated probe, read-only workspace request, external ID mapping, safe streaming and terminal reconciliation.
- [ ] No native shell tools in the app API process; restrictive worker/host setup.
- [ ] Record runtime version/capabilities in connection health screen; never display native auth secrets.

### Step 5: Durable execution and UI

- [ ] Run admission with Idempotency-Key, project/agent grant, concurrency cap.
- [ ] Worker queue (pg-boss) persists jobs; `run_events` indexed with ordered sequence and source dedup.
- [ ] SSE feed with snapshot/reconnect; browser refresh reconstructs state.
- [ ] Basic Agent Directory editor, Projects list/task details, Run inspector, Command Center state cards.
- [ ] Request cancel, show `stopping` until observed terminal status; recovered/unknown handled.
- [ ] Evidence panel and manual `Accept Result` action; no auto-accept from text reply.
- [ ] Usage event schema and basic readout, `unknown` when absent.

### Step 6: Tests and signoff

- [ ] Run unit tests, DB integration with real PostgreSQL, mock adapter contract tests, Playwright login+task+run UI smoke.
- [ ] Security tests: unauthorized view/cancel denied, provider secrets not logged, no tool execution from API, invalid input rejected.
- [ ] Restart DB/API/worker while mock/real read-only tasks present; verify reconciliation and no duplicate run on request retry.
- [ ] Record screenshots and redacted event trace. No placeholder features presented as operational.

## Definition of done for R1

The owner can sign in, create an agent/project/task, execute one authorized read-only run, watch authentic events, inspect output, cancel when needed, manually accept verified result, and reload without losing state. CI passes from a clean clone with no provider credentials (mock tests) and optional local integration suite passes when explicitly enabled.

## First agent instruction

**Do not build all 10 modules now.** Complete the Phase 0 checklist and report results with technical blockers and proposed ADR updates. Then create the repository foundation and implement the smallest independent run lifecycle, stop after the first functional gate for review.

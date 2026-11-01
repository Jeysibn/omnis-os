# Omnis OS - Engineering Kickoff

## Mission

Build **Omnis OS** as a private, self-hosted AI organization platform with an operational control plane, isolated personal chat, an agent workforce, Skills/MCP, shared knowledge, task/project orchestration, scheduled work, usage analytics, and a state-driven 3D office. The first deliverable is **one safe, real, traceable agent run**, not the full visual company.

## First-day order

1. **Create a new repository** named `omnis-os` and commit this documentation pack as-is. The product name is **Omnis OS**; no GitHub repository has been created by these documents.
2. **Read** `AGENTS.md`, `CONTEXT.md`, `docs/06-delivery/PHASE_0_1_HANDOFF.md`.
3. **Capture environment inventory:** host OS/WSL, Node version, Docker Compose, PostgreSQL availability, existing Hermes version, Codex CLI version, Claude Code version, existing signed-in status (report status only; never export tokens).
4. **Run policy/integration spikes:** native Hermes API run/status/stream/stop; Codex CLI auth and non-interactive controls; native Claude Code subscription CLI policy/automation limits. Record results in `docs/07-governance/DECISIONS_RISKS.md` or new ADRs.
5. **Choose authenticated runtime for first vertical slice:** use the first one that passes policy, isolation, and event-stream tests. Prefer Hermes for initial API integration, but do not assume it is available.
6. **Scaffold and validate** the monorepo only after checks 1-5. Follow gated issues in `docs/06-delivery/BACKLOG.md`.

## Stage 0 exit gate

- [ ] Existing credentials stay in native runtime stores; no token is copied into repo/DB/logs.
- [ ] Confirm a legitimate, supported model path for interactive use and separately for unattended scheduling.
- [ ] Verify one model can answer a read-only request with streaming progress and cancellation, or document a tested fallback.
- [ ] Decide minimum supported runtime versions and record them, not guesses.
- [ ] Confirm free disk/CPU/RAM limits and GPU needs (GPU optional when relying on hosted models).
- [ ] Security posture approved: private networking, one user initially, read-only tools by default, approval for external writes.
- [ ] Spec and acceptance criteria for Stage 1 reviewed.

## Stage 1 exit gate

- [ ] Authenticated dashboard and API start through local Compose/approved dev process.
- [ ] Schema migrations run against a clean PostgreSQL DB.
- [ ] Create a department, agent profile, project, task, and run in persistent storage.
- [ ] Submit a read-only task to a verified runtime through an adapter.
- [ ] Live events appear in UI; event history survives browser refresh and backend restart.
- [ ] A completed output includes a verifiable artifact or read-only evidence.
- [ ] Stop/cancel and approval state are observable and enforced.
- [ ] Cost & Usage Center shows measured token data **or explicitly `unavailable`**, never fabricated zero.
- [ ] Unit, database integration, and browser smoke tests pass.

## Delivery protocol

Implement in small PR-sized steps, each with:
- Scope and non-goals.
- Documentation linked to the change.
- Failing test or acceptance case first when feasible.
- Implementation, database migration if needed, test run, screenshots for visual changes.
- Threat-model check for new external inputs or privileges.
- Clear note: what was verified, what remains proposed, and what is blocked.

## Current risks to resolve before unattended automation

- Provider policies: Claude subscription OAuth is intended for native apps; do **not** construct a third-party proxy to use subscription OAuth tokens. Codex subscription CLI use may not confer automation entitlements. See `RUNTIME_AUTH.md`.
- Native CLIs may have filesystem/tool privileges beyond the web application's intentions. Enforce at host/container boundary.
- Provider token events may lack precise usage or billing; represent `unknown` explicitly.
- OAuth subscription capacity is shared across personal chat and agent tasks.

## Success definition

You can create an agent named Nova, assign a read-only task in a project, submit it through an authorized runtime, watch its status change, read its final result and measured usage (if available), and reload the dashboard without losing state.

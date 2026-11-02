# Omnis OS context

- Product: Omnis OS, a single-owner command center for agents, projects, tasks, and runs.
- Phase 1 success target: create a task, start an authorized read-only run, observe events, cancel when needed, inspect output, manually accept a verified result, and reconstruct state after reload.
- Current implementation checkpoint: deterministic mock lifecycle backed by PostgreSQL and pg-boss; task/run/event state and SSE history survive API/worker process restarts. Mock workloads execute in a digest-pinned Docker container with a read-only root, run-scoped workspace, no network, dropped capabilities, and resource limits. R1-G3 adds tested logical backup/restore, clean-clone reproduction, and local worker/sandbox/database failure recovery. The UI visibly identifies mock data and must not suggest a provider is connected.
- Remaining Phase 1 release work includes an authorized real runtime, production-grade sandbox deployment review, broader domain entities, remote GitHub Actions confirmation, safe Docker-daemon recovery, and final owner review. A worker process needs an external restart after database loss. See the R1-G3 evidence; local milestones do not pass the complete R1 release gate.
- Runtime order: Hermes first only after bearer auth, capability discovery, tool restriction, SSE, and stop have been demonstrated on an isolated read-only request. Otherwise select a separately verified permitted native runtime.
- Claude background execution remains disabled pending owner and policy review. Never build a third-party tunnel for native credentials.
- Runtime secrets belong to a dedicated worker or local runtime host, never browser code or API logs.
- Repository layout follows the brief: `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `packages/runtime-adapters`, `packages/policy`, `packages/db`, optional `packages/ui`, `infra/compose`, `docs`, and `tests`.

See `AGENTS.md` for implementation guardrails and `docs/07-governance/` for gate evidence.

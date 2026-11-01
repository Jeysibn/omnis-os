# Omnis OS context

- Product: Omnis OS, a single-owner command center for agents, projects, tasks, and runs.
- Phase 1 success target: create a task, start an authorized read-only run, observe events, cancel when needed, inspect output, manually accept a verified result, and reconstruct state after reload.
- First implementation gate: deterministic mock lifecycle only. The UI must visibly identify mock data and must not suggest a provider is connected.
- Runtime order: Hermes first only after bearer auth, capability discovery, tool restriction, SSE, and stop have been demonstrated on an isolated read-only request. Otherwise select a separately verified permitted native runtime.
- Claude background execution remains disabled pending owner and policy review. Never build a third-party tunnel for native credentials.
- Runtime secrets belong to a dedicated worker or local runtime host, never browser code or API logs.
- Repository layout follows the brief: `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `packages/runtime-adapters`, `packages/policy`, `packages/db`, optional `packages/ui`, `infra/compose`, `docs`, and `tests`.

See `AGENTS.md` for implementation guardrails and `docs/07-governance/` for gate evidence.

# Release Scope Matrix

## Release definitions

- **R0 / Phase 0**: Verifications and decisions; no operational product claims.
- **R1 / Foundation MVP**: One real safe agent task; projects/profiles/history; dashboard and basic usage.
- **R2 / Personal AI and multi-runtime**: Profile chat with isolation; additional verified native adapters.
- **R3 / Capabilities and knowledge**: Skills/MCP registry, scoped execution, Second Brain.
- **R4 / Work management**: Rich project management, scheduling, budget/approval workflows.
- **R5 / Visualization and teams**: Event-driven 3D office and multi-agent delegation.
- **R6 / Production**: Security, deployment, backups/restore, reliability/performance.

| Capability | R1 | R2 | R3 | R4 | R5 | R6 |
|---|---|---|---|---|---|---|
| Login, private access, project/task/profile CRUD | Core | Improve | | | | Harden |
| Agent runtimes (Hermes, Codex, Claude) | First verified | Additional verified | | | | Update |
| Durable events, stop/approval, artifacts | Core | Improve | | Expand | | Harden |
| UI isolated chat and model selection | | Core | Tools opt-in | | | Harden |
| Skills Registry and MCP connections | Stub | | Core | | Expand | Harden |
| Second Brain, project/global knowledge | | | Core | Expand | | Harden |
| Task dependency/delegation | Basic dependencies | | | Expand | Multi-agent | Harden |
| Scheduling and automation | | | | Core | Event-driven | Harden |
| Usage collection, estimated and actual costs | Event schema | Basic views | | Budgets/reports | | Harden |
| 3D office | Mock spike only | | | | Real event-driven | Optimize |
| Private Docker Compose deployment on Linux | | | | | | Core |

## Important exclusions

- R1 only requires **one** policy-verified real runtime. All three adapters are long-term scope, not a gate if a provider policy blocks one.
- R1 does not require vector embeddings, autonomous skill installation, multi-agent calls, real 3D workers, or full scheduling.
- R2 private chats default to no tools and must have separate memory/session and execution namespaces.
- R5 3D office is a read-only projection for status, with explicit authorized UI actions forwarded to control plane.

## Release gates

- R1: [Phase 0/1 Handoff](../06-delivery/PHASE_0_1_HANDOFF.md)
- R2: auth/entitlements and chat isolation integration test.
- R3: MCP escape/prompt injection audit; knowledge ACL and provenance retrieval tests.
- R4: retries, missed-trigger recovery, de-dup, approvals, budget cutoff tests.
- R5: scene-truth tests, accessible 2D equivalent, measured FPS and memory budget.
- R6: backup/restore drill, rollback, secure private network, no default public exposure.

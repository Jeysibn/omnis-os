# Omnis OS

Omnis OS is a single-owner command center for managing agents, projects, tasks, and observable runs. The first implementation gate is deliberately limited to a visibly labeled mock run lifecycle while runtime permissions and the real integration boundary are reviewed.

## Current status

R1-G1 now uses PostgreSQL for task, run, result, cancellation, and ordered event state, with pg-boss for durable mock admission. Process restart, SSE replay, cancellation, and recovery checks passed locally. The product remains mock-only: no provider is connected, and synthetic output is not verified AI evidence. The original Phase 0 findings remain in [the integration notes](docs/07-governance/INTEGRATION_NOTES.md); current infrastructure results and remaining risks are in [the governance decision log](docs/07-governance/DECISIONS_RISKS.md) and [R1-G1 evidence](docs/07-governance/evidence/R1_G1_PERSISTENCE.md).

## Development

The workspace uses pnpm 12.16.1 and the committed lockfile. The current gate uses a React/Vite/Tailwind web app, a Fastify API, a loopback-only worker boundary, PostgreSQL as the task/run/event source of truth, and pg-boss for durable mock admission. All model runtimes remain disabled.

```sh
pnpm install
pnpm configure:owner
pnpm db:up
pnpm dev
```

The worker applies committed SQL migrations before it starts. Compose exposes PostgreSQL only on `127.0.0.1:5432` and stores data in the `omnis-os_omnis-postgres-data` named volume. Use `pnpm db:down` to stop the service while retaining that volume. Integration tests require `OMNIS_TEST_DATABASE_URL` to point to a disposable database whose name ends in `test` or `tests`.

## Safety boundary

The API process does not launch native shell tools. Real provider execution stays disabled until the runtime, policy, token ownership, and worker isolation gates are documented and approved. PostgreSQL retains tasks, runs, results, idempotency records, and ordered events across API and worker restarts. A run interrupted after it starts is recorded as interrupted and is never automatically replayed. The mock process has no provider credentials or arbitrary shell access; host-level sandboxing and network egress restrictions remain unverified.

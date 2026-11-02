# Omnis OS

Omnis OS is a single-owner command center for managing agents, projects, tasks, and observable runs. The first implementation gate is deliberately limited to a visibly labeled mock run lifecycle while runtime permissions and the real integration boundary are reviewed.

## Current status

R1-G1 provides PostgreSQL-backed tasks, runs, results, cancellation, ordered events, and durable mock admission. R1-G2 runs the mock workload in an ephemeral Docker container with a read-only root, a per-run workspace, dropped capabilities, resource limits, and no network. Local security, persistence, process-restart, and browser checks passed. The product remains mock-only: no provider is connected, and synthetic output is not verified AI evidence. The original Phase 0 and R1-G1 records remain preserved; current risks and [R1-G2 evidence](docs/07-governance/evidence/R1_G2_SANDBOX_SECURITY.md) are in the governance decision log.

## Development

The workspace uses pnpm 12.16.1 and the committed lockfile. The current gate uses a React/Vite/Tailwind web app, a Fastify API, a loopback-only worker boundary, PostgreSQL as the task/run/event source of truth, and pg-boss for durable mock admission. All model runtimes remain disabled.

```sh
pnpm install --frozen-lockfile
pnpm configure:owner
pnpm sandbox:image:pull
pnpm db:up
pnpm dev
```

Run Docker commands from a fresh WSL login shell with the existing Docker group membership. Docker group access is root-equivalent. The worker applies committed SQL migrations before it starts. Compose exposes PostgreSQL only on `127.0.0.1:5432` and stores data in the `omnis-os_omnis-postgres-data` named volume. Use `pnpm db:down` to stop the service while retaining that volume. Integration tests require `OMNIS_TEST_DATABASE_URL` to point to a disposable database whose name ends in `test` or `tests`. `pnpm --filter @omnis/worker test:sandbox` runs the actual-container negative security suite.

## Safety boundary

The API process does not launch shell tools. Real provider execution stays disabled until its separate runtime, policy, token ownership, and isolation gates are documented and approved. PostgreSQL remains authoritative for tasks, runs, results, idempotency records, and ordered events. The current mock container receives only task-title JSON, has no host credentials or Docker socket, and uses Docker `--network=none`. Rootless Docker and AppArmor are unavailable on the tested WSL host; the trusted launcher still depends on a rootful Docker daemon, which remains a high-impact trust boundary.

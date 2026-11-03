# Omnis OS

Omnis OS is a single-owner command center for managing agents, projects, tasks, and observable runs. The first implementation gate is deliberately limited to a visibly labeled mock run lifecycle while runtime permissions and the real integration boundary are reviewed.

## Current status

R1-G1 provides PostgreSQL-backed tasks, runs, results, cancellation, ordered events, and durable mock admission. R1-G2 runs the mock workload in an ephemeral Docker container with a read-only root, a per-run workspace, dropped capabilities, resource limits, and no network. R1-G3 adds locally verified backup/restore, clean-clone build checks, worker/sandbox/database recovery tests, and passing remote GitHub Actions. The product remains mock-only: no provider is connected, and synthetic output is not verified AI evidence. Docker-daemon failure recovery remains unverified. Read the [R1-G2 security evidence](docs/07-governance/evidence/R1_G2_SANDBOX_SECURITY.md), [R1-G3 recovery evidence](docs/07-governance/evidence/R1_G3_CI_RECOVERY.md), and governance decision log.

## Development

The workspace uses pnpm 12.16.1 and the committed lockfile. The current gate uses a React/Vite/Tailwind web app, a Fastify API, a loopback-only worker boundary, PostgreSQL as the task/run/event source of truth, and pg-boss for durable mock admission. All model runtimes remain disabled.

```sh
pnpm install --frozen-lockfile
pnpm configure:owner
pnpm sandbox:image:pull
pnpm db:up
pnpm dev
```

Run `pnpm configure:owner` once to create private `.env`, `.env.worker`, `.env.authorizer`, `.env.migration`, and `.env.db-admin` files. The worker receives only its runtime database password and API-to-worker token. The authorizer receives its separate database password and API-to-authorizer token. The API receives owner-session configuration and both outbound service tokens, but no database password. Start PostgreSQL with `pnpm db:up`, provision roles with `pnpm db:roles`, then apply application and pg-boss migrations with `pnpm db:migrate`; `pnpm dev` applies pending migrations before starting API, authorizer, worker, and web services. PostgreSQL is bound to loopback and stored in a named volume. Docker group access is root-equivalent. The local processes share the invoking Unix identity and the worker controls Docker, so this is application credential separation, not a host-enforced trust boundary. Use separately managed service identities, private secret delivery, and a worker without Docker-daemon access before relying on process separation against a compromised worker. Integration tests use separate disposable admin, migration, runtime, and authorizer PostgreSQL roles; the database name must end in `test` or `tests`. `pnpm --filter @omnis/worker test:sandbox` runs the actual-container negative security suite.

## Safety boundary

The API process does not launch shell tools. Owner approval and revocation are handled by a separate loopback authorizer process with its own PostgreSQL role. The worker receives only `omnis_runtime`; it has no authorizer routes or configured authorizer credentials. The API verifies the owner session and CSRF token before sending a control request authenticated by a distinct API-to-authorizer token. The authorizer derives the actor as `owner` and writes the durable decision and audit transaction. The worker still checks the persisted grant during admission and execution. If the authorizer is unavailable, approval and revocation return an explicit failure and do not fall back to worker-side logic.

This is not yet an OS-enforced isolation boundary. The local processes share one Unix user, so that user can read each other's environment and private environment files; the worker also has Docker-daemon access, which is root-equivalent on the host. Separate service identities and secret mounts are not provisioned by this repository. A compromised worker may still inspect or control local control-plane processes through these host capabilities. G4-3 is therefore partially addressed and remains a blocker for real provider execution. PostgreSQL remains authoritative for tasks, runs, results, idempotency records, and ordered events. The current mock container receives only synthetic task data, has no host credentials or Docker socket, and uses Docker `--network=none`. Rootless Docker and AppArmor are unavailable on the tested WSL host; the trusted launcher still depends on a rootful Docker daemon, which remains a high-impact trust boundary.

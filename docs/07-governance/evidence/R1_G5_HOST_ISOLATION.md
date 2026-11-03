# R1-G5 host authorizer isolation and trusted control plane — PR #11

**Status: Partial implementation; host-isolation gate not passed.** This branch proposes a host deployment boundary and removes direct Docker control from the worker application path. The host identity setup and systemd services were not installed or run in the validation environment, so this evidence does not claim demonstrated host-enforced isolation.

## Architecture change

The API connects to the authorizer through a private Unix socket and retains owner-session and CSRF checks. The API and authorizer share a dedicated service token; the worker and launcher configurations do not contain it. Separate systemd templates assign `omnis-api`, `omnis-authorizer`, `omnis-worker`, and `omnis-launcher` identities. The authorizer secret file and API secret file are installed mode `0600` for their respective users. The worker is not in the authorizer socket group. The worker and launcher share a separate socket group so the worker can submit only the constrained launch request.

The worker no longer imports or instantiates the Docker executor. `omnis-sandbox-launcher` owns Docker operations and uses the dedicated `omnis_launcher` role. Migration `0011_authorized_mock_sandbox_launch.sql` adds two fixed security-definer operations and one launch reservation table. The launcher validates the run ID, worker lease owner, execution generation, live lease, consumed task-scoped owner grant, expiry, and revocation state before one launch per run. It constructs the fixed mock program and Docker options itself; request fields for images, commands, mounts, environment, devices, networking, or privileged mode are rejected.

The launcher belongs to the rootful Docker group in the proposed systemd deployment, which is effectively host-root access. This narrows the worker's direct privilege but makes the launcher, host, kernel, Docker daemon, and systemd deployment trusted components. The launcher is not a general Docker API proxy and does not accept provider credentials or arbitrary workloads.

## Host deployment checks

`scripts/host-security/provision-identities.sh` creates the service users and socket groups but does not run automatically. `scripts/host-security/install-service-secrets.sh` verifies that the API, worker, authorizer, and launcher env files do not contain the other service's database credentials or owner/service secrets before installing them. `scripts/host-security/verify-worker-boundary.sh` runs negative file, process-environment, protected-socket, executable-tree, group-membership, and Docker-socket checks under the actual `omnis-worker` identity.

These scripts were syntax-checked only. They were not executed because this environment has no Omnis service identities or systemd deployment, and changing the shared host's users/groups/services was outside scope. The actual Docker socket is `root:docker` mode `0660`; the current shell user is not in `docker`, and `docker info` returns permission denied. Docker and PostgreSQL integration could not be run locally. The rootful launcher, service user, `/proc`, secret-file and socket boundaries therefore remain unverified on a deployed Linux host.

## Trusted request and failure behavior

The authorizer continues to accept privileged requests only through API service authentication, assigns the fixed single-owner actor after API authentication, and records authorization decisions transactionally. The worker does not receive the API-authorizer token or authorizer DB credential. A lost response after a request reaches the UDS transport maps to `authorization_outcome_unknown`, not definite failure. The same idempotency key is safe to retry and authenticated readback is available. A pre-connect failure maps to `authorizer_unavailable`. No worker-side approval fallback was added.

The owner identity is still the single local `owner` principal authenticated by the API session and CSRF boundary. The authorizer does not independently validate a multi-user assertion or step-up factor. The static service token requires coordinated rotation. This remains mock-only and is not adequate authority for real provider access.

## Local verification

Environment: Node.js `24.22.1`, pnpm `12.16.1` invoked through `npm exec`; no `OMNIS_*` test database URLs were set. The current user is `jeysi`; groups are `adm cdrom sudo dip plugdev users`. `/var/run/docker.sock` is owned by `root:docker` with mode `0660`; Docker access returned permission denied. `pg_isready` is unavailable. No host service identity or shared service was modified.

| Check | Result |
|---|---|
| `pnpm format:check` | Passed after formatting |
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed across workspaces |
| Workspace unit tests | Passed: `pnpm --workspace-concurrency=1 -r test`; 50 passed, 0 failed. The PostgreSQL run-store suite skipped because database URLs were unset; one actual-Docker sandbox scenario was skipped because Docker access was denied. Mock server/protocol and fixture security tests ran and passed. |
| PostgreSQL authorization, role, migration, recovery, restore tests | Not run locally; suite skips without disposable PostgreSQL URLs |
| Actual Docker sandbox tests | Not run locally; Docker socket permission denied |
| `integration:mock`, legacy upgrade, backup/restore | Not run locally; require disposable PostgreSQL and actual container infrastructure |
| Host identity negative probe | Script added and shell syntax checked; not run because host users/services must not be changed here |
| GitHub Actions | To be reported from the exact pushed branch SHA; not yet available |

The successful `pnpm check` run reported 50 workspace tests passing and the database-backed run-store suite skipped because test URLs were absent. The database recovery-policy suite separately passed 30/30. The exact CI workflow now also runs the disposable identity probe before role provisioning. `pnpm build` passed. `pnpm install --frozen-lockfile` passed. The standalone sandbox-launcher test command reported 5 passed. The Docker-only security subtest displayed as skipped in the broader workspace suite; actual Docker sandbox execution was not verified.

## Finding disposition and remaining gates

G4-3 is **Partially Fixed** on this branch. The worker code delegates container execution to a strict launcher and has no Docker client dependency. The proposed host deployment separates service identities and confines Docker group membership to the launcher. However, those OS permissions have not been executed or verified here, and the launcher remains a privileged trusted component. Do not claim host isolation passed until the deployment-level verifier and actual disposable sandbox tests pass under the deployed identities.

I-3 has pool-level idle-client error handling and a PostgreSQL subprocess regression test in the workspace suite; the database-backed subprocess was not executed locally here. I-4 has API transport tests for pre-connect failure versus a connected request whose response is lost; these run in the API unit suite. Provider requests, credentials, general-purpose tools, and arbitrary container configuration remain disabled. ADR-0010 remains Proposed; ADR-0011 remains Proposed. A trusted credential broker, independent revocation enforcement during provider side effects, separately protected audit sink, egress policy, and provider-specific approval controls remain future gates.

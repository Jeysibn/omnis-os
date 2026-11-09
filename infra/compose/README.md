# Private Docker Compose application topology

The application overlay runs PostgreSQL, API, worker, and the Omnis OS web gateway with Docker Compose. The existing host systemd authorizer and restricted sandbox launcher remain host-managed because the launcher has tightly constrained access to the Docker daemon. The API and worker receive only their respective read-only Unix socket mounts; neither receives the Docker socket. Docker-group access remains host-root-equivalent and is confined to the launcher.

The `edge` and `data` networks are Docker internal networks. Web is attached only to `edge`; the worker and database are attached only to `data`; API bridges both so the browser gateway can reach the API and the API can reach the worker. API and worker have no published ports. Web and PostgreSQL publish only to host loopback. The web gateway serves the built SPA and proxies `/api/*` requests, including SSE streams, to the internal API while preserving browser origin, cookies, CSRF, and idempotency headers.

## First startup

This topology is for a private Linux deployment, not a command to run on an unreviewed host. Run these provisioning commands from a root shell so Docker can access its daemon and the tools can read owner-only environment files. Start PostgreSQL first so roles and migrations can be provisioned before the API and worker processes are launched:

```sh
sudo docker compose --env-file .env.db-admin -f infra/compose/docker-compose.yml up -d postgres
pnpm db:roles
pnpm db:migrate
```

## Host prerequisites

After PostgreSQL is healthy and migrations are applied, install and review the existing service identities, secret files, and systemd units using the approved host procedure. Start only the authorizer and restricted launcher as host services; Compose owns the web, API, worker, and PostgreSQL processes.

1. Generate owner secrets and install the service-specific files using the existing reviewed host procedure. Keep `.env.db-admin`, `/etc/omnis/api.env`, and `/etc/omnis/worker.env` owner-only. Docker Compose and the database provisioning tools must run as root because Docker control is root-equivalent and the service env files are deliberately not readable by an ordinary account.
2. Set `OMNIS_ALLOWED_ORIGIN` in `/etc/omnis/api.env` to the exact HTTPS origin served by the private reverse proxy and set `OMNIS_SECURE_COOKIES=true`. Configure the proxy to forward requests to `127.0.0.1:8080`; it must preserve `Origin`, `Cookie`, and `Set-Cookie` and support long-lived SSE responses. The proxy, TLS certificate, DNS, and private ingress are outside this Compose file.
3. Copy `.env.compose.example` to `.env.compose`. Set the authorizer and launcher socket group IDs to the numeric IDs of `omnis-authorizer-socket` and `omnis-launcher-socket` on that host. The file contains topology values only, no credentials.
4. Verify that the host authorizer and restricted launcher are active, their Unix sockets have the expected group access, the secret files are private, and their socket group IDs match the Compose settings:

   ```sh
   sudo node scripts/compose/check-host-prerequisites.mjs
   ```

The preflight is read-only. It does not install host identities, modify systemd, alter firewall rules, change Docker, or start services.

Then start the application overlay:

```sh
sudo docker compose --env-file .env.db-admin --env-file .env.compose \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.app.yml up -d --build
```

The database's only host-published port is `127.0.0.1:5432` for the host-managed authorizer, launcher, and migration tools. The API and worker listen on their private Docker networks. The web gateway listens on `127.0.0.1:${OMNIS_WEB_PORT:-8080}` for a separate private HTTPS proxy. No internet-facing ingress or database port is configured here.

## Health, persistence, and recovery

- Compose waits for PostgreSQL health before starting worker, then waits for worker and API health before starting web. Host socket readiness is checked separately by the preflight.
- PostgreSQL state lives in the existing named `omnis-postgres-data` volume. API, worker, and web containers are read-only, non-root, capability-free, bounded by CPU/memory/PID limits, and restart under Compose. Their durable task, assignment, authorization, Run, and event state remains in PostgreSQL.
- Worker startup reconciles expired leases and uncertain submissions through the existing durable lifecycle. Compose restart does not authorize replay of uncertain external work. The runtime remains mock-only.
- Use the existing `pnpm db:backup` and `pnpm db:restore:verify` flows against the private database. Backup data, encryption keys, owner secrets, and host service credentials require separate protected storage. A passing disposable backup test is not a backup schedule or a target-host restore drill.
- To stop app containers while keeping PostgreSQL, use `sudo docker compose` with both files and `stop web api worker`. Preserve the database volume. Do not use `down --volumes` for an operational deployment.

## Verification boundary

`pnpm compose:config:test` validates the rendered service topology, internal networks, published-port bindings, resource bounds, service identities, and socket mount allowlist using disposable environment files. Container CI builds the web gateway and probes static delivery, API proxying, cookies, SSE, and path traversal with a local fake API. These checks do not prove compatibility with a particular Linux kernel or Docker daemon, actual host systemd socket permissions, private TLS ingress, scheduled backup, target-host restore, or host restart recovery. Those checks remain required before treating a private deployment as operational. Do not run deployment commands against the owner's machine without separate authorization.

## Disposable full-stack Compose CI test

`pnpm integration:compose-smoke` builds and starts the application Compose tier with a unique project name and a unique disposable PostgreSQL database. Run it only on a disposable Linux CI runner or a separately approved disposable Docker environment. It uses the repository's PostgreSQL role provisioning and migration flow, then starts the existing authorizer and restricted launcher processes as short-lived test fixtures. Those fixtures bind separate, test-scoped Unix socket directories. The API receives only the authorizer socket mount; the worker receives only the launcher socket mount. The test does not install host units, change the Docker daemon, or mount the Docker socket into application containers.

The script creates random database and service tokens, a temporary owner password hash, mode-0600 environment files, a loopback-only web publication, and project-scoped networks and volumes. In the CI overlay, PostgreSQL stays unpublished on the internal data network. Host test fixtures use a Unix socket in a per-run directory mounted only into PostgreSQL; directory and socket access are limited to the CI runner's numeric group, and local database authentication uses SCRAM. Application containers continue using TCP service discovery on the internal data network. The test asserts PostgreSQL has no host port binding. The production Compose file's loopback PostgreSQL publication remains unchanged. A fixed test-only owner password is used only by the disposable CI journey; no provider credential is configured. The test runs the real browser owner task-creation flow against the Compose web gateway, then admits and observes a deterministic mock Run through the existing owner authorization and CSRF checks. It checks that the Run and its events remain available after worker, API, and PostgreSQL restarts. It also inspects runtime container restrictions, confirms app containers have no host-published ports or Docker socket mounts, probes denied external egress, and confirms API startup fails if the authorizer socket bind is missing.

Startup and health use Compose health conditions plus bounded readiness checks. On failure, Compose status and the last 100 service log lines are emitted with known generated database passwords redacted; CI retains a sanitized diagnostics artifact for seven days. Cleanup runs on success or failure and targets only the unique Compose project, its labeled resources, and sandbox containers carrying the database-derived test scope. It does not run Docker prune or remove unrelated volumes.

**Current CI status: blocked.** On Docker Engine 28.0.4 in [run 42542612036](https://github.com/Jeysibn/omnis-os/actions/runs/42542612036), web listened on `0.0.0.0:8080` and returned internal HTTP 200 with zero restarts. Before and after the security probes, Docker's requested loopback `HostConfig` binding existed, but effective `NetworkSettings.Ports` was empty and runner TCP/HTTP received `ECONNREFUSED`. A disposable comparison using the same hardened, credential-free web image reproduced empty effective ports/refused HTTP on a runtime-inspected internal bridge; the normal-bridge control had effective loopback publication and returned HTTP 200. This establishes the internal-bridge publication incompatibility on this CI daemon, not behavior on the owner's WSL2 host. Playwright, owner execution, and restart assertions remain blocked; no passing Compose acceptance is claimed.

A networking correction requires security review before implementation. The narrow proposal is a separate ingress bridge attached only to web, retaining the internal `edge` and `data` networks and loopback-only publication. That bridge must have explicit default-deny outbound enforcement, allow only established response traffic, and preserve web-to-API access through the existing internal edge network. A plain additional bridge would grant web outbound access and is not an acceptable correction. The proposal needs an enforceable policy design, disposable positive/negative egress tests, independent platform/security review, and owner acceptance of the topology. No such bridge, firewall rule, host service, or production topology change is implemented here. An approved solution must pass host HTTP before Playwright, followed by the full owner journey, persistence, restarts, and cleanup.

This CI test is intended to cover the Compose-managed application tier and test-only host socket fixtures. It does not establish the owner's WSL2 daemon or kernel behavior, production host service identities or systemd policy, broker-specific egress enforcement, real credential custody, provider network access, target-host backup restoration, or whether the final Docker-only architecture is acceptable. Those remain separate acceptance gates. A passing job would not approve the current hybrid deployment topology or establish production readiness.

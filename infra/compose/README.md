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

`pnpm integration:compose-smoke` builds and starts the application Compose tier with a unique project name and a unique disposable PostgreSQL database. Run it only on a disposable Linux CI runner or a separately approved disposable Docker environment. It uses the repository's PostgreSQL role provisioning and migration flow, then starts the existing authorizer and restricted launcher processes as short-lived test fixtures. Those fixtures bind separate, test-scoped Unix socket directories. The API receives only the authorizer socket mount; the worker receives only the launcher socket mount. The test does not install host units, change the Docker daemon, or mount the Docker socket into application or browser containers.

The script creates random database and service tokens, a temporary owner password hash, mode-0600 environment files, a loopback-only web publication request, and project-scoped networks and volumes. In the CI overlay, PostgreSQL stays unpublished on the internal data network. Host test fixtures use a Unix socket in a per-run directory mounted only into PostgreSQL; directory and socket access are limited to the CI runner's numeric group, and local database authentication uses SCRAM. Application containers continue using TCP service discovery on the internal data network. The test asserts PostgreSQL has no host port binding. The production Compose file's loopback PostgreSQL publication remains unchanged. A fixed test-only owner password is used only by the disposable CI journey; no provider credential is configured.

The CI overlay adds an internal `browser_web` network shared only by `web` and a Playwright 1.64.1 image pinned to its Linux/amd64 digest. The web gateway remains on its existing internal `edge` network to reach API. The browser does not join `edge` or `data`, has no published ports or Docker socket, runs as the disposable CI runner's non-root numeric identity, uses a read-only workspace, and has only a test-results bind mount plus a temporary filesystem. The browser talks to `http://web:8080`; all API operations are same-origin through the web gateway. Runtime checks inspect actual network memberships and container restrictions. From the browser namespace they test web access; direct TCP denial to the inspected API, worker and PostgreSQL addresses; selected host-gateway ports; IPv4 metadata; TCP to `1.1.1.1:80/443`; and a direct UDP DNS query to `1.1.1.1:53`. A test-scoped firewall rule on the disposable GitHub-hosted Linux runner drops IPv4 host-INPUT packets arriving from the browser bridge subnet and all IPv6 host-INPUT packets arriving on that bridge. The test opens a temporary listener on the Docker host gateway, verifies it is reachable from the runner, then confirms the browser cannot reach it and the IPv4 DROP counter increments. If the bridge and browser have link-local IPv6, a temporary IPv6 listener is tested from both runner and browser, and public IPv6/metadata egress is probed when a global IPv6 address and default route exist. Rules are removed after Compose teardown in `finally`; if browser shutdown cannot be verified, the guard is intentionally retained until the disposable runner is torn down and the job fails. This runner-only firewall is not applied on an owner's WSL2 host. Docker's embedded DNS may resolve external names and forward queries via the daemon; the probe records lookup behavior and tests that resolved HTTPS destinations are unreachable from the browser container. DNS probes have a 2.5-second deadline. They do not establish DNS-query privacy or deny every possible host port, destination, or protocol.

Compose network membership is not directional filtering: API is attached to both `edge` and `data` and binds `0.0.0.0` on those private Compose networks, so peers on either network can initiate connections to API. Option C establishes a direct-network denial boundary from the browser container; it does not prove worker/PostgreSQL cannot initiate connections to API. The CI container assertions also do not verify Chromium's internal sandbox mode; they verify the browser container's own non-root identity and Docker restrictions.

The browser journey authenticates the disposable owner, verifies CSRF denial, creates and assigns a Task, approves the existing mock Run flow, checks idempotent replay, verifies ordered synthetic Run events, reloads the application, and writes only Task/Run IDs and event identity fields to a test-scoped result directory. The same browser verifies those committed records after worker, API, and PostgreSQL restarts. The test also confirms no real provider key is configured, no application service has unintended host ports or Docker socket mounts, and API TCP connection to the sampled `1.1.1.1:443` endpoint fails while its service networks are internal. That single API probe is not a complete protocol-wide egress policy test. API startup also fails if the authorizer socket bind is missing.

Startup and health use Compose health conditions plus bounded readiness checks. On failure, Compose status and the last 100 service log lines are emitted with known generated database passwords redacted; CI retains a sanitized diagnostics artifact for seven days. Cleanup runs on success or failure and targets only the unique Compose project, its labeled resources, and sandbox containers carrying the database-derived test scope. It does not run Docker prune or remove unrelated volumes.

**Host-loopback ingress remains blocked on the tested CI daemon.** On Docker Engine 28.0.4 in [run 42543015445](https://github.com/Jeysibn/omnis-os/actions/runs/42543015445), web listened on `0.0.0.0:8080` and returned internal HTTP 200 with zero restarts. Before and after security probes, Docker's requested loopback `HostConfig` binding existed, but effective `NetworkSettings.Ports` was empty and runner TCP/HTTP received `ECONNREFUSED`. A disposable comparison using the same hardened, credential-free web image reproduced empty effective ports/refused HTTP on an internal bridge; the normal-bridge control had effective loopback publication and returned HTTP 200. This establishes an internal-bridge publication incompatibility on that CI daemon, not behavior on the owner's WSL2 host. Option C runs report host ingress as **NOT VERIFIED in that run**; they do not convert this historical failure into a pass.

Option C changes only how CI exercises the application: it uses a separate internal browser-to-web network instead of requiring the runner to reach Docker's host-published web port. It is not a Docker host port-publication fix, production ingress design, or deployment topology decision. CI internal browser integration and host-loopback ingress are separate acceptance results. A passing internal journey does not make host ingress pass; it remains blocked for the tested CI daemon and NOT VERIFIED on the target WSL2 host. Preserve the host publication diagnostics and require separate disposable WSL2 validation plus an owner-approved deployment architecture.

This CI test covers the Compose-managed application tier and test-only host socket fixtures. It does not establish the owner's WSL2 daemon or kernel behavior, host-loopback publication, production host service identities or systemd policy, broker-specific egress enforcement, real credential custody, provider network access, target-host backup restoration, or whether the final Docker-only architecture is acceptable. Those remain separate acceptance gates. CI uses a Docker Engine internal network for the test browser; it does not make the final Omnis OS deployment Docker-only or approve the existing hybrid topology. A passing job does not establish deployment readiness.

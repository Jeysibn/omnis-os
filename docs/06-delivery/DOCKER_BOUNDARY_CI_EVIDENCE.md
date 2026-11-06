# Disposable Docker Boundary Verification

The `container-images` CI job builds the API, worker, and static web-asset images, then runs `scripts/container-boundary/verify-disposable-boundary.mjs` on a disposable Ubuntu Linux runner. The test uses only those built images, synthetic Unix socket servers, temporary directories, and uniquely labeled Docker networks and containers. It does not start Omnis services, connect to PostgreSQL, mount actual authorizer or launcher sockets, or run a provider.

## CI evidence

The harness verifies:

- API and worker run as UID/GID `10001:10001`, load their deployed internal workspace dependencies, and fail for the expected application configuration reasons when started without required configuration. The API reports that `OMNIS_SESSION_SECRET` must be generated; the worker reports that `OMNIS_INTERNAL_TOKEN` must be generated. The test rejects arbitrary startup failures, including `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, module-not-found errors, syntax errors, and timeouts.
- Historical incident: before PR #51, PR #49 head `06a3896e113b42da743a23262900fdc1a8323dca` failed container-image startup in CI run [42258764905](https://github.com/Jeysibn/omnis-os/actions/runs/42258764905). Node raised `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` while resolving `@omnis/contracts/src/index.ts` from `node_modules`. PR #51 (`a89982c9af5c1107d5156b2ad53fd4d603de929b`) corrected the deployed internal workspace compilation and runtime exports. The correction is included in PR #49's current base. Its startup assertions now pass on head `12bf0e09339de71e34e78fb0e6fa922d9edaf9f7` in CI run [42265593538](https://github.com/Jeysibn/omnis-os/actions/runs/42265593538). The TypeScript startup failure is no longer an active blocker.
- Synthetic workloads use a read-only root filesystem, dropped capabilities, `no-new-privileges`, a PID limit, CPU and memory limits, and a small writable `/tmp` tmpfs. It checks process identity and effective capabilities from inside the container, inspects the Docker configuration, and confirms Docker sockets and Windows/host mount paths are absent.
- API and worker can connect to only their separately mounted synthetic Unix socket when given the matching supplementary group. A missing group is denied with `EACCES`; the other service socket is absent with `ENOENT`. Socket ownership, group, mode, directory traversal, read-only bind behavior, stale socket detection, socket recreation, and directory replacement/remount behavior are checked.
- A Docker `--internal` network permits a synthetic HTTP health check after bounded readiness retries, while denying a direct TCP connection to an external address. Before interpreting that denial, a probe on the normal bridge must complete a TCP handshake to the same external address. A second internal network's synthetic service is first positively reached on its own network, then verified unreachable from the first network. All positive controls must pass before denial results are accepted.
- A deliberately failing synthetic cleanup probe is removed by the harness cleanup path. CI also has a run-ID-scoped cleanup trap for resources left by an interrupted test.
- The static web image remains a static asset bundle with no command, entrypoint, or exposed port; existing image checks extract and verify `index.html` without starting a server.

Each container and network is labeled with the GitHub run and attempt identifier. Cleanup selects only resources with that exact label. The harness has command timeouts, and CI bounds the complete job to 25 minutes. Diagnostics contain only probe results and generic command failures; no database URLs, service tokens, credentials, or host files are supplied to the workloads.

## Evidence limits

This is evidence for the tested Docker Engine behavior on an Ubuntu CI runner. It does not establish compatibility with the target WSL2 host, including its kernel, mount, networking, cgroup, Docker daemon security settings, or restart behavior. The synthetic socket protocol is only a Unix permission/connectivity probe; it does not exercise real authorizer or launcher sockets or their protocols. Inspecting configured limits verifies the requested Docker controls were set; it does not constitute a load or exhaustion test. `no-new-privileges` and dropped capabilities constrain privilege escalation but do not prevent an application from spawning ordinary child processes.

The packaged API and worker still use loopback defaults and are not started as a Compose deployment here. This job does not resolve the separately owned Compose addressing contract, grant containers Docker daemon access, or verify production service integration. It does not prove Windows-to-WSL port exposure behavior, systemd automatic restart or stop/start behavior, or operational deployment readiness. It provides no authorization for production use or real AI runtime execution.

## Required target-WSL checklist

Before relying on host-managed systemd socket mounts from application containers, run a separately authorized verification on the intended WSL2 Ubuntu host. Use only disposable synthetic socket servers and no real Omnis credentials or persistent database changes.

1. Record the WSL distribution and kernel, Docker Engine/Compose versions, daemon mode, cgroup version, AppArmor/seccomp status, and relevant Docker user-namespace settings.
2. Verify exact socket owner, group, mode, parent-directory traversal permissions, and container UID/GID plus supplementary-group mapping for each synthetic socket.
3. Confirm API-equivalent credentials can connect only to the synthetic authorizer socket and worker-equivalent credentials only to the synthetic launcher socket. Verify reverse and cross-service denial, Docker socket absence, and no Docker-group authority in application containers.
4. Exercise socket replacement while retaining the directory; then separately exercise systemd automatic restart, explicit service restart, stop/start with directory removal, and WSL shutdown/restart. Record whether an existing container mount sees the replacement and whether container remount/recreation is required. Do not infer `RuntimeDirectoryPreserve=restart` behavior from this CI test.
5. Verify application containers have no Windows drive mounts, developer-home mounts, or broad host directories. Inspect actual mounts and test synthetic canary paths without reading real credential files.
6. Confirm only intended host-loopback ports are reachable from Windows and WSL peers, and verify private Compose network behavior with positive local-service and negative cross-network/egress controls.
7. Confirm resource settings and cleanup after normal stop, forced container termination, Docker restart, WSL restart, and a simulated launcher failure. Record orphan-container results.

Record the tested host configuration and exact image digests. A failed or unavailable prerequisite is a blocked result, not a pass. These host checks do not authorize provider credentials, provider egress, or real AI execution.

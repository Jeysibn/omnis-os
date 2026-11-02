# R1-G2 Sandbox Security Evidence

**Run date:** 2026-11-02 (Asia/Manila)
**Scope:** Local WSL2 mock-only execution path
**Result:** Passed locally for the implemented deterministic mock sandbox; production deployment and real runtimes remain gated.

## Threat model

### Assets

- Owner/provider credentials and home-directory files.
- Docker socket and daemon control.
- PostgreSQL task, run, event, and authorization state.
- Other run workspaces, host processes, host services, private networks, and cloud metadata.
- Host availability and the integrity of run status/evidence.

### Trust boundaries and assumptions

- The browser, task title, and task description are untrusted input.
- Fastify validates and authorizes requests. It does not launch shell commands.
- The trusted worker owns job admission, run state, sandbox creation, cancellation, and PostgreSQL access. Sandbox code cannot reach PostgreSQL or report events directly.
- The Docker daemon, host kernel, worker executable, image digest, and user with Docker group access are trusted. Rootful Docker access is root-equivalent.
- R1-G2 workload scope is deliberately narrow: a fixed deterministic Node program that consumes JSON title data and emits synthetic output. No provider inference, arbitrary agent code, MCP, or native runtime executes.

### Residual attacker capabilities and risks

A container/kernel/daemon escape or trusted launcher compromise could affect the host. Containers share the host kernel. Rootless Docker/user namespaces and AppArmor were unavailable on this host; Docker's default seccomp was present. A malicious workload cannot contact external services in the configured network mode, but resource and kernel vulnerabilities remain possible. If the worker disappears, a bounded container may continue until its 30-second timeout; a replacement worker removes expired-lease orphans. No guarantee is made for a host that never restarts its worker.

## Architecture and enforced controls

- Worker launches an ephemeral container from `node@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85`; image pulls are disabled during execution.
- Network: Docker `--network=none`; no external, host, PostgreSQL, peer-container, private-network, or metadata route is provided.
- Identity/privilege: container uses the worker's non-root numeric UID/GID; `--cap-drop=ALL`, `no-new-privileges`, Docker default seccomp, no privileged mode.
- Filesystem: read-only image root; one unique temporary workspace mounted at `/workspace`; `/tmp` is a bounded `noexec,nosuid,nodev` tmpfs. No home, SSH, OAuth, Docker socket, DB file, or unrelated workspace mount is added. Temporary host directories are mode 0700 and removed after completion.
- Resources: 128 MiB memory with equal swap cap, 0.5 CPU, 32 PIDs, 16 MiB shared memory and tmpfs, core limit zero, 128 file descriptors, 30-second maximum executor timeout, 64 KiB combined output cap.
- Input/command: the runtime adapter provides a fixed program and JSON stdin. Executor validates argument size/count, stdin size, run ID and timeout bounds; it does not invoke a shell. Errors persisted to run state are allowlisted safe messages.
- Lifecycle: cancellation requests Docker stop and confirms termination; uncertainty is surfaced as interrupted. Worker reconciliation uses PostgreSQL lease state to remove only scoped orphan containers. Active leases are resolved after Docker enumeration to reduce stale-snapshot races, and expired leases cannot be revived by a late heartbeat.
- Network extension: intentionally absent. Any future egress requires network-layer allowlisting and separate review.

## Environment

- WSL2 Ubuntu 26.04.1 x86_64; kernel 6.6.87.2.
- Node.js v24.22.1; pnpm 12.16.1 via `npx`.
- Docker Engine 29.9.2; Docker Compose v5.6.1; PostgreSQL 17.6 Alpine.
- Docker socket owner/group/mode: `root:docker`, `0660`. The initial shell lacked the already-configured supplementary group; a fresh WSL login for `jeysi` had Docker group membership and could access the daemon. No permission, group, daemon, or firewall changes were made.
- Engine reported cgroup v2, built-in seccomp, and CPU/memory/PID controls. Rootless/userns mode and AppArmor were unavailable. Container image selected platform was linux/amd64 and reported Node v24.22.2.
- Disposable `omnis_r1g2_test` database and named volume were local only. No provider credential was read or passed to the test container.

## Security tests and outcomes

The actual Docker suite is `apps/worker/src/docker-sandbox.security.test.ts`, enabled with `OMNIS_SANDBOX_INTEGRATION=1`. The test workload itself attempted prohibited operations; outcomes below are expected denials unless indicated.

| Test | Actual observation | Result |
|---|---|---|
| Host-only dummy file and synthetic credential outside the workspace | Paths absent/inaccessible | Pass |
| Unrelated run directory and writes outside `/workspace` | Other workspace absent; host write denied | Pass |
| Docker socket | No socket path or mount | Pass |
| Identity and privilege | Effective UID non-zero; setuid/privilege escalation unavailable | Pass |
| Capabilities | No effective capabilities | Pass |
| Root filesystem | Write to image root denied | Pass |
| Workspace and `/tmp` | Run workspace writable; `/tmp` writable but `noexec`; other locations unavailable | Pass |
| Egress | Requests to controlled public endpoint, host-local listener, PostgreSQL, peer test container, private test address, and metadata addresses failed with networking disabled | Pass |
| PID limit | Attempt to exceed process limit failed | Pass |
| CPU limit | CPU-bound probe observed throttling under configured cgroup quota | Pass |
| Memory limit | Allocation above configured limit caused controlled container failure; worker stayed alive | Pass |
| Timeout and cancellation | Timed-out/cancelled process terminated; run coordinator recorded correct terminal state | Pass |
| Crash/output limit | Failure and output cap surfaced with safe error categories | Pass |
| Orphan cleanup | Expired-lease container removed; active-lease container preserved | Pass |
| Unsafe executor input | Shell/invalid run identity or out-of-range values rejected before execution | Pass |

The suite comprised 8 integration test cases, with several tests checking multiple denied paths. All 8 passed against the real local Docker daemon. The suite output also reported 12 coordinator tests passing; all 20 worker tests passed. No test was substituted with configuration-only assertions.

## Persistence, lifecycle and browser checks

- PostgreSQL integration tests passed against a real PostgreSQL 17.6 instance, including migration execution, rollback, idempotent/concurrent admission, ordered event storage/replay, cancellation, lease selection, rejection of late renewal after lease expiry, and safe failure event persistence.
- `pnpm integration:mock` passed using the container-backed adapter and actual API/worker processes. It exercised sign-in/CSRF checks, task admission, durable SSE, cancellation, API restart, worker restart, state reconstruction, and no unsafe duplicate replay.
- Playwright browser smoke passed: owner sign-in; task creation; completion of a container-backed synthetic run; event/output inspection; a second run cancelled while in progress; reload with persisted state. Responsive checks used 390x844 and 1440x1000 viewports. Post-auth browser console had no errors or warnings.
- Screenshots: [desktop](r1-g2-desktop.png) and [mobile](r1-g2-mobile.png). They show only synthetic mock output.
- The restart smoke used normal process termination/restart. Hard host power loss and Docker daemon crash were not simulated. Database lease/orphan logic was additionally exercised by targeted tests.

## Commands executed

From a fresh WSL login shell with the pre-existing Docker group membership; the DB URL was sourced from a mode-0600 local test env file and pointed only to the disposable `omnis_r1g2_test` database:

```sh
npx --yes pnpm@12.16.1 install --frozen-lockfile
npx --yes pnpm@12.16.1 sandbox:image:pull
OMNIS_SANDBOX_INTEGRATION=1 npx --yes pnpm@12.16.1 check
npx --yes pnpm@12.16.1 build
npx --yes pnpm@12.16.1 integration:mock
```

`pnpm check` passed formatting, ESLint, all workspace TypeScript checks, and 42 tests (3 contracts, 4 API, 11 database, 2 policy, 2 runtime-adapter, 20 worker/coordinator/sandbox). The actual-container suite was enabled, and no sandbox tests were skipped. Production build and PostgreSQL-backed API/worker restart integration passed. `pnpm install --frozen-lockfile` and the exact image digest pull both passed. During the final cycle, an initial invocation used a stale disposable DSN and failed authentication; the next check caught a TypeScript nullable-pool error in the new regression test. Both were corrected, and the complete final run passed. No secrets were written to evidence or logs. GitHub Actions has not been run remotely. A clean clone was not created for R1-G2; the frozen install used the committed lockfile in the current checkout.

## Security exceptions and limitations

- No security checks or host permissions were weakened. Docker access used existing owner-authorized group membership only.
- The daemon is rootful; the worker has Docker control. A compromised worker or Docker daemon can control the host.
- Rootless/userns and AppArmor enforcement were unavailable; only the kernel/Docker controls actually measured above are claimed. WSL2 host kernel/container compatibility may differ from Linux server deployment.
- Docker container isolation is not a VM boundary. No formal container escape assessment was performed.
- Egress denial is implemented with Docker's no-network namespace. Tests cover representative targets, not every possible kernel attack or host configuration.
- Apparmor, host firewall, cloud firewall, remote CI, and production deployment were not modified or verified.
- No Hermes, Codex, Claude, OAuth store, model endpoint, shell tool, or MCP server was accessed. Real inference remains disabled.
- Independent Claude Code review has not been performed; prepare it as a separate review after policy approval. The local Codex review is not a substitute.

## Gate assessment

**R1-G2: Passed Locally for the deterministic mock execution path.** The local WSL2 acceptance checks above passed. This result is scoped to the tested code and environment and is not production approval, a general arbitrary-code sandbox certification, real runtime authorization, or completion of the broader R1 release gate.

Remaining gates: remote CI confirmation; production deployment isolation review; independent security/architecture review; authorized runtime policy and connector work; backup/restore and hard-failure recovery drills.

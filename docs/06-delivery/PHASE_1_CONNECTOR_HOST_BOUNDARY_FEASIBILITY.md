# Phase 1 — Connector Host-Boundary Feasibility

**Assessment date:** 2026-11-05  
**Repository baseline:** `origin/main` at `e0512609973bf24a8fd40f7da7731865fdc45377`
**Readiness handoff:** PR #37, head `853ff8ae73b55efb1495734d56280bbd0df9382d` (merged)
**Scope:** Design and feasibility only. No provider authentication, inference, host provisioning, egress activation, or runtime change was performed.

## Decision

**BLOCK — real-runtime readiness.** A separate systemd connector identity, filesystem view, resource limits, local socket, and deny-by-default egress proxy are plausible designs. The candidate Codex app-server is not presently demonstrated to provide a no-tool mode: OpenAI's SIWC preview documentation explicitly says app-server can run local shell and MCP tools and coordinate child agents. A prompt or an empty intended tool list is not a host security boundary. The current repository also contains no connector unit, broker, egress policy, or tests proving those capabilities are denied. Keep the runtime mock-only and keep G4-3 **Partially Fixed** and R1-G5 **Partially Complete**.

This blocks a real provider request, not further design or synthetic-only platform prototyping. The shortest safe path is: (1) Codex #1 reviews the authorization and credential boundary below; (2) select a connector interface/configuration that can prove tool dispatch is absent or render every tool capability inert at the OS boundary; (3) implement a disposable-VM/CI synthetic verifier; (4) have a Codex #1 independent read-only security-review subagent review the design and evidence; (5) verify on a separately approved owner-controlled target before any real OAuth or inference authorization.

## 1. Verified baseline and scope

### Repository and active work

- Latest fetched `origin/main` is `e0512609973bf24a8fd40f7da7731865fdc45377`.
- PR #37 was merged at `853ff8ae73b55efb1495734d56280bbd0df9382d`; its readiness and Codex #3 handoff documents are included in the current main baseline.
- PR #36 is the full-stack browser-to-PostgreSQL smoke test (`724f854a94f742b544171e35d067466443b34d37`); #31 is frontend work (`edf93d72cea4d7fd0f64c1c2c68fba885b1ccd2a`); #25 is frontend department work; #26 is local Compose PostgreSQL digest work. None changes the proposed new feasibility-document path. No application or infrastructure files were changed by this assessment.
- The original worktree was already on `security/r1g5-host-authorizer-isolation`, behind its remote by two commits, with an unrelated untracked UI specification. It was left untouched. This document is in an isolated worktree based on current `origin/main`.

### Existing host isolation evidence

`docs/07-governance/evidence/R1_G5_HOST_ISOLATION.md` records a successful disposable Ubuntu 24.04 systemd deployment check (historical CI run `41687576726`, implementation SHA `a6f33442da291ac02ca8b47b6cb758bd50540c30`). That run exercised actual service identities, installed root-owned application files, restricted service secrets, socket boundaries, and mock API-to-worker-to-launcher execution on an ephemeral runner. It is evidence for that exact disposable setup, not the developer host or a production/homelab target.

Current units in `infra/systemd/` define `omnis-api`, `omnis-worker`, `omnis-authorizer`, and `omnis-launcher`; each uses a distinct primary group and several systemd hardening directives. The launcher is explicitly in the `docker` group and remains root-equivalent. The worker has only its private group and `omnis-launcher-socket`; it is not in Docker or the authorizer socket group. The current units permit AF_UNIX, AF_INET, and AF_INET6 and define no connector-specific cgroup resource budgets or provider egress policy. `scripts/host-security/provision-identities.sh` provisions no connector or credential-broker identity. `install-service-secrets.sh` installs service-specific files but has no provider credential path.

The existing `scripts/host-security/verify-disposable-systemd-deployment.sh` is explicitly destructive to its disposable runner: it provisions users, groups, files, secrets, units and services and requires root/systemd/Docker/credentials. It was inspected but **not run** locally. Do not use it on a developer or target host.

### Current developer environment

Read-only observations: Ubuntu 26.04.1 under WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, systemd 259 running as PID 1, and cgroup v2. The current developer user is UID/GID 1000 and belongs to `sudo`, `adm`, and general desktop groups. `systemd-analyze has-tpm2` reports `partial`; the local systemd build reports a missing `libtss2-esys` library. This is not evidence of usable TPM-backed credential encryption. No service isolation, Windows-mounted-path denial, network namespace behavior, credential protection, or provider boundary was tested. Microsoft notes WSL systemd services do not keep a WSL instance alive, so WSL is useful for development checks but is not by itself evidence of an always-on host service.

## 2. Candidate architecture

Treat the connector as a separate, low-trust protocol client, not as an extension of the API or worker.

```text
Owner UI → API ── existing owner auth/CSRF ── authorizer
              │
              └── private job UDS + scoped, short-lived authorization ──┐
                                                                       ▼
                                          omnis-connector (one isolated instance)
                                            │                       │
                                            │ broker UDS             └── only egress proxy UDS
                                            ▼                                │
                                     credential broker                     ▼
                                     (refresh secret)             provider allowlist
```

The connector receives a fixed-schema job envelope, never a database URL, provider refresh credential, task workspace path, shell command, or generic tool configuration. It has no PostgreSQL connection, authorizer/launcher socket, Docker socket, or workspace mount. API authentication and authorizer decisions remain owned by Codex #1. A local socket proves peer identity and limits reachability; it does not prove that an individual job was authorized. The backend contract must cryptographically or transactionally bind the owner decision, task/request identity, connector operation, expiry, and replay/idempotency policy. The connector must fail closed when that authorization or the broker is unavailable.

### Proposed service identity and policy

- Dedicated static system user/group `omnis-connector`, no login shell, no developer home, private primary group, empty supplementary groups. Do not reuse `omnis-worker`, `omnis-launcher`, `omnis-api`, authorizer groups, PostgreSQL groups, or `docker`.
- Root-owned, non-writable pinned executable and dependency tree under a versioned `/opt/omnis-connector/<version>` path. Verify hashes/provenance at installation; do not load `$HOME/.codex`, project plugins, inherited user config, or ambient environment.
- A private per-instance home and task scratch area (for example `/var/lib/omnis-connector/instances/<opaque-id>`), mode 0700, with bounded size and cleanup. Do not mount ordinary task workspaces, Git checkouts, `/home`, `/root`, `/mnt`, `/media`, or `/run/user`.
- Initial concurrency limit one. If concurrent invocations are later required, use a separately isolated UID/private directory per invocation, not multiple mutually visible jobs under the same service account.
- Start with `NoNewPrivileges=yes`, empty capability sets, `PrivateTmp=yes`, `PrivateDevices=yes`, `ProtectSystem=strict`, `ProtectHome=tmpfs` (or `yes` if no private home is needed), `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectKernelLogs=yes`, `ProtectControlGroups=yes`, `ProtectClock=yes`, `ProtectHostname=yes`, `ProtectProc=invisible`, `ProcSubset=pid`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `RestrictRealtime=yes`, and `UMask=0077`. Apply `ReadWritePaths=` only to the private scratch and narrowly scoped runtime directories. Keep only the AF_UNIX socket access needed; remove AF_INET/AF_INET6 if the chosen proxy channel permits it.
- `PrivateNetwork=yes` is a candidate network control, not proof of no network path. If used, the connector must communicate through a narrowly permissioned Unix socket to an egress proxy in a different network namespace. Test AF_UNIX visibility and proxy bypass. Alternatively use a cgroup-aware firewall plus a restrictive proxy; do not assume `IPAddressDeny=` supports FQDN policy.
- Use `TasksMax`, `MemoryMax`, `CPUQuota`, `LimitNOFILE`, `LimitFSIZE`, `RuntimeMaxSec`, `TimeoutStopSec`, and cgroup-wide kill behavior. Exact values below are starting proposals, not validated sizing. `LimitNPROC` alone is not adequate for a multi-process service; systemd/cgroup limits are preferred. Avoid `MemoryDenyWriteExecute` until tested against the pinned Node/V8 runtime.
- Consider `SystemCallFilter=` only after syscall tracing and disposable compatibility testing; an untested allowlist can prevent app-server startup and is not a substitute for denying tools.

systemd documents filesystem namespaces, syscall/address-family restrictions, cgroup resource controls, and credential delivery, but effective controls depend on kernel and systemd support. Unit syntax and actual behavior must both be verified on the exact disposable Ubuntu image and later target. WSL's running systemd/cgroup v2 does not verify all namespace, `ProtectHome`, `PrivateNetwork`, BPF, TPM or mount behavior.

## 3. Explicit allow/deny resource matrix

| Resource             | Connector allowed                                                                                                                       | Connector denied                                                                                                                                       | Enforcement/evidence required                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Identity/groups      | Own `omnis-connector` UID/private GID only                                                                                              | `docker`, DB, authorizer, launcher, API, developer, `sudo`, socket groups                                                                              | `id`/`/proc/<pid>/status` from independent verifier; `SupplementaryGroups=` reset and user DB checks                                |
| Executable/config    | Root-owned pinned app-server, connector, fixed root-owned config and libraries                                                          | User Codex/Claude/Hermes configs, plugins, hooks, project configuration, writable binaries/dependencies                                                | Ownership/mode/hash check; attempt modification/read of user config from service context                                            |
| Filesystem           | Private bounded scratch; minimal read-only runtime libraries; service's own credential mount only if reviewed                           | Developer homes, `/root`, `/mnt`, `/media`, Git repositories, other tasks, host `/etc`, API/worker/authorizer/launcher secrets, PostgreSQL data/socket | systemd filesystem namespace plus negative open/list/write tests; test symlink and `/proc` escapes                                  |
| Local sockets        | One job socket to API; one credential-broker socket; one egress-proxy socket, each with separate parent dirs and peer-credential checks | Docker, authorizer, launcher, PostgreSQL, arbitrary `/run`, user bus, SSH/GPG agents, container runtime sockets                                        | `connect(2)` negative matrix under actual service UID and mount/network namespace                                                   |
| Database             | None                                                                                                                                    | `omnis_runtime`, migrator, authorizer, launcher, administrator roles; database TCP/local sockets                                                       | No DB env/credential/file/route; attempt known test-only endpoints in disposable environment                                        |
| Devices/capabilities | None beyond ordinary required runtime facilities                                                                                        | `/dev/kvm`, raw devices, privileged capabilities, namespaces, ptrace/process inspection                                                                | `PrivateDevices`, capability bounding set, namespace restrictions; inspect effective process status and attempt operations          |
| Network              | Only broker/proxy Unix sockets; proxy may reach reviewed provider auth/API FQDN and port after later approval                           | Direct IP, DNS, arbitrary Internet, localhost/loopback, private/link-local/metadata, Omnis services, alternate proxy, host/WSL gateway                 | Network namespace + firewall; proxy DNS/IP validation and TLS verification; negative tests before any provider allowlist activation |
| Process control      | Own process and bounded children only if future connector contract requires them                                                        | Shell, arbitrary exec, child agents, process inspection/signals against other services                                                                 | No-tool protocol configuration plus kernel denial tests, proc restrictions, cgroup-wide lifecycle                                   |
| Logs/artifacts       | Bounded redacted status, opaque request ID, safe diagnostic code                                                                        | Tokens, cookies, authorization headers, raw env, full request/response headers, core dumps, unreviewed traces                                          | Canary scans over journals, files, artifacts and process metadata; core dumps disabled                                              |

Unix socket paths should be under dedicated root-owned runtime directories (e.g. `/run/omnis-connector/` and `/run/omnis-egress/`), not `/tmp`. The API and connector would be the only members of a dedicated `omnis-connector-api` socket group; the worker must not join it. Broker and egress sockets should have separate groups/directories so connector access to one does not imply access to the other. Verify `SO_PEERCRED` (or equivalent) and validate every message against a strict runtime schema.

## 4. Credential custody

### Proposed separation

1. If a supported owner-consented OAuth flow is selected, use a distinct Omnis app-owned client and consent journey. Never reuse or inspect existing native Codex CLI credential files.
2. Keep refresh credentials outside PostgreSQL and outside API, worker, authorizer, launcher, task, workspace, event, and log records. A separate minimal broker owns the refresh secret and OAuth refresh/revocation logic. Its account alone can read its encrypted store; connector has only broker socket access.
3. Broker returns only a short-lived access token scoped to the selected connector request and audience, over a private Unix socket after peer credential and job authorization checks. Do not return refresh tokens. Bound token lifetime and response size; fail closed on expired/unavailable broker or revocation status.
4. Codex app-server's published SIWC setup currently passes the access token to the app-server child using an `env_key`/`ACCESS_TOKEN` environment variable. That means the token is available to that child and to sufficiently privileged host/root inspection; it is not an absolute no-process-inspection design. Same-UID process access must be prevented (dedicated UID, restrictive `ProtectProc`, no ptrace), core dumps disabled, environment never logged, and the child must be short lived. This residual requires review by Codex #1 and a separate Codex #1 independent read-only security-review subagent, or a different connector transport that keeps the token in memory and does not use environment injection.
5. systemd credentials can deliver activation-time secrets via a protected credential directory, but they are static for that service activation; they do not alone implement OAuth refresh, revocation, per-request scoping, or rotation. A broker/short-lived child lifecycle is still needed. TPM-backed encryption was not established in this WSL environment (`systemd-analyze has-tpm2`: `partial`). At-rest protection must be selected and tested on the eventual target; root compromise remains in the trusted computing base.

No credential facility was exercised and no credential material was accessed. A synthetic high-entropy canary is sufficient to test that a known string does not appear in journals, process arguments, environment dumps accessible to another service, temporary files after cleanup, test results, traces, or CI artifacts. This cannot prove a real OAuth flow's provider policy, token scope, revocation timing, storage guarantees, or app-server internal handling; those require separately authorized consented integration and review.

## 5. Egress boundary

The connector should have no direct IP networking. Prefer an isolated network namespace with only a Unix socket to a separate egress proxy/gateway. That proxy is the only component attached to a controlled external network and must reject by default. A host firewall/cgroup policy should provide a second enforcement layer and prevent alternate routes if the proxy fails. Do not rely on `HTTP_PROXY`/`HTTPS_PROXY` environment variables alone.

For any later allowlist, constrain destination hostname, port, TLS SNI/hostname certificate validation, DNS answer addresses, redirect destinations, and (if the protocol allows without weakening TLS) method/path. Resolve at the proxy, reject any private, loopback, link-local, multicast, reserved, IPv4-mapped IPv6, and metadata address, pin the vetted result for the connection, and revalidate each redirect/resolution. Provider endpoint changes require a reviewed policy update. DNS must not be directly available to the connector. Proxy/firewall startup or health failure must leave egress denied, never fall back to direct network.

TLS passthrough preserves provider end-to-end TLS and permits the proxy to enforce host/port/SNI but not encrypted URL paths or request semantics. Enforcing method/path requires a carefully reviewed application-aware proxy or trusted TLS termination, which introduces a new credential and privacy boundary. The first design should use the narrowest provider host/port set the provider documents, avoid interception, and explicitly accept host-level rather than path-level enforcement if adequate. No provider hostname is allowlisted in this assessment.

### Negative reachability matrix (future disposable test only)

Use only controlled local test endpoints and reserved addresses; do not contact actual provider or cloud metadata services. Assert connection denial and bounded completion for:

| Attempt from connector                                                                           | Expected result                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `127.0.0.1`, `::1`, connector namespace loopback TCP                                             | Denied except explicitly reviewed local Unix sockets                      |
| API, PostgreSQL, authorizer, launcher, Docker and arbitrary host ports                           | Denied                                                                    |
| RFC1918 ranges, WSL host/gateway, link-local, `169.254.169.254`, IPv6 ULA/link-local             | Denied without sending traffic to real metadata endpoints                 |
| Direct external IPv4/IPv6 and raw socket                                                         | Denied                                                                    |
| DNS to arbitrary resolvers, DoH, alternate DNS port                                              | Denied; only proxy-side controlled resolution works                       |
| Allowed synthetic test hostname through proxy                                                    | Allowed only to a local TLS fixture with a test CA; never a real provider |
| Disallowed hostname, IP literal, alternate port, malformed Host/SNI, redirect to private address | Denied by proxy and network layer                                         |
| Proxy absent, stopped, malformed policy, DNS timeout, policy reload failure                      | Fail closed; no direct fallback                                           |
| Proxy socket enumeration/other local Unix socket paths                                           | Denied by directory permissions and peer validation                       |

Provider-only egress is **not established** until all negative tests pass on the exact target environment, and those tests alone do not authorize egress activation.

## 6. Tool-free execution assessment

OpenAI's SIWC preview documentation states that Codex app-server can run local shell and MCP tools and coordinate child agents. The documented SIWC route is therefore not itself a no-tool configuration. Removing MCP entries, omitting plugins, using a restrictive prompt, or selecting an app-server “external sandbox” policy is not sufficient evidence that shell or other local tool dispatch cannot occur.

Before any real provider request, demonstrate both protocol-level and host-level control:

- Pin a specific reviewed app-server version and configuration; start with no user or project config, no MCP servers, extensions, plugins, hooks, browser, scheduler, child-agent configuration, or arbitrary function tools.
- Identify a documented, enforceable setting that prevents all local tool invocation/dispatch for that pinned version. If unavailable, do not use this app-server candidate for the first request unless an independently reviewed adapter refuses all tool-call events and demonstrably terminates the turn before any execution.
- Regardless of protocol setting, provide no workspace or user-home files; mount only a bounded empty scratch; deny network except the proxy; run with no shell or helper executables available in the filesystem view; use process/cgroup and syscall controls that prevent child execution after the app-server itself starts. The exact seccomp/systemd mechanism must be tested because `execve` restrictions can also prevent normal service startup and Node runtimes may need subprocess/system calls.
- Feed synthetic protocol messages that request shell execution, file read/write, MCP, browser, plugin, child-agent, Git, and network actions. Verify the action is rejected before execution and that no observable side effect occurs. Any uncertain tool-dispatch behavior is a gate failure.

Current evidence does not demonstrate those controls for Codex app-server. **This is the direct blocker for real-runtime readiness.** If tool-free behavior cannot be established for the pinned candidate without unsupported patches or weakening the host sandbox, select a different text-only transport or keep the candidate disabled.

## 7. Resource, request and process lifecycle

Initial disposable-profile values for sizing tests only (not approved production settings): one concurrent connector; `TasksMax=32`; `CPUQuota=100%`; `MemoryMax=1G`; `LimitNOFILE=256`; `LimitFSIZE=16M`; request wall clock 120 seconds; output cap 64 KiB; process lifetime bounded to request + short shutdown grace; `LimitCORE=0`; `TimeoutStopSec=5s`; kill the entire service cgroup after grace. Measure a pinned synthetic app-server on the exact runner and tune values before a future target proposal.

The API/backend must persist a transition to a submitting/unknown-capable state before handing a request to the connector. Give every attempt an Omnis request ID and propagate a correlation ID if the app-server/provider exposes one. Stream only bounded text and safe event metadata. On timeout, connection loss, connector crash, or host restart after possible send, mark the request `unknown`/`interrupted`; do not automatically retry or create a replacement submission. Require explicit owner resolution or a provider-supported reconciliation path before another request.

No documented Codex app-server guarantee for idempotency of a provider submission, exactly-once delivery, replay-safe resumption after client disconnect, or stable provider request ID surfaced to the host was established in this assessment. Treat all as **unavailable until verified** against the selected version/protocol. A local app-server thread ID is not proof that the provider did not receive or bill a request. Cancellation is best effort; local process termination cannot prove remote provider computation stopped.

Service restart may restore the listener for future requests, but must not replay an in-flight request. Persist only non-secret state and correlation metadata needed to mark the former attempt unknown. Use `Restart=on-failure` only if the supervisor can distinguish listener recovery from job replay and the backend remains fail-closed. Drain requests, send a bounded interrupt, then TERM/KILL the entire cgroup. Crash dumps and core files stay disabled.

## 8. Executable synthetic verification plan

The following is a future disposable Ubuntu VM/runner test plan, not a command list to run on this developer host. Use a fresh ephemeral VM with systemd and cgroup v2. All credential values are random synthetic canaries; all OAuth/provider endpoints are local fixtures; no actual provider domain is contacted. Do not reuse the current host-security deployment verifier as a shortcut because it provisions the existing application stack and Docker launcher, not this connector boundary.

### A. Source/design evidence

- Review exact pinned unit files, binary/dependency hashes, filesystem layout, socket ACLs, broker contract, proxy policy, and backend authorization schema.
- Validate supported systemd directives against the target systemd version and reject unknown/ignored directives.
- Inspect effective unit properties and `systemd-analyze security` as advisory evidence only; it is not a proof of isolation.
- Static checks ensure no provider URLs/secrets enter test fixtures; no DB URL/token/credential is in the job schema or browser process environment.
- Confirm tests assert failure closed and do not create DB records/tasks/runs by direct SQL to simulate the browser's actions.

### B. Disposable-environment evidence

1. Provision disposable synthetic user/groups; assert exact primary/supplementary memberships and absence from Docker/Omnis DB/control-plane groups.
2. Start actual systemd unit with synthetic fixture executable; inspect effective UID/GID, capabilities, namespaces, proc view, cgroup, core-dump setting, and loaded credential directory permissions.
3. Attempt forbidden home, `/root`, `/mnt`, `/media`, other service secret, DB credential, code tree write, and workspace access; each must fail. Test symlink traversal and `/proc/<other-pid>` access.
4. Attempt every denied Unix socket and local TCP/UDP endpoint; verify failure. Verify only the intended API, broker and proxy sockets accept and check peer UID.
5. Place a canary in fake broker credential flow; scan process args, accessible environ, unit environment, journal, service logs, temp files after cleanup, test outputs and uploaded artifacts. Assert no canary outside the connector process's intended memory/credential handoff. Explicitly record that the connector itself and root can access its short-lived access token.
6. Submit synthetic tool-dispatch requests for shell/exec, file, MCP, browser, plugin, child-agent, Git and network. Assert no process, file, socket or network side effect. Force a test sentinel command and verify it never executes.
7. Run resource stressors in the disposable unit; verify process/thread count, CPU, memory, descriptors, file size, output cap and wall-clock limits terminate or reject as configured without affecting other services.
8. Test cancellation during pre-send, send-in-progress, streaming and post-response phases. On lost acknowledgement/restart, assert `unknown`/`interrupted`, no automatic second submit, no retry after service restart, and bounded child cleanup.
9. Stop broker, proxy, DNS fixture, filesystem mount or required systemd facility; verify connector startup/request is denied with sanitized diagnostics and no alternate path.
10. Verify logs redact synthetic tokens and auth headers, core files are absent, service shutdown removes ephemeral scratch/credential files, and unrelated services/host mounts remain untouched.
11. Run negative egress matrix above with local fixtures; require all prohibited targets denied and the controlled local TLS fixture reachable only through proxy.

The existing CI proves systemd behavior only for its tested Ubuntu runner and current services. Adding a dedicated connector boundary job requires a separate, reviewed implementation task; this assessment does not alter CI.

### C. Target-host evidence

Before any real-runtime approval, use an owner-approved, disposable target matching intended deployment: exact distro/kernel/systemd, cgroup controllers, LSM, network/firewall/proxy, DNS, filesystem mounts, credential facility/TPM, swap/core-dump policy, and service lifecycle. Repeat the negative tests against the effective namespaces and firewall on that target. Specifically test WSL mounted Windows paths and WSL shutdown/restart if WSL is intended. For another deployment host, test its actual platform rather than extrapolating from WSL or GitHub CI. Do not access real credentials or provider endpoints until the owner separately authorizes a consented credential-path test after security review.

Disposable CI evidence is necessary, not production/homelab assurance.

## 9. Existing gates and required remediation

| Existing finding                                                                                           | Does it directly block connector/provider request?                                                                                                                                                                                                | Minimum remediation/evidence                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No independently enforced no-tool boundary                                                                 | **Yes — direct blocker.** Candidate app-server can dispatch local tools/agents; no host denial evidence exists.                                                                                                                                   | Pin candidate; prove documented no-tool mode or add reviewed adapter+kernel boundary; pass synthetic malicious-tool tests with no side effects; independent Codex #1 security-review subagent review.                                                        |
| No approved provider credential path                                                                       | **Yes — direct blocker.** No app-owned consent flow, broker, storage or revocation path exists.                                                                                                                                                   | Codex #1 and an independent Codex #1 security-review subagent approve OAuth/client/consent, broker/store, scoped access-token handoff, expiry/revocation, leakage and failure-closed tests. No native CLI credential reuse.                                  |
| G4-3 partially fixed; rootful Docker launcher is root-equivalent                                           | Not inherently if the connector is independently isolated and has no Docker group, socket, launcher group, or reachable control socket; it remains a host TCB risk and broad host-compromise concern.                                             | Verify connector cannot inspect/control Docker/launcher in disposable and target tests. Reduce rootful launcher risk separately before broader production execution; do not relabel G4-3 complete here.                                                      |
| R1-G5 partially complete; owner assertion/replay protection and key rotation/revocation drills remain open | **Yes for trusted request admission.** A connector socket alone does not prove a request carries valid owner authorization; static API/authorizer token and existing idempotency do not satisfy proposed real-provider assertion/replay boundary. | Codex #1 defines signed/scoped short-lived decision or equivalent authorization binding, replay ledger, uncertainty behavior, revocation/rotation drill; an independent Codex #1 security-review subagent reviews. Keep R1-G5 partial until evidence exists. |
| No connector identity, sockets, broker, proxy, resource policy, or boundary tests                          | **Yes.** These are design-only proposals.                                                                                                                                                                                                         | Implement in isolated platform PR after backend contract/security review; prove with synthetic disposable verifier; obtain independent review and target-host test plan.                                                                                     |
| Local WSL runs under developer account                                                                     | **Yes as assurance gap**, not proof a future separate host cannot work.                                                                                                                                                                           | Do not provision this host. Use ephemeral Ubuntu CI for initial test and separately owner-approved target for final host proof.                                                                                                                              |

Mock-only CI passing does not close any provider execution gate.

## 10. Codex #1 implementation handoff

### Backend/security contracts requiring Codex #1 ownership

- Exact authenticated API operation that creates a connector request; no generic command or arbitrary app-server config.
- Owner/authorizer decision bound to request ID, task ID, connector identity, allowed text-only operation, expiry, and replay policy; define verifier key custody and rotation/revocation.
- Request lifecycle states including `queued`, `submitting`, `streaming`, `completed`, `failed`, `unknown`, and `interrupted`; never infer remote non-delivery from lost local response.
- Idempotency rules limited to safe local admission; state explicitly that external provider execution is not exactly-once unless provider evidence confirms it.
- Bounded input/output/event schemas; reject tool/function/MCP/agent calls and malformed protocol messages; define what happens if candidate app-server emits a tool request.
- No DB credentials or database access for connector. Do not serialize provider tokens in task, database, event, API response or browser payload.
- Coordinate static API-to-connector socket peer-auth with short-lived request authorization; do not treat socket membership as authorization.

### Platform-owned implementation candidates (future task only)

- New systemd unit/socket files under `infra/systemd/` for connector and, if approved, broker/egress proxy.
- New identity/provisioning and disposable boundary verification scripts under `scripts/host-security/`.
- Dedicated synthetic protocol, socket, credential-canary and egress tests under test/platform infrastructure.
- Carefully scoped disposable CI job changes to `.github/workflows/ci.yml`, only after evidence that runner features support the tested isolation. Preserve existing required contexts.
- No API/worker/authorizer logic, production DB migration, frontend, existing provider configuration, host state, or CI egress allowlisting in this design task.

Codex #1 must review the proposed identity, authorization and credential boundary before implementing provider authorization or adapter code. A separate Codex #1 independent read-only security-review subagent reviews the security architecture and synthetic evidence. Codex #2 reviews only if browser/test tooling changes are later proposed; Claude #2 is needed only if a user-facing consent flow/UI change is proposed.

### Unresolved threats and explicit assumptions

- Root, kernel, systemd manager, and the trusted connector binary remain in the trusted computing base; process concealment cannot defeat host root.
- systemd credential directory protection does not make a token invisible to the process receiving it and does not replace a refreshing/revoking broker.
- Network namespaces/proxy and systemd IP filtering can differ by kernel, systemd, cgroup BPF, host firewall and WSL configuration; exact target tests are mandatory.
- Codex app-server's no-tool configuration and tool-call handling are unproven; current docs describe active local tool and child-agent abilities.
- OAuth terms, supported app-owned flow, token scopes/lifetimes, provider endpoint stability, request identifiers/idempotency, and cancellation semantics have not been validated in a consented integration.
- No actual provider request, real OAuth operation, provider endpoint connection, or native credential inspection was performed.

## 11. References

- PR #37 [Phase 1 real-run readiness](https://github.com/Jeysibn/omnis-os/blob/853ff8ae73b55efb1495734d56280bbd0df9382d/docs/06-delivery/PHASE_1_REAL_RUN_READINESS.md) and [Codex #3 connector boundary handoff](https://github.com/Jeysibn/omnis-os/blob/853ff8ae73b55efb1495734d56280bbd0df9382d/docs/06-delivery/CODEX_3_PHASE_1_CONNECTOR_BOUNDARY_HANDOFF.md).
- Repository evidence: [`R1_G5_HOST_ISOLATION.md`](../07-governance/evidence/R1_G5_HOST_ISOLATION.md), `infra/systemd/omnis-*.service`, `scripts/host-security/provision-identities.sh`, `scripts/host-security/install-service-secrets.sh`, and `scripts/host-security/verify-disposable-systemd-deployment.sh` at the baseline SHA above.
- OpenAI, [Codex app-server SIWC setup](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) and [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). The latter explicitly documents local shell/MCP tools and child agents for app-server.
- systemd, [Credentials](https://systemd.io/CREDENTIALS/) and [`systemd.exec`](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html). Credential delivery is activation-time protected delivery; it does not by itself provide a dynamic OAuth broker.
- Microsoft, [Use systemd to manage Linux services with WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd), including WSL systemd support and service lifetime limitations.

**Gate status:** Runtime remains mock-only. G4-3 remains **Partially Fixed**. R1-G5 remains **Partially Complete**. No real connector, credential flow, provider egress, or inference is approved by this assessment.

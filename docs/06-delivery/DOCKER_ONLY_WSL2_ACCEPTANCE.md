# Omnis OS Docker-only WSL2 deployment acceptance

Verdict: **BLOCKED**. Assessment date: 2026-11-10. Source baseline (freshly fetched main): `4a27bc3718d4960ad9b132b0f53cdc938da57b54`. This is a mock-only deployment gate, separate from real-runtime Phase 1 readiness. No deployment or owner-host configuration change was performed.

## Current architecture and gaps

Read against AGENTS.md, MASTER_PLAN.md, ADR-0012, the Docker-only threat model, completion matrix, real-run readiness, roadmap, Compose files, Dockerfiles, CI, API/worker network validators and sandbox launcher.

| Area | Implemented on baseline | Gap for Docker-only acceptance |
| --- | --- | --- |
| React/Fastify/worker/PostgreSQL | Existing Compose images, health dependencies, bounded read-only non-root app containers, persistent DB volume | Preserve these services; current bridge topology is not ADR-0012 network-none topology |
| Authorizer/launcher | Host processes with restricted filesystem sockets; launcher validates DB grant/lease/generation before fixed mock launch | No container packaging/provisioning for their proposed distinct identities and socket groups |
| Identity | App containers all use 10001:10001, separate socket supplementary groups | Not the distinct 11002–11006 identities proposed in ADR; setgid ownership and every-bind verification unproved |
| Network | Internal edge/data bridges; API belongs to both; API/worker have no host ports | Internal bridges do not enforce directional filtering or deny daemon DNS forwarding; PostgreSQL publishes loopback TCP |
| Ingress | HTTP web loopback publication; external HTTPS proxy expected | No Docker-only HTTPS gateway, approved provenance predicate, immutable bootstrap or confinement proof |
| Mock execution | Fixed digest-pinned sandbox image, network-none, capability removal, limits, constrained workspace and durable admission | Preserve; not evidence that the entire control plane is isolated |
| Persistence/recovery | Existing migrations, restricted roles, lease reconciliation, encrypted backup tooling and disposable CI harnesses | No Docker-only/WSL2 daemon, shutdown, fresh-volume restore or partial-bootstrap recovery evidence |
| Owner experience | Existing browser/Compose synthetic journeys and API tests | Full requested feature journey on deployed HTTPS target remains unverified; existing browser test uses a secure-context override, not TLS |
| Authorization | API uses worker/authorizer contracts, no direct DB credential; sessions/CSRF and synthetic-only schemas | API sessions are memory-backed: restart requires login; peer credentials and imported/inherited descriptor policy remain unproved |

Current system is **hybrid**, not an approved Docker-only deployment. No rebuild of working services is justified before the mandatory design gate closes. Existing synthetic broker is test-only and receives no new production authority. Real provider schemas, credentials and execution remain disabled.

## Evidence and acceptance matrix

Statuses: PASS = actual verification of the stated narrow claim; FAIL = observed mismatch/defect; BLOCKED = missing prerequisite or decision; NOT TESTED = no verification occurred. All rows use baseline SHA above unless an attached exact-head artifact states a different SHA. Local environment: Fedora Linux kernel `7.2.10-200.fc44.x86_64`, Docker client/server `29.9.1`, Compose `5.6.0`, Node `24.20.0`; Windows and WSL versions unavailable. Independent review: pending for every row. No row grants acceptance.

| Requirement | Status | Command / evidence | Expected / actual | Remaining risk |
| --- | --- | --- | --- | --- |
| Current-main baseline | PASS | `git fetch origin main`; `git rev-parse origin/main` | Exact fetched SHA matches baseline | Later main changes require reassessment |
| Docker-only service membership | FAIL | Source inspection: `infra/compose/docker-compose.app.yml`, README | All required services in Compose / authorizer and launcher host-managed | Existing topology cannot meet this acceptance requirement |
| Distinct service identities, core network-none, unpublished DB | FAIL | Same source plus API/worker deployment-config modules | ADR topology / shared app UID, TCP bridge contracts and published DB | Requires reviewed transport, provisioning and packaging increment |
| Windows-local ingress discriminator | BLOCKED | ADR-0012 and threat model | Enforceable source distinction / none established | NAT/proxy may erase source distinction |
| Gateway bootstrap, egress and FD policy | BLOCKED | ADR-0012 design gate | Approved, tested confinement / proposed only | No listener should be released |
| Preflight metadata and fail-closed exit | PASS | `node --test scripts/compose/wsl2-acceptance-preflight.test.mjs` (3 passed) | No automatic acceptance, no raw child diagnostics / verified fixtures and CLI | Inventory is not runtime evidence |
| Target inventory | NOT TESTED | Target commands below | Windows 11 + WSL2 / local host is Fedora | Linux evidence cannot substitute |
| Actual UID/GID/groups, caps, seccomp, NNP, mounts/devices | NOT TESTED | Future disposable candidate runtime probes | Match approved policy and deny forbidden actions / no candidate available | Compose declarations alone insufficient |
| UDS identity, substitution, descriptor inheritance/transfer | NOT TESTED | ADR descriptor negative tests, candidate harness not implemented | Wrong peer, symlink, SCM_RIGHTS, inherited IP FD denied / not run | Network-none alone insufficient |
| Docker daemon restriction, lateral/egress IPv4/IPv6 | NOT TESTED | Candidate runtime negative probes, harness not implemented | Only launcher daemon authority; all forbidden flows denied / not run | Default seccomp is not the proposed FD policy |
| Clean/repeated deployment and partial startup | NOT TESTED | Disposable candidate lifecycle harness not implemented | Idempotent jobs; partial bootstrap fails closed / not run | Never run current hybrid stack as candidate substitute |
| Service/authorizer restart and DB reconnection | NOT TESTED | Existing `corepack pnpm integration:recovery` is baseline-only | Durable admission/event IDs preserved / not run here | New topology still requires its own tests |
| Worker interruption and unclean shutdown | NOT TESTED | Same baseline harness; candidate extension required | Fenced leases; uncertain outcome remains unknown / not run | Never retry uncertain provider submissions |
| Docker daemon interruption | NOT TESTED | Dedicated disposable host only; procedure below | Reconcile without duplicated launches / not run | Daemon interruption affects every host container |
| WSL shutdown/restart | NOT TESTED | Dedicated disposable WSL distro only | Durable DB survives / not run | Owner host not accessed |
| Backup/fresh database restore | NOT TESTED | `corepack pnpm integration:backup-restore` | Authenticated decrypt, ACL/history equality; tamper/wrong-key denial / not run here | No backup schedule or target restore proof |
| Complete HTTPS owner journey/SSE | NOT TESTED | Baseline `integration:compose-smoke` is hosted-CI-only; target harness pending | Login/logout, CSRF, agents/profiles, projects/tasks, assignment, approval, admission, replay/revoke, cancel, output/audit, refresh/restarts / no complete target run | Report feature gaps explicitly; no TLS override on target |
| Exact-head CI | NOT TESTED | `gh pr checks <PR>` plus workflow head SHA | Required suites pass on exact revision / pending PR evidence | Baseline or merge-result tests alone not exact-head evidence |
| Independent security review | BLOCKED | Owner-appointed independent review required | Review exact revision and evidence / pending | Self-review cannot close gate |
| Explicit owner acceptance | BLOCKED | Separate recorded approval | All mandatory gates closed / not requested prematurely | Do not mark ACCEPTED |

## Safe evidence collection

Run from the checked-out revision in the intended WSL distro (read-only; no root needed unless Docker access requires the existing authorized mechanism):

```sh
git rev-parse HEAD
git status --porcelain
node scripts/compose/wsl2-acceptance-preflight.mjs
uname -sr
docker version --format '{{.Client.Version}} {{.Server.Version}}'
docker compose version --short
docker info --format '{{json .SecurityOptions}}'
```

Preflight exits **2 intentionally** while mandatory gates remain open. It collects fixed version fields only, suppresses raw subprocess failures, never reads environment files or service logs, and never starts containers. `trackedTreeClean` excludes untracked files; retain a separately reviewed working-tree inventory. A WSL2-looking kernel is inventory, not attestation of Windows version, networking mode or locality enforcement. Do not publish `docker inspect`, full `compose config`, env output, cookies, password hashes, backup keys, or unredacted logs.

On Windows PowerShell, collect read-only metadata separately:

```powershell
wsl --version
wsl --status
wsl --list --verbose
Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsBuildNumber
Get-NetIPConfiguration
Get-Content "$env:USERPROFILE\.wslconfig" -ErrorAction SilentlyContinue
```

Review hostnames, addresses and paths before sharing artifacts. A missing `.wslconfig` does not prove the active network mode. Do not change Windows firewall, WSL mode, Docker settings, owner secrets or existing databases to obtain a pass.

## Provenance investigation gate

No authoritative experiment was possible on Windows/WSL2 here. Do not infer impossibility on all hosts from the historical Linux internal-bridge publication failure. The discriminator is currently **unproven**, so deployment is blocked.

After independent design approval, build a credential-free fixed-response disposable gateway fixture before connecting application sockets. Record enforcement-point source/destination/interface, namespace rule counters and connection results for Windows localhost IPv4/IPv6, Windows LAN from a second machine, WSL-local, unrelated container bridge, and direct container IP. Repeat each with forged Host/Origin, both IP families, relevant Docker proxy/publishing modes, and NAT/mirrored WSL modes on disposable hosts. Positive Windows-local connectivity and negative LAN/WSL/container results are both required. An unavailable family/path is NOT TESTED, not a denied-flow pass. Packet metadata and counters must correlate with an enforced rule; a curl failure alone may mean no listener.

Only after an approved fixture exists, these client commands can generate traffic (substitute its actual public test certificate/port/address; do not use `-k`):

```powershell
curl.exe --cacert fixture-ca.pem https://localhost:18443/health
curl.exe --cacert fixture-ca.pem https://127.0.0.1:18443/health
curl.exe --cacert fixture-ca.pem https://[::1]:18443/health
# From a separate LAN machine, repeat with the Windows LAN address.
```

```sh
curl --cacert fixture-ca.pem https://127.0.0.1:18443/health
curl --cacert fixture-ca.pem 'https://[::1]:18443/health'
# Repeat from a disposable unrelated container and against inspected fixture IPs.
# Do not give the probe Docker socket, host networking, credentials or core mounts.
```

Exact fixture/container commands depend on the approved discriminator and bootstrap; no safe final deployment command exists yet. If prohibited and permitted paths yield indistinguishable enforceable metadata, reject this candidate. The smallest safe interim alternative is **no owner-facing listener**, with existing disposable internal synthetic CI retained. Host-managed ingress or changing the locality requirement would be explicit architectural exceptions requiring separate owner review; neither is approved here.

## Recovery, rollback and review sequence

1. Review provenance and immutable bootstrap/FD design independently. No runtime transport conversion until this gate closes.
2. Implement socket clients/listeners and role-authenticated PostgreSQL UDS with interface tests, then distinct identities, server-owned volumes, pinned authorizer/launcher images, no core ports/networks, and negative runtime tests. Split transport/security and lifecycle verification PRs. Preserve current contracts and synthetic gates.
3. Run clean/repeated deployment, partial initialization, service/authorizer/worker interruption, PostgreSQL reconnect, SSE disconnect/replay/revoke, cancellation and output/audit checks in a uniquely named disposable Compose project with synthetic data. Preserve run/event/launch IDs before and after each fault. Never turn an uncertain result into success without durable evidence.
4. Run encrypted backup/restore into a fresh disposable database; compare roles, ACLs, Run/event/audit fingerprints and wrong-key/tamper failures. Record commands, exact SHA/image IDs, versions, times and redacted results. Existing operational backup scripts must not be pointed at owner data as part of this drill.
5. On a dedicated disposable Linux/WSL host only, interrupt Docker and confirm restart/reconciliation. On a dedicated disposable Windows/WSL environment only, use `wsl --terminate <disposable-distro>` then `wsl -d <disposable-distro> -- true`. Do not use `wsl --shutdown` on a shared owner host. Record daemon startup behavior and compare DB/job/launch evidence. These are disruptive and were not executed here.
6. Rollback requires a verified backup and schema compatibility decision before changing images. Stop scoped admission/worker services, preserve named DB volumes, select the last reviewed image digests, and reverify. Never use prune, operational `down --volumes`, blind downgrade migrations, automatic uncertain job retry or insecure networking fallback. No reviewed Docker-only image set currently exists to roll back to.
7. Execute full exact-head CI, independent review and separately authorized target acceptance. Attach each requirement's exact SHA, host versions, command, expected/actual, evidence, risk and reviewer signoff to this matrix. Only then request owner approval.

This increment adds evidence tooling and the acceptance gap assessment only. No real inference, production broker activation, host changes, deployment or merge is authorized by a passing source test.

## This increment's local verification

Executed in an isolated worktree based on the baseline above; existing owner worktree edits were preserved. `corepack pnpm install --frozen-lockfile` passed. With temporary Corepack shims on PATH (the host initially had no `pnpm` executable), `pnpm check` passed: formatting, lint, strict typecheck and complete repository source test suite. `pnpm compose:config:test` passed. `node --test scripts/compose/*.test.mjs` passed 10 tests, including three new preflight interface tests. `git diff --check` passed. Preflight observed the local Docker/Compose versions above, detected no WSL2 kernel and returned BLOCKED with exit 2 as intended. No containers were started or interrupted by this increment. Recovery, backup/restore and browser integration were not executed locally. These source results do not promote any target-host row.

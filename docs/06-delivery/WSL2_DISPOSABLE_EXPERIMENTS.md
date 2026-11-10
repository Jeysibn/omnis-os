# Omnis OS disposable WSL2 ingress experiments

Execution status: **NOT TESTED on Windows/WSL2**. Scope: synthetic research, no application or production credentials. This package prepares observations, not a deployable HTTPS gateway. Independent approval of an ingress predicate is still missing. See the [review packet](../05-security/ADR_0012_REVIEW_PACKET.md).

## Isolation and setup

Use a dedicated disposable Windows 11 computer/VM with WSL2 hardware/nested virtualization support, Linux Docker Engine (not an assumed Docker Desktop equivalent), Compose, Node24 and a second isolated LAN test machine. No owner database, OAuth stores, app env files, CA keys, shared WSL distros or unrelated workloads. A dedicated distro on an otherwise shared Windows machine is insufficient for global networking-mode changes. Do not run these commands on the owner's host.

Operator records host authorization, exact source SHA, Windows build, WSL/kernel, Engine/client/Compose versions, effective NAT/mirrored mode, Docker rootful/userns status, firewall backend, userland proxy and direct-routing/gateway settings. Windows PowerShell read-only inventory:

```powershell
wsl --version
wsl --status
wsl --list --verbose
Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsBuildNumber
Get-NetIPConfiguration
Get-Content "$env:USERPROFILE\.wslconfig" -ErrorAction SilentlyContinue
netsh interface portproxy show all
```

In disposable WSL, clone the reviewed PR revision, keep evidence outside the repository, then:

```sh
git rev-parse HEAD
git status --porcelain
uname -sr
docker version --format '{{.Client.Version}} {{.Server.Version}}'
docker compose version --short
docker info --format '{{json .SecurityOptions}}'
ip -br address
ip route
ip -6 route
node scripts/compose/wsl2-acceptance-preflight.mjs
# Exit 2 from the preflight is expected: it never grants deployment acceptance.
```

Record effective mode using `wslinfo --networking-mode` where available; otherwise preserve configuration plus observed interface/path evidence and mark mode attestation unresolved. Docker configuration may contain sensitive endpoints: extract only reviewed network settings, never archive whole daemon config/env/inspect. Source code and these fixtures require no credentials.

## Phase A: executable path observation, no security policy

The standalone Compose file mounts only one fixed probe script. It uses no app services/volumes, secrets, daemon socket, capabilities or privileged mode. It uses a regular bridge intentionally so host publication can be observed; **that bridge allows egress and same-network peers**. The fixed program makes no outbound calls, proxies no traffic and logs only synthetic case IDs and kernel socket metadata. Keep the diagnostic window bounded. No HTTP Host/Origin/X-Forwarded-For is trusted or logged. It is HTTP, not TLS: never log in through it.

Before starting, ensure ports 18443 and 18080 are unused; do not stop another listener. Review and pull the digest-pinned official Node image separately on this disposable environment. Do not substitute a mutable tag. Choose a fresh unique project name and reuse exactly that value through cleanup:

```sh
export OMNIS_PROBE_PROJECT=omnis-path-20261110-a1
mkdir -m 700 "$OMNIS_PROBE_PROJECT-evidence"
docker pull node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml config --quiet
docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml up -d --pull never
export OMNIS_PROBE_ID=$(docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml ps -q probe)
docker inspect --format '{{.State.Pid}} {{json .NetworkSettings.Ports}}' "$OMNIS_PROBE_ID"
docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}}{{end}}' "$OMNIS_PROBE_ID"
```

These targeted inspect templates intentionally exclude environment and secret-bearing fields. Missing IPv6 support or failed publication is a prerequisite failure, not a security-denial pass; do not silently remove IPv6 and call the matrix complete. The fixed listener binds dual-stack `::`; verify actual v4/v6 behavior rather than assume IPV6_V6ONLY defaults.

Windows PowerShell (one attempt per distinct case ID):

```powershell
curl.exe --noproxy "*" --max-time 3 http://127.0.0.1:18443/probe/windows-v4
curl.exe --noproxy "*" --max-time 3 "http://[::1]:18443/probe/windows-v6"
curl.exe --noproxy "*" --max-time 3 -H "Host: localhost" -H "Origin: https://localhost:8443" http://127.0.0.1:18443/probe/windows-forged
# Substitute actual Windows LAN address and WSL/container addresses from inventory.
# Repeat from the second LAN machine, using /probe/lan-v4 and /probe/lan-v6.
```

WSL-local and disposable peer (substitute **literal inspected** container addresses for CONTAINER_V4/CONTAINER_V6):

```sh
curl --noproxy '*' --max-time 3 http://127.0.0.1:18443/probe/wsl-v4
curl --noproxy '*' --max-time 3 'http://[::1]:18443/probe/wsl-v6'
curl --noproxy '*' --max-time 3 http://CONTAINER_V4:18080/probe/wsl-direct
# IPv6 direct form: http://[CONTAINER_V6]:18080/probe/wsl-direct-v6
docker run --rm --pull never --network "${OMNIS_PROBE_PROJECT}_observation" --user 11002:11002 --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 32 --memory 128m --cpus 0.5 --entrypoint /usr/bin/env node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c -i /usr/local/bin/node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(3000),headers:{Host:"localhost",Origin:"https://localhost:8443"}}).then(r=>console.log(r.status)).catch(()=>process.exitCode=2)' http://CONTAINER_V4:18080/probe/peer-direct
```

Repeat peer tests on a separate newly created disposable bridge (record its name, remove it at cleanup). The same-bridge case is a necessary stronger test; a default unrelated bridge denial alone is insufficient. Probe host bridge address, WSL address and Windows LAN address as well as direct container IP; preserve family/direction and interface in each case. Current diagnostic fixture intentionally accepts reachable peers: that is observation, **not a production security regression or denied-flow test**.

Capture bounded metadata while the operator generates one identified attempt at a time. On the disposable WSL host only, trusted operator reads the probe PID above and substitutes it for PID:

```sh
sudo timeout 30 nsenter -t PID -n tcpdump -nn -q -i any -c 40 'tcp port 18080'
sudo nsenter -t PID -n ip -br address
sudo nsenter -t PID -n ip route
sudo nsenter -t PID -n ip -6 route
docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml logs --no-log-prefix --no-color probe > "$OMNIS_PROBE_PROJECT-evidence/tuples.jsonl"
```

No `-A`, `-X` or packet payload archive. Use equivalent bounded header-only capture on the WSL bridge/host interfaces concurrently to locate translation; diagnostic port carries synthetic traffic only. Windows-side packet metadata requires a separately reviewed collection command for that Windows build; do not install broad capture drivers or change firewall policy as a convenience fallback. If boundary metadata cannot be collected, mark the corresponding claim NOT TESTED. Do not infer source identity from case ID: it is operator correlation only and deliberately forgeable.

## Phase B: decision and enforced fixture gate

Compare Windows-local and prohibited attempts' tuples, interfaces and translation paths. Same observations at the proposed enforcement boundary reject that source-only predicate. Different tuples in a finite run are not proof of unforgeability: reviewer must examine whether an unprivileged prohibited process can reproduce the allowed tuple/path. Do not add a source allow rule based on one successful sample.

Only after independent approval, implement the minimum confined TLS diagnostic fixture specified in the packet. This package deliberately supplies **no privileged bootstrap, nftables allowlist or unapproved gateway**. The exact rules depend on the still-unresolved discriminator; fabricating runnable policy now would hide the blocker. Before connecting any core socket, reviewer must specify immutable policy, counter names, approved binary/image hashes, initial/final identities/caps, TLS trust and fault hooks. No app DB or broker is needed.

For the approved fixture, record counters and namespace policy generation before/after each attempt using the operator-selected PID (read-only inspection):

```sh
sudo nsenter -t PID -n nft -j list ruleset
sudo nsenter -t PID -n ss -lnt
sudo cat /proc/PID/status
sudo ls -l /proc/PID/fd
```

Retain only approved synthetic counters, policy hashes, capability/identity/FD metadata after manual review; no socket content, keys, process environment or credentials. Do not execute `nsenter` from application containers or mount host proc/daemon into them. Operator inspection privilege is not a production sidecar.

## Required experiment and evidence ledger

All target executions below are **NOT TESTED**. Each row requires exact SHA, image/policy hash, host versions/mode, command, expected/actual, artifact hash/path, risk, operator and independent reviewer disposition. Keep a separate ledger for every supported configuration; do not reuse an IPv4/NAT result as IPv6/mirrored evidence.

| ID | Stimulus / exact test action | Required observation and rejection condition |
| --- | --- | --- |
| E01 | Windows localhost v4/v6; Phase A commands, then same paths via `curl.exe --cacert fixture-ca.pem https://localhost:8443/health` once reviewed TLS exists | Valid TLS/response and correlated allow counter; unsupported family NOT TESTED |
| E02 | Second LAN machine to Windows/WSL addresses and routed container IP | Packet reaches intended enforcement boundary and deny counter increments; refusal/no route alone inconclusive |
| E03 | WSL-local via loopback, host/WSL address, direct container IP, both families | Every prohibited path hits denial; tuple collision with E01 rejects predicate |
| E04 | Same-bridge and separate-bridge disposable peer, host bridge and direct IP, forged headers | Boundary denial; no daemon authority/mounts in probing container; repeat IPv6 |
| E05 | Repeat E01–04 with forged Host/Origin/X-Forwarded-For | No policy change; TLS/login never counted as locality discriminator |
| E06 | Dedicated hosts configured NAT versus mirrored, proxy on/off, allowed direct-routing/gateway configurations | Inventory each effective setting, capture translation; source code argument for any unsupported mode and fail-closed detection. `.wslconfig` changes only on entirely disposable Windows host with owner/operator authorization |
| E07 | Approved fixture: `docker compose … restart gateway`; kill bootstrap/controller only in fault fixture | No policy-loss window; connection attempts continuously sampled with counters; namespace recreation repeats guards. Exact service/file is supplied by reviewed fixture, not this observation Compose |
| E08 | Fault hooks: missing predicate/filter support, failed rule load, wrong socket owner, injected capability, extra FD, guard mismatch | No listener before confinement; fail reason identifier, no alternate entrypoint or broad repair; every fault separately evidenced |
| E09 | Approved IPC fixture: wrong UID/GID/token, symlink and stale path, disconnect/rebind | Verify SO_PEERCRED mapping and per-bind owner/mode; all wrong clients denied, intended peers work; no API DB permission |
| E10 | Approved FD fixture: inherited connected IP socket; SCM_RIGHTS sendmsg to confined receiver; recvmsg/recvmmsg/io_uring, proc/pidfd, VSOCK and raw socket attempts | Actual syscall result/FD inventory and remote canary counter prove no usable forbidden descriptor; compare positive control outside final filter. Merely failing sender is not receiver-filter proof |
| E11 | Dedicated disposable WSL distro only: operator `sudo systemctl restart docker`; reconstruct reviewed fixture | Persisted state/counters and repeated E01–10, no stale readiness or unguarded listener; affects all daemon workloads so never shared host |
| E12 | Dedicated Windows environment: `wsl --terminate Omnis-Disposable`; `wsl -d Omnis-Disposable -- true` | Record daemon autostart/failure, repeat admission/denial and recovery; fresh namespace must rebootstrap. No `wsl --shutdown` on shared host |

E07–E10 remain gated test specifications because there is no approved enforcement implementation to target. They are not silently substituted with diagnostic observation. Later full app recovery must additionally preserve DB/Run/launch/event IDs across faults, encrypted fresh-volume restore, SSE replay/revocation and reauthentication, with no duplicate jobs or unknown-outcome retries.

## Cleanup and evidence handling

Stop capture processes via their bounded timeout; stop only this unique project. Diagnostic Compose creates no named persistent volumes:

```sh
docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml down --timeout 5
# Remove only the separately created disposable probe bridge by its recorded exact name.
docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml ps -a
```

Do not prune, remove unrelated networks/volumes, overwrite a database, disable Windows firewall or broadly allow inbound Hyper-V traffic. Do not commit machine-specific IP/hostname metadata. Review tuple/capture files, hash approved artifacts with `sha256sum`, retain outside repo in protected test storage, record cleanup result and reviewer disposition. Windows teardown/revert is the disposable host operator's responsibility; no script here changes host settings.

## Dedicated-machine mode profiles

Prepare two disposable Windows snapshots from the same clean baseline. On the **entirely disposable, authorized Windows machine only**, save the existing `.wslconfig` outside the test snapshot if needed, then use one of these minimal profiles. Do not copy these profiles onto an owner's/shared Windows installation:

```ini
[wsl2]
networkingMode=nat
localhostForwarding=true
```

```ini
[wsl2]
networkingMode=mirrored
```

Apply a profile by stopping WSL on that disposable machine (`wsl --shutdown`), then start only `Omnis-Disposable` and verify effective mode again. This global shutdown is prohibited on a shared host. Do not disable Windows/Hyper-V firewalls or add broad ingress exceptions. If the isolated LAN test path is blocked upstream, capture that fact and mark gateway-denial verification NOT TESTED until the reviewer approves a narrowly scoped test path; do not claim gateway enforcement from upstream denial. Restore/revert the disposable Windows snapshot between profiles, preserving only reviewed synthetic evidence. Proxy/direct-routing variations require separately approved Docker test profiles and a dedicated daemon; record exact settings and restart before each case. They are not production defaults or authorized changes to existing Engine configuration.

## Local preparation verification (not target execution)

On Fedora kernel 7.2.10 with Engine29.9.1/Compose5.6.0, the new probe interface test passed inside an existing local Node image `be23f54a88d3` with network-none, UID/GID11001, read-only source/root, empty environment, caps dropped, NNP, 256MiB memory, 1 CPU, 64 PID and 60-second wall limit. Only 16MiB scratch tmpfs was writable. The test verified socket-derived tuple output, fixed synthetic response, forged-header/cookie exclusion and rejection of invalid paths/methods without logging their values. This cached test image is not the package's digest-pinned target image; image/runtime target compatibility remains NOT TESTED. The Compose file rendered with `docker compose -p omnis-research-config-only -f infra/compose/wsl2-provenance-research.yml config --quiet`. Changed JavaScript lint/format checks and `git diff --check` passed. No published fixture, security policy, owner host configuration, daemon interruption or target experiment was run locally.

# Omnis OS disposable WSL2 ingress experiments

> [!CAUTION]
> **Research and review only. Experiment execution is prohibited.** None of the commands in this document is currently authorized to run. Do not start the Compose listener or any probe until the owner separately authorizes the exact experiment and every prerequisite below has been implemented and validated for the target environment.
>
> Future execution requires all of the following: explicit owner authorization for the exact experiment; an independently enforced maximum runtime; verified process and container identities; an independent process-termination authority; confirmed termination and cleanup behavior; Docker-outage and interrupted-session handling; quarantine and recovery procedures for residual resources; and evidence that the target environment supports those controls. These mechanisms do not currently exist or have target validation. This runbook does not implement or authorize Mission 9D Phase A.
>
> `restart: 'no'`, shell traps, manual cleanup, and ordinary `docker compose down` do not provide independent containment or termination. Do not treat any one of them as a substitute for the required lifecycle safeguards.

Execution status: **NOT TESTED on Windows/WSL2**. This runbook is for research and review only. Its scope is synthetic observation with no application or production credentials. The package prepares observations, not a deployable HTTPS gateway. Independent approval of an ingress predicate is still missing. See the [review packet](../05-security/ADR_0012_REVIEW_PACKET.md).

## Future environment inventory (reference only; execution is not authorized)

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

## Phase A reference: path observation only (not authorized for execution)

The standalone Compose file mounts only one fixed probe script. It uses no app services/volumes, secrets, daemon socket, capabilities or privileged mode. It uses a regular bridge intentionally so host publication can be observed; **that bridge allows egress and same-network peers**. The fixed program makes no outbound calls, proxies no traffic and logs only synthetic case IDs and kernel socket metadata. Keep the diagnostic window bounded. No HTTP Host/Origin/X-Forwarded-For is trusted or logged. It is HTTP, not TLS: never log in through it.

Before any future launch, an independently reviewed lifecycle implementation must enforce the maximum runtime and termination requirements in the warning above. The commands below are reference material only. They are not a currently approved quick start.

Run the WSL reference snippets in one Bash session with strict error handling. Generate the project identity from 128 bits of randomness, validate its Compose-safe form, and create the evidence directory exclusively. A failed validation or directory creation must stop the session. Then perform read-only label checks and stop if the selected project identity already exists. Do this before any image pull, container creation, network creation, or listener start. Do not use a timestamp alone as an identity.

```sh
set -Eeuo pipefail
umask 077
set -o noclobber
OMNIS_PROBE_SUFFIX="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')"
export OMNIS_PROBE_PROJECT="omnis-probe-${OMNIS_PROBE_SUFFIX}"
[[ "$OMNIS_PROBE_PROJECT" =~ ^omnis-probe-[a-f0-9]{32}$ ]]
export OMNIS_PROBE_EVIDENCE="${OMNIS_PROBE_PROJECT}-evidence"
mkdir -m 700 -- "$OMNIS_PROBE_EVIDENCE"

assert_project_is_unused() {
  local kind ids
  for kind in containers networks volumes; do
    case "$kind" in
      containers)
        ids="$(docker container ls --all --quiet --filter "label=com.docker.compose.project=${OMNIS_PROBE_PROJECT}")"
        ids+=$'\n'"$(docker container ls --all --quiet --filter "label=org.omnis-os.research.project=${OMNIS_PROBE_PROJECT}")"
        ;;
      networks)
        ids="$(docker network ls --quiet --filter "label=com.docker.compose.project=${OMNIS_PROBE_PROJECT}")"
        ids+=$'\n'"$(docker network ls --quiet --filter "label=org.omnis-os.research.project=${OMNIS_PROBE_PROJECT}")"
        ;;
      volumes)
        ids="$(docker volume ls --quiet --filter "label=com.docker.compose.project=${OMNIS_PROBE_PROJECT}")"
        ids+=$'\n'"$(docker volume ls --quiet --filter "label=org.omnis-os.research.project=${OMNIS_PROBE_PROJECT}")"
        ;;
    esac
    if [[ -n "$ids" ]]; then
      printf 'Project identity collision in %s; stop without creating resources.\n' "$kind" >&2
      return 1
    fi
  done
}

assert_project_is_unused
OMNIS_PROBE_NETWORK_NAMES="$(docker network ls --format '{{.Name}}')"
if printf '%s\n' "$OMNIS_PROBE_NETWORK_NAMES" | grep -Fxq -- "${OMNIS_PROBE_PROJECT}_observation"; then
  printf 'Network-name collision; stop without creating resources.\n' >&2
  exit 1
fi

# Pull only after the unique project and evidence identities pass preflight.
docker pull node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml config --quiet
docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml up -d --pull never
OMNIS_PROBE_CONTAINER_IDS="$(docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml ps --all --quiet)"
[[ -n "$OMNIS_PROBE_CONTAINER_IDS" ]]
mapfile -t OMNIS_PROBE_CONTAINERS <<< "$OMNIS_PROBE_CONTAINER_IDS"
[[ "${#OMNIS_PROBE_CONTAINERS[@]}" -eq 1 ]]
export OMNIS_PROBE_ID="$(docker inspect --format '{{.Id}}' "${OMNIS_PROBE_CONTAINERS[0]}")"
[[ "$OMNIS_PROBE_ID" =~ ^[a-f0-9]{64}$ ]]
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "org.omnis-os.research.role"}}' "$OMNIS_PROBE_ID")" == "${OMNIS_PROBE_PROJECT}|probe|probe" ]]
OMNIS_PROBE_NETWORK_IDS="$(docker network ls --quiet --filter "label=com.docker.compose.project=${OMNIS_PROBE_PROJECT}")"
[[ -n "$OMNIS_PROBE_NETWORK_IDS" ]]
mapfile -t OMNIS_PROBE_NETWORKS <<< "$OMNIS_PROBE_NETWORK_IDS"
[[ "${#OMNIS_PROBE_NETWORKS[@]}" -eq 1 ]]
export OMNIS_PROBE_NETWORK_ID="$(docker network inspect --format '{{.Id}}' "${OMNIS_PROBE_NETWORKS[0]}")"
[[ "$OMNIS_PROBE_NETWORK_ID" =~ ^[a-f0-9]{64}$ ]]
[[ "$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}|{{index .Labels "org.omnis-os.research.role"}}' "$OMNIS_PROBE_NETWORK_ID")" == "${OMNIS_PROBE_PROJECT}|observation|observation" ]]
printf 'project\t%s\ncontainer\t%s\t%s\nnetwork\t%s\t%s\n' \
  "$OMNIS_PROBE_PROJECT" \
  "$OMNIS_PROBE_ID" "$OMNIS_PROBE_PROJECT|probe|probe" \
  "$OMNIS_PROBE_NETWORK_ID" "$OMNIS_PROBE_PROJECT|observation|observation" \
  > "$OMNIS_PROBE_EVIDENCE/resource-manifest.tsv"
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
export OMNIS_PROBE_PEER_NAME="${OMNIS_PROBE_PROJECT}-peer"
OMNIS_PROBE_EXISTING_PEER="$(docker container ls --all --quiet --filter "name=^/${OMNIS_PROBE_PEER_NAME}$")"
[[ -z "$OMNIS_PROBE_EXISTING_PEER" ]]
docker run --pull never \
  --name "$OMNIS_PROBE_PEER_NAME" \
  --cidfile "$OMNIS_PROBE_EVIDENCE/peer.cid" \
  --label "org.omnis-os.research.project=${OMNIS_PROBE_PROJECT}" \
  --label org.omnis-os.research.role=peer \
  --network "${OMNIS_PROBE_PROJECT}_observation" \
  --user 11002:11002 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 32 --memory 128m --cpus 0.5 \
  --entrypoint /usr/bin/env \
  node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c \
  -i /usr/local/bin/node \
  -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(3000),headers:{Host:"localhost",Origin:"https://localhost:8443"}}).then(r=>console.log(r.status)).catch(()=>process.exitCode=2)' \
  http://CONTAINER_V4:18080/probe/peer-direct
export OMNIS_PROBE_PEER_ID="$(cat "$OMNIS_PROBE_EVIDENCE/peer.cid")"
[[ "$OMNIS_PROBE_PEER_ID" =~ ^[a-f0-9]{64}$ ]]
[[ "$(docker inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "org.omnis-os.research.project"}}|{{index .Config.Labels "org.omnis-os.research.role"}}' "$OMNIS_PROBE_PEER_ID")" == "${OMNIS_PROBE_PEER_ID}|/${OMNIS_PROBE_PEER_NAME}|${OMNIS_PROBE_PROJECT}|peer" ]]
printf 'container\t%s\t%s\n' \
  "$OMNIS_PROBE_PEER_ID" "$OMNIS_PROBE_PROJECT|${OMNIS_PROBE_PEER_NAME}|peer" \
  >> "$OMNIS_PROBE_EVIDENCE/resource-manifest.tsv"
```

For a separate bridge, use a second collision-checked name derived from the validated random project ID. Record its exact network ID and the peer container ID in the same protected manifest. Require the expected owner/run labels on both. If the name, ID, label, or expected resource set is missing or ambiguous, stop and leave any residue quarantined for separately authorized recovery. The same-bridge case is a necessary stronger test; a default unrelated bridge denial alone is insufficient. Probe host bridge address, WSL address and Windows LAN address as well as direct container IP; preserve family/direction and interface in each case. Current diagnostic fixture intentionally accepts reachable peers: that is observation, **not a production security regression or denied-flow test**.

Capture bounded metadata while the operator generates one identified attempt at a time. On the disposable WSL host only, trusted operator reads the probe PID above and substitutes it for PID:

```sh
sudo timeout 30 nsenter -t PID -n tcpdump -nn -q -i any -c 40 'tcp port 18080'
sudo nsenter -t PID -n ip -br address
sudo nsenter -t PID -n ip route
sudo nsenter -t PID -n ip -6 route
docker compose -p "$OMNIS_PROBE_PROJECT" -f infra/compose/wsl2-provenance-research.yml logs --no-log-prefix --no-color probe > "$OMNIS_PROBE_EVIDENCE/tuples.jsonl"
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

**Cleanup is currently blocked.** This PR does not implement or validate an independent terminator or a cleanup helper that proves exact resource ownership. Do not use `docker compose down`, shell traps, `docker rm`, `docker network rm`, or manual cleanup as an execution plan. A future separately authorized procedure must compare the live container, network, and volume ID sets to the protected run manifest; verify each exact ID, name, Compose project/service labels, research-role label, and expected membership before removal; and refuse removal if any extra, missing, unlabeled, or ambiguous resource exists. It must bind every stop/removal to the recorded full IDs and owner labels, not a reusable project name or wildcard. If Docker is unavailable or a session is interrupted, preserve evidence and quarantine residual resources. Recovery requires a separately reviewed, owner-authorized procedure. If these checks cannot be implemented and validated for the target, the experiment remains blocked.

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

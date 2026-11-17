# Stage 1C Docker Resource Inventory Authorization Proposal

**Status: PROPOSED — NOT AUTHORIZED AND NOT EXECUTED.** Stage 1A and Stage 1B were accepted by the owner with documented exceptions. Stage 1C requires a new explicit grant. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Purpose and boundaries

Collect a bounded read-only inventory to identify possible conflicts before any separately authorized restricted startup. The inventory covers existing containers, Docker networks and volumes, relevant WSL TCP listeners, and current WSL/Docker resource capacity. It does not establish application readiness, authorize use of any existing resource, or prove Windows-origin ingress enforcement.

Target proposed for owner confirmation: Ubuntu WSL2, operator `jeysi`, direct Docker endpoint `unix:///run/docker.sock`. Docker context `default` is recorded as prior configuration, but every Docker command below uses the explicit socket endpoint with `--host`; it does not select a context. Stage 1B's daemon ID remains self-reported and unmatched. Do not repeat Stage 1A or Stage 1B identity checks. Before the inventory, the owner must confirm there is no known endpoint, daemon, or Docker-root change since Stage 1B and that `docker.service` and `docker.socket` are already active. No command may activate, start, or restart them. If that state is uncertain, stop before any Docker command.

This self-contained Stage 1C command list is narrower than the earlier general Stage 1 inventory manifest; it does not invoke or reauthorize that manifest's commands 1–16 or any `inspect` operation.

This is read-only in intent, but the explicit Unix socket grants broad rootful Docker API authority. A Docker CLI request can reach a socket-activated daemon; the service-active precondition is required to avoid starting an inactive daemon. The state check and the API request are sequential, not atomic: owner-supervised execution must have no intervening service changes. The owner must explicitly accept this residual race in the Stage 1C grant. If a stop/restart or unexpected activation occurs, stop and report it; do not repeat the query. No `sudo` is permitted.

## Exact proposed command manifest

Run one code block at a time in the owner-confirmed Ubuntu distribution. Do not paste headings or prose into the terminal. After each command, immediately run the status helper below; stop on any nonzero status or unexpected output. Do not retry, switch endpoints, add flags, or continue after a stop condition.

### 0. Reject Docker endpoint overrides

This reports no environment values. Any nonzero result means stop; do not unset or change the variables.

```sh
test -z "${DOCKER_HOST:-}" && test -z "${DOCKER_CONTEXT:-}"
```

### 1. Confirm the daemon service is already active

This local systemd state check does not contact Docker or start a unit. It is an activation-safety guard, not a repeat of Stage 1A process/socket provenance or Stage 1B API identity verification. Both units must already be active; otherwise do not issue Docker commands.

```sh
systemctl is-active --quiet docker.service && systemctl is-active --quiet docker.socket
```

### 2. Capture bounded container inventory

This lists the containers known to this daemon, with IDs (short form), names, image references, state, published-port mappings, and only the Compose project/service labels. It does not request environment, command, mounts, logs, or filesystem contents. Docker reads the full list response transiently to format the selected fields; the command prints only the fields shown.

```sh
docker --host unix:///run/docker.sock container ls --all --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}'
```

### 3. Capture network metadata

This lists network IDs, names, driver, scope, internal flag, and the Compose project label. It does not inspect endpoints, IPAM configuration, attached containers, or traffic. Docker documents `--host` as selecting the daemon socket and these list commands as supporting selected Go-template output; see the official CLI references below.

```sh
docker --host unix:///run/docker.sock network ls --format '{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}|{{.Internal}}|{{.Label "com.docker.compose.project"}}'
```

### 4. Capture volume metadata

This lists volume names, drivers, scope, and the Compose project label only. It does not inspect mountpoints or volume contents.

```sh
docker --host unix:///run/docker.sock volume ls --format '{{.Name}}|{{.Driver}}|{{.Scope}}|{{.Label "com.docker.compose.project"}}'
```

### 5. Check WSL listeners on proposed restricted host ports

The current restricted Compose default publishes Web on loopback port `8080` and PostgreSQL on loopback port `5432`. The owner must confirm these exact candidates or commission a reviewed command update for another Web port.

```sh
ss -H -ltn '( sport = :8080 or sport = :5432 )'
```

This sees only the current WSL network namespace. It does not inspect Windows listeners, firewall policy, NAT/mirrored networking, or prove reachability from Windows or a LAN.

### 6. Capture Docker-reported and WSL resource capacity

The Docker response is formatted to print only CPU count, total memory, and Docker root directory. The daemon's full info response is handled transiently by the CLI; only these fields are printed. The owner must stop if the reported root differs from the Stage 1B observation `/var/lib/docker`; do not substitute another path.

```sh
docker --host unix:///run/docker.sock info --format '{{.NCPU}}|{{.MemTotal}}|{{.DockerRootDir}}'
```

```sh
free -b
```

```sh
getconf _NPROCESSORS_ONLN
```

```sh
df -B1 --output=size,used,avail,pcent,target / /var/lib/docker
```

The last command reads filesystem capacity for the WSL root and the already observed Docker data-root path; it does not traverse the data directory. If it fails without elevation, stop and record the capacity as unavailable. Do not use `sudo` or another path.

### Immediate status helper

Run this separately and immediately after each preceding command, before any other command. The status helper itself is not a substitute for reviewing the command output.

```sh
printf 'exit_status=%s\n' "$?"
```

## Evidence interpretation

The inventory is complete only if every authorized command returns status 0, the explicit endpoint is reached without observed activation/elevation, and the output is reviewed in the owner terminal. A successful inventory is not a startup approval. The Docker ID is not rechecked; Stage 1C relies on the accepted Stage 1B observation and the owner's confirmation that no relevant daemon change is known.

Classify resources conservatively:

- **Project-labeled:** exact `com.docker.compose.project` and service labels match an owner-confirmed Omnis project/service mapping.
- **Candidate:** name or image resembles Omnis, but labels or owner mapping do not confirm it.
- **Unclassified:** no reliable mapping is available.
- **Unrelated:** only when the owner confirms it is unrelated.

Names, image references, IDs, port mappings, and labels alone do not prove ownership. Never call an unclassified workload unrelated or remove/alter any resource. An existing project-scoped volume/network, occupied candidate port, active Worker, or uncertain database/container is a finding that blocks a later startup decision until separately resolved; it does not authorize cleanup or stopping.

Stage 1C is **PASS** when the bounded inventory completes and its evidence is privately reviewed, whether or not it finds conflicts. Resources may remain explicitly **unclassified**; that does not make the inventory incomplete, but any possible conflict blocks a later startup decision until resolved. It is **INCONCLUSIVE** if the commands succeed but the evidence cannot resolve a proposed port binding or capacity assumption, or the reported Docker root differs from `/var/lib/docker`. It is **BLOCKED** on endpoint/provenance drift, conflicting selector overrides, inactive service/socket, any attempt to use privilege, observed daemon activation, command failure, secrets or sensitive content exposure, or scope deviation. A PASS only supports planning a separate Stage 2/3 request.

## Privacy, evidence custody, and recovery

The raw list output can reveal unrelated workload names, image references, host ports, network names, volume names, labels, and local paths. Keep raw output private. Do not paste raw inventories into chat. Return only a redacted summary: counts, whether the exact proposed project resources exist, occupied candidate ports, available CPU/memory/storage figures, and owner-classified Omnis candidates. Do not capture environment variables, credentials, logs, database contents, volume contents, mounts, container commands, full network inspection, or unrelated workload configuration.

Proposed evidence location is `/home/jeysi/.local/share/omnis-os/stage1-inventory`, with directory permissions `0700`, evidence file permissions `0600`, and retention for 30 days after report acceptance. These settings are proposals carried forward from the owner's prior administrative configuration; they are not yet authorized for Stage 1C. The owner must confirm destination, access, whether any evidence files may be created, retention, and recovery contact before granting Stage 1C. No directories or evidence files are created by this procedure. Recovery contact `jeysi` and the private out-of-band method must be reconfirmed.

If a command fails, identity/endpoint changes, the service is inactive, unexpected data appears, or output cannot be safely handled, stop immediately. Do not retry, inspect more deeply, stop a workload, invoke an emergency stop, change configuration, or clean resources. Notify the confirmed recovery contact and request a new resource-specific authorization if needed. This read-only inventory grant does not authorize emergency-stop actions.

## Planned restricted resources for conflict checks

If later separately authorized, the restricted profile uses Compose project `omnis-os-restricted-dev`, database `omnis_restricted_dev`, and exactly PostgreSQL, API, Worker, and Web. Its current declared project-scoped networks are `omnis-os-restricted-dev_edge` and `omnis-os-restricted-dev_data`; its volume is `omnis-os-restricted-dev_omnis-postgres-data`. Only Web and PostgreSQL publish to loopback, with proposed ports `8080` and `5432`. API and Worker execution remain `OMNIS_RESTRICTED_DEVELOPMENT=true` and `OMNIS_EXECUTION_MODE=disabled`. This Stage 1C proposal does not authorize creating, starting, or using those resources.

## Owner authorization request — Stage 1C only

**Purpose:** one owner-operated, read-only inventory of existing Docker resources and WSL capacity to inform a later restricted-startup decision.

- **WSL distribution/operator:** Ubuntu (WSL2) / `jeysi` — confirm.
- **Docker target:** direct `unix:///run/docker.sock`; historical context `default` is not used by these commands — confirm endpoint and no known daemon/provenance change since Stage 1B.
- **Authority acknowledgement:** confirm understanding that this socket grants broad rootful Docker API authority even for read-only list operations, and that `docker info` processes the full response transiently while printing only the three selected fields.
- **Service state:** confirm Docker service and socket are already active; inactive units must not be started.
- **Socket-activation race:** explicitly accept that the active-state guard and Docker requests are sequential, not atomic; stop if any intervening service change or activation is observed.
- **Ports:** confirm loopback Web `8080` and PostgreSQL `5432`, or request a newly reviewed port command.
- **Window:** proposed **2026-11-18, 09:00–09:30 Asia/Manila**; owner confirmation required. This is a proposal, not approval.
- **Evidence custody:** confirm whether local evidence-file creation is authorized at the proposed path/permissions/retention above, or choose in-session-only redacted reporting.
- **Recovery:** reconfirm `jeysi` and reachable private out-of-band contact method.
- **Permitted actions:** only commands 0–6 above and the immediate status helper, one command at a time, within the confirmed targets.
- **Excluded:** all resource mutations/lifecycle operations, Docker Compose, image pulls/builds, database access, credentials, `sudo`, host/network changes, Windows inspection, mock/provider execution, deployment, cleanup, and Stages 2–4.
- **Stop:** any failed preflight/command, endpoint or provenance uncertainty, inactive daemon/socket, privilege requirement, sensitive output exposure, or deviation.

**Authorization status: NOT GRANTED.** No command in this procedure has been executed. Stage 1C authorization does not authorize provisioning, startup, runtime acceptance, restart, stop, emergency response, or cleanup. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Command-reference sources

The command forms and selected output placeholders follow the Docker CLI references for [`docker --host`](https://docs.docker.com/reference/cli/docker/), [`container ls`](https://docs.docker.com/reference/cli/docker/container/ls/), [`network ls`](https://docs.docker.com/reference/cli/docker/network/ls/), and [`volume ls`](https://docs.docker.com/reference/cli/docker/volume/ls/). The filtered listener syntax follows the [`ss(8)` reference](https://github.com/iproute2/iproute2/blob/main/man/man8/ss.8). These are documentation references, not runtime evidence.

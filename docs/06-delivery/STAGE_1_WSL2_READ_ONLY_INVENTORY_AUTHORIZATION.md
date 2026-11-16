# Stage 1 WSL2 Read-Only Inventory Authorization Request

**Status:** Proposed owner authorization request. Not approved and not executed. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Requested scope

Authorize one bounded read-only inventory session in the owner-designated, already-running WSL2 Ubuntu distribution and its already-active Docker daemon. The session records enough identity and resource metadata to decide whether a later restricted startup request can be prepared. It does not authorize connecting to an unknown/default Docker daemon, activating an inactive daemon, stopping workloads, or any Stage 2–4 action.

The reviewed startup package is [Restricted WSL2 Runtime Readiness](RESTRICTED_WSL2_RUNTIME_READINESS.md), based on source `7a428a72c21b8633e81518b4c5f45bef7243ef52`, SHA-256 `ac0c44a852b4666da5a89733c048302fda976d56d9ec3942678e18ea8f084337`. Its recovery safeguards remain: every future resource-creating grant must include its own exact-ID emergency stop permission and timeout consequences, and an env-independent fallback may stop only recorded IDs after daemon identity is reverified. Neither safeguard grants stop authority under this inventory request.

## Owner-supplied fields required before execution

- WSL distribution name and confirmation it is already running.
- Operator identity and a bounded date/time window, including timezone.
- Docker context name and exact expected local `unix:///...` socket endpoint.
- Independent provenance for the expected daemon identity (for example owner-recorded daemon ID/name); context/socket metadata alone is insufficient.
- Approval to use the Docker-authorized account that can query the already-active daemon. No `sudo` or permission changes.
- Private evidence destination, access list, retention period, and recovery contact.

If any field is missing, context variables conflict, the daemon is inactive, or identity cannot be corroborated, do not execute the Docker portion. Do not guess `default`, infer a context, start a service, or switch endpoints.

## Proposed command manifest

Commands are listed for owner review only. Run them from the named WSL distribution in the reviewed source checkout. `CTX`, `ENDPOINT`, and `DOCKER_ROOT` are values supplied or confirmed by the owner; never substitute an implicit default. Do not paste full output into chat. Store approved output privately and redact host usernames, unrelated project names/labels, addresses, IDs and paths before sharing a summary.

| ID | Proposed command | Target, privilege and access | Effect, evidence and stop condition |
| --- | --- | --- | --- |
| 1 | `cat /etc/os-release; uname -r; ps -p 1 -o comm=` | Named WSL guest; ordinary user; OS/kernel/PID 1 metadata. | Read-only. Record distro/release/kernel/init. Wrong distro or inability to establish target: stop. |
| 2 | `docker --version; docker compose version` | Local client binaries only; ordinary user; no daemon request. | Read-only. Record versions; unavailable tools stop the Docker review. |
| 3 | `test -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}"` | Current shell only; no values printed. | Read-only. Any override means stop and reconcile; never unset/alter it as part of this grant. |
| 4 | `docker context inspect --format '{{.Name}} {{.Endpoints.docker.Host}}' "$CTX"` | Named context metadata; ordinary user; local Docker client config, no daemon socket request. | Read-only. Record only selected context and endpoint; require exact owner-approved values. Context metadata is not daemon identity. |
| 5 | `stat -Lc '%F %u %g %a' "${ENDPOINT#unix://}"` | Exact owner-supplied local socket; ordinary user. | Read-only metadata; no connection. Record type/owner/group/mode only. Missing, non-socket, unexpected ownership or endpoint mismatch: stop; no permission changes. |
| 6 | `docker --context "$CTX" version --format '{{.Client.Version}} {{.Server.Version}}'` | Explicit context and endpoint; daemon-authorized account; reads client/server version API. | API query is intended read-only but contacts the daemon and exercises socket authority. Run only if owner has confirmed it is already active and identity provenance is available. Record versions; unexpected/missing server: stop. |
| 7 | `docker --context "$CTX" info --format '{{.ID}} {{.Name}} {{.OperatingSystem}} {{.OSType}} {{.Architecture}} {{.SecurityOptions}} {{.NCPU}} {{.MemTotal}} {{.DockerRootDir}}'` | Same explicit daemon; daemon-authorized account; reads daemon metadata. | No intended resource mutation, but contacts rootful daemon. Record ID/name/security options/resources/root path; compare identity with owner provenance. Any mismatch, proxy ambiguity, or rootless/rootful ambiguity: stop. Treat Docker root path as sensitive. |
| 8 | `docker --context "$CTX" ps -a --no-trunc --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}} {{.Label "com.docker.compose.project"}} {{.Label "com.docker.compose.service"}} {{.Ports}}'` | Same daemon; all container metadata, including unrelated workloads. | Read-only list; names, ports, labels and IDs are sensitive. Record private baseline and classify candidate Workers, PostgreSQL and Omnis resources. Unknown active Worker or ambiguous resource blocks future mode transition. Do not inspect env/logs. |
| 9 | `docker --context "$CTX" image ls --no-trunc --digests; docker --context "$CTX" network ls --no-trunc; docker --context "$CTX" volume ls` | Same daemon; global image/network/volume metadata. | Read-only inventory; unrelated names/digests are sensitive. Record exact existing identities and collisions privately. No inspect of volume contents. |
| 10 | `docker --context "$CTX" ps -a --no-trunc --filter ancestor=postgres --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}} {{.Label "com.docker.compose.project"}}'` | Same daemon; PostgreSQL-like containers by image ancestry. | Read-only heuristic, not a complete DB inventory. Cross-check all container image/name labels from ID 8; do not query databases. Any active or uncertain database collision blocks provisioning. |
| 11 | `ss -ltn` | WSL network namespace; ordinary user; local listening TCP sockets. | Read-only snapshot; addresses/ports are sensitive. Record candidate port conflicts. It does not inspect Windows listeners or prove ingress boundaries. |
| 12 | `free -b; getconf _NPROCESSORS_ONLN; df -B1 .;` | WSL guest; ordinary user; host-visible memory/CPU and checkout filesystem capacity. | Read-only snapshot. Record available capacity. Does not establish Docker storage capacity. |
| 13 | `docker --context "$CTX" info --format '{{.DockerRootDir}}'` then, only after confirming that exact path is the intended Docker data root, `df -B1 "$DOCKER_ROOT"` | Same daemon metadata plus named filesystem path; ordinary user. | Read-only. Record filesystem capacity without traversing data. If root path differs from owner expectations or cannot be confirmed, do not run `df` against another path. |
| 14 | `docker --context "$CTX" inspect --format '{{.Id}} {{.Name}} {{.Config.Image}} {{.Config.User}} {{.HostConfig.Privileged}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.CapDrop}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{json .Mounts}} {{json .NetworkSettings.Ports}}' "$APPROVED_ID"` | One container ID selected from ID 8 and explicitly approved by owner; daemon-authorized account. No `.Config.Env`, command, logs or filesystem contents. | Read-only metadata, but exposes mount paths and ports. Use only for named Omnis/Worker/DB candidates; never iterate over all IDs or unrelated containers. Unknown ID or sensitive unrelated paths: stop and redact. |
| 15 | `docker --context "$CTX" network inspect --format '{{.Id}} {{.Name}} {{json .Labels}} {{json .IPAM.Config}} {{json .Containers}}' "$APPROVED_NETWORK_ID"` and `docker --context "$CTX" volume inspect --format '{{.Name}} {{json .Labels}} {{.Mountpoint}}' "$APPROVED_VOLUME_NAME"` | Only exact network/volume IDs or names associated with identified Omnis candidates; daemon-authorized account. | Read-only metadata; network addresses and volume mountpoints are sensitive. Do not inspect volume contents. Any unrelated/ambiguous target: omit and stop that branch. |
| 16 | `ip -brief address; ip route show` | WSL guest network namespace; ordinary user; local interface/address/route metadata. | Read-only; addresses/routes sensitive. Describes WSL only, not Windows firewall, NAT/mirrored mode, forwarding or LAN reachability. No Windows command, packet capture or probe is in scope. |

Existing Omnis resources are identified from ID 8 labels/names and exact, owner-approved ID inspections only. Process inventory from WSL `ps` cannot establish container descendants. No broad process argument listing, `docker inspect` environment output, logs, database query, secret-file access or Windows inspection is allowed.

## Preservation and stop rules

This grant excludes container start/stop/restart/exec, Compose commands, image builds/pulls, resource creation/removal, prune, database access or mutation, credential access/generation, host/package/systemd/network configuration, mock or provider execution, Windows changes, deployment and cleanup. It excludes emergency stop. If a workload appears unsafe, collect no additional data and notify the named recovery contact; obtain separate explicit resource-scoped authority before any mutation.

Stop immediately if the selected context or endpoint is not exactly owner-supplied; environment overrides conflict; the daemon is inactive or identity differs; output suggests a proxy or unverified host; a command would need elevated privileges; an unrelated workload would be touched; secrets appear; inventory is incomplete; or evidence custody is unavailable. Do not retry against another context or elevate privileges.

## Stage boundary

This request covers **Stage 1: read-only inventory only**. Stage 2 credential preparation and resource provisioning, Stage 3 restricted startup, and Stage 4 runtime acceptance/restart/controlled stop each require separate later approval. The future restricted scope, if separately authorized, remains project `omnis-os-restricted-dev`, database `omnis_restricted_dev`, and exactly PostgreSQL/API/Worker/Web with `OMNIS_RESTRICTED_DEVELOPMENT=true` and `OMNIS_EXECUTION_MODE=disabled`. Authorizer, launcher, mock execution and real providers remain excluded.

## Owner authorization form

**STAGE 1 — REQUEST FOR OWNER AUTHORIZATION**

- Target WSL distribution: **PENDING owner selection**
- Docker context: **PENDING owner supply**
- Unix-socket endpoint: **PENDING owner supply**
- Expected daemon identity provenance: **PENDING owner supply**
- Operator/window/timezone: **PENDING owner selection**
- Evidence destination/access/retention and recovery contact: **PENDING owner selection**
- Allowed commands: IDs 1–16 above, subject to their listed targets, privileges and stop rules
- Evidence handling: private approved storage; retain only necessary metadata; redact unrelated identities, paths, ports and network addresses before reporting; never collect secrets
- Excluded operations: all mutations, privileged operations, lifecycle actions, credentials, database access, Windows changes, execution and deployment listed above
- Stop conditions: any identity mismatch/unknown target, inactive daemon, conflicting context variables, elevated privilege need, unrelated resource ambiguity, secret exposure, incomplete evidence or unavailable custody
- Authorization scope: **READ-ONLY INVENTORY ONLY**

**This form is not approved.** The inventory cannot begin until every pending field is supplied and the owner explicitly authorizes this scope. Approval does not extend to Stages 2–4.

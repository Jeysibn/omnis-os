# Stage 1A — Docker Daemon Process Provenance Authorization

**Status:** Proposed owner authorization request only. No command in this document has been executed. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Target and existing evidence

Use only the owner-selected Ubuntu WSL2 environment, operator candidate `jeysi`, and configured endpoint `unix:///var/run/docker.sock`. The earlier local metadata preflight is complete and must not be repeated. It reported WSL name `Ubuntu`, context `default`, endpoint `unix:///var/run/docker.sock`, no `DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG` overrides, and a Unix socket mode `0660`, UID `0`, GID `986`. That preflight did not query the daemon and did not establish daemon identity.

This Stage 1A procedure investigates the current local socket inode, listening process, process executable/owner/parent and namespace, and local supervisor evidence. It never opens or connects to the socket. It cannot authenticate a remote/forwarded daemon behind a proxy or prove the Docker daemon's internal identity. No `sudo`, Docker API, process mutation, or configuration change is permitted.

## Preconditions and stop rules

Before execution, owner must provide:

- Inspection date and bounded window in Asia/Manila.
- Independently obtained expected process/service identity and provenance, such as the intended daemon implementation, expected executable path and digest, expected supervisor/unit, and how that expectation was recorded. Do not derive the expected identity from this socket or a Docker API response.
- Confirmation of approved evidence destination, access, retention and recovery contact. Evidence-file writes remain separately gated by the existing custody proposal.
- Explicit approval for this exact procedure and its local process/service metadata exposure.

The process identity anchor must be specific enough to compare observed executable path, executable digest, UID, parent/service and relevant namespace IDs. An expected label such as “Docker” or context `default` is insufficient. If no independent anchor is available, the outcome is **INCONCLUSIVE** and no Stage 1B API request should be made yet.

Stop on any mismatch, multiple possible listeners, missing listener, unrecognized proxy/forwarder, PID reuse/race, inaccessible `/proc` data, required privilege elevation, unexpected service manager, secret-bearing process arguments/configuration, or evidence custody failure. Do not retry against another socket, inspect broad process arguments, read service unit contents, use `sudo`, or open the socket. All output may identify local users, paths, PIDs, namespaces and services; summarize only fields needed for comparison.

## Proposed commands

Commands below are proposals, not an executable shell block. Run individually, in order, only after the owner approves the target and evidence handling. `<PID>` must be copied from the exact socket-filtered listener result, and parent PIDs must be followed one at a time from `ps`; never expand to a system-wide process dump.

| Step | Exact proposed command                                                                                                  | Purpose / target                                                                                               | Read-only behavior, privilege and exposure                                                                                                                                                                  | Stop condition                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `stat -c '%F %a %u %g %d %i %n' /var/run/docker.sock`                                                                   | Current directory entry type, mode, owner/group, device and inode.                                             | Metadata lookup only; no socket open. Ordinary user. Reveals path and numeric IDs. Compare device/inode and owner/mode to the prior preflight; inode change is a new socket instance and needs explanation. | Missing path, non-socket, unexpected owner/mode or unexplained inode change.                                                                              |
| 2    | `stat -Lc '%F %a %u %g %d %i %n' /var/run/docker.sock`                                                                  | Resolved socket target metadata, including device/inode.                                                       | Follows filesystem symlink metadata but does not connect to socket. Ordinary user. Reveals resolved path/IDs.                                                                                               | Resolved target differs from approved endpoint, is not a socket, or path resolution is ambiguous.                                                         |
| 3    | `ss -xlpn                                                                                                               | awk '$0 ~ /\/var\/run\/docker\.sock/ {print}'`                                                                 | Local listening Unix socket row(s) matching the exact path; capture process/PID when kernel permits.                                                                                                        | Reads local kernel socket/process metadata; no connection. Ordinary user may not see process details for all owners. Output can expose PID/process names. | No row, multiple rows, listener path mismatch, or process identity omitted/ambiguous. No privilege escalation to reveal it. |
| 4    | `ps -p <PID> -o pid=,ppid=,uid=,gid=,comm=,lstart=`                                                                     | Exact listener PID, parent, numeric owner/group, short process name and start time.                            | Reads process table; no arguments or environment. Ordinary user. Reveals local identity and timing.                                                                                                         | PID absent/reused, UID/GID not visible, process inconsistent with independent expected identity, or command name suggests an unexplained proxy.           |
| 5    | `readlink /proc/<PID>/exe`                                                                                              | Executable path for the exact listener PID.                                                                    | Reads proc symlink; no process interaction. Ordinary user may be denied. Reveals local path.                                                                                                                | Permission denied, deleted/replaced executable marker, or path mismatch. Do not elevate.                                                                  |
| 6    | `sha256sum /proc/<PID>/exe`                                                                                             | Digest of the exact listener executable for comparison to an independently recorded expected digest.           | Reads executable bytes through procfs; no mutation or execution. Ordinary user may be denied. Digest is not proof without trusted expected value.                                                           | Permission denied, digest mismatch, or no independent digest source.                                                                                      |
| 7    | `readlink /proc/<PID>/ns/pid; readlink /proc/<PID>/ns/mnt; readlink /proc/<PID>/ns/net; readlink /proc/<PID>/ns/user`   | PID, mount, network and user namespace identifiers for the exact listener.                                     | Reads proc namespace links; no namespace entry/join. Ordinary user may be denied. Namespace IDs reveal host structure.                                                                                      | Any missing/denied identifier or unexpected boundary; do not enter namespaces.                                                                            |
| 8    | `cat /proc/<PID>/cgroup`                                                                                                | Cgroup/unit association of exact listener.                                                                     | Reads one proc file; no cgroup mutation. Ordinary user may be denied. Reveals service paths.                                                                                                                | Missing or inconsistent association. Do not inspect cgroup files or change limits.                                                                        |
| 9    | `ps -p <PPID> -o pid=,ppid=,uid=,gid=,comm=,lstart=`                                                                    | One parent process at a time, following only the chain rooted at the listener until PID 1 or known supervisor. | Reads process metadata, not arguments/environment. Ordinary user. Reveals process names/IDs.                                                                                                                | Unexpected parent, PID race, ambiguous forwarding chain. Do not dump the process table.                                                                   |
| 10   | `systemctl show docker.socket docker.service --no-pager --property=LoadState,ActiveState,SubState,MainPID,FragmentPath` | Local systemd unit state and MainPID/path, if systemd is the supervisor.                                       | Read-only systemd manager query; no start/stop/reload. May contact local systemd D-Bus but not Docker API. Ordinary user where permitted; no sudo. Output reveals unit/path.                                | systemd unavailable or unit names/results conflict; do not try to activate units or read unit files.                                                      |

For step 9, substitute only the PPID printed by the prior approved `ps` command, and stop at PID 1 or the independently identified supervisor. Do not use `ps aux`, `ps -ef`, `/proc` scans, `lsof`/`fuser` alternatives, system logs, unit-file contents, environment dumps, or command-line arguments; they broaden exposure or are not part of this reviewed procedure.

If `ss` reports `systemd` as the socket listener, compare that PID with PID 1; use the socket unit's `ActiveState`/`SubState` only as supporting evidence because a socket-activation unit commonly has `MainPID=0`. Compare `docker.service` MainPID to the daemon PID only when that service is the observed supervisor. If `ss` reports `dockerd`, compare its executable and process/service evidence to the independent expected identity. If it reports Docker Desktop integration, a socket proxy, relay, or another forwarding process, this procedure can identify the local forwarder only; it cannot identify the remote daemon endpoint behind it. Mark identity **INCONCLUSIVE** unless the owner provides independent provenance for that forwarding chain.

## Evidence and trust assessment

Keep four claims distinct:

1. **Owner expectation:** intended WSL distribution, daemon implementation, executable/service identity and provenance, supplied out of band before this inspection.
2. **Local socket/process evidence:** socket device/inode, listener PID, executable path/digest, UID/GID, parent, cgroup/service and namespace IDs from commands above.
3. **Daemon response:** any later Docker API identity fields are self-reported by the selected endpoint and are not independent proof.
4. **Unverified assumptions:** socket listener may be a proxy; a local process may forward to Docker Desktop or another daemon; namespaces may obscure process relationships; local root can replace process/socket evidence. No in-guest read-only procedure alone defeats a compromised guest administrator.

The procedure can establish a plausible local process-to-socket relationship when the exact listener PID, executable and supervisor chain match a trusted owner-provided anchor. It cannot prove the internal Docker daemon ID or a remote/forwarded daemon's identity without an independent anchor and a separately authorized Stage 1B query. Context metadata and socket metadata are not identity anchors.

No evidence files are authorized here. If the owner separately authorizes in-memory review only, return a redacted summary in the conversation. Persisting output requires separate approval for exact path creation, permissions, file creation and retention.

## Authorization request

### STAGE 1A — DAEMON PROCESS PROVENANCE AUTHORIZATION

- Target: Ubuntu WSL2; operator candidate `jeysi`; configured endpoint `unix:///var/run/docker.sock`.
- Expected process/service identity and independent provenance: **PENDING OWNER SUPPLY**.
- Inspection window: **PENDING OWNER CONFIRMATION, Asia/Manila**.
- Evidence destination/access: **PENDING OWNER CONFIRMATION**; no persistent writes included.
- Retention: **PENDING OWNER CONFIRMATION**.
- Recovery contact: **PENDING OWNER CONFIRMATION**.
- Permitted commands: steps 1–10 above, only for the exact approved socket listener and its direct parent chain.
- Required privileges: ordinary operator access only; if any command requires elevation or access is denied, stop.
- Evidence: redacted local metadata only; no secrets, process environments/arguments, unrelated process listings, logs or Docker API data.
- Stop conditions: every condition in the preconditions section; especially multiple/unknown listener, proxy/forwarder without independent chain provenance, mismatch, inaccessible process data, or expired window.
- Authorization scope: **Stage 1A local process/socket provenance only**. No Docker API query is included.

**Authorization status: NOT YET GRANTED.** The owner must supply the expected identity anchor, inspection window, evidence handling and recovery contact, then explicitly approve this exact procedure.

## Separate next gates

- **Stage 1A:** this local process/socket procedure; separate approval required.
- **Stage 1B:** a specifically named Docker API identity query; requires independent provenance review and a new explicit authorization. This procedure does not authorize it.
- **Stage 1C:** full Docker resource inventory using the independently reviewed manifest; separate authorization required.
- **Stages 2–4:** credentials/provisioning, restricted startup, acceptance/restart/stop; remain unauthorized.

The restricted application target remains `omnis-os-restricted-dev` / `omnis_restricted_dev`, with exactly PostgreSQL, API, Worker and Web, `OMNIS_RESTRICTED_DEVELOPMENT=true`, and `OMNIS_EXECUTION_MODE=disabled`, only after later separate approvals. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

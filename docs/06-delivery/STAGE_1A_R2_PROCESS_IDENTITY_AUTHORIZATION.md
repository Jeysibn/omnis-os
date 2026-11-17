# Stage 1A-R2 — Final Daemon Process Verification Authorization

**NOT AUTHORIZED.** Documentation preparation only. No inspection below has been executed. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Target, evidence and scope

Source baseline: `e082d305e94f1a6b7e71547d7f17408217d2ce3d`. Existing reviewed Stage 1A/R1 procedures remain unchanged. R1 authorization is consumed.

Owner-observed privileged ss output associates `/run/docker.sock` with `dockerd` PID 501/fd 5 and systemd PID 1/fd 57. Socket identifier 20538 is neither a PID nor the previously measured filesystem inode 182. This is planning evidence, not a current attestation. The two holders are compatible with systemd socket activation; multiple holders are no longer automatically a failure when they are exactly this explicitly reviewed pair.

Expected environment: Ubuntu WSL2, operator jeysi, context default, canonical socket `/run/docker.sock`, root-owned `/usr/bin/dockerd`. Owner-supplied executable SHA-256: `6bffa5fc9b8922bfef287243f6d92677d30174e26e671d98afe8651dc7ef7d39`. Package/source verification is not repeated. No claim of independent package authentication is added.

This R2 proposal is fixed to PID 501 and PID 1. If the daemon PID changed, do not substitute a new PID or service MainPID: stop and request a new exact-target scope. Socket/process inspection never calls Docker or opens the Docker socket.

## Privilege decision before execution

Read-only process metadata may be visible to jeysi, but root-owned `/proc/501/exe`, namespace and fd links may require elevated access. The earlier unprivileged ss omitted all PIDs. Their availability cannot be determined here without performing the prohibited inspection.

Request a narrowly scoped elevated metadata bundle only if the owner accepts it: exact `sudo -n` commands marked below, no interactive password collection, shell, wildcard targets, sudoers changes or arbitrary Python under sudo. Sudo may write authentication/audit logs and refresh an existing credential timestamp; these incidental effects must be expressly accepted. If noninteractive sudo is unavailable, stop; do not use a password prompt or `sudo -v`. Read-only describes the intended target-resource effect, not a guarantee of zero logging or atime changes. The owner may instead run the elevated commands manually and supply their results, which remains owner evidence rather than Codex-observed evidence.

No elevated command is currently authorized. A fresh grant must explicitly approve the elevated subset and its audit consequences, not merely approve “read-only inspection.”

## Exact command allowlist and order

Run each command separately, evaluate its result, and stop on denied access, missing data or mismatch. No output redirection, persistent files, installations, alternative commands or PID substitution. This is a proposed sequence, not a block to execute automatically.

### A. Socket and listener, before process reads

```sh
stat -Lc '%F %a %u %g %d %i %n' /run/docker.sock
sudo -n ss -H -xlpn | awk '$2 == "LISTEN" && $5 == "/run/docker.sock" {print}'
```

The stat is ordinary metadata lookup; expected Unix socket UID 0/GID 986/mode 0660. Record the current device/inode, not an assumed historical value. ss reads kernel metadata, not Docker API; awk exposes only the exact canonical local-address row. Sudo's ss enumerates local sockets internally, so operator/tool trust must cover that underlying read; no unfiltered output may be retained. Require one row with exactly dockerd PID 501 and systemd PID 1 as holders, no other holders/rows, and verify reported path/state. Missing process fields, unexpected proxy or changed candidate means stop. Numeric ss columns never supply the PID.

### B. Stable process marker, beginning and end

Execute this exact ordinary-user command immediately before C and again after D. It emits only boot ID, PID, kernel start ticks and parent PID. Its source reads proc metadata, not environments/arguments. `-B` avoids bytecode-cache writes.

```sh
python3 -B -c 'from pathlib import Path; p=Path("/proc/501/stat").read_text(); f=p[p.rfind(")")+2:].split(); print("boot_id="+Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "pid="+p.split(" ",1)[0], "start_ticks="+f[19], "ppid="+f[1])'
```

Require exact equality of the complete beginning/end marker. This detects ordinary process replacement/PID reuse across the observation, including start ticks within one second; it does not create an atomic multi-command snapshot or defeat malicious local root. Read failures or changed marker invalidate the whole result. Do not retry within this one-time grant. Require native systemd parent PID 1 for this fixed R2 scope; another native supervisor requires separate owner identification/review.

### C. Process/executable/holder evidence

```sh
ps -p 501 -o pid=,ppid=,uid=,gid=,comm=,lstart=
ps -p 1 -o pid=,ppid=,uid=,gid=,comm=,lstart=
sudo -n readlink /proc/501/exe
sudo -n sha256sum /proc/501/exe
sudo -n readlink /proc/501/fd/5
sudo -n readlink /proc/1/fd/57
sudo -n readlink /proc/501/ns/pid /proc/501/ns/mnt /proc/501/ns/net /proc/501/ns/user
sudo -n readlink /proc/1/ns/pid /proc/1/ns/mnt /proc/1/ns/net /proc/1/ns/user
cat /proc/501/cgroup
cat /proc/1/cgroup
```

ps and cgroup reads use ordinary user privileges. They expose numeric identities, process start times, short names and cgroup paths; no process arguments/environments. Require dockerd root UID and expected native PID 1/systemd parent; record numeric GID without inventing a baseline. Executable symlink must be `/usr/bin/dockerd` without deleted marker and digest must match the owner's supplied baseline. SHA reads executable bytes only, not process memory.

The two fixed fd readlinks inspect link metadata only: require the same `socket:[N]` value, and compare N to the current listener's ss socket identifier. Do not assume N is 20538 at execution or compare it with filesystem inode. Missing/reassigned fd, multiple values or mismatch invalidate attribution; no fd scans or substitute fd numbers. This extra association supports socket activation without replacing the identified dockerd PID with a service-derived PID.

Namespace readlinks do not enter namespaces. Compare corresponding PID/mount/net/user namespace IDs to PID 1 as a local reference; unexplained differences are INCONCLUSIVE, not inherently malicious. PID 1 is a comparison reference, not an independent authenticity anchor. Cgroup paths and namespace IDs alone do not prove the supervisor or prevent proxying.

### D. Systemd relationship and closing observations

Only after B/C establish PPID 1 and ps reports systemd for PID 1:

```sh
systemctl show docker.socket docker.service --no-pager --property=LoadState,ActiveState,SubState,MainPID,FragmentPath
sudo -n ss -H -xlpn | awk '$2 == "LISTEN" && $5 == "/run/docker.sock" {print}'
stat -Lc '%F %a %u %g %d %i %n' /run/docker.sock
```

systemctl queries the existing system manager through D-Bus, not Docker; ordinary user access only, no activation/restart or unit contents. Require loaded/active docker.service MainPID 501, loaded/active docker.socket state consistent with listening, native unit paths and cgroup consistent with service supervision. Socket MainPID zero is acceptable and not compared with PID 1. Unexpected unit path or missing provenance remains unresolved; do not read arbitrary unit files. Repeat listener/socket metadata must match the beginning, then repeat B's marker as the last command. Any drift invalidates the result. Fixed executable/fd reads and markers reduce races but remain observations in a trusted local kernel/admin model, not a security boundary against hostile root.

## Outcome and exposure limits

**PASS, local provenance only:** all required evidence visible and stable; exact holder pair/fds map to one current listener; PID 501 is root-owned dockerd at the expected executable/digest; parent/service/cgroup and namespace relationship are coherent with native systemd; no unexplained proxy or drift. This is a bounded observation with owner-supplied package anchor, not cryptographic daemon authentication or proof of internal Docker ID.

**INCONCLUSIVE:** insufficient visibility, privilege unavailable, missing/changed marker, incomplete identity/supervisor/namespace evidence, unfamiliar output or fd drift. Stop without alternatives, retries or escalation beyond the exact grant.

**BLOCKED:** executable/digest/target mismatch, unexpected forwarding/proxy, prohibited operation needed, extra process/socket targets, custody failure, secret exposure or expired window. Do not repair or restart anything.

All process paths, unit paths, boot ID, namespace IDs, socket IDs and cgroups are private metadata; return minimized redacted conclusions in-session. If unexpected sensitive contents appear, stop reporting raw output. No persistent evidence files, permission changes or secret reads.

## STAGE 1A-R2 — FINAL DAEMON PROCESS VERIFICATION AUTHORIZATION

- Target/operator: Ubuntu WSL2 / jeysi; socket `/run/docker.sock`; context default (no Docker command authorized).
- Exact candidate/activation holders: dockerd PID 501/fd 5; systemd PID 1/fd 57. No substitutions.
- Expected executable/digest: `/usr/bin/dockerd` / `6bffa5fc9b8922bfef287243f6d92677d30174e26e671d98afe8651dc7ef7d39` (owner supplied).
- Allowlist: A; B beginning; C; D conditionally; B ending, with individual stop decisions. No repeated complete attempt.
- Privileges: jeysi plus only listed `sudo -n ss`, exact proc readlink and executable sha256sum commands, **if explicitly approved**. No root shell, interactive auth, arbitrary scripts under sudo or configuration writes. Incidental audit/timestamp effects require explicit acceptance.
- Date/window: **PENDING FRESH OWNER APPROVAL, Asia/Manila**. One supervised execution.
- Evidence: redacted results in-session only; no persistent evidence files. Retention follows conversation policy, subject to owner confirmation.
- Recovery contact: previously confirmed private arrangement; reconfirm availability for the new window.
- Stop/verdict criteria: as above; no automatic continuation on missing evidence.
- Status: **NOT GRANTED**. Approve the exact reviewed document hash, elevated subset/audit effects, time window and evidence/recovery arrangements before execution.

Stage 1B requires an independently assessed sufficient provenance result and a new explicit grant for a named Docker API identity query. Stage 1C and Stages 2–4 remain separately unauthorized. No Docker API/socket connection, daemon/service/process change, container lifecycle operation, package modification, database operation, evidence write, deployment or cleanup is authorized here. Prior authorization does not extend to R2. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

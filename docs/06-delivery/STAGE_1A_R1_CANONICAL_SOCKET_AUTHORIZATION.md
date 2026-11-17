# Stage 1A-R1 — Canonical Socket Listener Verification

**Status: NOT AUTHORIZED.** Preparation only; no amended inspection executed. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Evidence and amendment rationale

Source baseline: `e082d305e94f1a6b7e71547d7f17408217d2ce3d`. The previous one-time Stage 1A execution stopped after its `/var/run/docker.sock` listener filter returned no row. The owner subsequently reports `readlink -f /var/run/docker.sock` resolved to `/run/docker.sock`, and `ss -xln` listed a Unix stream listener under that canonical path, identifier `20538`. Those diagnostics are owner-supplied evidence, not newly executed checks by Codex.

The pathname mismatch explains why the prior text filter could miss this listener; it does not prove that the listener is dockerd. `20538` is an ss socket identifier, not a PID. Filesystem inode `182` from the earlier stat is a different identifier; no equality or process association is inferred. These observations are dated snapshots, not guarantees about a future inspection.

The proposed regex `/\/run\/docker\.sock[[:space:]]/` also matches a longer pathname ending in that substring, such as `/other/run/docker.sock`. Use an exact local-address field comparison instead:

```sh
ss -H -xlpn | awk '$2 == "LISTEN" && $5 == "/run/docker.sock" {print}'
```

`-H` removes the header. In the expected ss Unix table layout, columns are Netid, State, Recv-Q, Send-Q, Local Address, socket identifier, Peer Address, peer identifier, followed by optional process data. This command reads kernel/socket-process metadata; it does not connect to any socket or Docker API. Ordinary operator access only. Exact field equality rejects `/var/run/docker.sock`, `/other/run/docker.sock`, `/run/docker.sock.extra`, and other related sockets. If the format differs, no trustworthy row is available: stop INCONCLUSIVE rather than substituting a broader filter.

ss enumerates local listening Unix sockets internally, but awk returns only exact matching rows. Do not print or save the unfiltered table. A matching row may expose process names/PIDs and endpoint metadata; redact unrelated process details. No process arguments, environments, logs or secret contents are requested. The amendment changes only the approved path targeting and header/row selection; PID-specific checks retain their original scope.

## Complete proposed command allowlist

Run individually in order, with stop decisions after every command. Never execute placeholders literally. No command below is authorized by this document alone.

```sh
stat -c '%F %a %u %g %d %i %n' /run/docker.sock
stat -Lc '%F %a %u %g %d %i %n' /run/docker.sock
ss -H -xlpn | awk '$2 == "LISTEN" && $5 == "/run/docker.sock" {print}'
ps -p <PID> -o pid=,ppid=,uid=,gid=,comm=,lstart=
readlink /proc/<PID>/exe
sha256sum /proc/<PID>/exe
readlink /proc/<PID>/ns/pid; readlink /proc/<PID>/ns/mnt; readlink /proc/<PID>/ns/net; readlink /proc/<PID>/ns/user
cat /proc/<PID>/cgroup
ps -p <PPID> -o pid=,ppid=,uid=,gid=,comm=,lstart=
systemctl show docker.socket docker.service --no-pager --property=LoadState,ActiveState,SubState,MainPID,FragmentPath
```

Commands 1–2 inspect only the canonical socket metadata and do not open/connect to it. Record current device/inode; do not claim continuity with the earlier inode. A symlink, non-socket, unexpected ownership/mode, unavailable path or ambiguous resolution is a stop. Expected prior metadata was UID 0/GID 986/mode 0660, subject to fresh observation.

Step 3 must return one exact LISTEN row with one identifiable owning process PID in its process metadata. Copy `<PID>` only from that process field, never from numeric socket columns. No row, multiple rows, missing process data, or several owning PIDs means stop INCONCLUSIVE. A successful pipeline exit alone proves nothing about visibility or attribution.

Steps 4–8 apply only to that unique PID. Expected executable is `/usr/bin/dockerd`, owner root, with owner-supplied SHA-256 `6bffa5fc9b8922bfef287243f6d92677d30174e26e671d98afe8651dc7ef7d39`. The owner's package verification evidence is a supplied comparison anchor, not independently authenticated by Codex. Denied access or PID disappearance/reuse means stop; no sudo or alternate proc scans. Record namespace links as observations only; no independent namespace baseline has been supplied.

Step 9 follows only observed parent PIDs, one at a time, to PID 1 or an independently identified native supervisor. Step 10 is conditional on systemd being observed as supervisor. No systemd activation is allowed. For socket activation, PID 1 may hold the listener and docker.socket MainPID may be zero. Unit state alone does not bind the socket to dockerd. Do not substitute docker.service MainPID in steps 4–8. A systemd-only listener or otherwise incomplete daemon linkage is INCONCLUSIVE; request an exact separately reviewed extension. The expected installation is native Docker Engine; unexpected Desktop forwarding, proxies or remote delegation stop this procedure.

## Outcome and stop criteria

- **PASS for local provenance only:** exact unique listener with one visible PID, root ownership, expected dockerd executable/digest, coherent parent/cgroup/supervisor and adequately anchored namespace relationship, with no unexplained proxy or race. This does not establish the internal daemon ID or authorize API access.
- **INCONCLUSIVE:** no row/PID, multiple candidates, incomplete proc visibility, unrecognized output format, PID race, systemd socket activation without daemon linkage, or missing supervisor/namespace/identity anchors. Stop; do not broaden inspection or infer success.
- **BLOCKED:** target/path/executable/digest mismatch, unexpected forwarding/proxy, elevation or extra access required, secret exposure, filesystem mutation needed, evidence custody failure, or expired authorization. Stop without repair, retry against another endpoint, or workload changes.

## Fresh owner authorization request

**STAGE 1A-R1 — CANONICAL SOCKET LISTENER VERIFICATION**

- Target: Ubuntu WSL2; operator: `jeysi`; configured context: `default`; canonical socket: `/run/docker.sock` (configured alias `/var/run/docker.sock`).
- Commands: the complete allowlist above, with its exact row/PID selection and conditional steps; ordinary user privileges only.
- Inspection date/window: **PENDING NEW OWNER CONFIRMATION**, Asia/Manila. One supervised amended inspection only.
- Evidence: redacted results returned in-session; no persistent evidence files, directories, ownership/permission changes, raw socket table, or secret collection. Conversation retention follows platform policy; reconfirm this handling with the fresh grant.
- Recovery contact: previously owner-confirmed private arrangement for `jeysi`; reconfirm availability for the new window without publishing contact details.
- Trusted executable comparison: owner-supplied `/usr/bin/dockerd` baseline above; missing namespace/supervisor anchors cannot be fabricated.
- Stop conditions: all outcome/stop rules above. Uncertainty is never PASS.
- Explicit exclusions: Docker API/socket connections, sudo/elevation, service/process/container lifecycle actions, installs, database work, image operations, filesystem evidence creation, cleanup, providers, mock execution and deployment.
- Authorization status: **NOT GRANTED**. Prior 08:00–09:00 approval was consumed and grants no permission to repeat or amend the inspection.

Owner must approve this exact amendment/hash, a fresh date/window, evidence handling and recovery availability before execution. Stage 1B API identity, Stage 1C resource inventory and Stages 2–4 each remain separately unauthorized. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

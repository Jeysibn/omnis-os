# Stage 1A-R2.1 — Owner-Mediated Process Verification

**NOT AUTHORIZED.** Preparation and review only; no amended inspection executed. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Amendment and responsibilities

Preserves original R2 procedure SHA-256 `eca467a9947c89311e602e427872ccc580fe7a375f1d11afe82c9dfff2acd0b3`. The prior authorization was consumed when noninteractive sudo required authentication. This amendment replaces only the listed `sudo -n` calls with owner-operated `sudo`, and wraps each listener pipeline in a subshell enabling Bash `pipefail`. No package checks, targets, fds or fallback commands are added.

OWNER jeysi runs each approved command manually in the Ubuntu WSL2 **Bash** terminal, enters any sudo password only into the local trusted sudo prompt, inspects status and evidence, and stops on failure. CODEX supplies commands and evaluates redacted returned evidence; Codex executes none of these commands and never requests, collects or handles the password. Do not share raw terminal transcripts containing authentication interactions.

Target: native root-owned `/usr/bin/dockerd`, PID 501/fd 5 and systemd PID 1/fd 57 sharing `/run/docker.sock`; context default (no Docker command). Historical identities must be revalidated at step 2. No PID/fd substitutions, root shell, sudoers change, `sudo -v`, timestamp extension configuration, or retry is included. Existing cached sudo behavior may apply; no dedicated privilege persistence is requested. Sudo can create audit/authentication records and affect its normal credential timestamp; file reads may affect atime. Fresh approval must explicitly accept these incidental effects. Owner may choose not to enter a password and stop.

## Failure propagation and manual stop gate

Every numbered block is a separate command. Do not concatenate the blocks or paste the full sequence as a script. Immediately after each numbered command, run the following status-only shell builtin as the next command, before anything else overwrites `$?`:

```sh
printf 'exit_status=%s\n' "$?"
```

This helper reports status, changes no target resource, and is part of the proposed allowlist. Nonzero status, any error diagnostic, empty/missing expected fields, or mismatch means STOP. Do not continue to the next numbered block. A zero status alone never proves attribution or acceptance. In particular, multi-path readlink needs every required output, not merely zero status.

The two ss pipelines use `(set -o pipefail; ... )`: Bash returns a nonzero pipeline status if sudo/ss or awk fails, even if awk exits successfully. The setting is confined to the subshell and does not persist in the owner's shell. No unfiltered socket table is printed/saved. ss internally enumerates sockets; awk emits exact local-address LISTEN rows only. Unexpected errors must not be dismissed as formatting noise.

## Exact owner command sequence

Do not execute until the fresh grant covers this document. All commands are read-only as to target resources; no Docker API or socket connection is performed. Process namespace reads do not enter namespaces. Any inability to obtain evidence requires INCONCLUSIVE, not elevation beyond the listed commands.

### 1

```sh
stat -Lc '%F %a %u %g %d %i %n' /run/docker.sock
```

**Ordinary user:** no sudo permitted for this step. Socket, UID 0/GID 986/mode 0660; record device/inode. Missing/wrong target or metadata: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 2

```sh
(set -o pipefail; sudo ss -H -xlpn | awk '$2 == "LISTEN" && $5 == "/run/docker.sock" {print}')
```

**Owner sudo:** exact elevated metadata read only; manual local authentication if prompted. One exact LISTEN row with dockerd PID 501/fd 5 and systemd PID 1/fd 57 only. Missing/extra/changed holders, wrong format, or sudo/pipeline error: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 3

```sh
python3 -B -c 'from pathlib import Path; p=Path("/proc/501/stat").read_text(); f=p[p.rfind(")")+2:].split(); print("boot_id="+Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "pid="+p.split(" ",1)[0], "start_ticks="+f[19], "ppid="+f[1])'
```

**Ordinary user:** no sudo permitted for this step. Record beginning boot ID, PID 501, start ticks and PPID 1 privately. Missing/error/wrong PPID: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 4

```sh
ps -p 501 -o pid=,ppid=,uid=,gid=,comm=,lstart=
```

**Ordinary user:** no sudo permitted for this step. PID 501 is dockerd, UID 0, PPID 1; record GID/start time. Mismatch: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 5

```sh
ps -p 1 -o pid=,ppid=,uid=,gid=,comm=,lstart=
```

**Ordinary user:** no sudo permitted for this step. PID 1 is root-owned systemd. Otherwise stop; no alternate supervisor assumption. Then run the status-only helper and evaluate both status and evidence before continuing.

### 6

```sh
sudo readlink /proc/501/exe
```

**Owner sudo:** exact elevated metadata read only; manual local authentication if prompted. Exactly /usr/bin/dockerd, no deleted marker. Otherwise stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 7

```sh
sudo sha256sum /proc/501/exe
```

**Owner sudo:** exact elevated metadata read only; manual local authentication if prompted. Must equal 6bffa5fc9b8922bfef287243f6d92677d30174e26e671d98afe8651dc7ef7d39. Mismatch/error: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 8

```sh
sudo readlink /proc/501/fd/5
```

**Owner sudo:** exact elevated metadata read only; manual local authentication if prompted. Record socket:[N] for fixed PID501/fd5. Missing/reassigned/not a socket: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 9

```sh
sudo readlink /proc/1/fd/57
```

**Owner sudo:** exact elevated metadata read only; manual local authentication if prompted. Must equal the previous socket:[N] and the current ss socket identifier, not filesystem inode. Otherwise stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 10

```sh
sudo readlink /proc/501/ns/pid /proc/501/ns/mnt /proc/501/ns/net /proc/501/ns/user
```

**Owner sudo:** exact elevated metadata read only; manual local authentication if prompted. Record PID501 namespace links in listed order; all required. Denied/missing: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 11

```sh
sudo readlink /proc/1/ns/pid /proc/1/ns/mnt /proc/1/ns/net /proc/1/ns/user
```

**Owner sudo:** exact elevated metadata read only; manual local authentication if prompted. Compare corresponding PID1 namespace links with PID501; unexplained difference: INCONCLUSIVE and stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 12

```sh
cat /proc/501/cgroup
```

**Ordinary user:** no sudo permitted for this step. PID501 cgroup must cohere with native docker.service; missing/ambiguous: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 13

```sh
cat /proc/1/cgroup
```

**Ordinary user:** no sudo permitted for this step. PID1 cgroup reference must cohere with system manager; missing/ambiguous: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 14

```sh
systemctl show docker.socket docker.service --no-pager --property=LoadState,ActiveState,SubState,MainPID,FragmentPath
```

**Ordinary user:** no sudo permitted for this step. Only after PPID1/systemd established: loaded/active docker.service MainPID501 and loaded/active listening docker.socket, native unit paths. Socket MainPID0 is acceptable. Unknown/unexpected path/state: stop; no unit-file inspection. Then run the status-only helper and evaluate both status and evidence before continuing.

### 15

```sh
(set -o pipefail; sudo ss -H -xlpn | awk '$2 == "LISTEN" && $5 == "/run/docker.sock" {print}')
```

**Owner sudo:** exact elevated metadata read only; manual local authentication if prompted. Closing exact listener holder pair/fds/socket identifier must match beginning. Any drift/error: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 16

```sh
stat -Lc '%F %a %u %g %d %i %n' /run/docker.sock
```

**Ordinary user:** no sudo permitted for this step. Closing socket type/mode/ownership/device/inode must equal beginning. Drift/error: stop. Then run the status-only helper and evaluate both status and evidence before continuing.

### 17

```sh
python3 -B -c 'from pathlib import Path; p=Path("/proc/501/stat").read_text(); f=p[p.rfind(")")+2:].split(); print("boot_id="+Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "pid="+p.split(" ",1)[0], "start_ticks="+f[19], "ppid="+f[1])'
```

**Ordinary user:** no sudo permitted for this step. Complete ending marker must exactly equal beginning (boot ID, PID, start ticks, PPID). Drift/error: invalidate entire attempt; no retry. Then run the status-only helper and evaluate both status and evidence before continuing.

## Interpretation and verdict

Beginning/end boot-ID/start-tick markers detect ordinary process replacement and PID reuse; the parent must remain 1. The observations are sequential, not atomic, and cannot detect every intervening exec or defeat malicious local root. The exact executable digest is an owner-supplied package-matching anchor, not newly authenticated here. Socket:[N], ss socket identifiers, filesystem inode and PID are separate concepts.

Two holders are expected for socket activation: dockerd501 and systemd1. Unit state/cgroups corroborate that relationship; docker.socket MainPID may be zero. Do not replace PID501 with a service-derived PID. PID1 namespaces are a local comparison reference, not independent proof of host authenticity. Unknown proxies, forwarding or namespace boundaries are not acceptable inferred matches.

- **PASS, bounded local provenance only:** all required observations visible, stable and coherent; holder/fd relationship and socket identifier match; executable path/digest and root ownership match; native systemd supervision, cgroups and namespaces are supported; beginning/end markers and socket observations match; no unexplained forwarding. Not proof of internal Docker ID or cryptographic daemon authentication.
- **INCONCLUSIVE:** unavailable privilege/evidence, missing/changed marker, incomplete proc/supervisor/namespace evidence, unfamiliar output or fd drift. Stop without retry or alternatives.
- **BLOCKED:** executable/digest/target mismatch, unexpected proxy/forwarding, unapproved operations/access needed, custody failure, secret exposure or expired window. No repair/restart.

The sudo steps are 2, 6–11 and 15: only ss, the fixed executable hash and the exact fixed proc links. All other numbered steps and the status helper run as ordinary jeysi. `systemctl show` reads the existing system manager through D-Bus, not Docker; no activation. Output can reveal private PIDs, paths, timestamps, boot ID, cgroups and namespaces. Return minimized comparisons in-session, redact identifiers not needed for evaluation, and never share credentials or unrelated workloads. No logs, process arguments/environments, persistent evidence files, directories, permission changes or shell transcripts are authorized.

## STAGE 1A-R2.1 — OWNER-MEDIATED PROCESS VERIFICATION

**Status: NOT GRANTED.** Target Ubuntu WSL2; owner/operator jeysi; `/run/docker.sock`; exact fixed identities above. CODEX does not execute the inspection. Proposed allowlist is steps 1–17 plus the immediate status-only helper after each step, with no automated sequence.

New date/window: **PENDING OWNER APPROVAL, Asia/Manila**. One manual attempt only. Evidence: redacted in-session results, no persistent evidence files. Recovery contact/private arrangement: **PENDING RECONFIRMATION of availability**. Explicit acceptance of interactive local sudo and its incidental audit/authentication-timestamp/atime effects: **PENDING OWNER APPROVAL**. Password is entered privately by the owner, never supplied to Codex.

Fresh approval must identify the reviewed R2.1 SHA-256, complete allowlist, date/window, evidence policy and recovery availability. Previous R2/R1 approval is consumed. No Docker API, lifecycle/service change, database/package operation, image operation, cleanup, deployment or evidence-file write is included. No automatic retries, unrestricted escalation or later-stage permission. Stage 1B requires adequate provenance review and separate named API-query authorization; Stage 1C and Stages 2–4 remain unauthorized. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

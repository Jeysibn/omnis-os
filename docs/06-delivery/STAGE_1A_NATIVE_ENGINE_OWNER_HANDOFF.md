# Stage 1A Native Engine Owner Handoff

Preparation only; no inspection authorized. The reviewed procedure remains unchanged at SHA-256 `393da47f177adb4f574d0fee83394af872782472509d372d9e7dca81918874f8`. Its source is `STAGE_1A_DAEMON_PROCESS_PROVENANCE_AUTHORIZATION.md` in this worktree.

## Owner expectation and outstanding anchors

Owner confirms the intended installation is native Linux `dockerd` inside Ubuntu WSL2, owned by root, context `default`, endpoint `unix:///var/run/docker.sock`, operator `jeysi`. Ubuntu systemd is expected only if configured; otherwise the owner must identify the native supervisor/process relationship. Docker Desktop forwarding and remote daemons are unexpected. These statements specify intent; no process has been observed.

Available independent evidence is currently the owner's installation-type attestation only. No installation record, package/version/architecture identity, vendor provenance, trusted executable path/digest or service configuration has been supplied or inspected. Possible stronger anchors are an owner-controlled installation receipt with repository/package/version/architecture provenance, a trusted vendor package manifest and executable digest, and an owner-attested expected unit/supervisor relationship. A locally installed package database or checksum alone can be changed by local root and is supporting evidence, not independent authentication. A package archive digest is not the executable digest. Do not invent either.

Inspection of package records, unit contents, package downloads or new commands is outside this proposal; owner may supply sanitized existing records. If additional collection is needed, prepare a separate reviewed request before doing it. Unit state/MainPID from the existing procedure is an observation to compare against expectations, not its own trust anchor.

The prior preflight did not record socket device/inode or namespace baselines. Stage 1A can record them for the first time, but cannot claim they match a previous measurement. Any inode-change or namespace-match claim requires a real comparison source. File inode and kernel socket inode are different identities; do not equate them. The socket filter in step 3 is textual and may match extra rows: inspect the reported path for exact equality and stop on ambiguity; do not broaden the search or infer a listener when PID visibility is denied.

## Exact command sequence for owner approval

These reproduce the commands intended by the reviewed table, in plain code blocks to avoid its Markdown pipe-rendering ambiguity. They must run individually, with stop decisions between steps. Do not paste placeholders into a shell. `<PID>` is the unique listener PID from step 3; `<PPID>` is only its observed parent chain. If ownership hides the PID or `/proc` details, stop without sudo. Hashing a root-owned executable may be denied under ordinary access.

```sh
stat -c '%F %a %u %g %d %i %n' /var/run/docker.sock
stat -Lc '%F %a %u %g %d %i %n' /var/run/docker.sock
ss -xlpn | awk '$0 ~ /\/var\/run\/docker\.sock/ {print}'
ps -p <PID> -o pid=,ppid=,uid=,gid=,comm=,lstart=
readlink /proc/<PID>/exe
sha256sum /proc/<PID>/exe
readlink /proc/<PID>/ns/pid; readlink /proc/<PID>/ns/mnt; readlink /proc/<PID>/ns/net; readlink /proc/<PID>/ns/user
cat /proc/<PID>/cgroup
ps -p <PPID> -o pid=,ppid=,uid=,gid=,comm=,lstart=
systemctl show docker.socket docker.service --no-pager --property=LoadState,ActiveState,SubState,MainPID,FragmentPath
```

Step 9 follows parents one at a time only to PID 1 or a known supervisor. Step 10 is conditional on systemd being the observed supervisor; absent systemd is not a reason to activate it. A non-systemd path requires the owner-identified native supervisor expectation before proceeding. For a direct root-owned dockerd listener, compare executable/digest/owner and parent/cgroup with that expectation. For systemd socket activation, PID 1 may hold the socket: socket unit MainPID may be zero, so use unit state only as support. The service MainPID identifies a daemon candidate only when that unit actually supervises it; the original sequence does not silently authorize substituting the service PID for the listener PID in steps 4–8. If inspecting that additional PID is necessary, request a separately reviewed extension. Namespace IDs alone do not show equivalence to an unmeasured host namespace.

## Verdict criteria

- **PASS for local process provenance only:** unique exact listener; owner-approved root-owned native dockerd executable and trusted digest match; PID/parent/cgroup/supervisor and namespace evidence have adequate independent comparison anchors; no proxy or unexplained namespace boundary; evidence complete under ordinary permissions. This does not prove the daemon's internal ID or authorize an API query.
- **INCONCLUSIVE:** no trustworthy digest/install anchor, no namespace comparison anchor, socket activation reveals only PID 1, listener PID hidden, inaccessible proc data, PID race or incomplete supervisor relationship. Stop; request only the exact missing evidence or additional reviewed scope.
- **BLOCK:** observed mismatch with expected executable/owner/target, unexpected Docker Desktop/proxy/remote forwarding, ambiguous multiple listeners, need for elevated privilege or prohibited operation, custody failure or expired authorization. Do not repair, activate, connect or try another endpoint.

## STAGE 1A — DAEMON PROCESS PROVENANCE AUTHORIZATION

Target: Ubuntu WSL2. Operator: jeysi. Context: default. Endpoint: unix:///var/run/docker.sock. Expected native root-owned dockerd; systemd only if observed/configured, otherwise an explicitly identified native supervisor. Desktop/remote forwarding unexpected.

Permitted commands: exact sequence above, conditional and bounded as described in the approved procedure. Privilege: ordinary jeysi only. Trusted executable/package/supervisor/namespace anchors: PENDING OWNER SUPPLY. Window: PENDING OWNER CONFIRMATION, Asia/Manila. Evidence destination/access/retention and recovery contact: PENDING OWNER CONFIRMATION; no evidence-file writes included. Proposed reporting mode: redacted summary in this conversation only, subject to explicit owner approval.

Stop on any mismatch, ambiguity, denied access, privilege requirement, proxy, secret exposure, unavailable custody or expired window. Do not repeat the completed preflight. Approval must identify both this handoff and the unchanged reviewed procedure; no approval is recorded here. Stage 1B API identity, Stage 1C inventory and Stages 2–4 require separate later authorizations. Phase 1 R1 remains BLOCKED / NOT ACCEPTED.

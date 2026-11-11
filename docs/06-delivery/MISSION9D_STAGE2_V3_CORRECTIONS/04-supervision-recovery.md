# Supervision, startup interlock, outage and recovery

## Authority and deadlines

A dedicated system-manager-owned transient supervisor and independent finalizer are required outside the fixture cgroup and controller lifetime. T0 and Stage 1 absolute deadline are BOOTTIME-bound. Activity is at most 720 seconds from original T0; cleanup allowance is the next 180 seconds, total at most 900 seconds. These are upper limits, not a new start window: no application start may be permitted at or after original Stage 1 deadline. Finalizer is armed before fixture creation. At the original activity deadline or any safety event: close admission and serialize finalizer against the kernel first-instruction fence. If finalizer wins, freeze the exact fixture cgroup before any app instruction and terminate; if the app-entry event has already won, record its pre-deadline kernel evidence then terminate at expiry. Verify empty by cleanup deadline. Gate opening, exec success, permit delivery, and a user-space timestamp do not prove execution began. No fence proof means the fixture never starts. Cleanup may continue diagnostically after 900 seconds only with release closed; it cannot extend activity or silently claim successful termination.

Controller death is handled by manager-owned finalizer. Supervisor process death is handled by separately instantiated finalizer and unit dependency/watchdog. If systemd manager is unavailable, no local process can promise manager-based action. WSL shutdown destroys volatile authority and changes boot ID; persistent startup interlock must prevent Docker fixture autostart before a privileged reconciliation gate is restored. If that boot ordering cannot be enforced, **RELEASE BLOCKED — SUPERVISION GUARANTEE UNAVAILABLE**. No statement that transient units alone survive manager or WSL failure.

## Containment and late starts

Before creation, create unique root-owned cgroup-v2 subtree and freeze it; confirm cgroup2 mount, inode, manager ownership, empty state and no delegation. Runtime must assign container init and all descendants to that subtree before first executable instruction. Verify process PID/starttime in host namespace, `/proc/<pid>/cgroup`, cgroup inode/mount, runtime container ID/config digest, PID namespace mapping, and `cgroup.events`. Deny fixture write access to cgroup control files, migration/reparent controls, systemd/Docker sockets, host namespace and privileged capabilities. Exact immutable unit/nonce/config and container IDs are recorded before subsequent actions.

Late Docker create/start requests must be fenced by root-owned admission broker and persistent deny-start generation. Every created task enters the retained frozen ancestor before any instruction. Manager/Docker restart ordering must restore deny-start interlock before runtime can auto-start fixture objects. A frozen cgroup alone does not prevent daemon from removing/replacing it or creating elsewhere; broker/runtime controls and boot ordering require proof. First application instruction—not cgroup thaw—is deadline linearization. Delayed IPC, descheduling, expiry, and freeze races are denied unless kernel event evidence proves first application instruction at `now < deadline`. If placement, ancestry, cgroup identity or startup interlock is absent/inconsistent, do not thaw; kill known scope and retain blocking `containment_unknown` for any possible escape.

## Manager/runtime failure matrix

- Controller death: finalizer runs, closes gate, freezes/kills and verifies.
- Supervisor death: independent finalizer watchdog detects unit invocation loss and owns stop.
- systemd manager death/unavailable: no release unless a separate surviving kernel-enforced authority already owns fence and kill; otherwise block and require boot recovery.
- WSL restart: boot mismatch invalidates authorization; startup interlock runs before Docker; reconcile persistent deny-start record.
- Docker failure: cgroup freeze/kill and Windows Job termination proceed independently; record objects as unknown until Docker and exposure assessment return.
- Docker restart: keep startup admission broker closed; reject old generation and enumerate exact resource IDs before any enablement.
- cgroup mismatch/unknown process: block; do not assert termination or quarantine.
- Persistent residue: exact IDs, image/config digest, nonce, creation intent, cgroup/network/publication IDs and exposure assessment remain durable and monitored.

If no termination authority survives, release cannot start. If manager failure or WSL shutdown removes the fence/finalizer, persistent deny-start interlock must block old fixtures on next boot; if startup ordering cannot be proven, release stays blocked. Detection by polling, shell trap, Compose down, restart policy or Docker API response is insufficient. `cgroup.kill` and Windows Job termination require positive empty checks using trusted identities. Escaped or unaccounted processes mean containment unknown.

## Outage quarantine and cleanup

Record intent before API create, immutable container ID immediately on receipt, generation, exact image digest/config, returned process IDs+starttime, network ID, publication mapping and cgroup inode. Never reconcile by name/label alone. Docker acknowledgment does not prove stop. With Docker unavailable, stop via independent cgroup and Windows Job authorities; independently verify processes gone, then assess residual exposure using approved observations. Only both proofs allow `quarantined_residual_resources`; missing either stays `recovery_required` and blocks all new fixtures. Monitor quarantine continuously for late starts/exposure changes; loss of monitoring returns to blocking unknown.

Later deletion requires a separate owner authorization naming exact immutable IDs and operation set. No prune, broad labels, unrelated network or firewall cleanup. If daemon remains unavailable, retain ledger and interlock; report incomplete. Recheck unrelated baseline and exact ownership before removing exact container/network; verify publication absent on Windows/WSL and no unexpected endpoints. Keep evidence until verified. No cleanup is performed in this mission.

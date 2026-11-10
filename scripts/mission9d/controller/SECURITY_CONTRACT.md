# Mission 9D Stage 1 Controller

This directory implements journal validation and atomic attempt reservation only. It does not create fixtures, open listeners, send network requests, or release activity. Stage 2 owns the separately reviewed release channel.

The implementation follows approved contract SHA-256 `aa67d2d44bc0b807068b9e07f7e61f77bc0228d1359ac999b1a7e0df329c14ef`.

- Journal and lock files require an explicit persistent, private, user-owned state directory. Symlinks, unsafe ownership/modes, unknown lock identity, malformed state and unverified filesystem paths fail closed.
- A distinct stable `journal.lock` is locked through the system `flock` utility. Journal storage reads and writes are private to the transaction module; each storage entry point verifies the held descriptor, pathname identity, and the current process's exclusive device/inode lock record in `/proc/locks`. Missing lock evidence or unavailable procfs fails closed. Lock contention returns a denial; no stale lock is stolen.
- Initial journal creation is allowed only to the controller that atomically creates and durably syncs a previously absent `journal.lock`. If an existing lock is present while `journal.json` is missing, initialization fails closed. A crash after lock creation but before the first journal commit therefore requires a separately provisioned directory; it cannot be retried in place.
- A run has one durable controller-session identity. A different or restarted controller cannot resume admission for that run.
- Every reservation binds run, generation, path and attempt ID. A committed receipt ID is stored in the journal. Identical retries are non-actionable; conflicting retries fail. Three reservations per path is the limit.
- A caller must supply a trusted `ClockAdapter` backed by the verified host boot ID and `CLOCK_BOOTTIME`. There is no fallback to wall time or JavaScript timers. Tests inject a network-free fake adapter; the production clock provider and WSL2 behavior remain separate validation requirements.
- Commit order is temp write, file `fsync`, identity and deadline recheck, atomic rename, directory `fsync`, a second deadline/boot check while the lock is still held, unlock, then a final deadline check before receipt delivery. Ambiguous commits return no receipt and terminally deny further admission for the run. Duplicate reservations return only a non-actionable summary and never re-emit the stored receipt identifier.

Tests must use an explicitly supplied user-owned scratch directory. Separate local worker processes exercise cross-process serialization, and interruption tests kill an explicitly owned local controller process at precommit and postcommit boundaries. These tests do not prove WSL2 or target-filesystem lock-record behavior. This code has no Docker, socket, packet-capture, browser, systemd, cgroup or provider integration. Power-loss durability and target-host filesystem semantics are not established by these tests.

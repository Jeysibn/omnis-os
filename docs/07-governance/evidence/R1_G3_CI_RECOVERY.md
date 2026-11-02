# R1-G3 CI, Backup/Restore and Failure Recovery Evidence

**Review date:** 2026-11-02  
**Scope:** reproducible CI, PostgreSQL logical backup/restore, and local failure injection  
**Base revision inspected:** `e127c9bd556e8c00273786b1fb0b6318160e45ff`  
**Final revision tested remotely:** `621f7509b36f76c6db444b945c8bbc5bb2ae5b81`
**Data:** synthetic Omnis tasks and mock runs only; no provider inference or credentials

## Threat model and boundaries

PostgreSQL is the authority for tasks, run state, cancellation, leases, idempotency and ordered events. The trusted API and worker connect to PostgreSQL. The worker launches the fixed deterministic mock program in an ephemeral, digest-pinned Docker container. The sandbox has no Docker socket, database credentials, host credentials or network. The rootful Docker daemon and host kernel remain trusted boundaries. The sandbox was verified only for this fixed mock workload.

This milestone exercises worker process loss, sandbox container loss, API restart, and temporary database unavailability. It does not test Docker-daemon or host restart because the development daemon also runs unrelated services. Backup artifacts are private, but the scripts do not encrypt them. No real runtime was enabled.

## CI and clean checkout

The CI workflow pins Node `24.22.1`, pnpm `12.16.1`, PostgreSQL `17.6-alpine` by image digest, the mock sandbox image by digest, and GitHub Actions by commit SHA. It uses `contents: read`, disables persisted checkout credentials, installs with `pnpm install --frozen-lockfile`, and runs formatting, ESLint, TypeScript, tests, production build and recovery integration. Tests use synthetic data and no provider secrets.

Remote GitHub Actions status: **Passed** on `621f7509b36f76c6db444b945c8bbc5bb2ae5b81`: [run 41437998618](https://github.com/Jeysibn/omnis-os/actions/runs/41437998618). GitHub reports all steps successful: pinned checkout/tool setup, sandbox image pull, frozen install, `pnpm check`, production build, `pnpm integration:recovery`, and cleanup. Total job duration was 1m44s. An earlier run also passed on `1e2821dad6cf9140bd98ab264654b0a485eb0fb3` ([run 41437576359](https://github.com/Jeysibn/omnis-os/actions/runs/41437576359)). No production secrets or provider credentials were supplied.

Clean-clone verification: **Passed locally** on implementation revision `55636c3b999304b94cede48a75b182a1da6bda47` in `/tmp/omnis-os-r1g3-clean-55636c3`, cloned from local Git without build artifacts or `node_modules`. `npx --yes pnpm@12.16.1 install --frozen-lockfile` installed all 209 packages with no download, followed by `pnpm check`, `pnpm build`, and `pnpm integration:mock`. Formatting, ESLint, all TypeScript packages, 42 tests (including 11 real PostgreSQL tests and eight actual Docker sandbox tests), production build, and the API/worker integration smoke passed. The pnpm store used `/tmp/.pnpm-store/v11` because the clone and default store are on different filesystems.

Earlier disposable-clone attempts exposed timing assumptions: a 700 ms sandbox deadline raced container startup, and an interrupted-run assertion sampled state before lease reconciliation. The integration test deadline is now 3 seconds and the lifecycle smoke waits for the durable interrupted state (up to 45 seconds). The final clean clone on `55636c3` passed; the database lease policy and production execution timeout were not changed.

## Backup and restore procedure

The backup script takes a repeatable-read exported PostgreSQL snapshot shared by `pg_dump` and its metrics query. It emits PostgreSQL custom format (`PGDMP`) and a SHA-256/count manifest. The scripts require a private directory and owner-only files, reject overwrite, verify the archive list, and refuse restore to an existing database. Restore targets must use the reserved `omnis_restore_` prefix. A target is created with connections disabled, and runtime access is granted only in the same transaction that marks the target verified. A rejected restore quarantines and removes its own target; if removal fails, it remains connection-disabled with an unverified marker. See [the operator procedure](../../06-delivery/OPERATIONS.md) for failure investigation and safe cleanup.

Commands run against the isolated local Compose PostgreSQL 17.6 instance (password supplied only through a mode-0600 environment file):

```sh
node --env-file=/tmp/omnis-r1g3-compose.env scripts/db-recovery/backup.mjs /tmp/omnis-r1g3-backup/omnis-test.dump
OMNIS_TRUSTED_ARCHIVE_ACKNOWLEDGED=true node --env-file=/tmp/omnis-r1g3-compose.env scripts/db-recovery/restore-verify.mjs /tmp/omnis-r1g3-backup/omnis-test.dump omnis_restore_r1g3_test
```

The archive was 58,135 bytes, mode `0600`, and its SHA-256 was `646ce0255df7a5bc1b9d44bf1fe55dc28404ddab8704fe6b29fac552fe33e83c`. Its private manifest recorded migration `0001_initial`, two tasks, two runs, six events, terminal cancelled/interrupted history, contiguous event sequences, no active/unknown runs, and matching record fingerprints. Restore and validation took 1,149.64 ms. Counts and fingerprints matched. `pnpm integration:mock` then passed against the restored database, demonstrating application queries and run lifecycle work against restored state. The test did not start a worker until the explicit application smoke.

The measured restore is a small local synthetic database result, not an RTO guarantee. Proposed targets are RPO under 24 hours and RTO under four hours. Retain daily backups for seven days and weekly backups for four weeks during private alpha, then adjust with usage. Encrypt backups containing real data before they leave the protected host, store keys separately, and run periodic isolated restore drills. See [Operations](../../06-delivery/OPERATIONS.md).

## Failure injection results

The final local command was `pnpm integration:recovery`, with `OMNIS_TEST_DATABASE_URL` pointed at a new disposable database and `OMNIS_TEST_POSTGRES_CONTAINER` set only to the test container bearing `com.omnis.os.r1g3-disposable=true`. The run completed on implementation revision `55636c3b999304b94cede48a75b182a1da6bda47` with: `PostgreSQL-backed recovery passed: durable lifecycle, API/SSE replay, abrupt worker recovery, sandbox crash cleanup, and no duplicate execution.`

| Scenario | Result | Observation |
|---|---|---|
| API restart | Passed locally | Tasks/runs reconstructed from PostgreSQL; terminal state persisted. |
| SSE reconnect/replay | Passed locally | Replay after `Last-Event-ID: 1` retained ordered stable IDs with no duplicate event IDs or state transition. |
| Abrupt worker `SIGKILL` | Passed locally | Replacement worker did not duplicate execution. After the 30-second lease expired, one interrupted terminal event was persisted; previous events remained. The orphaned workspace was removed by reconciliation. |
| Sandbox container `SIGKILL` | Passed locally | Only the labeled run container was killed; its run failed with a safe message, unrelated completed/cancelled runs were unchanged, and its workspace was cleaned. |
| PostgreSQL outage | Passed with operational recovery | Only the labeled disposable PostgreSQL container was stopped/started. Task/run admission while unavailable returned 500 and the failed task did not persist. The worker process exited (code 1) during the outage; after PostgreSQL was healthy, a replacement worker was started. Repeated admission with the same idempotency key returned the same run, which completed once. This is restart recovery, not in-process worker self-healing. |
| Docker-daemon interruption | Not verified | Shared daemon interruption was unsafe because unrelated MoniKey containers use it. No daemon restart or host/WSL action was performed. |

The recovery integration completed with: `PostgreSQL-backed recovery passed: durable lifecycle, API/SSE replay, abrupt worker recovery, sandbox crash cleanup, and no duplicate execution.`

## Environment and commands

- WSL2 Ubuntu 26.04.1, Node `v24.22.1`, pnpm `12.16.1` via `npx`, Docker Compose with PostgreSQL `17.6-alpine`.
- Docker socket access came from the existing account `docker` group membership in a fresh `sg docker` shell. No socket mode, group membership, daemon configuration, or host firewall was changed.
- Disposable Compose project: `omnis-r1g3-0dad5eae`, unique named volume, loopback-only host port. Existing unrelated MoniKey containers remained running and healthy.
- Frozen install: `npx --yes pnpm@12.16.1 install --frozen-lockfile` — passed from the source checkout and clean clone.
- `pnpm check` — passed on the final code revision, including all eight actual Docker security cases and 11 PostgreSQL integration tests.
- `pnpm build` — passed on the final code revision.
- `pnpm integration:mock` — passed against both source and restored databases.
- `pnpm integration:recovery` — passed after the final workspace cleanup, SSE terminal reader, outage worker-restart and task-count corrections.
- Actual Docker sandbox negative suite — eight container tests passed in final `pnpm check` with `OMNIS_SANDBOX_INTEGRATION=1`.

## Remaining limitations and gate decision

- The worker process is not resilient in place to a PostgreSQL outage; an external process supervisor must restart it. No default systemd/Docker supervisor is configured here.
- The host uses a rootful Docker daemon. Rootless Docker/user namespaces, AppArmor, a separate host, and shared-daemon failure are unverified. Docker containers do not remove trust in the launcher, Docker daemon, or kernel.
- GitHub Actions passed remotely on published `main` at `621f7509b36f76c6db444b945c8bbc5bb2ae5b81`. The repository is public at `https://github.com/Jeysibn/omnis-os`.
- Clean-clone checks must be recorded against the final committed revision.
- Backups are not encrypted by these scripts; encryption and off-host retention are operational prerequisites for real data.
- Hermes, Codex and Claude remain disabled; this evidence grants no model/runtime authorization.

**R1-G3 status:** Local checks, clean-clone verification, backup/restore, process recovery, and remote CI passed. Docker-daemon failure remains **Not Verified** and is still an open recovery scenario. Worker process recovery from database loss requires a replacement process. Do not infer daemon-level recovery or complete R1 readiness from this result.

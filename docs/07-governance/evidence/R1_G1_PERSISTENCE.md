# R1-G1 PostgreSQL Persistence and Mock Lifecycle Evidence

**Date:** 2026-11-02  
**Environment:** WSL2 Ubuntu 26.04.1; Node v24.22.1; pnpm 12.16.1; Docker CLI 29.9.2; Compose v5.6.1; PostgreSQL 17.6 Alpine.  
**Runtime scope:** Mock only. No Hermes, Codex, Claude, model API, or native tool execution was enabled.

## Infrastructure

- The original command process did not have the Docker supplementary group, although `/var/run/docker.sock` was owned by `root:docker` with mode `0660` and `getent group docker` already listed `jeysi`. A fresh WSL login shell (`wsl.exe -d Ubuntu -u jeysi -- ...`) showed the existing membership and accessed the daemon. No socket mode, ownership, or account/group permissions were changed.
- Docker Compose started `postgres:17.6-alpine`, bound only to `127.0.0.1:5432`; its health check reported healthy. Compose uses the named volume `omnis-os_omnis-postgres-data`.
- pnpm/Corepack were absent in the original shell. The configured registry returned HTTP 200. `npx --yes pnpm@12.16.1 install` and subsequent `pnpm install --frozen-lockfile` succeeded; `pnpm-lock.yaml` is committed and CI uses frozen installs.
- No unrelated `monikey` containers were stopped or modified.

## Implemented persistence behavior

Migration `packages/db/migrations/0001_initial.sql` creates the first physical operational slice: tasks, runs, ordered events, idempotency records, results/evidence references, retry policy/count, execution generation, pg-boss job mapping, and worker leases. Admission writes the run, initial event, idempotency record, and pg-boss job in a PostgreSQL transaction. Database constraints and partial indexes enforce the mock-only data shape and active-run/query patterns.

Run events receive a stable event ID and per-run increasing sequence while holding the run row lock. They are committed before being published to worker/API SSE subscribers. API SSE first subscribes and replays the persisted cursor range; already-seen sequence IDs are ignored. pg-boss admission has retries disabled. A worker interruption or expired lease produces a terminal `interrupted` event and does not automatically requeue work. Stop requests are durable; healthy lease owners observe them through their heartbeat, and the worker reconciler may acknowledge a stop after pg-boss confirms the job is terminal.

A PostgreSQL test initially exposed a completion defect: the row-lock projection omitted the `lease_owner` column. The store now selects the lease fields and a regression test proves that only the lease owner can complete the run. This fixed the previously failing queue jobs observed during browser testing.

## Commands and results

The following were run against the current source with `OMNIS_TEST_DATABASE_URL` pointed to a disposable local PostgreSQL database ending in `_test`:

| Command/check | Result |
|---|---|
| `npx --yes pnpm@12.16.1 install --frozen-lockfile` | Passed; workspace dependencies matched lockfile. |
| `npx --yes pnpm@12.16.1 format` / `format:check` | Passed. |
| `npx --yes pnpm@12.16.1 lint` | Passed. |
| `npx --yes pnpm@12.16.1 typecheck` | Passed for all workspace packages. |
| `npx --yes pnpm@12.16.1 test` | Passed: 26 tests across contracts, DB, API, policy, runtime adapter, and worker packages. DB tests ran against real PostgreSQL, not skipped. |
| `npx --yes pnpm@12.16.1 build` | Passed; Vite production build completed and all TypeScript package checks passed. |
| `npx --yes pnpm@12.16.1 integration:mock` | Passed against real PostgreSQL, using separate API and worker child processes. |

PostgreSQL coverage includes migration execution, atomic admission/outbox writes, rollback when queue admission fails, concurrent idempotent submissions, single active-run admission, lease ownership, ordered event replay, cancellation, stopped queued-job recovery, terminal queue cancellation recovery, and expired-lease interruption without replay.

The process integration created an owner session and task, admitted a synthetic run with an `Idempotency-Key`, retried admission to confirm the same run ID, opened SSE, requested stop, and observed cancellation. It stopped/restarted the API, signed in again, verified task/run reconstruction, and replayed events after `Last-Event-ID: 1` with unique ordered IDs. It then stopped/restarted the worker, verified the canceled run remained canceled, stopped a worker during an active synthetic run, restarted it, and verified exactly one `run.started`, one `run.interrupted`, and no replay.

## Browser proof

Using the installed Playwright CLI and local Chromium, the owner signed in, created tasks, observed a naturally completed synthetic run and event trail, requested stop on another run, observed terminal cancellation, and reloaded the page with state intact. A mobile viewport at 390×844 stacked the task list and run inspector; desktop at 1440×1000 displayed both columns. The browser console had zero errors after the final run.

- [Desktop screenshot](r1-g1-desktop.png)
- [Mobile screenshot](r1-g1-mobile.png)

## Security and limitations

- The web/API/worker are loopback-only. The API does not execute shell commands. The only adapter available to the worker is deterministic mock; it makes no provider call and emits visibly synthetic results. Usage is represented as unknown.
- Native provider credentials were not read, copied, logged, or reused. No third-party token tunnel or billable provider fallback exists.
- Docker daemon access is root-equivalent through the existing `docker` group. The owner authorized use of that existing membership from a fresh WSL login for local PostgreSQL testing; no membership or socket changes were made.
- The worker runs in a distinct process, but OS sandbox controls, filesystem isolation, and network egress restrictions are not established. Process separation alone is not a complete sandbox.
- GitHub Actions was configured but not run remotely. A clean committed-worktree install/check remains to be recorded after the implementation commit. A database restart/backup-restore drill was not performed.
- The broader Omnis OS models (departments, agents, projects, profile versions, approvals, usage ledger, and other modules) remain roadmap items; the current DB migration is the initial task/run slice.

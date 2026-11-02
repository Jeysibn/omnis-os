# Omnis OS Phase 0 decisions and risks

**Review date:** 2026-11-02  
**Scope:** Phase 0 host/runtime gate and safe Phase 1 foundation  
**Status:** Real runtime gate blocked; safe mock scaffold may proceed. Technology versions are proposals derived from the available environment, not owner approval.

## Decisions

| ID | Decision | State |
|---|---|---|
| D-001 | Start as a single-owner local web application. Keep authentication, CSRF, secret storage, and network boundaries explicit before any remote exposure. | Proposed for owner review |
| D-002 | Use pnpm workspaces. Pin the observed npm registry latest `pnpm@12.16.1`; the environment has no preinstalled pnpm/Corepack. | Proposed; not owner-approved |
| D-003 | Use React, Vite, Tailwind, Fastify, strict TypeScript, and runtime schema validation as proposed in the handoff. | Owner selected for first gate |
| D-004 | Make the initial run lifecycle deterministic mock-only. Label it as synthetic in data and UI. | Approved by implementation brief |
| D-005 | Keep API free of native shell execution. Future real execution belongs in a restricted worker/runtime host with explicit grants and concurrency limits. | Security requirement |
| D-006 | Do not enable Claude background runs pending plan/Agent SDK policy review. Do not create a third-party credential tunnel. | Security/policy gate |
| D-007 | Do not start Hermes API or send provider inference until its tool capabilities can be restricted to the authorized read-only scope and the owner approves usage. | Security/policy gate |
| D-008 | A future Codex plan-backed integration must use the supported Sign in with ChatGPT authorization path, local user-controlled token storage/runtime, express consent for background automation, and one connected app boundary. The installed CLI login alone is not authorization for Omnis OS. | Security/policy gate |

## Phase 0 checklist

| Gate | Result | Evidence / blocker |
|---|---|---|
| Host/WSL, Node, package manager, Docker, resources, and ports | Complete | WSL2 Ubuntu 26.04.1 x86_64; Node v24.22.1; npm 11.19.1; no pnpm or Corepack; Docker CLI 29.9.2 and Compose v5.6.1 installed, but Docker socket returns permission denied. RAM 31 GiB total / 22 GiB available; 8 GiB swap; workspace filesystem 1,007 GiB total / 887 GiB available. Listeners observed: 127.0.0.1:4173, :4180, :41967, :33823. No listeners observed at :5432, :8642, :9119. |
| Installed Hermes/Codex/Claude versions and connection status | Complete, redacted | Hermes Agent v0.22.2; `hermes status` reports gateway running, no platforms, 0 jobs. Codex CLI 0.166.0; `codex login status` says logged in using ChatGPT. Claude Code 2.1.316; filtered `claude auth status` fields report logged in, auth method `claude.ai`, account category `team`, provider `firstParty`. No credential values were read or recorded. |
| Hermes bearer auth, capabilities, isolated read-only request, SSE, stop | Blocked | Hermes API docs describe `API_SERVER_KEY` bearer auth and `/v1/capabilities`, run submission/status/SSE/stop. The documented API server has access to the full agent toolset, including terminal commands. No read-only tool profile or isolation was demonstrated for this installed configuration. API server is not listening at :8642. No inference request or server startup was made. |
| Codex non-interactive interface, token events, session isolation, policy | Partially verified; integration blocked | Local CLI provides `codex exec` and `codex app-server`. Official app-server integration streams `item/agentMessage/delta` and uses explicit thread IDs for start/resume. Official Sign in with ChatGPT guidance requires supported OAuth, local user-controlled persistent token storage, user-triggered or expressly authorized automation, one connected-app boundary, and no charge/upgrade requirement. The installed CLI login is not a substitute for Omnis OS OAuth/consent. No token was reused and no inference was sent. |
| Claude CLI integration and subscription/Agent SDK policy | Partially verified; background integration blocked | Local Team-authenticated Claude Code 2.1.316 supports `-p` non-interactive CLI mode. Official Anthropic docs distinguish Claude Code plan usage from Console/API usage; the current Agent SDK/team policy and permission model for Omnis OS background operation has not received owner/legal review. Background Claude remains disabled. |
| Web auth, runtime secret storage, sandbox, network | Partially implemented | Loopback-only API and worker, owner password login, signed HttpOnly SameSite=Strict session cookie, Origin + CSRF checks on mutations, and a generated local internal token are implemented. This is a local mock gate only; persistent secret storage, worker OS isolation, egress controls, and remote deployment policy remain open. |
| One supported real R1 runtime, exact command/endpoint/version | Not established | No real runtime passed the policy and isolation gates. |
| Build proof and no-cost guarantees | Mock proof complete; infrastructure proof blocked | Strict TypeScript checks, ESLint, Vite production build, 13 Node interface/unit tests, API security/idempotency/SSE/stop integration smoke, and browser login/task/run/cancel/reload smoke passed using cached host dependencies. pnpm was unavailable and registry access timed out, so a clean pnpm install and lockfile were not verified. Docker socket access prevented PostgreSQL validation. No provider inference was sent and no cost guarantee is claimed. See [mock run proof](evidence/MOCK_RUN_PROOF.md). |

## Risks and blockers

1. **Hermes tool scope:** bearer auth protects the API but does not by itself constrain the powerful toolset. Do not call the API with a read-only prompt until a verified tool allowlist and isolated workspace are in force.
2. **Provider-account usage:** existing local sign-in state is personal account material. Do not pass it into a web/API process or a shared service. Any future background run requires the supported provider authorization flow and explicit user consent.
3. **Claude automation policy:** subscription authentication exists on the machine, but this does not approve reuse by an app-owned unattended worker. Keep disabled until reviewed.
4. **Host infrastructure:** The original command shell lacked the current Docker supplementary group. A fresh WSL login showed the already-configured `docker` group and successfully ran Compose; no socket permissions or group membership were changed. Docker group membership is root-equivalent and must remain a deliberate host-owner decision.
5. **Repository baseline:** workspace was empty and had no `.git`, source documentation pack, or existing implementation to preserve. The initial documentation commit records the handoff before code is added.
6. **Dependency reproducibility:** the initial Phase 0 install could not reach the registry. During R1-G1, the registry responded, pnpm 12.16.1 installed dependencies, `pnpm-lock.yaml` was generated, and CI now uses frozen-lockfile installs. Clean-worktree verification is recorded separately below.

## Phase 1 infrastructure revalidation — 2026-11-02

| Gate | Result | Evidence |
|---|---|---|
| Host toolchain | Verified | WSL2 Ubuntu 26.04.1; Node v24.22.1; Docker CLI 29.9.2; Compose v5.6.1. Existing user membership was `docker:x:986:jeysi`; the original process lacked supplementary GID 986. A fresh `wsl.exe -d Ubuntu -u jeysi -- ...` shell had the group and reached the daemon. No permissions changed. |
| pnpm and registry | Verified locally | pnpm 12.16.1 was obtained through `npx`; the registry returned HTTP 200. Dependency installation and `pnpm install --frozen-lockfile` succeeded. Exact versions and lockfile are committed. |
| PostgreSQL Compose | Verified locally | `postgres:17.6-alpine` reached healthy status on `127.0.0.1:5432`; named volume `omnis-os_omnis-postgres-data` was used. No unrelated `monikey` containers or data were touched. |
| PostgreSQL migrations and persistence | Verified locally | Migration `0001_initial.sql`, transaction rollback, task/run/event persistence, queue admission, lease recovery, and cancellation were tested against real PostgreSQL. See [R1-G1 persistence evidence](evidence/R1_G1_PERSISTENCE.md). |
| API/worker restart and SSE replay | Verified locally | Process integration stopped/restarted the API and worker, reconstructed task/run state, replayed events from `Last-Event-ID`, and checked interrupted work was not replayed. |
| Web browser | Verified locally | Playwright CLI smoke covered owner login, task creation, completed mock run, stop, SSE trail, browser reload, and 1440px/390px layouts. Screenshots and command notes are in the R1-G1 evidence report. |
| Clean worktree and CI | Clean committed-worktree verification passed | Frozen install, formatting, lint, type checks, 26 tests, production build, and PostgreSQL-backed API/worker restart integration passed in a detached worktree at `2451e1e`. GitHub Actions itself was not run from this local environment. |

## R1-G1 status

The PostgreSQL-backed mock lifecycle is implemented and its local code, database, process-restart, and browser checks passed. Real Hermes/Codex/Claude inference remains disabled. R1-G1 does not authorize provider use or claim OS-level worker sandboxing or egress enforcement. The exact version pin `pnpm@12.16.1` is in the repository; explicit owner approval of version pins for production remains open.

## Owner decisions still needed

- Approve the technology/version proposals before production use.
- Approve the authentication and token ownership model, including whether Omnis OS will register a Sign in with ChatGPT integration.
- Approve the real runtime and documented tool permissions after isolated proof.
- Review Claude Team/Agent SDK terms and any background use before enabling it.
- Review the committed package/image pins before any production deployment; pnpm 12.16.1 and the dependency lockfile now have a local reproducibility proof.
- Review [ADR-0007](adr/0007-loopback-mock-functional-gate.md) before any real runtime or non-loopback access is enabled.

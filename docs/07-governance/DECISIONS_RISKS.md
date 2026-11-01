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
| Web auth, runtime secret storage, sandbox, network | Open | Single-owner local auth, session/CSRF/secure-cookie policy, token storage, worker isolation, and network egress rules are not implemented or approved yet. No real runtime is enabled. |
| One supported real R1 runtime, exact command/endpoint/version | Not established | No real runtime passed the policy and isolation gates. |
| Build proof and no-cost guarantees | Not established | No provider inference or Docker-backed build was attempted. No cost guarantee is claimed. |

## Risks and blockers

1. **Hermes tool scope:** bearer auth protects the API but does not by itself constrain the powerful toolset. Do not call the API with a read-only prompt until a verified tool allowlist and isolated workspace are in force.
2. **Provider-account usage:** existing local sign-in state is personal account material. Do not pass it into a web/API process or a shared service. Any future background run requires the supported provider authorization flow and explicit user consent.
3. **Claude automation policy:** subscription authentication exists on the machine, but this does not approve reuse by an app-owned unattended worker. Keep disabled until reviewed.
4. **Host infrastructure:** Docker socket access is denied. PostgreSQL Compose and DB integration cannot be validated until Docker permissions or an approved local PostgreSQL service are available.
5. **Repository baseline:** workspace was empty and had no `.git`, source documentation pack, or existing implementation to preserve. The initial documentation commit records the handoff before code is added.

## Owner decisions still needed

- Approve the technology/version proposals before production use.
- Approve the authentication and token ownership model, including whether Omnis OS will register a Sign in with ChatGPT integration.
- Approve the real runtime and documented tool permissions after isolated proof.
- Review Claude Team/Agent SDK terms and any background use before enabling it.
- Provide/approve Docker socket access or choose a supported PostgreSQL path.

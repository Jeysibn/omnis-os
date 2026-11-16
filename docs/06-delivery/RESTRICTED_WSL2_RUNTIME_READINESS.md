# Restricted WSL2 Runtime Readiness and Owner Acceptance Plan

**Status:** Source preparation only. No target-host operation is authorized by this document. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## 1. Baseline and evidence boundary

This package is prepared against merged `main` revision `ed5d647a35ffb80bfb579342cd25e04f31b6d83e` (PR #124). It describes the restricted, Authorizer-free, execution-disabled profile from `infra/compose/OPTION_A_INTEGRATION_READINESS.md` and the Compose contract in `infra/compose/README.md`. Repository history and source are inspectable here; this is not evidence from the owner's WSL2 daemon.

| Requirement | Current evidence | Target WSL2 evidence |
| --- | --- | --- |
| API and Worker lock | Source sets `OMNIS_RESTRICTED_DEVELOPMENT=true` and `OMNIS_EXECUTION_MODE=disabled`; backend contract and offline tests are documented in the Option A record. | Not tested. Inspect effective container configuration and capability response after separate authorization. |
| Service boundary | Static Compose verifier checks the restricted effective configuration: exactly PostgreSQL, API, Worker, Web; no Authorizer/launcher/Docker socket mounts; internal networks; loopback publication; non-root app identities and limits. | Not tested. Compare daemon inventory and actual created resources to the reviewed rendering. |
| Compose and project selection | `scripts/compose/restricted-compose.sh` fixes the three files and project `omnis-os-restricted-dev`; it validates approved env files and the selected context endpoint metadata. | Context name, Unix socket endpoint, and daemon identity have not been supplied or verified. |
| PostgreSQL identity | Pinned image digest is `postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`. Compose does not set `user`, capability restrictions, PID/CPU/memory bounds, or read-only rootfs. | Image metadata, initialization identity, steady-state UID, and effective container restrictions are unverified. |
| Database roles and migrations | Source provisions `omnis_migrator`, `omnis_runtime`, `omnis_authorizer`, and `omnis_launcher`; migration applies application schema and pg-boss metadata/grants. Neither is an automatic Compose startup action. | Not provisioned. Existing CLI scripts load fixed repository `.env.*` files; no approved restricted-only delivery path has been established. |
| Images and build inputs | Dockerfiles pin Node `24.22.1`, package manager `pnpm@12.16.1`, and use frozen lockfile installation. Registry/cache availability is unknown. | No image inventory or build/cache evidence collected. |
| CI | `.github/workflows/ci.yml` uses PR events (`opened`, `reopened`, `synchronize`, `ready_for_review`) and manual dispatch; no feature-branch `push` or `pull_request_target` trigger. | CI is hosted evidence only and does not establish WSL2 behavior. |
| Mock journey | PR #124 provides the combined synthetic owner-acceptance journey in disposable CI. | It is not restricted-profile or WSL2 acceptance. No mock execution is authorized here. |

No target Docker context, daemon identity, host inventory, secret, or database state was read during preparation. Earlier status reports and CI are not substitutes for fresh target evidence.

## 2. Exact proposed resource envelope

The following are proposed resource names and boundaries, not authorization or proof that a resource is fresh. The owner must approve the exact daemon, resources, parameters, operation window, and operator before any command is run.

| Resource | Proposed value / scope | Required precondition |
| --- | --- | --- |
| Host | Existing owner-managed WSL2 Ubuntu only; no Windows changes, extra VM, host service installation, or daemon configuration changes. | Owner identifies the WSL distro and confirms the Docker CLI/daemon arrangement. |
| Docker endpoint | Owner-supplied context name and exact local Unix-socket URI. Do not infer either from a previous machine or from a familiar context name. | Review `DOCKER_CONFIG`; ensure `DOCKER_HOST` and `DOCKER_CONTEXT` are unset; compare local context metadata to the owner-approved URI; independently identify the daemon using `docker info` metadata before lifecycle work. Metadata endpoint equality alone does not prove which daemon is behind a proxy. |
| Project | `omnis-os-restricted-dev`; explicit `--project-name omnis-os-restricted-dev` retained. | Confirm no existing resources with this project identity; wrong project names are a hard stop. Top-level Compose `name` does not override `-p`. |
| Services | Only `postgres`, `api`, `worker`, `web`. | Exact files, in order: `infra/compose/docker-compose.yml`, `infra/compose/docker-compose.app.yml`, `infra/compose/docker-compose.restricted-dev.yml`. Exclude CI and `docker-compose.mock-execution.yml`. |
| Database | `omnis_restricted_dev`; PostgreSQL user `omnis`; runtime role `omnis_runtime`; migration role `omnis_migrator`. | Database name/path must be unique across relevant launcher-managed Omnis databases. No existing database or volume may be adopted. Role provisioning still includes authorizer/launcher roles for preserved contracts. |
| Volume | New project-scoped logical volume `omnis-postgres-data`, rendered as `omnis-os-restricted-dev_omnis-postgres-data`. | Read-only daemon inventory must prove the exact volume is absent before first creation. Never reuse, rename, remove, or reset an existing volume. |
| Networks | Project-scoped internal `edge` and `data`. Web uses `edge`; Worker/PostgreSQL use `data`; API bridges both. | Inventory exact project network identities before creation. Network membership is not directional filtering and loopback binding is not Windows-origin enforcement. |
| Published ports | Web `127.0.0.1:${OMNIS_WEB_PORT:-8080}:8080`; PostgreSQL `127.0.0.1:${OMNIS_DB_PORT:-5432}:5432` from base Compose. API/Worker publish none. | Owner selects and checks free host ports; only loopback is allowed. Do not treat WSL localhost forwarding as ingress provenance. |
| Application identities/resources | API and Worker `10001:10001`; Web `10001:10001`; all drop capabilities, `no-new-privileges`, read-only rootfs, bounded PIDs/CPU/memory as in Compose. | Verify rendered config before any create and inspect actual runtime config afterward. No Docker socket, Authorizer socket, launcher socket, host bind, privileged mode, or additional service. |
| PostgreSQL resources | Image pinned by digest above; current Compose has no explicit CPU/memory/PID limits, cap drop, `no-new-privileges`, or read-only rootfs. | Owner selects limits; independent review must verify compatibility with the pinned image's initialization and steady-state behavior before service start. Do not force a UID or capability set based on assumptions. |
| Environment inputs | `restricted-compose.env`, `restricted-api.env`, `restricted-worker.env` in owner-selected private directory; preflight allowlists are in `infra/compose/README.md`. | Owner approves provenance and secret custody. Files are owner-owned private regular files, mode `0600` or stricter; inspect names/metadata and preflight result without printing contents. No actual secret was read or created. |
| Evidence | Sanitized operation log, exact context/daemon/resource IDs, image digests, effective config digest, health/capability fields, DB identity, and stop/cleanup observations. | Owner selects an access-controlled evidence location and retention period before execution; exclude credentials, environment values, raw secret-bearing inspect output, and unbounded logs. |

### Required restricted environment keys

Use the repository preflight's exact allowlists. Compose interpolation: `OMNIS_RESTRICTED_DB_NAME`, `OMNIS_DB_PASSWORD`, optional `OMNIS_WEB_PORT`, `OMNIS_RESTRICTED_API_ENV_FILE`, `OMNIS_RESTRICTED_WORKER_ENV_FILE`. API: `OMNIS_OWNER_PASSWORD_HASH`, `OMNIS_SESSION_SECRET`, `OMNIS_INTERNAL_TOKEN`, `OMNIS_ALLOWED_ORIGIN`, `OMNIS_SECURE_COOKIES`. Worker: `OMNIS_INTERNAL_TOKEN`, `OMNIS_RUNTIME_DB_PASSWORD`.

The restricted environment-file names are not a new credential store. Do not pass provider keys, Authorizer/launcher values, admin/migration credentials, generic application env files, or arbitrary shell overrides. `scripts/compose/restricted-compose.sh` is the only documented Compose entry point because it revalidates env files, removes exported `OMNIS_*`/`COMPOSE_*`, pins context/project/files, and limits command forms.

## 3. Mode-transition and inventory gate

Configuration changes do not terminate a prior mock-enabled Worker or its descendants. Before any transition to restricted mode, a separately authorized read-only inventory must:

1. Confirm the exact Docker context endpoint and daemon identity (name, daemon ID, server version, operating system/root directory metadata) and record UTC plus Asia/Manila observation time.
2. Inventory all daemon containers, projects, networks, volumes, and relevant images by IDs/names without inspecting environment values. Identify all Omnis/QA/backup/MoniKey and unrelated resources and mark them out of scope.
3. Identify every prior enabled Worker and execution consumer by exact container ID and effective mode evidence that does not disclose secrets. Identify exact synthetic fixture/workload IDs and map project/database URL pathname to launcher scope only from authoritative configuration/evidence.
4. Confirm each old enabled Worker and every descendant/fixture workload is stopped, then prove it absent or exited through authoritative process/daemon evidence. A changed Compose file, launcher shutdown, `--rm`, or Run status is insufficient. If scope mapping is ambiguous or any survivor is unknown, stop and quarantine; do not broaden cleanup.
5. Confirm the proposed project, volume, networks, database name, and ports are unused and do not select any existing resource. Any collision means stop and owner decision; do not rename or remove existing resources to proceed.

Inventory commands such as `docker --context "$CTX" info`, `ps -a`, `network ls`, `volume ls`, and `image ls` are future read-only examples only. They have not been run and still target a selected daemon, so the owner must separately authorize the exact context and read-only inventory scope. Never run `docker inspect` with unfiltered environment output or print `docker compose config` output containing values.

## 4. Future operation sequence and boundaries

Every row below requires a separate, explicit owner authorization covering the context, project, resources, operator, time window, and evidence retention. The command fragments are templates for that later authorization; none has been executed. The wrapper currently permits only the listed Compose operations. Database tooling has a separate unresolved input-path dependency described below.

| Order / operation | Purpose and exact target | Prerequisites and expected evidence | Stop / rollback rule |
| --- | --- | --- | --- |
| 0. Static preflight (`node scripts/compose/verify-app-config.mjs`; `node scripts/compose/verify-restricted-env.mjs ...`) | Validate Compose and owner-created restricted env files without starting services. | This offline source check is permitted now; real env-file preflight only after owner provisions files. It prints no secret values. | Any unknown key, path, duplicate, mismatch, unsafe mode, override, or rendered-profile error fails closed. Do not display raw rendered config. |
| 1. Context check and inventory | Read exact owner-selected daemon metadata and all relevant resource IDs. No resource mutation. | Separate read-only inventory authorization; expected context URI and daemon ID are owner supplied; verify project/volume/network/DB/port absence and prior mock consumers. | Endpoint/daemon mismatch, pre-existing candidate resource, enabled Worker, unknown workload, or ambiguous scope: stop. No cleanup. |
| 2. Compose configuration (`restricted-compose.sh ... config --quiet`) | Render only the 3 restricted files under project `omnis-os-restricted-dev`. | Approved env files and context metadata; expected only four services, exact DB/volume/network names, loopback ports, disabled API/Worker. Do not capture values. | Any unexpected service/mount/port/name/mode or wrapper failure: stop; no create. |
| 3. PostgreSQL image availability | Confirm the exact pinned image digest is already present, or decide separately whether a pull/build is authorized. | Read-only image inventory. No `pull` is in the wrapper. A missing image blocks startup unless a separate exact image-pull authorization is granted. | Do not substitute tag/digest or pull implicitly. |
| 4. Start PostgreSQL only (`up --no-build --pull never -d postgres`) | Create/start only the named project's PostgreSQL service and its new volume/network. | Exact new project/volume identity, free loopback DB port, approved image already present, owner-approved DB password file, approved PG limits and identity review. Verify container ID, project labels, image digest, mount/network/port, health, process identity, and resource settings. | Any mismatch, unhealthy service, wrong image/volume/port/identity, or missing evidence: stop exact project services and preserve the volume. Do not reset or delete data. |
| 5. Provision roles (currently blocked) | Create/update role ownership/grants on `omnis_restricted_dev` for existing role contract, including `omnis_migrator` and `omnis_runtime`. | Requires separate database-mutation grant and safe restricted-only secret delivery. `pnpm db:roles` hard-codes `.env.worker`, `.env.authorizer`, `.env.sandbox-launcher`, `.env.migration`, `.env.db-admin`; code requires four role passwords and its default admin target can be `omnis`. No approved method presently proves those fixed files belong solely to the fresh restricted project. | Do not run current command against shared/default files. Block until an independently reviewed safe env-delivery path and exact target assertion are available. Failure means stop and retain the volume for review; no role/database reset. |
| 6. Migrations (currently blocked pending same prerequisite) | Apply schema migrations and initialize pg-boss schema/queue metadata/grants using `omnis_migrator` against the exact DB. | Separate migration authorization after successful role provisioning; exact `OMNIS_MIGRATION_DATABASE_URL` must select host `postgres`/loopback, user `omnis_migrator`, database `omnis_restricted_dev`; inspect target identity read-only before mutation. Current package command loads fixed `.env.migration`; its migration fallback selects database `omnis` and starts PgBoss migration/queue setup. | Missing/mismatched URL, role, DB, or uncertain partial migration: do not retry, drop, recreate, or remove volume. Preserve and classify inconclusive. |
| 7. Build API/Worker/Web (if needed) (`build api worker web`) | Build only application images in the exact project configuration; builds may use registry/network. | Separate build/registry authorization; Node `24.22.1`, pnpm `12.16.1`, frozen lock; approved source revision and cache/network disclosure. | Missing dependencies or unexpected network access: stop; no unapproved pull or dependency installation. |
| 8. Start application services (`up --no-build --pull never -d api worker web`) | Start only API, Worker, Web after DB initialization and images are ready. | Steps 0–7 complete, exact old-consumer stop proof, fresh DB/roles/migrations, same disabled lock on API/Worker, loopback port availability, startup authorization. | Any mode mismatch, queue/launcher activity, unexpected mount/network/provider setting, auth failure, or health/capability inconsistency: stop exact services and retain DB volume. Do not enable mock mode to troubleshoot. |
| 9. Verify and stop (`ps --all`; bounded `stop api worker web postgres`) | Record project-scoped state and stop these exact four services, preserving the volume. | Runtime acceptance below; separate stop authorization and bounded evidence procedure. | Stop timeout or survivor: escalate to recovery contact; do not kill arbitrary PIDs or remove resources. Volume deletion is excluded and requires a later exact-resource grant. |

No `docker compose down --volumes`, `docker system prune`, `docker volume rm`, broad `kill`, Windows `wsl --shutdown`, Docker daemon restart, or global revoke/delete is part of this plan. The current wrapper intentionally offers no destructive cleanup operation. If stop cannot terminate a service, isolate through the exact Docker project authority and contact the owner; any forced termination must be separately authorized against exact IDs.

## 5. PostgreSQL provisioning and recovery boundary

Intended order is: create a fresh project-scoped PostgreSQL volume; wait for PostgreSQL health; provision the existing role contract with the administrative connection; verify `current_database()`/`current_user` read-only; apply migrations as `omnis_migrator`; verify migration ledger and database identity; only then start API/Worker/Web. No DB operation runs automatically as a Compose service command.

The current `db:roles` script invokes Node with fixed repository env-file paths and provisions passwords for `omnis_migrator`, `omnis_runtime`, `omnis_authorizer`, and `omnis_launcher`. The current `db:migrate` script invokes `apps/worker/src/migrate.ts` with fixed `.env.migration`; if `OMNIS_MIGRATION_DATABASE_URL` is absent it falls back to `127.0.0.1:5432/omnis`, not `omnis_restricted_dev`. Therefore there is no safe executable command sequence in this package for database setup. Do not copy existing `.env.*`, place credentials in command arguments, or rely on environment overrides while shared env files can supply competing values. A future narrowly scoped environment-delivery change needs Codex #1 review and independent platform review before DB authorization.

The existing migration runner is not transactional as a whole: it applies ordered/checksummed app migrations, starts PgBoss migration/queue setup, then grants pg-boss access. On a partial failure, retain the exact volume and collect sanitized failure evidence; do not infer rollback or retry blindly. A fresh project volume and a reviewed recovery/backup choice are prerequisites. No local DB content was read.

PostgreSQL currently relies on pinned image defaults for startup/runtime UID and privileges. Before startup, require image metadata and an independent compatibility decision for initialization-time root behavior, steady-state `postgres` UID, capabilities, read-only-rootfs feasibility, and numeric CPU/memory/PID bounds. No UID or limits are invented here.

## 6. Runtime acceptance matrix — procedure only

All checks require separately authorized startup. Failure, unavailable evidence, or ambiguity is **FAIL / INCONCLUSIVE**, never pass.

| Check | Expected observation / evidence | Pass condition | Failure or stop condition |
| --- | --- | --- | --- |
| Reproducible configuration | Source SHA, Compose file list/order, environment file names and digest metadata (not values), image digest, context/daemon ID, effective service/resource IDs. | All bind to the approved source, exact project, and approved immutable inputs. | Any drift or missing identity. |
| Infrastructure readiness | `ps --all`; four expected services only; PostgreSQL healthy; API/Worker/Web health endpoints; exact network/volume/port membership. | Health means liveness only; all four are in exact project and only Web/PostgreSQL have approved loopback ports. | Extra service, non-loopback publication, wrong resource, or health timeout. |
| Owner authentication | Login with owner-selected local credential; retain status and non-secret session proof only. | Authenticated owner session succeeds; no secret value in evidence. | Invalid session, exposed credential, or unexpected redirect/auth bypass. |
| Historical reads | Authenticated task/run list/detail using existing data only; no Task/Run creation. | Permitted reads succeed and do not mutate state. If a fresh DB has no records, mark this check **NOT EXERCISED**; do not seed data under this grant. | Unexpected state change or unauthorized disclosure. |
| SSE replay/reconnect | Open the supported historical event stream and exercise replay/reconnect without Run creation. | Existing ordered events replay; reconnect does not create events or receipts. If there is no existing event fixture, mark **NOT EXERCISED**; do not create one. | Mutation, duplicate, missing security checks, or no bounded proof. |
| Capability schema | Owner-authenticated capability endpoint and schema `omnis.runtime-capabilities.v3`. | API and Worker agree: execution disabled, authorization unavailable, queue and launcher not required. | Missing schema, mismatch, or any availability claim. |
| API/Worker lock | Effective config plus capability response; do not print secret env. | Both have literal restricted `true` and execution `disabled`. | Mismatch, inherited mock setting, or uncertain old Worker. |
| Run admission | Authenticated/CSRF-valid direct request using a non-mutating test fixture only if the backend route contract defines one; preserve request/response and compare DB state. | `503 execution_disabled` before mutation. No new Run, queue item, or event. | Any accepted/mutated Run; missing evidence. Do not retry. |
| Run stop | Only an already eligible approved disposable fixture, if separately authorized; verify no pre-mutation state change. | `503 execution_disabled` before mutation, per backend contract. | Any mutation or fixture not proven eligible; do not fabricate one for this restricted startup. |
| Authorizer-dependent actions | Authenticated and security-precondition-valid request to a documented operation. | `503 authorizer_unavailable` after required authentication/ACL/CSRF checks; no socket attempt or state mutation. | Auth bypass, mutation, socket access, or ambiguous route-specific expectation. |
| Queue/launcher/provider absence | Worker startup evidence, non-secret capability response, process/service/network inventory. | No PgBoss consumer, recovery execution, launcher initialization, agent, provider, synthetic Run, or external account activity. | Any consumer, launcher/provider process, egress/use, or unknown descendant. |
| API/Worker mode conflict | Offline negative configuration test is preferred; do not deliberately start a mismatched live pair on owner host. | Static verifier rejects conflict and source contract fails closed. | Runtime mismatch that reports execution available; stop services. |
| Persistence/restart | Only if separately authorized: stop/start the same exact non-destructive service set without volume removal; compare DB identity and known prior records. | Existing database identity/rows persist and no queue recovery/execution occurs. | Any data loss, different volume, unexpected replay, or uncertain service identity. |
| Termination and cleanup | Bounded stop evidence and fresh daemon inventory by exact IDs; verify all app/DB processes exited. | Exact four services stopped; volume and unrelated resources remain intact. | Timeout, survivor, changed unrelated resource, or missing evidence. Preserve volume and escalate. |

The restricted profile is for read-only/history validation. Do not create a Task or Run, accept results, activate a mock agent, or call a provider during this exercise. PR #124's disposable CI journey remains separate evidence and does not authorize this host activity.

## 7. Evidence, incident response, and retention

Before operations, owner must name an operator, authorization window, recovery contact, evidence location, and retention period. Capture:

- Source commit, script versions, Compose file order, sanitized `config --quiet` result, env-file names/mode/owner and preflight verdict (never contents or values).
- Docker context endpoint metadata, daemon ID/name/version/OS, and exact container/image/network/volume IDs before and after.
- Image digests and PostgreSQL image `Config.User`; actual service user, capability/security options, resource limits, mounts, networks, and port bindings.
- Health status, non-secret capability JSON fields, expected HTTP statuses, bounded sanitized logs, request identifiers only where non-sensitive, DB identity (`current_database`, `current_user`) and migration head without row data.
- Prior enabled Worker and fixture inventory, exit status, descendant/daemon workload absence, restart-denial result, and final service/volume state.

Use time-bounded evidence with access controls. Redact tokens, passwords, password hashes, database URLs, cookies, owner session material, full env dumps, and request bodies. If a secret appears, stop collection, restrict access, inform the recovery contact, and follow owner incident response; do not paste it into chat, tickets, or CI artifacts. Any unexpected provider contact, execution, listener exposure, mode disagreement, unknown workload, resource collision, data mutation, or evidence leakage requires immediate stop and owner notification. Do not attempt an improvised cleanup.

## 8. Future mock-only topology feasibility

This matrix is a platform handoff, not an architecture decision. Codex #1 owns the security design and execution authorization contract.

| Candidate | Source evidence / security consequence | Status |
| --- | --- | --- |
| Existing host-managed launcher plus Compose Worker UDS | Current mock overlay grants the Worker a launcher UDS mount; repository ADRs treat the host launcher and Docker authority as trusted privileged boundaries. Rootful Docker socket access is effectively host-root-equivalent. API/Worker must never receive the Docker socket. | Existing hybrid design; no activation or target-host acceptance in this task. |
| Raw Docker socket in API or Worker | Would grant broad daemon authority and collapse the application/host boundary. ADR-0012 explicitly excludes it. | Rejected for ordinary application services. |
| Docker-in-Docker / privileged app service | Adds privileged nested daemon and weakens the current restricted application boundary; not established by reviewed repository contracts. | Not proposed; requires a new independent architecture/security decision. |
| Separate rootless Core/Runtime daemons and policy gateway | `P0_R2_2_ROOTLESS_HARNESS_IMPLEMENTATION_PLAN.md` describes a candidate with disjoint UIDs/data roots/sockets and a narrow gateway. Its identity, supervisor, deadline, rollback/anchor, ingress, and cleanup properties are not established by this restricted Compose profile. | Future research/design only; Codex #1 review and separate authorization required. |
| Rootful isolated VM/daemon | Provides a possible disposable host boundary but remains dependent on host/hypervisor trust, daemon identity, bounded resources, network policy, and exact termination proof. Stage B evidence would not establish WSL2 equivalence. | Separate feasibility and grant; not authorized here. |

Rootful Docker context selection is a major trust boundary: anyone able to control the daemon can generally create containers, mount host paths, and alter workloads. Keep daemon authority with the owner/operator; do not delegate its socket to Omnis API/Worker or treat loopback publication as a host ingress control. Any topology, socket, identity, or termination change belongs to Codex #1's review before implementation.

## 9. Owner decisions and pre-start checklist

No active testing may begin until all items are supplied and separately approved:

1. **Context/daemon:** WSL distro, Docker context, exact Unix-socket URI, daemon ID/identity evidence, `DOCKER_CONFIG` custody, operator, and authorization window.
2. **Scope:** exact four service names, three Compose files and order, project `omnis-os-restricted-dev`, DB `omnis_restricted_dev`, new project volume/networks, loopback ports, and explicit exclusion of mock/CI overlays.
3. **Inventory:** permission for read-only daemon-wide inventory; written inventory of existing Workers/consumers and exact fixture IDs; proof all old enabled consumers/descendants are stopped; proof candidate names/ports are unused.
4. **Environment:** approved secret source and private directory; three restricted file names, owner/mode, allowlist preflight; owner-authentication mechanism; internal token; no provider, Authorizer, launcher, or admin/migration secrets in app files.
5. **Images/resources:** image-cache evidence or separate pull/build grant; source revision; selected PostgreSQL CPU/memory/PID bounds and reviewed identity/capability compatibility; port availability.
6. **Database:** fresh volume/database proof; separate owner grant for provisioning/migration; a reviewed restricted-only credential delivery mechanism replacing current shared fixed `.env.*` dependency; exact admin and migration endpoints/roles; backup/recovery choice. This is a current hard blocker.
7. **Verification:** independent review of final source/effective config and operation-specific plan; acceptance criteria and test fixtures constrained to read-only existing data; no mock or provider activity.
8. **Stop/evidence:** exact bounded stop scope, escalation contact, evidence location/retention, incident procedure, volume preservation, and explicit statement that cleanup/deletion of the volume is not included.

The owner must separately authorize read-only inventory, image builds/pulls, fresh PostgreSQL creation, role provisioning, migration, application startup, restart, shutdown, evidence retention, and any later exact-resource cleanup. Authorization for one does not imply authorization for the others. No Stage C, Stage D, Mission 9D, provider execution, deployment, Windows ingress acceptance, or R1 acceptance follows from this package.

## 10. Validation performed for this package

The document is a source-level plan. `node scripts/compose/verify-app-config.mjs` passed; `node --test scripts/compose/*.test.mjs` passed all 14 tests; `git diff --check` passed; and the normal pre-commit hook passed the full `pnpm check` suite (format, lint, typecheck, and tests). The hook reused 214 packages from the local pnpm store with zero downloads. Docker Compose CLI reports `v5.6.1`; no daemon command was run. The repository's pinned Node version is available (`v24.22.1`). No Docker daemon, container lifecycle, image, database, credential, provider, WSL host, or Windows operation is part of this preparation. A passing static verifier is not runtime acceptance.

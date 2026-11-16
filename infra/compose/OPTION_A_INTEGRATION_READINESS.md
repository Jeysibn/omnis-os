# Option A Authorizer-Free Restricted Docker Integration

## Status and evidence boundary

This records source-level platform integration against backend commit `14399b4ed0e663d0d51e7d6822b9ec5bee1fee30` (parent `e589b35f4538f956253ff17df194833b0f783496`), descended from the previous platform baseline `4c20cd631d2d74cc2cb26bfadabbdb63ef88b11a`. The required commit was locally accessible. This work does not authorize builds, database changes, or application startup, and makes no runtime claims. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Pull-request CI contract

The repository has one CI workflow, `.github/workflows/ci.yml`. It runs on pull request `opened`, `reopened`, `synchronize`, and `ready_for_review` events, plus the existing manual `workflow_dispatch` full-validation control. It has no `push` or `pull_request_target` trigger. A regression test lives under the repository's existing `scripts/ci/*.test.mjs` test glob. Existing validation jobs and their selection conditions are unchanged.

Read-only inspection on 2026-11-16 found the active `main` ruleset requires a pull request and strict-up-to-date status checks named `checks` and `frontend-browser`; those job IDs are unchanged. The ruleset currently requires zero approving reviews and does not require CODEOWNERS review. This change preserves that ruleset; independent security review remains a project gate, not a GitHub-enforced approval requirement. The old default-branch workflow remains active until the trigger change merges. A push to this feature branch does not match its current `main` or `security/post-audit-remediation` push filters.

The platform branch is based on the reviewed backend commit and therefore includes the preceding execution-disabled API/Worker contract and frontend capability-display/gating commits. Codex #1 confirmed these are intentional prerequisites for one coherent restricted-mode milestone, rather than unrelated frontend history.

Integration worktree: `/home/jeysi/projects/omnis-os-option-a-14399b-integration`, branch `codex/option-a-compose-14399b-integration`, based exactly on the required backend SHA. The original platform worktree `/home/jeysi/projects/omnis-os-docker-restricted` was left unchanged. Eight tracked platform files transferred with a cleanly applicable patch (SHA256 `4e7c544fcc892c9e8c7a3167565df0df66c04849f62f91b61cffc44179681079`); the two platform-owned untracked files were copied and hash-verified before editing. The platform patch transferred no frontend or delivery-matrix files; frontend capability-display/gating commits are present in the reviewed backend ancestry as necessary disabled-mode prerequisites.

## Backend source contract

Inspection of the exact backend commit found:

- `packages/contracts/src/execution-mode.ts` requires literal `OMNIS_RESTRICTED_DEVELOPMENT=true` and `OMNIS_EXECUTION_MODE=disabled`. Unknown lock values, non-disabled mode, and non-empty Authorizer or launcher settings fail startup.
- API restricted startup accepts absent/empty Authorizer token and socket. Run admission and stop respond `503 execution_disabled` after owner/CSRF checks and before mutation. Authorizer-backed operations respond `503 authorizer_unavailable` after their required security checks.
- Worker disabled startup does not initialize PgBoss consumers, launcher execution, or recovery. Process-local mode locking does not stop older mock-enabled Workers globally.
- Runtime capabilities use `omnis.runtime-capabilities.v3`; consistent disabled mode reports execution disabled, authorization unavailable, and queue/launcher `not_required`. Mismatched API/Worker modes cannot report execution available.
- Backend unit tests exist for execution-mode validation, API environment, Authorizer route guards, Run admission/stop, runtime capabilities, and Worker execution readiness. They passed in the repository's normal pre-commit check at platform revision `ea547466f1364c369a9c8b05af038ad99a87e9b6` and in the hosted `checks-core` job recorded below.

## Integrated platform delta

The restricted Compose files are exactly `docker-compose.yml`, `docker-compose.app.yml`, and `docker-compose.restricted-dev.yml`, with default project `omnis-os-restricted-dev` and database `omnis_restricted_dev`. The overlay sets a top-level project name, but `-p` and `COMPOSE_PROJECT_NAME` can override it; all operational examples retain the explicit project flag. The verifier checks the default, intended explicit selection, and rejects incorrect CLI/environment selections. It also verifies the resulting networks and volume use that project prefix. It cannot determine whether those exact resources already exist on a Docker daemon.

The restricted overlay explicitly sets the lock and disabled mode for API and Worker. It selects required `OMNIS_RESTRICTED_API_ENV_FILE` and `OMNIS_RESTRICTED_WORKER_ENV_FILE` paths with `env_file: !override`, clears inherited Authorizer and launcher values, removes API's inherited Authorizer socket mount and supplemental group, and declares no Authorizer, launcher, or Docker-socket service/mount. Owner authentication and API-to-Worker internal-token settings remain in the restricted env files. Non-root application identities, resource limits, internal networks, loopback-only publication, and project-scoped PostgreSQL volume remain. The base and mock profile env-file configuration remains unchanged.

The mock overlay is rendered separately without the restricted overlay and retains its original API Authorizer socket and Worker launcher socket dependencies. The restricted profile does not select it. Compose profiles are selection aids, not security authorization.

Restricted Compose interpolation allowlist: `OMNIS_RESTRICTED_DB_NAME`, `OMNIS_DB_PASSWORD`, optional `OMNIS_WEB_PORT`, `OMNIS_RESTRICTED_API_ENV_FILE`, and `OMNIS_RESTRICTED_WORKER_ENV_FILE`. Restricted API env allowlist: `OMNIS_OWNER_PASSWORD_HASH`, `OMNIS_SESSION_SECRET`, `OMNIS_INTERNAL_TOKEN`, `OMNIS_ALLOWED_ORIGIN`, `OMNIS_SECURE_COOKIES`. Restricted Worker env allowlist: `OMNIS_INTERNAL_TOKEN`, `OMNIS_RUNTIME_DB_PASSWORD`. All other variable names are rejected, including provider keys, Authorizer/launcher settings, admin database credentials, and migration credentials. The Compose DB password is supplied only to PostgreSQL. API/Worker env-file paths must be absolute literal paths without `$`, preventing Compose interpolation from redirecting to a different, unvalidated file. Preflight also checks syntax, duplicates, required values, secret formats, loopback origin, matching API/Worker internal tokens, matching env-file paths, and private regular-file ownership/mode. Error messages do not include values. The generated `.env` and `.env.worker` files from `pnpm configure:owner` contain disallowed keys and cannot be used directly. Owner-approved restricted files must be prepared separately; no credentials were created or read by this work.

The required file names are `restricted-compose.env`, `restricted-api.env`, and `restricted-worker.env` in an owner-selected private directory. They must be regular files owned by the current WSL user with mode `0600` or stricter. The compose file stores the PostgreSQL initialization password and paths to the two app env files; API/Worker files carry only the allowlisted values above. The owner must approve the file sources and secret custody separately. The preflight is not a secret store or a replacement credential architecture.

## Static verification

`scripts/compose/verify-app-config.mjs` renders the restricted and mock configurations separately and inspects effective Compose JSON. Synthetic allowlisted Compose/API/Worker env files pass the restricted preflight; synthetic provider, Authorizer, launcher, admin/migration database, unknown, and malformed settings fail without value disclosure. A mismatched internal token and group/world-readable env file also fail. Rendering checks the restricted lock/mode, empty sensitive settings, empty API volumes/groups, absent launcher/Docker mounts, exact four services, non-root identities, resource limits, ports, project/network/volume/database scope, and owner/internal-token configuration. It verifies project selection with no CLI flag, the intended flag, an incorrect `-p`, and an incorrect `COMPOSE_PROJECT_NAME`. Ambient execution-mode overrides and hostile `COMPOSE_FILE`/profile values are also set during rendering. Mock rendering verifies the base project default and separate Authorizer/launcher socket mounts remain.

This validation establishes static configuration only. It does not contact the Docker daemon, start services, provision a database, or prove runtime identity, host ingress, process termination, migration safety, or recovery.

## Hosted CI evidence and journey coverage

The earlier pull-request run [43800489386](https://github.com/Jeysibn/omnis-os/actions/runs/43800489386) tested platform revision `ea547466f1364c369a9c8b05af038ad99a87e9b6` and completed successfully. The final source revision `5837462e5e1037d54464acb059e139b1d4eb1bb6` passed pull-request run [43802613033](https://github.com/Jeysibn/omnis-os/actions/runs/43802613033): `checks`, `checks-core`, `frontend-browser`, `platform-security`, both database integration jobs, `backup-restore`, `full-stack-browser-integration`, and `container-images` all passed. Both are GitHub-hosted CI evidence; neither is a WSL2 startup or restricted-profile runtime result.

A prior container job failure was traced to a fixture permission gap: the non-root Worker could not traverse the synthetic launcher socket directory because the CI overlay omitted its supplemental fixture group. `docker-compose.ci.yml` now adds only `OMNIS_LAUNCHER_SOCKET_GID` to that CI Worker, and the smoke asserts the effective group list from rendered Compose configuration. The exact change passed independent platform review and the `container-images` jobs in both runs above. The restricted development profile and mock-execution overlay are unchanged by this CI-only permission.

The final revision also includes bounded launcher-failure diagnostics. The launcher logs allowlisted executor error codes through its request logger; the parser correlates them only with exact POST `/internal/v1/mock-executions` request and completion records. It accepts bounded string or safe integer request IDs, invalidates signals for duplicate/reused IDs, and outputs only allowlisted error codes and HTTP status numbers. The three focused parser tests and normal pre-commit suite passed, and this code is included in final run `43802613033`. It does not expose request IDs, payloads, or credential values.

The hosted tests cover related stages through two separate synthetic paths:

| Journey stage | Evidence | Result |
| --- | --- | --- |
| Create and assign a Task | Compose browser smoke creates the Task and assignment in `apps/web/integration/tasks.integration.spec.ts` | Verified in CI |
| Execute a mock agent Run | The same Compose smoke approves the mock Run and verifies completion plus ordered `synthetic=true`, `source=mock` events | Verified in CI |
| Await owner review | The full-stack synthetic-broker browser journey verifies the completed Task enters `in_review` and shows the owner review state | Verified in CI |
| Accept the result | That separate synthetic-broker journey records explicit owner acceptance and checks the durable receipt and replay | Verified in CI |
| Complete the accepted Task | The synthetic-broker journey verifies the accepted Task is `completed` and the receipt survives reload | Verified in CI |
| Complete one sandbox-launcher Run through owner acceptance | The launcher mock path and synthetic-broker acceptance path are separate tests and do not prove this one combined journey | Partial / not established |
| Run the restricted execution-disabled profile | No restricted-profile services were started; the CI Compose smoke uses the separately gated mock profile | Blocked pending separate owner authorization and runtime evidence |
| Accept the target WSL2 runtime | No WSL2 startup, ingress, or runtime verification occurred | Blocked pending separate owner authorization and runtime evidence |
| Exercise a real provider | No provider credentials or services were used | Excluded; requires a later separate owner authorization |

These results are test evidence, not Phase 1 acceptance. The canonical [Phase 1 completion matrix](../../docs/06-delivery/PHASE_1_COMPLETION_MATRIX.md) remains authoritative for acceptance status; this readiness document does not modify its AO rows, mark Stage B authorized, or change R1 from **BLOCKED / NOT ACCEPTED**. The request-ID diagnostic hardening is not represented in earlier run `43800489386`; it is included in final run `43802613033`.

## PostgreSQL initialization plan — not executed

Use only a new volume rendered for project `omnis-os-restricted-dev` (`omnis-os-restricted-dev_omnis-postgres-data`) and database `omnis_restricted_dev`. Before startup, a separately authorized, read-only inventory must establish that this exact project volume is fresh and that the published host port is available. Do not select, rename, or clean up existing Omnis, QA, backup, or MoniKey resources.

The current `pnpm db:roles` path calls `packages/db/src/provision-roles.ts` with an administrative connection and requires passwords for `omnis_migrator`, `omnis_runtime`, `omnis_authorizer`, and `omnis_launcher`. It changes roles, membership, object ownership, schemas, privileges, and grants. Its target check accepts Omnis database names, so the operator must independently verify `current_database()` equals exactly `omnis_restricted_dev` before allowing it to mutate anything. Retain the Authorizer and launcher role contracts for future mock execution unless Codex #1 separately reviews a change; their presence does not mean those services run in Option A.

Only after role provisioning succeeds, run `pnpm db:migrate` with `OMNIS_MIGRATION_DATABASE_URL` targeting the same database as `omnis_migrator`. The migration path applies application schema migrations and initializes pg-boss schema/queue metadata and runtime grants. Option A's disabled Worker must not start consumers or recovery; migration setup is an explicit one-time administrative step, not an application startup side effect.

The launcher derives its scope from the database URL pathname alone. Before any later mock transition, compare this database name against every relevant launcher-managed Omnis database; duplicate or unknown mappings stop the operation. Project-name uniqueness does not prove launcher-scope uniqueness.

If role provisioning or migration fails, stop the exact project and retain its volume for review. Do not retry against an uncertain partial database, drop/recreate the database, remove the volume, or run broad cleanup without a separate owner decision and exact-resource authorization. No rollback behavior is assumed by this plan.

## First owner-authorized startup and verification sequence

Every command below is a future planning template. None has been run. Before any of them, this exact backend integration must pass the relevant offline checks and independent platform review; owner-provided environment files must be reviewed without exposing values; all existing enabled Workers must be inventoried; and each build/database/lifecycle operation must be separately authorized.

Use only these files, in this order, and the exact project name:

```sh
: "${OMNIS_RESTRICTED_COMPOSE_ENV:?Set the owner-approved restricted Compose env-file path}"
: "${OMNIS_RESTRICTED_API_ENV_FILE:?Set the owner-approved restricted API env-file path}"
: "${OMNIS_RESTRICTED_WORKER_ENV_FILE:?Set the owner-approved restricted Worker env-file path}"
node scripts/compose/verify-restricted-env.mjs \
  --compose-env "$OMNIS_RESTRICTED_COMPOSE_ENV" \
  --api-env "$OMNIS_RESTRICTED_API_ENV_FILE" \
  --worker-env "$OMNIS_RESTRICTED_WORKER_ENV_FILE"
restricted_compose_env_file=$OMNIS_RESTRICTED_COMPOSE_ENV
restricted_api_env_file=$OMNIS_RESTRICTED_API_ENV_FILE
restricted_worker_env_file=$OMNIS_RESTRICTED_WORKER_ENV_FILE
scripts/compose/restricted-compose.sh \
  "$restricted_compose_env_file" "$restricted_api_env_file" "$restricted_worker_env_file" \
  config --quiet
```

Use `scripts/compose/restricted-compose.sh` for every restricted Compose command below. Pass the exact Compose, API, and Worker env-file paths each time; the wrapper reruns the value-free allowlist preflight immediately before every Compose invocation, clears exported `OMNIS_*` and `COMPOSE_*` variables, fixes the explicit project name and exact file list, and rejects every command/argument sequence outside the documented allowlist. The explicit project name remains an additional safeguard. The verifier tests the wrapper with a stub `docker` executable and confirms hostile flags are rejected before any Docker invocation. The wrapper does not choose or verify the Docker daemon: it inherits `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, and active Docker CLI context selection. Immediately before each separately authorized invocation, in the same shell, the owner must read-only verify and record those values, the active context, and its endpoint, and confirm they identify the intended local WSL2 Docker Engine. If any value or context can change between verification and invocation, stop and reverify; no remote or Windows host is authorized by this plan. Expected: configuration validation exits successfully, with no output containing secrets. The mock and CI overlays are excluded. Before proceeding, owner-authorized resource inventory must confirm that the exact project, volume, database name, and loopback ports do not select or conflict with existing workloads.

After separate database and image-build authorizations, the proposed sequence is:

```sh
scripts/compose/restricted-compose.sh \
  "$restricted_compose_env_file" "$restricted_api_env_file" "$restricted_worker_env_file" \
  up --no-build --pull never -d postgres

# Separately authorized database mutations; both URLs must name the fresh DB.
# The fixed .env.* inputs consumed by these package scripts must first be
# owner-approved restricted-project files, not shared existing app files.
: "${OMNIS_RESTRICTED_ADMIN_DATABASE_URL:?Set the owner-approved restricted admin URL}"
: "${OMNIS_RESTRICTED_MIGRATION_DATABASE_URL:?Set the owner-approved restricted migration URL}"
OMNIS_DB_NAME=omnis_restricted_dev \
OMNIS_ADMIN_DATABASE_URL="$OMNIS_RESTRICTED_ADMIN_DATABASE_URL" \
  pnpm db:roles

OMNIS_DB_NAME=omnis_restricted_dev \
OMNIS_MIGRATION_DATABASE_URL="$OMNIS_RESTRICTED_MIGRATION_DATABASE_URL" \
  pnpm db:migrate

# Image builds require separate authorization and may use registries.
scripts/compose/restricted-compose.sh \
  "$restricted_compose_env_file" "$restricted_api_env_file" "$restricted_worker_env_file" \
  build api worker web

# Start only after all backend, database, and owner gates above pass.
scripts/compose/restricted-compose.sh \
  "$restricted_compose_env_file" "$restricted_api_env_file" "$restricted_worker_env_file" \
  up --no-build --pull never -d api worker web
```

The protected environment file and its source are owner-selected; the variable names above are placeholders, not credentials or pre-approved secret paths. `up --no-build --pull never` must fail closed if the pinned PostgreSQL image or previously built app images are absent; any image pull requires separate authorization, and startup cannot trigger an implicit build. Shell guards prevent empty or unset connection URLs from falling back to the default `omnis` database. Database commands must use newly provisioned role secrets loaded only from restricted-project protected env files. The current `pnpm db:roles` and `pnpm db:migrate` scripts load fixed repository `.env.*` paths; verify those are restricted-only inputs or stop until a separately reviewed env-delivery method exists. Verify both actual connection targets read-only before mutation. No Run or synthetic workflow is part of this startup.

Expected verification, after startup is separately authorized:

| Area | Evidence and expected result |
| --- | --- |
| Infrastructure | `scripts/compose/restricted-compose.sh "$restricted_compose_env_file" "$restricted_api_env_file" "$restricted_worker_env_file" ps --all` lists only `postgres`, `api`, `worker`, `web` under the exact project. Separately inventory daemon-managed sandbox workloads only by an independently verified database-derived scope and exact fixture IDs. API and Worker are UID/GID `10001:10001`; verify PostgreSQL process identity against the pinned image and actual runtime. No Authorizer, launcher, socket bind, Docker socket, unexpected mount, public port, or external resource exists in the restricted model. |
| Database | PostgreSQL readiness succeeds for `omnis_restricted_dev`; role and migration connections report the exact database and intended role. Existing project volumes remain untouched. |
| Backend | API starts without usable Authorizer environment/socket dependencies under the exact backend contract. Worker reports disabled and healthy. No queue consumer, queue recovery, launcher client, or automatic Run replay starts. API and Worker capability fields match the reviewed contract; liveness alone is insufficient. |
| Frontend | Owner login succeeds. Only contract-permitted read-only/history features work. UI visibly reports execution disabled. Approval and Run controls are blocked, and no response or UI state implies a successful execution. |
| Security | Direct Run/admission/approval requests fail closed. Owner authentication, ACL, and CSRF protections remain enforced. Authorizer-dependent mutations return the contract-defined unavailable result without socket attempts. Existing enabled Workers and their descendants are independently confirmed stopped before any mode transition. No real-provider or synthetic execution occurs. |

Capture only bounded, sanitized logs, non-secret capability fields, service identities, exact resource IDs, and database identity evidence under a separately approved retention period. If evidence is missing, contradictory, or ambiguous, stop and classify the result as inconclusive; do not retry Runs or clean up unrelated resources. For shutdown, stop only `api worker web postgres` under `omnis-os-restricted-dev`; preserve the volume. Volume destruction requires a later, exact-resource owner authorization.

## Dependencies and gates

| Work item | State |
| --- | --- |
| Required backend revision `14399b4ed0e663d0d51e7d6822b9ec5bee1fee30` | Available locally and used as exact integration baseline |
| Restricted Compose lock/mode and Authorizer/launcher removal | Implemented in this worktree; static configuration only |
| Mock overlay and its Authorizer/launcher requirements | Preserved separately; no mock execution authorized |
| Static Compose verifier | Updated; latest run passed offline |
| Backend source behavior | Source-confirmed against the exact SHA; relevant tests passed in the normal pre-commit suite and hosted `checks-core` job |
| Restricted API/Worker environment allowlist | Preflight added and tested only against synthetic values; owner must prepare and approve private restricted env files |
| Restricted default project identity | Top-level overlay name added and statically checked with no `-p`; wrong `-p` and `COMPOSE_PROJECT_NAME` are rejected by verifier assertions |
| PostgreSQL numeric resource limits | Not selected in source; owner must approve bounded CPU/memory/PID values before startup |
| Independent platform/security review | Prior Compose snapshot `bce82513b683c285bb64e5873fbcd0eefd367725ddce02d0d702e5dc6fc59124` was approved for owner source review; each later snapshot requires its own exact-revision review, recorded in the corresponding milestone report |
| Docker daemon selection | `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, and active context are not inspected or pinned by this source-only work; owner must verify them and the endpoint in the same shell immediately before each separately authorized wrapper invocation |
| Image builds, registry access, DB provisioning/migration, startup/shutdown | Require separate scoped owner authorization |
| Owner login, read-only UI, API/Worker runtime mode agreement, loopback behavior | Require future runtime verification after authorization |
| Stage B, Mission 9D, Stage C/D, provider use, deployment | Excluded; separately gated; R1 remains blocked |

No platform or backend execution approval is implied. Any future local startup must use the exact restricted Compose files and project/database identities above, pass independent review, establish a safe mode transition with no old mock-enabled Worker, and receive explicit owner authorization for database provisioning, builds, startup, evidence retention, shutdown, and any cleanup. Preserve the named volume; destruction requires separate exact-resource authorization.

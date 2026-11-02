# Operations, Environments and Deployment

## Environment strategy

1. **Development:** WSL2 Ubuntu/Linux with Node, pnpm, Docker Compose. PostgreSQL in Compose; native AI runtimes on trusted host or isolated dedicated execution user per capability/secret-store requirements.
2. **CI:** ephemeral PostgreSQL + pinned mock sandbox image, no OAuth credentials, no paid inference, migrations, sandbox negative tests and Playwright smoke tests.
3. **Production (after gated testing):** private k3s homelab with protected database PVC, SOPS+age for deployment secrets if selected, private DNS and device-trusted TLS/CA, no publicly exposed runtime or database endpoints.

No permanent staging required initially. Isolated local/CI test data must never point at production runtime homes or production database.

## Suggested baseline dependencies (version selection in Phase 0)

- Linux/WSL Ubuntu; Node supported LTS; TypeScript strict; pnpm; Docker Engine/Compose.
- PostgreSQL with tested migration library; pg-boss; pgvector optional after initial text-search version.
- Fastify API, React/Vite UI, Playwright e2e.
- Hermes, Codex, Claude Code installed only via official distribution and tested authenticators.
- Ollama optional for offline/local embeddings, not required to start.
- GPU only if running local inference/embeddings or demanding 3D scene; hosted model runtimes do not require a dedicated model GPU.

Pin dependencies and image digests in actual code; this document intentionally avoids inventing versions or manifests without an inspected environment.

### Current local mock gate

The repository pins pnpm `12.16.1` and Node `>=24`. Run `pnpm install --frozen-lockfile`, `pnpm configure:owner`, `pnpm sandbox:image:pull`, `pnpm db:up`, and `pnpm dev` from a fresh WSL login shell with the existing Docker group membership. The sandbox image is pinned to `node@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85` and is used with pulls disabled at execution time. Run DB-backed checks only against a disposable database ending in `test` or `tests`; `pnpm --filter @omnis/worker test:sandbox` requires the local Docker daemon. These controls establish a local mock boundary, not production isolation or provider authorization.

Docker group membership is root-equivalent. The worker uses the trusted rootful daemon to create containers; the sandbox container itself receives no socket, mount, or environment credentials. On the tested WSL host, rootless Docker/userns remapping and AppArmor were unavailable. Keep provider runtimes disabled until their authenticated connector and untrusted-tool sandbox are separately reviewed.

### PostgreSQL backup and isolated restore

Use PostgreSQL custom-format logical dumps for local recovery. Keep the `.dump` and adjacent `.dump.manifest.json` outside the repository in an owner-only directory (`0700` directory, `0600` files). The manifest stores counts, migration IDs, sequence checks and record fingerprints; it contains no database password. Set `OMNIS_BACKUP_DATABASE` to the source database name when it is not `omnis`.

```sh
mkdir -m 700 -p "$HOME/omnis-backups"
OMNIS_BACKUP_DATABASE=omnis pnpm db:backup "$HOME/omnis-backups/omnis-$(date -u +%Y%m%dT%H%M%SZ).dump"
OMNIS_BACKUP_DATABASE=omnis OMNIS_TRUSTED_ARCHIVE_ACKNOWLEDGED=true pnpm db:restore:verify "$HOME/omnis-backups/<backup>.dump" omnis_restore_drill
```

The `OMNIS_TRUSTED_ARCHIVE_ACKNOWLEDGED=true` value is an operator attestation that the archive was created by the trusted Omnis backup workflow and vetted for this local drill. It does not authenticate the archive or manifest, prove who created them, or make `pg_restore` safe for hostile input. Do not pass arbitrary, user-supplied, third-party, or otherwise externally supplied archives to this verifier. The current scripts are for isolated local/CI recovery drills using trusted Omnis archives; they are not approved for production restoration or real agent data.

The restore target must be new and use the reserved `omnis_restore_` prefix. It is created with PostgreSQL connections disabled. During restore only `omnis_migrator` receives temporary database access; PUBLIC and `omnis_runtime` CONNECT are revoked. Runtime access and the database's verified marker are committed together only after ACL, role, schema, fingerprint, sequence, and synthetic runtime-operation checks succeed. Failed validation quarantines the database before attempting removal. If removal fails, the database remains with connections disabled and the script emits a critical diagnostic. A process crash during restore may leave an `unverified` target; runtime and PUBLIC cannot connect, but the privileged administrator/migrator can inspect it. The database comment distinguishes `unverified` from `verified` targets.

After an interruption or cleanup failure, inspect only the exact reserved target and its ownership marker from the maintenance database. Do not connect the worker, API, or application clients to a target marked `unverified`. Confirm the database owner and comment before cleanup, disable new connections, revoke CONNECT, terminate any target sessions, and recheck the state before dropping that one database. Never run wildcard cleanup and never delete an existing database that this restore attempt did not create. If the marker is missing or changed, stop and escalate rather than guessing ownership. Keep the original private archive and review the redacted script diagnostic; the script intentionally does not print restored rows or credentials.

The verifier compares schema/migration state, row counts, status and event distributions, per-record fingerprints, sequence invariants, ACL policy, privileged-role attributes, and safe terminal state. For a synthetic application smoke check, point a temporary local `OMNIS_DATABASE_URL` at the verified target and run `pnpm integration:mock` only with a disposable database name ending in `test` or `tests`. Do not start production workers against a restore until its states and any external side effects have been reviewed.

The scripts do not encrypt or cryptographically authenticate artifacts. Do not use them with real agent data or untrusted archives until ADR-0010 has been approved, implemented, and independently reviewed. A proposed policy is daily backups with seven daily and four weekly copies, a restore drill at least weekly during private alpha, RPO under 24 hours and RTO under four hours. These are planning targets, not guarantees. A single small local restore measurement excludes provisioning, transfer, key recovery and service validation.

## Network

- Bind dashboard, API, worker and database to localhost/private interfaces during development.
- Browser -> HTTPS reverse proxy -> authenticated API; no direct browser-to-runtime privileged bearer access.
- Restrict k3s ingress to private network/Tailscale where appropriate; use Pi-hole/other private DNS and a trusted private CA if no public domain.
- Database accessible only to app/worker identities. External MCP traffic is explicitly allowlisted.

## Secrets

- Native subscription credentials remain in official runtime credential store/host keyring under dedicated service user; protect file perms and backups.
- App session secret, DB password, runtime API bearer and MCP auth must be separate and rotated.
- No `.env` secrets committed; provide `.env.example` in implementation.
- Logs/traces redact headers, auth data and sensitive tool arguments.

## Backups and restore

- **Backup set:** PostgreSQL consistent dump, approved knowledge Git content and metadata, artifact/object storage, relevant configuration secrets in separate encrypted backup.
- **Schedule:** proposed daily DB backup plus retention policy and weekly restore test during private alpha; adjust after measured usage and owner preference.
- **Verification:** test restore into isolated environment, verify file checksums and indexes rebuilt, confirm runnable migration state and ACLs.
- **Recovery limitations:** run external side effects may have occurred even if local DB crashed; require reconciliation before retry.

## Monitoring and incident response

- Metrics: queue delay, run terminal status distribution, worker heartbeat, runtime connection health, scheduler drift, token telemetry coverage, cost budget events, DB volume/latency and UI SSE disconnect rate.
- Structured logs include `request_id`, `task_id`, `run_id`, `agent_id`, service name, status and safe error code; never capture private keys.
- Alerts: DB unavailable, scheduled job failure, auth expiry, increased failure/unknown rate, unusual tool activity, low disk, backup failure, cost warning.
- Incident routine: contain affected worker, preserve redacted audit, disable MCP/automation grant, reconcile external actions, restore service and document a knowledge proposal with review.

## Deployment steps (not yet executable)

1. Run CI unit/integration/e2e tests and provider policy review.
2. Build immutable images and SBOM/license report; scan vulnerabilities.
3. Take verified database backup; run schema migrations as dedicated step.
4. Deploy API, worker, web with scoped secrets and private ingress.
5. Execute health, authentication, run-probe and rollback checkpoints.
6. Promote images manually (digest-based GitOps PR optional), never auto-deploy unreviewed agent code.

## Rollback

- UI/API can roll back image if schema remains compatible.
- Database migration rollback requires tested reverse migration or restore from snapshot; never blindly drop new columns with evidence.
- Disable scheduled work and agent execution before restoring state to prevent conflicting duplicate external actions.

## Operational budget

- Suggested start: 4 vCPU / 8-16 GB RAM for control plane and limited cloud-model agents, to validate with real usage; 3D scene browser-side load separate. Avoid a hard hardware minimum without profiling.
- Record actual cloud, electricity, storage, embedding and subscription expenses as distinct categories in Cost & Usage.

# Operations, Environments and Deployment

## Environment strategy

1. **Development:** WSL2 Ubuntu/Linux with Node, pnpm, Docker Compose. PostgreSQL in Compose; native AI runtimes on trusted host or isolated dedicated execution user per capability/secret-store requirements.
2. **CI:** ephemeral PostgreSQL + fake runtime, no OAuth credentials, no paid inference, migrations and Playwright smoke tests.
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

The repository pins pnpm `12.16.1` and Node `>=24`; workspace dependencies and the `postgres:17.6-alpine` development image are declared exactly in the repository. Run `pnpm install --frozen-lockfile`, `pnpm configure:owner`, `pnpm db:up`, and `pnpm dev`. The worker applies SQL migrations at startup. Run DB-backed integration checks only with an `OMNIS_TEST_DATABASE_URL` that targets a disposable database ending in `test` or `tests`. These pins establish reproducibility for the mock gate; they are not a production approval or provider-runtime authorization.

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

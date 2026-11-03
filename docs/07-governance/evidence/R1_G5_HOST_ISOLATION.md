# R1-G5 host authorizer isolation and trusted control plane — PR #11

**Status: Partial; the systemd deployment gate is pending this revision's CI.** This evidence separates CI-simulated identity tests from deployment verification. The development host was not provisioned. Provider credentials, real inference, arbitrary commands, images, mounts, and networking remain disabled.

## Changes in this hardening pass

| Finding | Change | Verification scope |
|---|---|---|
| N-1 — Trusted-code integrity | Added `install-application-tree.sh`. It installs only a new `/opt/omnis-os` copy, excludes `.env*`/`.git`, refuses an existing destination, rejects special files and broken/escaping symlinks, and makes the installed tree root-owned and non-service-writable. It does not change ownership of the checkout. The verifier checks every application/package/dependency path, symlink target, parent, Node executable, and systemd unit as `omnis-worker`. | The actual worker identity is exercised by the disposable identity test. The new systemd CI probe installs the real tree and runs the expanded verifier; its result is recorded after CI completes. |
| P-5 — Group isolation | API, authorizer, worker, and launcher now have private primary groups. API/authorizer share only `omnis-authorizer-socket`; worker/launcher share only `omnis-launcher-socket`. Worker supplementary groups are reset to exactly its private group plus launcher socket; it is excluded from Docker, authorizer socket, and launcher groups. Launcher secrets/workspaces use its private group; only launcher belongs to Docker. Socket directory/file ownership is applied by its systemd unit. | Disposable identity probes test private primary groups, cross-service secret denial, authorizer-socket denial, launcher-socket access, Docker-socket denial, and trusted process-environment denial. Actual systemd service identities are covered only if the new CI deployment probe reports `PASS`, not `SKIP`. |
| N-2 — Authorizer socket fallback | API now requires `OMNIS_AUTHORIZER_SOCKET`. `/run/omnis-authorizer/authorizer.sock` is the deployment endpoint; custom local test sockets require a private, non-symlink directory owned by the API process. Shared `/tmp`, relative, missing, malformed, and non-private endpoint values fail closed. `configure:owner` creates a per-user private development socket directory; the host secret installer rewrites service paths to the protected `/run` sockets. | API tests cover missing, relative, shared `/tmp`, wrong-parent, canonical deployment, and owned-private local paths. No authorizer token is sent until the endpoint passes startup validation. |

## Deployment and privilege boundaries

The CI-only `scripts/host-security/verify-disposable-systemd-deployment.sh` requires `CI=true`, an explicit opt-in variable, root, a running systemd PID 1, and an active Docker service. It refuses pre-existing Omnis users, groups, service paths, units, and occupied ports. On the ephemeral runner only, it provisions identities, installs a root-owned application copy and synthetic secrets, applies the actual systemd units, runs worker-boundary checks, and creates/approves/completes a synthetic task through API → authorizer → worker → restricted launcher → mock container. Cleanup removes only the created service resources. If systemd or Docker is unavailable, it reports `SKIP`; a skipped deployment probe is not host verification.

The shared development machine was not changed: no privileged host script was executed, no identities/groups/units were installed, and no shared Docker service was restarted. Local `pnpm dev` runs under one developer identity and is not isolation evidence. The launcher retains rootful Docker group membership, which is root-equivalent; the launcher, kernel, Docker daemon, host supervisor, and trusted API remain in the trusted computing base.

## Owner-decision scope and deferred gates

For the single-owner synthetic mock gate, owner authentication and CSRF remain at the API; a private OS-owned UDS plus the separate static API-authorizer token authenticates the API service to the authorizer. The authorizer records fixed `owner` attribution transactionally. Existing request IDs remain idempotency keys, and lost responses remain `authorization_outcome_unknown` with safe same-key retry/readback.

Per-decision signed owner assertions, HMAC binding of method/path/body/timestamp/request ID, a replay ledger beyond existing database idempotency, and a coordinated token-rotation drill are **not claimed as implemented**. They are explicit prerequisites before real-provider authorization or multi-user/step-up decisions. The current static token is acceptable only inside the synthetic single-owner deployment once OS permissions pass; it does not protect against compromise of the API, launcher, host, or kernel. ADR-0011 remains Proposed. ADR-0010 remains Proposed and its backup cryptography requirements are unchanged.

## Local verification

Environment: Node.js `24.22.1`; pnpm `12.16.1` via `npm exec`. The repository's frozen installation passed. `pnpm check` passed after the N-2 regression correction: Prettier, ESLint, all workspace type checks, unit suites, and 30 recovery-policy tests. The PostgreSQL run-store test was skipped because no disposable database URL was configured; Docker-dependent sandbox execution was unavailable because this shell cannot access `/var/run/docker.sock`. `pnpm build` passed. Shell scripts were syntax-checked only; host-security scripts were not executed locally.

## CI evidence

The prior successful PR CI on `f604b8373034676d2849b79521da04571c3551ed` (run `41663012114`) predates N-1/P-5/N-2 changes and is not evidence for them. Exact head SHA, CI run URL, test counts, and whether the systemd probe passed or skipped will be recorded after the updated branch workflow completes. No test is described as a systemd deployment pass before that result is observed.

## Disposition

N-1, P-5, and N-2 have implementation and regression coverage. CI-simulated Linux identities do not equal installed systemd verification. G4-3 remains **Partially Fixed** until the exact revised CI demonstrates the actual service deployment; if the probe skips, it remains unverified. Even if it passes, the root-equivalent launcher and same-host trusted components remain risks, and no real provider authorization or execution is approved.

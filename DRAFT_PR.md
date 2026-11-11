# Mission 9D Stage 2A inert implementation

## Scope

This Draft PR adds only the synthetic Stage 2A schema, test-scoped process-local ledger, fake Stage 1 validation adapter, production artifact exclusion guards, tests and review documentation. It creates no real issuer, live Stage 1 integration, release endpoint, IPC listener, executable fixture bootstrap, Docker/systemd runtime integration, production authority registration or provider activity.

The Stage 1 fake binds the V3 run, session, generation, manifest, attempt/path/ordinal, digest, receipt, boot/deadline/reservation time, controller identity and journal-sequence digest. It rejects identity mismatches, terminal/poisoned sessions, missing reservations and stale reservations.

## Production exclusion

- Workspace build scripts run a TypeScript dependency-graph guard for every production project. It rejects synthetic dependencies through imports, re-exports, literal dynamic imports and indirect paths; nonliteral dynamic imports/`require`, unresolved relative imports, unresolved bare imports, missing workspace dependencies and unresolved TS aliases fail closed.
- Resolved third-party packages are distinguished by their resolved `node_modules` path. Existing static assets that TypeScript does not resolve must be present; the web Vite plugin checks bundled module IDs.
- Docker output trees and host application packaging have exact artifact exclusion checks. The web client/server output passed locally. The five container image builds and their output checks run in the existing hosted CI job.

## Validation evidence

- Pre-publication validated source inventory: 35 files, manifest digest `ff24f4bcdbd92873252590afcc94c2e483a40b6f109b9f90afdddd9efa5d2541` (the original manifest remains in the task scratch location `/tmp/omnis-stage2a-targeted-corrections.SHA256SUMS`; its DRAFT_PR entry predates this publication summary and it is not the checksum for this commit).
- Historical pre-sync source and review-evidence inventory: `docs/06-delivery/MISSION9D_STAGE2A_PUBLISHED_SNAPSHOT.SHA256SUMS`, SHA-256 `44debb3d5fcf71be3d08a7c1c33cd1c010caf1cd9a1359812a718107f23cfcfc`; it verifies all 43 entries at the original PR head `5043a6338c8fdf68aeb4be56b0749ededc78007c` and is preserved unchanged.
- Synchronized source and review-evidence inventory: `docs/06-delivery/MISSION9D_STAGE2A_SYNCED_SNAPSHOT.SHA256SUMS`, SHA-256 `23f0856098abc65f93488abb2e53b352ef1713b9fcfab80addc742b63a43f7ce`; it verifies the same 43 paths at the synchronized tree. The only hash difference is `packages/db/package.json`, whose Stage 2A production graph guard remains and whose test command now also includes PR #90's Mission Lane admission test.
- Main synchronization: `main` at `2a3524ee308d3aba3f5a613af8879f43f7d73de5` (PR #90 squash) was merged by commit `e84cb35511a335681d2afff0f0fdbf9345399c70` into the existing branch without conflicts or history rewriting. No Stage 2A runtime source changed in that merge.
- V3 design evidence: byte-for-byte copy in `docs/06-delivery/MISSION9D_STAGE2_V3_CORRECTIONS/`; its `SHA256SUMS` digest is `579359b535c0d85f61fb349152307f380eb6d7688f014ac0aae51fb91edd34b9`.
- Frozen Stage 1 contract SHA-256: `aa67d2d44bc0b807068b9e07f7e61f77bc0228d1359ac999b1a7e0df329c14ef`.
- Phase A authority manifest SHA-256: `f9c6e5aacc13c79daf148e02483d4d454603ac5cf6f66ed3618959df9b18f123`.
- Local web build artifact manifest SHA-256: `96e55115358f597ed504720840f0774998f86f3898a288fe9b98325f1335a1de` (reproducible CI check is authoritative for PR artifacts).
- Pre-publication checks passed: Prettier, ESLint, workspace TypeScript checks/builds, actual TypeScript graph verification across 11 projects, web build and artifact scan, Stage 2A tests (20), exclusion fixtures (10), and host packaging tests (3). All reported zero failed and zero skipped tests.
- Local dependency setup used the frozen lockfile, pnpm 12.16.1 and isolated caches. Lifecycle scripts were skipped locally to avoid the root `prepare` hook changing shared Git configuration; hosted CI performs its normal install on disposable runners.

## Hosted CI scope

The existing workflow uses only `ubuntu-24.04` GitHub-hosted runners, grants `contents: read`, disables checkout credential persistence, and contains no `pull_request_target`, `workflow_run`, production environment, repository-secret reference or self-hosted runner. PR #90 updated the planner so security-sensitive Draft changes select full mode. This Stage 2A diff classifies as security-, container-, database-, full-stack- and full-frontend-sensitive; the next synchronize event should therefore run the complete suite and required gate. That run is pending for the synchronized head.

## Security restrictions and review

`RELEASE BLOCKED — DEADLINE FENCE NOT ESTABLISHED`

`LIVE STAGE 1 INTEGRATION BLOCKED — LIVENESS ORDERING UNPROVEN`

`RELEASE BLOCKED — SUPERVISION GUARANTEE UNAVAILABLE`

No merge authorization is granted. Codex #1's blocked assessment at comment `#6784372176` applies only to the pre-sync head and is historical, not an approval. The earlier independent read-only pass also applies only to the pre-sync head. Request a fresh direct Codex #1 review and an independent read-only applicability review naming the new exact head after hosted CI and before any Ready transition or merge consideration.

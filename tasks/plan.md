# Omnis OS Phase 1 Completion Plan

## Objective

Complete the documented Phase 1 owner journey on Docker Compose: persistent domain setup, exact owner authorization, durable Run lifecycle and events, honest synthetic evidence, safe cancellation/recovery, and a usable frontend. Real provider execution stays disabled until policy, consent, credential custody, isolation, egress, and independent review gates are satisfied.

## Current branch and dependencies

- Baseline `main`: `ac24bc3af8504c06465aeca2924011f4771252b3`.
- Current implementation branch: `codex/phase1-safe-integration`, based on the current head of Draft PR #58 (`0069e36d1e1ce6c4a0276b1a1df5c9c005d21ab7`).
- Existing dependency chain: #55 → #56 → #57 → #58. Exact-head CI is green for all four heads. They are still Draft and have not been merged or independently accepted.
- #54 has separate successful exact-head CI and overlapping audit-read behavior; review before combining.
- #41 and #46 are Draft, nonmergeable, and their latest recorded CI runs are cancelled. #41's migration 0021 remains excluded from the current stack; #46's process and network evidence remains incomplete.
- Current main has migrations 0001–0020 and 0022–0023. The missing 0021 belongs to #41 and must not be silently renumbered or applied.

## Ordered tasks

1. [x] Refresh main, PR heads/dependencies, CI runs, local branch/worktree state, and Phase 1 docs.
   - Acceptance: exact current main/head SHAs, current open PR set, and CI outcomes recorded.
   - Evidence: GitHub PR metadata/workflow runs and local `git status`, `git rev-parse`, migration inventory.
2. [x] Map AO-101 through AO-113 to implementation and evidence.
   - Acceptance: each gate has status, evidence, remaining blocker, and next action in `docs/06-delivery/PHASE_1_COMPLETION_MATRIX.md`.
   - Verification: check every row against current source/docs and exact-head CI, distinguishing mock evidence from real-provider evidence.
3. [ ] Review the #55→#58 implementation against the backend contract; review #54 overlap and #41/#46 compatibility before combining any work.
   - Acceptance: findings are recorded, ACL/migration effects are understood, and no incompatible PR is integrated.
   - Verification: focused diff review, migration/ACL review, and relevant tests on the candidate.
4. [ ] Close the synthetic task-to-Run vertical-slice gaps without adding a second authorization or attempt ledger.
   - Acceptance: canonical run admission, task/profile binding, durable events, SSE, cancellation request, audit read, idempotency, and unknown outcomes agree across API, worker, authorizer, and database.
   - Verification: interface tests, PostgreSQL integration, browser integration, restart/recovery, backup/restore.
5. [ ] Complete the minimum owner frontend journey using the existing design system and truthful synthetic labels.
   - Acceptance: owner can create/inspect a task, choose available agent/profile/runtime, review the exact operation, start, monitor, stop, inspect output/history, and see unknown/unavailable states.
   - Verification: browser E2E including refresh and cancellation; do not depend on unreviewed visual PRs.
6. [ ] Verify Docker Compose deployment readiness and update deployment docs to Docker-only.
   - Acceptance: private binding, health/readiness, persistent storage, startup order, env validation, service separation, backup/restore, and recoverable restarts are covered; no Kubernetes/k3s direction is introduced.
   - Verification: disposable Linux/Compose boundary and restart tests; do not change a live host.
7. [ ] Prepare a disabled-by-default real-runtime design and exact external gate list; do not contact a provider.
   - Acceptance: provider policy/consent, credential custody, no-tool guarantee, egress, host identity, cancellation, usage, and independent review have named evidence requirements.
   - Verification: documentation review and deterministic stub tests only.
8. [ ] Run full verification on the final candidate and prepare a Draft PR with evidence.
   - Acceptance: formatting, lint, TypeScript, unit/contract, PostgreSQL/migration, security, process-isolation, browser, recovery, backup/restore, and exact-head GitHub Actions results are recorded.
   - Gate: never push to main, merge, deploy, activate a provider, or run inference without separate authorization.

## Completion estimate

Initial source-based estimate: approximately 73% implemented for the existing mock-only scope, using equal weight across AO-101–AO-113, counting the eight documented verified gates as complete and each of the three partial gates as half-complete. This is not Phase 1 acceptance: AO-107 and AO-113 remain blocked, and real-provider execution has not been authorized. Current-candidate CI is evidence for #55–#58, but it does not independently validate a future combined candidate or the deployed Linux host. Recalculate after each verified increment.

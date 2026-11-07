# Phase 1 Work Queue

- [x] Refresh current repository, main, open PRs, branch dependencies, and exact-head CI.
- [x] Publish initial AO-101–AO-113 completion matrix.
- [x] Review #55→#58 diff and findings; record the remaining late-outcome and process-boundary gaps.
- [x] Review #54 audit overlap and #41 migration/ACL implications; selectively implement only the additive audit read path.
- [x] Implement a local owner-scoped, paginated synthetic execution audit API without adding a second ledger.
- [x] Render that audit history from a persisted Run authorization identity and add browser/database coverage.
- [x] Integrate reviewed Project Workspace V1 for project create/edit/archive and task/run inspection; project frontend suite passes locally.
- [ ] Complete minimum owner frontend journey and browser E2E, including task-to-project creation/assignment and agent/profile/runtime selection.
- [x] Set Docker Compose/private Linux as the documented deployment target and remove active Kubernetes/k3s roadmap direction.
- [x] Document real-runtime blockers and disabled-by-default design; no provider calls.
- [ ] Implement and verify a complete Docker Compose application topology with process/socket boundaries.
- [ ] Run full exact-candidate verification and prepare a Draft PR.

## Checkpoint

- [x] Local candidate has clean formatting, lint, TypeScript, and workspace checks (`pnpm check`).
- [x] Unit/contracts, disposable PostgreSQL backup/restore, ACL fixtures, and rejection-path tests pass.
- [ ] Exact-candidate browser owner journey, cancellation, refresh, and persisted recovery pass.
- [ ] Docker process-boundary and restart evidence is current; boundary script is restricted to disposable root Linux CI.
- [x] Exact-head GitHub CI passed for preceding Draft PR #60 docs head `f8bcbf5` (run `42352345165`, all eight jobs).
- [x] Exact-head GitHub CI passes for Draft PR #61 source commit `2df9aa1` (run `42353336401`, all eight jobs).

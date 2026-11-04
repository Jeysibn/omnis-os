# AO-104 Agent Profile Read API Foundation

**Status:** Merged read-only foundation. PR #14's reviewed candidate was `f1f1275eb9d7f04888ef21ee86a3f2bd04bee5c5`, merged into `main` as `6508a927989c1b384fe4bdf79f7172019a91eee4`. Post-merge CI passed for the exact merge commit. This implementation does not complete AO-104 or authorize agent execution.

## Contract

The backend contract uses camelCase, consistent with `packages/contracts`. The read API returns profile lifecycle (`draft`, `available`, `archived`) separately from observed activity. Drafts have no published current version; archived records remain visible in the API and retain their history. Versioned instructions are returned as bounded inert plain text. Response mappings are allow-listed and recognized credential-like values fail closed. Credential scanning is heuristic and does not guarantee detection of every secret; write APIs require input-boundary validation and broader credential controls before they are enabled. No runtime permissions or operational state are inferred from profile text.

`GET /api/v1/agents` returns a complete ordered directory (up to 1,000 summaries) with exact total metadata; it returns an error without partial results above that bound. Version history uses descending keyset pages (default 50, maximum 100). Its authenticated cursor binds the agent, total, high-water version, current version, and last version in the traversal. A domain-separated HKDF key derived from the worker internal token signs pagination cursors; the token is not used directly as the HMAC key. Deploying this signing-key change or rotating the worker token invalidates outstanding cursors, which receive the existing invalid-cursor response and must be restarted from the first page. Appends after page one do not change the traversal's total or current marker. Version numbers are contiguous, unique per agent, and the current reference must equal the latest version. Historical lookup uses the exact `(agentId, versionNo)` pair and never falls back to current data.

The contract decisions were sent to the PR #13 workstream at [the initial decision note](https://github.com/Jeysibn/omnis-os/pull/13#issuecomment-6612384778), [the snapshot pagination clarification](https://github.com/Jeysibn/omnis-os/pull/13#issuecomment-6612441133), and [reconciliation against updated proposal head `67b12d9`](https://github.com/Jeysibn/omnis-os/pull/13#issuecomment-6612689734). The updated proposal retained the requested response shapes and did not introduce a conflict.

## Persistence and security boundaries

Migration `0012_agent_profiles.sql` adds flat departments, owner-scoped agents, and immutable profile-version snapshots. Deferred constraints enforce that a draft has no published version and that an available or archived agent points to its contiguous latest version. Database triggers reject snapshot updates/deletes and reject agent/department deletion; archival preserves records. The `omnis_runtime` role receives `SELECT` only on these tables. Authorization remains the existing single-owner session in the API; the API has no database credentials and forwards reads through the existing authenticated worker boundary.

The storage model contains profile identity and authored text only. It adds no provider credential, secret reference, runtime binding, grant, execution state, or automatic execution feature. AO-104 create/edit/archive management APIs remain out of scope for a later backend increment.

## Endpoints

- `GET /api/v1/agents`
- `GET /api/v1/agents/:agentId`
- `GET /api/v1/agents/:agentId/versions`
- `GET /api/v1/agents/:agentId/versions/:version`

All are owner-authenticated. Invalid identifiers and query parameters return `422`. Unknown agents and unknown historical versions use the same generic `404` envelope. Empty directories and draft agents are represented explicitly, without seeded application data.

## Validation evidence

PR #14 was based on `main` at `198137c9281beed7b0d620ff2cfae28f660f3e9a`; its merged result is `6508a927989c1b384fe4bdf79f7172019a91eee4`. CI ran on Node 24.22.1 with pnpm 12.16.1.

- `pnpm check`: passed formatting, lint, workspace type checks, unit tests, API route tests, security regressions, and recovery/ACL policy tests.
- `pnpm build`: passed workspace builds.
- `git diff --check`: passed.
- GitHub Actions [run 41809235965](https://github.com/Jeysibn/omnis-os/actions/runs/41809235965) passed both jobs on the exact merged `main` commit: `checks` and `frontend-browser`.
- `pnpm check` reported **152 check-suite tests passed, 0 failed, 0 skipped**. This included 56 PostgreSQL integration tests. `pnpm build` passed. The separate host cleanup/packaging regression command reported **2 tests passed**; the combined test total was 154 passed, 0 failed, 0 skipped.
- Integration gates passed: legacy migration upgrade through 0012, recovery integration, disposable PostgreSQL backup/restore with ACL parity, host cleanup/packaging/required-check regressions, and disposable Ubuntu systemd host-isolation verification. The frontend browser job passed all 34 existing Command Center tests.
- Two earlier candidate CI runs exposed and fixed specific issues: the legacy-upgrade test still expected migration 0011 as latest; the ACL-free restore baseline omitted the three new runtime SELECT grants. Both fixes are included in the final candidate and the full run above passed.
- CI supplied PostgreSQL, Docker, cleanup/packaging, and disposable-systemd verification on disposable infrastructure; no developer-host identity or Docker environment was modified for this evidence.
- Database coverage includes empty and oversized directories, stable name tie ordering, department lookup, drafts and archived visibility, immutable historical snapshots, exact lookup/no fallback, contiguous version order, stable cursor totals/current markers during a concurrent append, malformed data rejection, and read-only runtime grants.

## Deferred work and limitations

- Full AO-104 department CRUD and agent create/edit/archive workflows are not implemented.
- There are no default or demonstration agents; until an approved write path exists, the directory may be empty.
- The single-owner `owner` identity is retained. Multi-user authorization is not implemented or authorized.
- No agent runtime, provider, background execution, tool permissions, or Docker authority is attached to profiles.
- Successful disposable-host verification does not establish production or homelab deployment assurance.

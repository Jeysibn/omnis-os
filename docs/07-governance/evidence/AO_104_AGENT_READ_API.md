# AO-104 Agent Profile Read API Foundation

**Status:** Draft implementation evidence. This change implements the owner-authenticated read slice only; it does not complete AO-104 or authorize agent execution.

## Contract

The backend contract uses camelCase, consistent with `packages/contracts`. The read API returns profile lifecycle (`draft`, `available`, `archived`) separately from observed activity. Drafts have no published current version; archived records remain visible in the API and retain their history. Versioned instructions are returned as bounded inert plain text. Response mappings are allow-listed, credential-looking values fail closed, and no runtime permissions or operational state are inferred from profile text.

`GET /api/v1/agents` returns a complete ordered directory (up to 1,000 summaries) with exact total metadata; it returns an error without partial results above that bound. Version history uses descending keyset pages (default 50, maximum 100). Its authenticated cursor binds the agent, total, high-water version, current version, and last version in the traversal. Appends after page one do not change the traversal's total or current marker. Version numbers are contiguous, unique per agent, and the current reference must equal the latest version. Historical lookup uses the exact `(agentId, versionNo)` pair and never falls back to current data.

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

## Local verification

The implementation worktree is based on `origin/main` at `198137c9281beed7b0d620ff2cfae28f660f3e9a`. Local checks run on Node 24.22.1 with pnpm 12.16.1.

- `pnpm check`: passed formatting, lint, workspace type checks, unit tests, API route tests, security regressions, and recovery/ACL policy tests.
- `pnpm build`: passed workspace builds.
- `git diff --check`: passed.
- The PostgreSQL integration suite did not run locally because no isolated test database was configured. The Docker sandbox test was skipped because the local Docker socket denied access. These checks must pass in the branch's GitHub Actions run before review readiness is claimed.
- Cursor validation unit test passed locally. Database integration coverage is present for empty and oversized directories, stable name tie ordering, department lookup, drafts and archived visibility, immutable historical snapshots, exact lookup/no fallback, contiguous version order, stable cursor totals/current markers during a concurrent append, malformed data rejection, and read-only runtime grants.

## Deferred work and limitations

- Full AO-104 department CRUD and agent create/edit/archive workflows are not implemented.
- There are no default or demonstration agents; until an approved write path exists, the directory may be empty.
- The single-owner `owner` identity is retained. Multi-user authorization is not implemented or authorized.
- No agent runtime, provider, background execution, tool permissions, or Docker authority is attached to profiles.
- PostgreSQL role/migration and Docker regression evidence remains pending the CI run for the implementation commit.

# R1-G4 Independent Authorizer Process Evidence

**Status:** Local verification complete; independent security review pending  
**Base:** PR #9 squash merge `71fe3f07e4d4e9541e366ba304420ec93164552a`  
**Branch:** `security/r1g4-authorizer-process-isolation`  
**Verification date:** 2026-11-03

## Scope and disposition

This change moves owner authorization request, approval/denial, and revocation operations to a distinct authorizer process using PostgreSQL role `omnis_authorizer`. The API remains the owner session and CSRF boundary. The worker uses `omnis_runtime`, has no approval or revocation routes, and continues to enforce persisted authorization before mock run admission and during worker lifecycle checkpoints. Migration 0009 adds the constrained runtime admission-denial audit entry point and idempotent request correlation; migration 0010 removes the runtime caller-supplied actor parameter from grant locking/consumption and records the fixed runtime service identity for consumption events.

**G4-3 disposition: Partially Fixed.** Authorizer credentials are absent from the worker's configured environment and normal process startup environment; runtime cannot assume `omnis_authorizer`; runtime requests to the authorizer without the API-authorizer token are rejected. However, the local API, authorizer, and worker run as one Unix user and the worker retains Docker-daemon access. A same-user or Docker-daemon-compromised worker can inspect or control other local services and may recover control-plane material. This implementation is an application boundary for the mock-only local deployment, not host-enforced credential isolation. It does not authorize real provider secrets or inference.

## Trust boundary and request flow

```text
Owner browser -- session + CSRF --> API -- separate loopback service token --> Authorizer
                                      |                                      |
                                      | worker token; no actor assertion     | omnis_authorizer DB role
                                      v                                      v
                                   Worker <------ PostgreSQL authorization state
                                     |
                                     +--> fixed synthetic Docker mock sandbox
```

The API validates the existing owner session, request origin, and CSRF token. It sends authorization lifecycle operations to the loopback authorizer with a dedicated token that differs from the API-to-worker token. The authorizer exposes only health and the minimal request/decision/revoke routes, compares the service token in constant time, rejects caller-supplied actor fields, and fixes lifecycle actor attribution to `owner`. Authorization state and decision audit remain in the same PostgreSQL transaction. API calls fail with an explicit unavailable response when authorizer or PostgreSQL is unavailable; there is no worker-side fallback.

Authorization request IDs are UUID idempotency keys persisted by the authorizer store. A repeated request key returns the original scoped request rather than creating a second one. The worker receives no owner actor header. Admission verifies that the persisted grant is owner-requested and applies only to the exact task and `mock.execute`; migration 0010 removes the actor argument from the runtime SQL lock and consume interfaces. Consumption audit attribution is fixed by SQL to `service:omnis-runtime`. Runtime lifecycle audit remains limited by the existing database append interface.

The authorizer has no queue, sandbox, or provider connection. Its health route checks the database without disclosing credentials. Tokens and cookies are redacted from authorizer logs. The service binds only to loopback in the supported local configuration.

## PostgreSQL and credential evidence

- Runtime and authorizer use distinct PostgreSQL passwords/roles; role-membership tests verify `omnis_runtime` cannot `SET ROLE omnis_authorizer`.
- The worker startup rejects authorizer DB password/URL and API-authorizer token variables if supplied. Local configuration writes separate mode-0600 `.env.worker` and `.env.authorizer` files; the worker file contains no authorizer credential/token.
- The actual integration starts the API, authorizer, and worker as distinct processes. It verifies the worker configuration omits authorizer credentials, unauthenticated runtime access to privileged authorizer routes returns 401, forged caller actor fields are rejected, authorizer outage returns failure without creating a grant, and authorizer restart preserves idempotent durable requests.
- These checks do not establish host isolation. All services share the developer's Unix identity. The worker has Docker socket/daemon access, which is root-equivalent. A compromised worker can potentially read same-user files or inspect/control another service. Separate secret filenames/processes do not prevent that.
- PostgreSQL runtime role remains non-superuser, non-CREATEROLE, non-CREATEDB, non-replication, NOBYPASSRLS, NOINHERIT, and has no authorizer membership. SQL privilege tests verify restricted functions and protected authorization/audit data.

## G4-19 through G4-21

- **G4-19 — Fixed after reproduction.** PostgreSQL 17.6 idle-in-transaction termination was exercised from a subprocess. The checked-out client error is associated with the transaction, the failed client is discarded, the subprocess survives, and a replacement pooled connection succeeds. The handler does not suppress transaction errors.
- **G4-20 — Assessed.** Restore role-integrity validation reads actual `pg_db_role_setting` entries for role and database scopes. A disposable `ALTER SYSTEM` cluster default test confirms a fresh runtime connection uses its explicit role-level timeout. Session-local changes on an already connected runtime session are not discoverable from those catalog settings and are not claimed to be audited.
- **G4-21 — Confirmed limitation, operationally mitigated.** PostgreSQL 17.6 permits `omnis_runtime` to persist a setting on its own role with `ALTER ROLE`; the integration test reproduces this. Runtime cannot escalate to another role, but it can weaken its own defaults. Privileged role provisioning repairs the setting, and restore role-integrity verification rejects unsafe persisted values. These defaults do not provide runtime-independent DoS protection.

## Verification performed

Infrastructure was synthetic and disposable: PostgreSQL 17.6 container `omnis-pr10-pg` bound to loopback port 15459, distinct runtime/migrator/authorizer roles, and disposable backup/restore Compose resources. No persistent or production database was used. The actual sandbox tests used Docker; no unrelated services were changed.

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed (local lockfile install; pnpm 12.16.1 invoked through npm because pnpm is not on PATH) |
| `pnpm check` | Passed: Prettier, ESLint, TypeScript, 89 workspace tests, 30 recovery/ACL/role-policy tests; 0 failures |
| PostgreSQL package tests | 48 passed, 0 failed on PostgreSQL 17.6 |
| Authorizer boundary tests | 3 passed, 0 failed |
| Worker tests in normal check | 21 passed; Docker-only security integration is gated separately |
| Actual-container sandbox | 29 passed, 0 failed, 0 skipped |
| `pnpm integration:mock` | Passed: real API, authorizer, worker; owner auth/CSRF, authorization request/decision/revoke, runtime denial, outage/restart, mock lifecycle and SSE |
| `pnpm integration:legacy-upgrade` | Passed from `708d0f5e9b6083da852e26c0643c60c0f5879f85`; includes migrations 0009–0010, role separation, legacy recovery, and post-upgrade worker execution |
| `pnpm integration:recovery` | Passed: PostgreSQL-backed lifecycle, API/SSE replay, abrupt worker recovery, sandbox crash cleanup, no duplicate execution |
| `pnpm integration:backup-restore` | Passed: disposable custom-format backup/restore, ACL/role verification, sequence and post-restore mock execution checks |
| `pnpm build` | Passed: all TypeScript workspace builds and Vite production build |
| Browser GUI smoke | Not run; API-level owner/session/CSRF flow was exercised; UI layout was not changed |
| GitHub Actions | Passed on implementation SHA `22fb4aa19f817f44364097fe42840b7cb656ff9e`: [run 41645566824](https://github.com/Jeysibn/omnis-os/actions/runs/41645566824) |

Commands used the repository scripts: `pnpm check`, `pnpm --filter @omnis/worker test` with `OMNIS_SANDBOX_INTEGRATION=1`, `pnpm integration:mock`, `pnpm integration:legacy-upgrade`, `pnpm integration:recovery`, and `pnpm integration:backup-restore`. All PostgreSQL URLs and passwords were generated or passed through process environment and are intentionally omitted from this evidence.

The CI run above passed frozen installation, role provisioning, `pnpm check`, build, legacy-upgrade, recovery, and disposable backup/restore on the implementation tree. The evidence and template follow-up commits are documentation-only and are being checked by the workflow on the final branch SHA separately.

## Remaining risks and gates

1. G4-3 remains partial until service identities/secrets are isolated by the host or deployment, worker Docker-daemon access is removed, and the API-authorizer channel is protected against a compromised worker.
2. The worker still performs its own authorization checks. Removing the authorizer credential does not independently force a compromised worker to obey those checks for work it controls.
3. No credential broker or provider connector exists. No Claude, Codex, Hermes, OpenAI, or other inference was enabled; no provider credential was read or used.
4. Provider-specific approval/policy, connector egress restrictions, independently enforced in-run revocation, trusted audit isolation, and credential-canary checks remain required before any future real runtime.
5. G4-21 role defaults are mutable by runtime itself; separate process/credential isolation and a policy that treats runtime as untrusted are still needed.
6. ADR-0010 remains Proposed; backup encryption/authentication was not changed. ADR-0011 is Proposed, not approved.

**Recommendation:** retain the mock-only gate, request independent security review, and do not interpret this local process split or passing CI as approval for real provider execution.

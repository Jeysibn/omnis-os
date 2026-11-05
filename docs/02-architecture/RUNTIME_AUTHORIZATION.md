# Durable authorization and audit foundation

## Current boundary

The shipped R1-G4 foundation is restricted to a local, authenticated owner approving one deterministic mock run for one task. It does not enable a model provider or general-purpose tools. PostgreSQL remains authoritative; process memory is not an authorization source.

```mermaid
sequenceDiagram
    participant H as Owner session
    participant A as API
    participant Z as Authorizer process
    participant W as Runtime worker
    participant DB as PostgreSQL
    participant S as Mock sandbox
    H->>A: Request and approve task-scoped grant (session + CSRF)
    A->>Z: Control request with separate API-authorizer token
    Z->>DB: Persist request/decision and audit (omnis_authorizer)
    H->>A: Start run with authorization ID
    A->>W: Start request (no owner assertion header)
    W->>DB: Consume exact owner-approved grant + admit run atomically (omnis_runtime)
    W->>DB: Lock/recheck grant before claim and completion
    W->>S: Execute fixed synthetic mock only
    W->>DB: Persist lifecycle and audit events
```

## State and scope

Each record contains a requesting principal, runtime, operation, capability set, task scope, policy version, correlation ID, expiry, decision actor/time, optional consuming run, and optional revocation actor/time. The current database checks constrain these values to `owner`, `mock`, `execute_task`, `mock.execute`, and exactly one task. A grant is consumed by at most one run. Approval is a separate explicit action; task creation does not approve execution.

Effective states are `pending`, `authorized`, `denied`, `revoked`, and derived `expired`. Expiry uses PostgreSQL time for decision, consumption, claim, heartbeat, and completion enforcement. A repeated or conflicting decision is rejected under a row lock. The separate `omnis_authorizer` login can request, decide, and revoke; `omnis_runtime` cannot directly modify authorization rows or insert directly into the audit table. Migration-owned security-definer routines expose atomic consumption, active-run row locking, and a restricted runtime audit append to the runtime login.

## Trusted identity and approval

The browser never supplies an actor identity. Owner-only API routes require the existing authenticated owner session and CSRF validation. The API sends authorization lifecycle requests to the separate loopback authorizer with a service token distinct from the API-to-worker token. The authorizer derives the fixed `owner` identity and does not accept caller-provided identity fields. The worker has no approval or revocation routes, does not load the authorizer credential, and does not receive an owner actor header for admission. It verifies the persisted grant is an owner-requested approval for the exact task and operation. Migration `0010` removes the runtime-supplied actor parameter from grant-lock and consumption functions; consumption audit attribution is fixed to `service:omnis-runtime`. The approval and decision audit entries retain the owner identity. The effective human principal remains the single local owner account, not a general identity provider.

The process split is not yet a host-enforced trust boundary. Local processes run as the same Unix identity, which can read their environment and private files. The worker also has Docker-daemon access, which is root-equivalent and can inspect/control other local services. A compromised worker with these host capabilities may still obtain the API-to-authorizer token or control the authorizer. G4-3 is partially addressed; do not use this arrangement for real provider credentials or workloads.

## Enforcement and revocation

1. The API rejects run requests without an authorization ID and trusted owner session.
2. The coordinator reads the durable authorization and verifies status, actor, runtime, capability, expiry, and exact task scope.
3. In the run-admission transaction, PostgreSQL consumes the grant once and commits the queued run, idempotency row, audit event, and pg-boss work together.
4. Before execution claim, the worker locks and rechecks the consumed authorization. Missing, expired, or revoked grants interrupt queued work; unsafe work is not replayed.
5. Lease renewal locks the run, then locks and checks its active authorization in the same transaction before updating the lease. Completion follows the same run-then-authorization order. This prevents a heartbeat statement snapshot taken before revocation from extending a lease after the revoke commits.

Revocation becomes effective when its transaction commits. If a claim or completion acquired the row lock first, that transition can commit before revocation; a checkpoint acquiring the lock after revocation commits is denied. The system cannot retract an external side effect that already completed. The only current operation is the deterministic local mock, which has no provider side effect.

Database connection or authorization lookup errors fail closed. After restart, the worker reconstructs the authorization for a run from PostgreSQL; no in-memory grant cache authorizes execution.

## Audit

The audit table records request, approval/denial, consumption, revocation, expiry, enforcement denial, operation start, and terminal outcomes with actor, effective service identity, authorization/task/run IDs when known, fixed capability, correlation ID, timestamp, outcome, and safe reason code. Request/decision/revoke records are written by the trusted authorizer connection. Runtime lifecycle audit records are emitted transactionally inside the constrained run-transition function, which invokes `append_runtime_authorization_audit` under its definer identity. The append helper derives actor/task/authorization/correlation/outcome from persisted rows and records the effective identity as `service:omnis-runtime`; it does not accept a caller-supplied actor or JSON provenance field. The runtime role cannot invoke the append helper directly or write approval, denial, or revocation decisions.

Audit row IDs default to PostgreSQL `gen_random_uuid()` values. Consumption and revocation inserts omit the ID, so a runtime-controlled predictable string cannot reserve the key needed by a privileged transition. Expiry is idempotent through a partial unique index on authorization ID for the single expiry event; the authorizer's conflict handling applies only to that explicit duplicate-expiry case. Required transition audit writes remain in the same transaction as their state changes and fail visibly if insertion fails. Prompts, credentials, and tokens are not stored in these records.

`omnis_runtime` has no direct audit-table INSERT, UPDATE, or DELETE privilege. The narrow append routine makes runtime operation events distinguishable from authorizer decisions; the trusted database administrator and authorizer process remain able to alter audit history. This is not tamper-proof: no cryptographic immutability or external audit anchoring is claimed.

Migration `0008` removes the shared authorization advisory lock. PostgreSQL exposes advisory-lock functions to `PUBLIC` by default, so a runtime session could hold the shared session lock indefinitely and block owner revocation. Admission now locks the exact eligible authorization row through the narrowly granted `lock_run_authorization_for_admission` function before it takes the task row lock; it then inserts the run and consumes that same grant in one transaction. Direct run insertion can hold the task foreign-key `KEY SHARE` lock before consumption, which is compatible with the audit foreign-key `KEY SHARE` lock acquired by unconsumed revocation. Unconsumed revocation locks and re-reads only the grant row; if it discovers that consumption won, it retries in a fresh transaction. For an already consumed grant, revocation locks the run and then the authorization row, matching worker claim, heartbeat, completion, and cancellation transitions. The grant row is the serialization point; unrelated grants do not share a revocation lock.

The lock order is therefore: run-store admission takes the existing global admission-cap lock, authorization row, task row, run insertion/consumption and audit foreign keys; direct consumption takes the authorization row and then audit foreign keys; unconsumed revocation takes the authorization row and audit foreign keys; consumed revocation and worker transitions take run row, authorization row, then audit foreign keys. The global admission-cap lock remains for admission limits and idempotency; revocation no longer acquires it. A transaction-local 3-second `lock_timeout` bounds row-lock waits inside revocation. A timeout raises SQLSTATE `55P03`, rolls back the revocation and its audit event, and is surfaced as an explicit retryable service-unavailable response. It does not mean the grant was revoked, and it does not prevent every form of database contention or repeated denial of service.

The admission-cap lock still uses a PostgreSQL advisory key callable by `PUBLIC`. A runtime session holding that key can block new run admissions, although the revocation function no longer waits on it. This admission availability limitation is not closed by migration `0008` and remains a separate reliability/security follow-up.

Admission sets a transaction-local three-second `lock_timeout` before taking the capacity lock or runtime-lockable rows. A timeout rolls back the complete admission transaction and returns HTTP 503 `admission_busy`; the authorization is not consumed and no run, queue job, or idempotency record is committed. The response bounds that attempt only. A session retaining the public advisory key can keep new admission attempts unavailable until it releases the lock.

## PostgreSQL connection timeout defaults

Role provisioning sets session defaults for new connections: `omnis_runtime` receives `lock_timeout=3s`, `statement_timeout=20s`, and `idle_in_transaction_session_timeout=20s`; `omnis_authorizer` receives `3s`, `15s`, and `20s`, respectively. The three-second lock bound matches admission/revocation transaction policy and heartbeat renewal. Worker heartbeats run every five seconds under a thirty-second lease; routine SQL transactions are short, and the twenty-second statement/idle-transaction ceilings leave room for normal work while staying below the lease window. `omnis_migrator` has these role defaults reset so schema upgrades retain necessary headroom. The `omnis` administrator/recovery login remains operator-managed. A disposable PostgreSQL test also sets a cluster `statement_timeout` default and verifies that the runtime role's explicit 20-second role default is effective for a new connection.

`idle_session_timeout` is intentionally not set for application roles. PostgreSQL warns that terminating normally idle pooled connections can cause middleware/pool churn. The Node pool already retires idle clients; an idle session-level advisory lock may remain held while a connection is idle. An idle-in-transaction timeout does terminate abandoned transactions and release their locks, but it does not terminate a session-level advisory lock held outside a transaction.

These are role defaults, not a security boundary: a connected `omnis_runtime` or `omnis_authorizer` can override ordinary session parameters with `SET` or transaction-local settings. Database-specific role overrides take precedence over global role defaults, so the role-integrity verifier rejects timeout overrides for the constrained application roles and checks the `pg_db_role_setting` catalog plus newly connected effective values. Role defaults are applied at login; existing pools must be drained/recycled (normally by restarting the worker after provisioning) to receive changes. The explicit transaction-local bounds in admission, revocation, and heartbeat remain the application behavior. A runtime holding its own lock can still cause bounded failed attempts, and G4-3 process/credential separation remains necessary for a trusted revocation boundary.

A heartbeat sets `lock_timeout=3s` before locking the run, then the authorization grant, then renewing the lease. SQLSTATE `55P03` rolls the transaction back and is treated as a failed renewal (`false`), never as success. The worker stops the sandbox and follows its existing claim-loss/interruption path; recovery does not replay unsafe work. A lock timeout may therefore interrupt a run even if the contention was temporary. Other PostgreSQL failures continue through the worker's persistence-failure path.

Migration `0008` also records migration provenance for active grant-less runs created before migration `0005_durable_authorization` was applied. Active rows created after that authorization boundary are not classified as legacy. Only migration-classified rows may be safely cancelled, failed, interrupted, or recorded as denied at execution claim. They cannot be started or completed, and no authorization grant is created for them. Runtime cannot read or modify the provenance table. Runtime-originated terminal audit events retain the fixed `service:omnis-runtime` actor and effective identity; the append function does not claim that a recovery principal performed the transition. A grant-less run created after the migration is not classified as legacy: execution enforcement fails closed, and a mandatory audit association failure rolls the lifecycle transaction back.

## Failure behavior and limits

- Missing, forged, cross-task, expired, consumed, denied, or revoked grants cannot authorize a run.
- A caller-provided approval flag or actor string is not accepted as authority.
- The adapter cannot grant itself a capability.
- Database failure stops admission or execution at the next checkpoint.
- Revocation row-lock waits are bounded to 3 seconds; a timeout is an explicit failed revocation, not a successful state change.
- Migration-classified legacy runs support terminal cleanup only; absent authorization never permits protected execution.
- Owner authentication is single-account; separate approver identities and delegated policy are future work.
- Persistent expiry status is derived from the expiry timestamp; an expiry audit record is emitted on authorizer-store read.
- This PR does not provide provider credential storage, connector network restrictions, model policy enforcement, or real-runtime authorization.

## Gates before model-only execution

Require an independently reviewed owner approval workflow and durable human identity, restricted connector with its own identity and provenance, trusted credential broker with revocation, provider-supported authentication and policy approval, bounded outbound egress, authorization checks before every provider operation, effective in-run revocation, and credential-canary absence verification. Keep provider credentials outside tool sandboxes. Do not reuse local Hermes, Codex, or Claude OAuth sessions. Arbitrary tools, shell execution, and general-purpose agent workloads remain prohibited. ADR-0010 backup encryption/authentication remains Proposed and separate.

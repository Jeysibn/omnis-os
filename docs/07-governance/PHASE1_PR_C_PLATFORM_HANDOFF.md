# Phase 1 PR C — historical platform handoff

**Historical status at reviewed base `7a7fd46d4736af02ad94a82c2977a2054943ea66`: BLOCKED pending an authorizer IPC contract.** PR #47 later added broker-only authorizer IPC and a fake-provider transport contract. This preserves the original findings; current status is in [Phase 1 PR C platform status](PHASE1_PR_C_PLATFORM_STATUS.md). No real authentication, credentials, inference, deployment, or runtime selection is authorized.

## Reviewed base and scope

- Base: `7a7fd46d4736af02ad94a82c2977a2054943ea66` (`origin/main`).
- Contract: [Phase 1 PR B broker contract](PHASE1_PR_B_BROKER_CONTRACT.md).
- Authorization implementation reviewed: `packages/contracts/src/connector-broker.ts`, `packages/runtime-adapters/src/synthetic-broker.ts`, `packages/db/src/connector-authorization-store.ts`, `apps/authorizer/src/connector-authorization-routes.ts`, `apps/authorizer/src/app.ts`, API connector authorization routes, and the current Compose/systemd/image definitions.
- No backend authorization, migration, runtime, host, or infrastructure files were changed for this handoff.

## Blocking contract discrepancies for Codex #1

### 1. Durable broker operations are not transportable across the process boundary

PR #45 implements `consumeForBroker()`, `beginSyntheticSubmission()`, and `recordSyntheticProviderEvent()` as `PostgresConnectorAuthorizationStore` methods. Those methods are currently called only in-process by database tests and the `SyntheticBrokerHarness` test adapter. `apps/authorizer/src/connector-authorization-routes.ts` exposes grant request, read, decision, and revoke operations; it does not expose broker admission, submission-start, event-record, or recovery operations. The API has no broker execution route and the worker does not invoke the connector attempt lifecycle.

Consequently, a separate broker with no database credentials cannot currently:

1. Ask the authorizer to atomically consume a grant and obtain the persisted attempt/envelope.
2. Ask the authorizer to commit `submitting` before a provider call.
3. Persist provider outcome/unknown state or recover an orphaned `submitting` attempt.
4. Independently confirm current revocation/replay state before the fake-provider boundary.

The broker must not call the database directly, trust a worker-supplied `approved` flag, or keep an in-memory substitute for the authorizer's durable state.

**Codex #1 handoff requested:** define and implement the authorizer-side, broker-only IPC contract for the three lifecycle methods, including `consumeForBroker` (or document which trusted caller owns that method), strict request/response schemas, bounded request sizes, idempotency, fail-closed errors, service identity authentication, and audited state transitions. Preserve the existing transaction/migration source of truth. Specify how the broker obtains a stable attempt ID/envelope without accepting caller-supplied owner identity. Add authorizer/API integration tests for unauthorized peers, repeated requests, revoked/expired grants, and unknown outcomes.

### 2. Current authentication is not broker-specific

The authorizer app currently protects internal routes with one static `x-omnis-authorizer-token` and an OS-owned socket. The PR B contract requires a platform-authenticated broker peer, but it does not specify a broker identity/token or the route-level authorization rule. The existing authorizer socket group is shared by API and authorizer, not the broker. Adding the broker to that group and handing it the API token would create a new, undocumented trust relationship.

**Codex #1 handoff requested:** specify an independently attributable broker service identity and authorization rule for each new lifecycle route. The broker must not receive the signing private key, runtime database credential, authorizer database credential, API-authorizer token, or any credential that grants owner decision/revocation routes. Platform work will add the OS socket and UID/GID enforcement after this identity contract is fixed.

### 3. No network fake-provider endpoint exists in the reviewed base

`DeterministicSyntheticProvider` in `packages/runtime-adapters/src/synthetic-broker.ts` is an in-memory test double. Its own comment states that it has no sockets, credentials, DNS, or provider URLs. The reviewed Compose file defines PostgreSQL only. There is no fake-provider HTTP endpoint or isolated provider network to which a platform policy can allow exactly one destination.

The in-memory provider can test broker lifecycle logic, but it cannot prove that a network policy permits the intended fake endpoint while denying public, metadata, private-host, DNS, proxy, and redirect paths. A positive request over an in-memory interface is not an egress positive control.

**Ownership handoff requested:** Codex #1 should confirm whether the existing synthetic-provider harness is intentionally in-process only. If a network endpoint is part of PR #45's contract, provide its exact protocol, fixed address/service name, response/event semantics, and redirect behavior. Otherwise platform PR C will add a dedicated fake-only endpoint and isolated test topology; it will not treat that new endpoint as existing backend infrastructure.

## Platform work that remains valid after the handoff

Once the broker lifecycle IPC contract is fixed, PR C can add:

- A standalone broker package/process with a distinct non-root identity, a private socket, Linux peer-UID verification, strict versioned schemas, and explicit Ed25519 public trust-anchor configuration.
- A broker-only authorizer client. Startup and requests fail closed if the authorizer socket, peer identity, trust anchors, authorization response, durable state, or fake-provider endpoint is unavailable.
- No signing key, database credential, Docker socket/group, host home, OAuth path, broad mount, or unrelated service socket in the broker runtime.
- A fixed synthetic provider adapter, no caller-provided URL, redirects disabled, and an OS/container egress policy that exposes only the fake endpoint with positive and negative network controls.
- Disposable integration tests covering socket owner/group/mode, actual peer UID/GID, envelope binding, replay/revocation/expiry, unknown submission recovery, cancellation semantics, resource limits, Docker denial, egress, and synthetic canary absence.
- A disabled-by-default systemd unit and test-only container/image integration. No owner-host provisioning or activation.

The implementation will reuse the PR #45 envelope and durable attempt tables. It will not introduce a broker-side grant store or alter authorization migrations.

## Required positive and negative proof

| Area               | Positive control                                                                                               | Negative control                                                                                                                    | Current base evidence                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Authorization      | Valid persisted grant, matching request digest and trust anchor produces one attempt.                          | Wrong audience/key/digest/correlation, expired/revoked grant, changed scope, or unknown authorizer fails before provider call.      | Envelope and store tests exist; no broker transport.                      |
| IPC peer           | Approved worker UID reaches only the broker request socket; broker reaches only broker lifecycle IPC.          | Wrong UID/GID, forged owner, unexpected fields, oversized body, duplicate/replayed attempt are rejected.                            | No broker socket or peer protocol.                                        |
| Submission         | One authorized request yields one deterministic fake submission.                                               | Replayed envelope, uncertain prior submit, restart, unavailable authorizer do not resubmit.                                         | In-process harness tests cover some lifecycle cases; no process boundary. |
| Egress             | Broker can reach the fixed fake endpoint.                                                                      | Public internet, metadata, host/private addresses, alternate DNS, proxy, redirect, and arbitrary URL attempts fail.                 | No network fake endpoint or broker egress policy.                         |
| Secret containment | Synthetic canary is not present in caller-visible output or records.                                           | Canary reads/leaks through env, argv, filesystem, socket, logs, DB events, serialized response, or container metadata are rejected. | Existing mock canary tests are unrelated to the new broker process.       |
| Platform           | Effective UID/GID/groups, socket ACLs, capabilities, mounts, and process limits match the deployment contract. | Broker lacks Docker access, credentials, broad host mounts, and ambient tool/process effects.                                       | Existing G5 CI evidence covers the mock worker/launcher split only.       |

## Trust boundary and residual risk

```text
Owner -> API -> Authorizer + PostgreSQL
                    ^
                    | broker-specific authenticated UDS lifecycle IPC (not yet implemented)
                    |
Worker -> restricted broker process -> fixed fake-provider endpoint (not yet present)

Worker -> restricted mock launcher -> rootful Docker daemon -> host kernel
                                            ^
                                            Root-equivalent trusted component; unresolved.
```

Even after PR C's synthetic process/socket/network checks pass, the rootful launcher remains host-root-equivalent. Do not place real provider credentials on that host or in any process/container controlled by that Docker daemon. Real credential custody still requires a separate protected VM/host or a separately reviewed design that removes this authority. WSL2 target verification remains distinct from disposable Linux CI and has not been performed by this branch.

## Gate disposition

- G4-3: **Partially Fixed**.
- R1-G5: **Partially Complete**.
- AO-107/AO-113: **BLOCKED**.
- Production: **Mock-only**.
- This handoff grants no authorization for provider authentication, real credentials, inference, tool execution, deployment, or owner-host provisioning.

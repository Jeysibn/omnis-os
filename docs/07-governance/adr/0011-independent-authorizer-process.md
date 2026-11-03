# ADR-0011: Independent authorizer and restricted sandbox launcher

**Status:** Proposed; implementation exists on an unmerged review branch and has not received deployment approval

**Date:** 2026-11-03

## Context

The earlier worker process loaded runtime and authorizer database credentials and exposed owner authorization routes. PR #10 moved owner decisions into a distinct authorizer process, but all local processes shared a Unix identity and the worker retained rootful Docker access. Separate Node processes, environment filenames, and PostgreSQL roles did not protect secrets against a compromised worker with those host privileges.

## Proposed decision

The authenticated API remains the owner-session and CSRF boundary. It contacts the authorizer through a private Unix-domain socket using a separate API-to-authorizer token. Only the API Unix identity belongs to the authorizer socket group. The authorizer uses only `omnis_authorizer`, derives the supported single `owner` actor after service authentication, validates request schemas, and commits decisions and their audit rows transactionally. Request IDs remain PostgreSQL-backed idempotency keys. If the response is lost after a request reaches the authorizer, the API reports `authorization_outcome_unknown`; the caller may retry with the same key or use authenticated readback.

The API, authorizer, worker, and sandbox launcher have separate systemd service identities and private environment files. The worker has the `omnis_runtime` role and access only to the fixed sandbox-launcher socket. It is not a member of the authorizer socket group or Docker group. It does not receive the authorizer or launcher database credentials, API-authorizer token, owner password hash, or API session secret. `scripts/host-security/verify-worker-boundary.sh` is intended to test those properties under the actual `omnis-worker` identity after deployment.

The privileged sandbox launcher is the only service in the rootful Docker group. Its Unix-socket API accepts only run ID, worker ID, and execution generation. Before creating a container, it uses `omnis_launcher` to verify the current unexpired run lease and the consumed, unrevoked, unexpired task-scoped `mock.execute` grant, and reserves one launch per run. It supplies a fixed digest-pinned mock image, fixed synthetic program, private workspace, no network, no extra mounts/devices/environment, and fixed resource limits. The launcher is part of the trusted computing base because Docker group membership is effectively host-root authority.

## Security boundary and limitations

This proposal provides host-level separation only when the reviewed systemd units, service identities, secret ownership, and socket permissions are actually installed and verified. The development shell remains same-identity convenience mode. The units and setup scripts are not automatically installed by this change, and host-level probes were not run in the implementation environment. Until a deployment passes those probes, G4-3 remains partially fixed.

A compromised worker may still request the fixed mock operation for a valid currently leased and authorized run through its allowed launcher socket. It cannot choose Docker configuration or obtain authorizer authority. Runtime and authorizer database credentials remain subject to PostgreSQL availability and contention limitations. The local single-owner design attributes decisions to `owner` after the trusted API authenticates its session; it is not a multi-user identity or step-up approval system. The static API-authorizer token requires coordinated rotation and does not authenticate arbitrary host principals independently of socket/file permissions.

The worker's launcher request cannot authorize a real provider call, provide arbitrary commands, or inject a credential. No provider credential is present. The launcher does not make a compromised host, kernel, Docker daemon, launcher, or trusted API safe. The mock-only workload and all existing PostgreSQL grant, lease, fencing, audit, and cancellation checks remain in force.

## Consequences

- API and authorizer secrets are separated from worker and launcher configuration by dedicated service users and `0600` files in the proposed host deployment.
- API owner decisions remain transactional and auditable; a lost response is represented as unknown rather than definite rollback.
- Docker-daemon access is removed from the worker and concentrated in one narrow launcher, reducing the worker's direct host authority while making the launcher a high-value trusted service.
- Local `pnpm dev` does not reproduce the host isolation boundary.
- The service identity setup, secret installer, systemd units, and worker-boundary verifier require independent review and actual deployment verification before this ADR can be accepted.
- ADR-0010 remains Proposed. Provider credential brokering, short-lived per-run credentials, independent revocation enforcement, a separate audit sink, constrained egress, and provider-specific policy remain future gates. No inference, provider credentials, or general-purpose tool execution is authorized by this proposal.

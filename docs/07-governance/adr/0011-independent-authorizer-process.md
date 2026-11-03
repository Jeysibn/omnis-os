# ADR-0011: Independent authorizer and restricted sandbox launcher

**Status:** Proposed; implementation exists on an unmerged review branch and has not received deployment approval

**Date:** 2026-11-03

## Context

The earlier worker process loaded runtime and authorizer database credentials and exposed owner authorization routes. PR #10 moved owner decisions into a distinct authorizer process, but all local processes shared a Unix identity and the worker retained rootful Docker access. Separate Node processes, environment filenames, and PostgreSQL roles did not protect secrets against a compromised worker with those host privileges.

## Proposed decision

The authenticated API remains the owner-session and CSRF boundary. It contacts the authorizer through a private Unix-domain socket using a separate API-to-authorizer token. Only the API and authorizer service identities belong to `omnis-authorizer-socket`; the API, authorizer, worker, and launcher each have private primary groups. The authorizer uses only `omnis_authorizer`, derives the supported single `owner` actor after service authentication, validates request schemas, and commits decisions and their audit rows transactionally. Request IDs remain PostgreSQL-backed idempotency keys. If the response is lost after a request reaches the authorizer, the API reports `authorization_outcome_unknown`; the caller may retry with the same key or use authenticated readback.

The API, authorizer, worker, and sandbox launcher have separate systemd service identities, private primary groups, and private environment files. The worker has the `omnis_runtime` role and is a member only of its own primary group and the dedicated `omnis-launcher-socket` group. The launcher has a private primary group and the same narrow socket group; only the API and authorizer share the separate `omnis-authorizer-socket` group. The worker is not a member of the authorizer socket or Docker group. Its secret file is not shared with the launcher. `scripts/host-security/install-application-tree.sh` copies the checkout to a new root-owned `/opt/omnis-os` deployment, excludes local environment files, and rejects broken or escaping dependency symlinks; it never changes ownership of the checkout. `scripts/host-security/verify-worker-boundary.sh` checks all deployed code and dependency paths as the actual worker identity. Local `configure:owner` uses a private user-owned temp directory; the deployment secret installer rewrites service socket endpoints to the systemd runtime paths.

The privileged sandbox launcher is the only service in the rootful Docker group. Its Unix-socket API accepts only run ID, worker ID, and execution generation. Before creating a container, it uses `omnis_launcher` to verify the current unexpired run lease and the consumed, unrevoked, unexpired task-scoped `mock.execute` grant, and reserves one launch per run. It supplies a fixed digest-pinned mock image, fixed synthetic program, private workspace, no network, no extra mounts/devices/environment, and fixed resource limits. The launcher is part of the trusted computing base because Docker group membership is effectively host-root authority.

## Security boundary and limitations

This proposal provides host-level separation only when the reviewed systemd units, service identities, secret ownership, protected application tree, and socket permissions are actually installed and verified. The API requires an explicit authorizer socket. It accepts only `/run/omnis-authorizer/authorizer.sock` for deployment or a socket inside a private, non-symlink temporary directory owned by the API process for disposable integration tests; shared `/tmp` endpoints fail startup. The development shell remains same-identity convenience mode. Until a disposable systemd deployment passes the host probes, G4-3 remains partially fixed.

A compromised worker may still request the fixed mock operation for a valid currently leased and authorized run through its allowed launcher socket. It cannot choose Docker configuration or obtain authorizer authority through its service identity. Runtime database credentials remain subject to PostgreSQL availability and contention limitations. The local single-owner design attributes decisions to `owner` after the trusted API authenticates its session; it is not a multi-user identity or step-up approval system. The static API-authorizer token requires coordinated rotation and does not authenticate arbitrary host principals independently of socket/file permissions. Per-request signed owner-decision assertions, HMAC binding of method/path/body/time/request ID, a replay ledger, and zero-downtime token rotation are explicitly deferred to the real-provider approval gate; the present static token plus OS-owned socket is scoped to the single-owner synthetic mock deployment and is not evidence for provider authorization.

The worker's launcher request cannot authorize a real provider call, provide arbitrary commands, or inject a credential. No provider credential is present. The launcher does not make a compromised host, kernel, Docker daemon, launcher, or trusted API safe. The mock-only workload and all existing PostgreSQL grant, lease, fencing, audit, and cancellation checks remain in force.

## Consequences

- API and authorizer secrets are separated from worker and launcher configuration by dedicated service users and `0600` files in the proposed host deployment.
- The API requires the provisioned authorizer socket path; a shared `/tmp` fallback is rejected. The worker-launcher socket group is separate from the API-authorizer socket group.
- The root-owned application installer rejects dependency symlinks that escape `/opt/omnis-os`; the host verifier checks all code and dependency entries under the worker identity. The source checkout ownership is not changed.
- API owner decisions remain transactional and auditable; a lost response is represented as unknown rather than definite rollback.
- Docker-daemon access is removed from the worker and concentrated in one narrow launcher, reducing the worker's direct host authority while making the launcher a high-value trusted service.
- Local `pnpm dev` does not reproduce the host isolation boundary.
- The service identity setup, secret installer, systemd units, and worker-boundary verifier require independent review and actual deployment verification before this ADR can be accepted.
- ADR-0010 remains Proposed. Provider credential brokering, short-lived per-run credentials, independent revocation enforcement, a separate audit sink, constrained egress, and provider-specific policy remain future gates. No inference, provider credentials, or general-purpose tool execution is authorized by this proposal.

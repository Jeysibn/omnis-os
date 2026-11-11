# P0-R2.2 Security-Gated Rootless Harness Implementation Plan

**Status:** Documentation and static planning only. No implementation or test execution is authorized by this plan.
**Source baseline:** `a830aeb28f388ab7b569ce5f61c663e6e0c461c2`.
**Approved P0-R2.1 snapshot:** all three supplied SHA-256 values were verified before this plan was prepared (see Snapshot verification).
**Decision state:** candidate architecture only; not implemented, tested, target-host validated, or approved for operation.
**Review state:** Codex #1 and Claude #1 requested targeted corrections to this plan; neither approved Stage A implementation.

## Snapshot verification

The incoming P0-R2.2 plan matched the supplied review target `d0eb7f1823f02804dc8ed28fc7b35972df3b05d2cca70ef313e9371767d09623` before edits.

The approved P0-R2.1 documents match the owner-provided SHA-256 values exactly. They are untracked in the isolated design worktree, absent from the source baseline tree, and were not modified for P0-R2.2.

| Approved document | SHA-256 | Result |
|---|---|---|
| `P0_R2_1_ROOTLESS_COMPATIBILITY_HARNESS_DESIGN.md` | `8ac6c3b47bfe52ef6c59cd5a61c2ebef35744b22c0dac938a73308b809defc69` | MATCH |
| `P0_R2_DOCKER_ONLY_PROOF_REGISTER.md` | `c4f26154162e2db5147d1e6fe25d1a300fa45ebb59914f08806fa4f0a2e36eab` | MATCH |
| `PHASE1_DOCKER_ONLY_PLATFORM_READINESS.md` | `10913421771e9dcbca6e3c43b768387c114324757148970b8b7c05ca12c8a401` | MATCH |

The supplied Codex #1 and Claude #1 approvals are taken as owner-provided planning authorization. They do not authorize implementation, provisioning, execution, CI, or changes to system configuration. The proof register needs no correction for this planning artifact; no evidence level or status has advanced.

## Scope and hard boundaries

This plan breaks implementation into reviewable work packages and later separately authorized test stages. It does not select unresolved operational identities, write gateway code, add a harness, specify a runnable topology file, create a container image, or change existing source.

- The final Docker-only topology remains a candidate. The transitional host-managed launcher does not satisfy Docker-only readiness.
- A launcher must never receive the raw Runtime Engine socket. The Core Engine and application worker must never receive it either.
- **Gateway compromise or unrestricted Runtime Engine socket access grants full administrative control of that Engine.** This plan does not claim that the gateway can contain its own compromise.
- A compromised launcher is a different threat case: it may issue arbitrary requests to its exposed policy protocol, but the gateway and outer host/network/quota controls must still enforce the approved subset.
- Docker AuthZ alone is insufficient. In particular, gRPC/upgrade/streaming/parser paths need rejection or complete independent coverage at the gateway.
- Rootless mode reduces daemon host privilege; it does not narrow a caller's authority over that daemon.
- A failure of independent API policy, external egress denial, or non-removable aggregate limits blocks the Runtime Engine candidate.
- No Phase A experiment, protected runtime activation, provider inference, fixture execution, deployment, live Stage 1 integration, or release-capable implementation is permitted.

### Stage A is pure-function-only

If separately authorized, Stage A may implement only versioned request/response data schemas; pure byte-decoding and parsing; validation and canonicalization; deterministic policy evaluation; synthetic capability validation; deterministic request hashing; in-memory idempotency/replay state transitions; and bounded structured error/audit-record generation. Unit tests use synthetic in-memory values only. Functions take explicit byte arrays, test peer identities, test capabilities, policy values, and replay-state values as arguments, then return values without external effects.

Stage A must not bind, create, connect to, or listen on sockets; start any server/listener/background service; spawn processes or containers; connect to Docker, PostgreSQL, or any host service; discover Docker configuration; read daemon endpoints or real credentials; issue, sign, or consume real authorization; modify a database, daemon, firewall, namespace, or WSL configuration; perform runtime launch operations; trigger CI; or create a disposable environment. Stage A must be testable offline without Docker, PostgreSQL, network access, or host privilege. Describing the future UDS transport below is a protocol specification only; no listener is part of Stage A.

## Proposed trust boundaries

```text
Core rootless Engine (Core service identity and data root)
  API ── reviewed private IPC ── Authorizer / capability issuer
  Worker ── reviewed private IPC ── Restricted launcher
                                           │ narrow protocol only
                                           ▼
Host-controlled policy UDS ── Runtime API Policy Gateway
                                  │ sole Runtime Engine socket holder
                                  ▼
                           Runtime rootless Engine
                                  │ exact fixed mock image/config only
                                  ▼
                           Synthetic runtime

Host OS/kernel, filesystem quotas, parent cgroups, network namespace and
external IPv4/IPv6 policy are outside launcher control and remain trusted.
No Core/Runtime Docker socket, daemon credential, data root or network is shared.
```

The diagram describes trust direction, not a selected deployment mechanism. In particular, packaging the gateway as a container under the Runtime Engine does not make it independent of that daemon. The implementation design must state who provisions, starts, updates, and recovers the gateway, and how the daemon's API cannot replace the gateway policy or obtain an alternate socket path. The owner and Codex #1 must approve that boundary before implementation.

## Trusted computing base

| TCB component | Security authority and compromise impact | Required integrity control / proof |
|---|---|---|
| Runtime API Policy Gateway | Holds unrestricted Runtime Engine socket authority. Compromise permits full administration of Runtime Engine, including stopping/removing workloads, creating new ones, mounting paths the daemon account can read, changing networks and exhausting resources within outer limits. | Minimize code and dependencies; reviewed protocol and parser; immutable verified artifact/config; distinct operator update path; no launcher write access; audit identity/digest; test a compromised launcher against the intact gateway. Gateway compromise is not claimed contained. |
| Runtime Engine daemon and service identity | Controls all runtime containers, images, networks, volumes, and daemon-readable host paths available to its rootless account. | Dedicated account, disjoint subordinate UID/GID ranges and data root; no Core/owner files; outer cgroup, filesystem quota and no-uplink policy; daemon/API inventory; restart and stale-workload proofs. |
| Independent Runtime containment supervisor | Holds authority to close admission and terminate a Runtime service/run cgroup without relying on gateway or Docker API. Compromise/unavailability can defeat bounded active-run termination. | Separate host-controlled identity and policy, no launcher/gateway write access, fixed maximum deadline, exact scope inventory and fail-closed startup. Per-run mapping is unproven; whole-service-scope kill is the fallback test candidate. |
| Core Engine daemon and service identity | Controls application containers, Core volumes, and secrets mounted to Core services. | Separate rootless account, subuid/gid mapping, socket, data root and private network; Runtime account and gateway cannot access Core socket/data; Core services receive no Runtime socket. |
| Gateway policy and capability issuer | Policy can authorize synthetic operations; issuer can mint capabilities that the gateway accepts. A compromised issuer can authorize malicious or replayed operations within gateway policy. | Codex #1 defines issuer, signing/verification, audience, scope, expiry, revocation, generation, key custody/rotation and durable consumption. Gateway policy additionally bounds what any capability can request. |
| Unix socket ownership and peer authentication | Filesystem permissions and peer credentials decide which service reaches authorizer, launcher and gateway protocols. | Owner-controlled socket directories, exact mode/UID/GID, no symlink or inherited-FD bypass, peer credential checks, credential rotation, UID translation tests. Target mappings are UNPROVEN. |
| Host OS, kernel and operator | Kernel namespaces, cgroups, network and filesystem policy underpin all rootless isolation. Host operator can alter policy, read test data or expose sockets. | Host/kernel are explicitly trusted for these tests. Isolate disposable guest; record versions and changes; keep secrets and owner files out; two-person or owner-reviewed change log for privileged provisioning and cleanup. |
| Filesystem isolation | Runtime daemon can access every path readable by its account; mounts can expose persistent data and secrets. | Separate Runtime data filesystem/root with hard block and inode caps; no owner, Windows, repository, Core, credential or backup-key paths; API policy denies bind mounts. Canary denial tests. |
| Network enforcement | RootlessKit and rootless network helpers can create user-mode forwarding; launcher-supplied `network=none` is not an outer control. | Host-managed no-uplink namespace and external v4/v6 denial around daemon plus helpers; no host/Windows/Core routes; no publish/forward path. Test alternate API network modes with private dummy sinks. |
| Aggregate resource/quota enforcement | Runtime daemon and its descendants can consume CPU, memory, PIDs, disk, inodes and logs. | Parent cgroup v2 limits and fixed quota-backed runtime filesystem controlled outside the launcher/gateway policy. Verify effective limits; unsupported or ignored controls fail. |
| Host operator and secret custody | Operator can provision daemon accounts, trust roots, issuer keys and test credentials; misuse defeats isolation. | Synthetic-only credentials, explicit owner custody and recovery, no reuse of application/provider secrets, short-lived disposable keys, inventory and destruction evidence. |

**Threat separation:** launcher-compromise tests prove that the gateway plus outer controls reject arbitrary launcher input. They do not prove safety after gateway, daemon, host-kernel, policy-issuer, or host-operator compromise. Those remain trusted components or separate threat-models. If an owner requires containment of gateway compromise, the current candidate is inadequate until a separate daemon/host boundary is specified and approved.

## Future launcher-to-gateway wire contract

This section specifies a future protocol. **It does not authorize or implement a socket/listener in Stage A.** Proposed transport is one local `AF_UNIX/SOCK_STREAM` connection per request, created by a trusted future launcher and accepted by a separately supervised gateway. Kernel peer credentials identify the connecting service; an operation-scoped signed capability supplies authorization. UDS path ownership, cross-engine UID mapping and peer-credential behavior remain unproven and require Codex #1 review plus later Stage B/C evidence. No TCP, HTTP, Docker API, or general proxy is exposed to the launcher.

### Framing and byte representation

Candidate wire version 1 uses exactly one frame per connection:

1. Four-byte unsigned big-endian payload length `N`.
2. Exactly `N` bytes of UTF-8 JSON payload.
3. Client half-closes its write direction; gateway returns one framed response and closes.

Request payload limit: 65,536 bytes. Response payload limit: 16,384 bytes. A zero length, truncated prefix/body, extra byte after the declared payload, second frame, missing client write-half-close, or deadline expiry is malformed and closes the connection without authorization evaluation. Server-side maximum concurrent connections, read/write duration, and total output bytes must be fixed outside caller input. Proposed caps are planning values; Codex #1 must approve exact limits before Stage A authorization.

This framing is selected over HTTP/1.1 chunked framing because it has one unambiguous length and no headers, transfer-encoding rules, URL parser, pipelining, or upgrade semantics. It does not prove the future gateway-to-Docker HTTP client safe; those tests belong to Stage B. Codex #1 must confirm the UDS stream + length-prefix choice or select a competing length-delimited record transport before Stage A is separately authorized. If transport/half-close semantics or cross-engine UDS identity cannot be specified without ambiguity, Stage A remains blocked.

Payload encoding is UTF-8 JSON conforming to RFC 8785 JSON Canonicalization Scheme for hash/signature byte derivation, with stricter gateway rules: reject duplicate object keys before canonicalization; reject unknown fields; reject invalid UTF-8, unpaired surrogates, non-finite numbers and floats; permit only bounded exact integers in the interoperable range; restrict identifiers/enums/digests to ASCII; do not Unicode-normalize strings; and require lower-case canonical UUID and digest syntax. Input object key order and whitespace do not affect canonical bytes. The parser must preserve enough raw input to detect duplicate keys before converting to a map. Validate every encoded binary field’s alphabet, padding policy, field-specific decoded length and decode/re-encode identity before constructing the validated semantic object or hashing it. Canonicalization output is UTF-8 JCS bytes with no trailing newline.

### Request schema deliverables

Version 1 top-level object has exactly these fields:

| Field | Type and rule |
|---|---|
| `protocol_version` | Integer `1`; any other value is `UNSUPPORTED_VERSION`. |
| `request_id` | Canonical RFC UUID; unique correlation ID for one exchange only. It grants no authority and is not the idempotency key. |
| `operation_id` | Canonical RFC UUID; stable across retries of one logical operation. |
| `operation` | Exact enum: `launch`, `inspect`, `read_output`, `cancel`, `reconcile`. |
| `arguments` | Operation-specific exact object from the table below; no extensions in version 1. |
| `request_hash` | Canonical unpadded base64url encoding of a 32-byte SHA-256 digest (exactly 43 characters; decode/re-encode identity required) over canonical semantic request bytes below. |
| `capability` | Exact signed envelope below. No bearer token or arbitrary credential field. |

Operation-specific `arguments` fields:

| Operation | Required fields | Restrictions |
|---|---|---|
| `launch` | `run_id`, `generation` | Run ID is canonical UUID; generation is integer `1..2^31-1`. Image, command, environment, network, mounts, resources and ports are not caller fields. |
| `inspect` | `run_id`, `generation` | Resolves only an operation-owned run; no daemon ID/name/query. |
| `read_output` | `run_id`, `generation`, `cursor`, `max_bytes` | Cursor is canonical unpadded base64url, 1..128 characters, with decode/re-encode identity and no padding; `max_bytes` is integer `1..8192`; no arbitrary log path/stream. |
| `cancel` | `run_id`, `generation`, `reason_code` | Reason is exactly `owner_requested`, `run_deadline`, or `authorization_revoked`; targets the exact generation; cancellation is idempotent. |
| `reconcile` | `run_id`, `generation` | Uses top-level `operation_id` for the read-only status/recovery query; never starts or recreates a missing container. |

The semantic request object for hashing consists of exactly `protocol_version`, `operation_id`, `operation`, and `arguments`; `request_id`, `request_hash`, and `capability` are excluded. Thus a retry can use a fresh request ID while the same operation ID and semantic request have the same hash.

`request_hash = SHA-256(ASCII("OMNIS-OS-RUNTIME-REQUEST") || 0x00 || uint16_be(protocol_version) || JCS(semantic_request))`.

JCS duplicate-key detection happens before hashing. The hash uses no host-dependent serialization, locale, wall clock, random value, HTTP bytes, or mutable policy lookup. Capability claims bind this hash. Any argument change creates a different hash. The fixed ASCII domain string prevents the same canonical bytes being reused as a digest for another protocol purpose.

Replay rules for the pure reducer are: a new operation ID/JTI pair may be evaluated once; the same operation ID and same semantic hash returns only the previously recorded/reconciled result and can never produce a fresh dispatch permit; the same operation ID with a different hash is `REPLAY_CONFLICT`; the same JTI bound to another operation/hash is `AUTHORIZATION_FAILURE`; and a prior `pending`/`unknown` state is `OUTCOME_UNKNOWN` until a later reconciliation input resolves it. `request_id` is only a response correlation value and cannot make a replay new. Future durable capability consumption/operation journaling and transaction order remain Codex #1 decisions; the Stage A reducer models values in memory only.

### Synthetic capability representation and signature contract

Version 1 envelope has exactly `protected`, `claims`, and `signature`:

| Member | Fields |
|---|---|
| `protected` | `typ` = `omnis-runtime-cap+jcs`; `version` = 1; `alg`; `kid`. Unknown fields and algorithm/key downgrade are rejected. |
| `claims` | `iss`, `aud`, `sub`, `scope`, `authorization_id`, `lease_id`, `run_id`, `task_id`, `project_id`, `operation_id`, `operation`, `generation`, `request_hash`, `policy_digest`, `restrictions`, `jti`, `not_before`, `expires_at`. |
| `signature` | Unpadded base64url signature over canonical protected and claims bytes. |

Claim field types/rules: `iss` and `aud` are configured ASCII identifiers of 1..128 bytes; `sub` is a peer-principal identifier of 1..128 ASCII bytes; `scope` and `operation` are exact enums; `kid` is 1..64 ASCII bytes; `authorization_id`, `lease_id`, `task_id`, and `project_id` are 1..128 ASCII bytes and use the application's canonical identifier form (never paths or free-form text); `run_id`, `operation_id`, and `jti` are lower-case UUIDs; `generation` is integer `1..2^31-1`; `request_hash` is exactly 43 canonical unpadded base64url characters encoding 32 bytes; `policy_digest` is `sha256:` followed by 64 lower-case hex characters; `not_before` and `expires_at` are integers `0..2^53-1` Unix seconds with `expires_at > not_before`; `alg` is exactly case-sensitive `Ed25519`; `signature` is exactly 86 canonical unpadded base64url characters encoding 64 bytes. The complete request remains <=65,536 bytes; JSON nesting depth is <=8, arrays are forbidden in v1, and no other variable-length fields exist.

`aud` is exactly the Runtime Policy Gateway identity. `sub` must equal the subject derived from verified peer identity; it is never taken from request input. `scope` must be exactly `synthetic_runtime`; there is no implicit scope conversion. Run/task/project, operation ID/enum, generation, request hash, policy digest, and restrictions must match the request and locally approved fixed policy. `restrictions` binds fixed image digest, command profile, no-egress network profile, no-secret environment profile, scratch profile, resource profile, maximum runtime, and maximum output. `jti` is a bounded unique capability identifier for replay tracking. Times are bounded integer Unix seconds and checked against an injected clock value in pure evaluation; production clock trust is a later platform decision.

`restrictions` is an exact object: `image_digest` (`sha256:` plus 64 lower-case hex), `command_profile` (`mock-v1`), `network_profile` (`isolated-no-egress-v1`), `environment_profile` (`synthetic-nonsecrets-v1`), `scratch_profile` (`bounded-run-scratch-v1`), `resource_profile` (1..64 ASCII bytes naming a reviewed fixed policy), `max_runtime_ms` integer `1..300000`, and `max_output_bytes` integer `1..1048576`. `read_output.max_bytes` is additionally capped at 8192. These are proposed schema ceilings for review, not measured workload needs. The object cannot carry arbitrary environment entries, commands, ports, mounts, devices, URLs, provider names, or credentials. Codex #1 must approve which constraints are authority claims versus policy-derived limits; capability values may only tighten fixed policy, never expand it.

Signed bytes are `ASCII("OMNIS-OS-RUNTIME-CAPABILITY") || 0x00 || JCS(protected) || 0x00 || JCS(claims)`. Ed25519 is the sole eventual production algorithm. Public keys are exactly 32 decoded bytes / 43 unpadded base64url characters; signatures are exactly 64 decoded bytes / 86 characters. Only `[A-Za-z0-9_-]` is accepted, without padding. This rule covers every base64url field, including public key, signature, request hash, output `data`, `next_cursor`, input cursor and any encoded audit hash/JTI hash; digest values explicitly specified as lowercase hex remain hex. For every base64url field, require decode/re-encode identity, rejecting invalid alphabet, padding, wrong length and nonzero unused bits. Fixed 32-byte values encode to exactly 43 characters; fixed 64-byte values to exactly 86. Variable data is bounded by its field limit and must still be canonical. No negotiation, fallback, MAC or unknown `kid` is accepted. Verify the domain-separated bytes above using the exact trusted issuer/kid mapping. Decode, lookup or verification failure gives `AUTHORIZATION_FAILURE`, `capability_invalid`, `deny`, `not_attempted`: no dispatch or authorization consumption. Gateway and launcher must never possess the production issuer private key. Stage A permits only injected synthetic verification and in-memory fixtures; no signing-key creation, production issuance or cryptographic assurance. Production custody, secure rotation, revocation and clock trust require later authorization.

Stage A uses only synthetic in-memory claims and a test-only verifier function/key fixture supplied by unit tests. Later production verifier requirements are stricter and remain a later-stage gate: use a maintained, reviewed Ed25519 implementation with explicit strict verification semantics; reject noncanonical point encodings, noncanonical scalar `S` (including `S >= L`), invalid or small-order public keys, malformed signatures, and any verification result other than success. Enforce exact 32-byte public-key and 64-byte signature inputs before calling it; do not accept permissive decoding, cofactor-relaxed verification, fallback algorithms, or exceptions as success. Bind the trusted key to issuer and `kid`, key validity/revocation state, audience and domain-separated signed bytes. Production key provisioning, rotation, revocation propagation and clock policy require owner approval and security review. These requirements do not authorize production verifier work in Stage A. It does not issue/sign/consume real capabilities, read keys from files/environment, or perform external authorization. Unit tests verify canonical signed-byte construction and claim-to-peer/request binding; cryptographic assurance is explicitly not claimed by a stub verifier.

### Response schema and outcome semantics

Version 1 response has exactly `protocol_version`, `request_id`, `operation_id`, `classification`, `policy_decision`, `reason_code`, `policy_digest`, `effect_state`, and `result`. `protocol_version` is always `1`; `request_id` and `operation_id` are canonical UUIDs when safely parsed, otherwise `null`; `result` is `null` or an operation-specific bounded object. A malformed frame that cannot contain a response closes without one; a complete frame with malformed payload receives a bounded v1 error response where possible. Classifications are:

| Classification | Meaning |
|---|---|
| `PERMITTED` | Pure policy evaluation permits the requested operation; this does **not** mean a daemon mutation was attempted or committed. |
| `POLICY_DENIAL` | Request is well-formed/authenticated but violates fixed policy or lifecycle rules. |
| `MALFORMED_REQUEST` | Framing, encoding, schema, duplicate key, canonical form or size is invalid. |
| `UNSUPPORTED` | Unknown protocol version, operation, enum or unsupported capability version. |
| `REPLAY_CONFLICT` | Operation ID was previously bound to a different semantic request or a prohibited repeat. |
| `AUTHORIZATION_FAILURE` | Synthetic capability invalid, expired, revoked, out of scope, wrong subject/audience/generation, or mismatch. |
| `OUTCOME_UNKNOWN` | A future external mutation may have reached the Engine but its result cannot be established. Reconciliation is required; automatic replay is forbidden. |
| `INTERNAL_FAILURE` | Unexpected failure. Before mutation it fails closed with `effect_state=not_attempted`; after possible dispatch it must be `unknown`, never assumed denied. |

`reason_code` is a fixed enum, never free text: `permitted`, `policy_denied`, `frame_invalid`, `encoding_invalid`, `schema_invalid`, `unsupported_version`, `unsupported_operation`, `peer_mismatch`, `capability_invalid`, `capability_expired`, `capability_revoked`, `scope_mismatch`, `generation_mismatch`, `request_hash_mismatch`, `replay_conflict`, `dependency_unavailable`, `engine_rejected`, `outcome_unknown`, or `internal_failure`. Unknown internal detail is not returned. `policy_digest` is the active fixed policy digest when known, otherwise `null`.

`policy_decision` is `allow`, `deny`, or `not_evaluated`. `effect_state` is `not_attempted`, `pending`, `committed`, `rejected`, or `unknown`. Pure Stage A evaluators may only return `not_attempted`; they cannot claim whether an Engine request committed. A future gateway may report `committed` or `rejected` only after authoritative daemon reconciliation. A timeout, connection loss, gateway crash, or response loss after possible dispatch maps to `OUTCOME_UNKNOWN` + `effect_state=unknown`. `result` is operation-specific, bounded and redacted; no raw daemon response is returned. Reason codes are fixed enums without exception text, stack traces, credentials, capability bytes or host paths.

Operation-specific `result` schemas contain no daemon IDs or raw Docker responses:

| Operation | Result fields |
|---|---|
| `launch` | `run_id`, `generation`, `state` (`pending`, `running`, `completed`, `interrupted`, `unknown`), `output_cursor` or `null`. |
| `inspect` | `run_id`, `generation`, `state`, closed `exit_class` below or `null`, `output_cursor` or `null`. |
| `read_output` | `run_id`, `generation`, canonical unpadded base64url `data` (decode/re-encode identity), canonical `next_cursor`, `truncated` boolean. Data length is <= fixed output cap. |
| `cancel` | `run_id`, `generation`, `state` (`cancelling`, `cancelled`, `unknown`). |
| `reconcile` | `run_id`, `generation`, `state`, `reconciliation_class` (`matched`, `missing`, `unexpected`, `unknown`); never an instruction to launch. |

For malformed, unsupported, authorization-failure, policy-denial, replay-conflict and internal-failure responses, `result` is `null` except a safe bounded state summary required for reconciliation. Unknown mutation outcomes never include a retry suggestion that would create a new launch.

Audit record fields are bounded: schema version, request/operation IDs, operation enum, derived peer role (not raw credentials), capability `kid`/`jti` hash, request hash, policy digest, classification, reason code, effect state, bounded duration bucket, and monotonic local sequence. Maximum serialized record is 4 KiB. No signature, token, secret, raw request body, canary contents, arbitrary path or daemon response is recorded. Audit storage, integrity protection and durability are later decisions; audit failure must not convert denial to allow.

### Runtime versus milestone authorization separation

**Invariant: a runtime-operation capability cannot authorize milestone mutations.** Runtime scope is exactly `synthetic_runtime`, audience is the Runtime Policy Gateway, resource is a run/task/project tuple, and operations are limited to the runtime enum. Milestone scope, audience, resource IDs and mutation operations are distinct and are not accepted by this protocol. No implicit scope conversion, shared mutation authority, capability substitution, or fallback to caller-supplied IDs is permitted.

The existing Authorizer-only database permissions remain unchanged. Stage A makes no database or migration changes. Stage D must test both directions: a runtime capability presented to any milestone mutation path is rejected by authorization/database permission checks with no row/event mutation; a milestone-scoped capability presented to the gateway is rejected before policy permit. Verify database role grants remain Authorizer-only. Codex #1 owns the authorization contract and database evidence.

### Future gateway module boundaries

| Module | Responsibility | Stage A status / later boundary |
|---|---|---|
| Byte decoder and schema validator | Pure exact-frame and JSON decode, duplicate detection, schema validation, bounded errors. | Stage A pure functions only; future UDS accept/read loop is Stage B/C, separately authorized. |
| Canonicalizer and request hasher | Pure JCS canonical bytes and domain-separated hash. | Stage A unit-tested test vectors; no I/O. |
| Synthetic capability validator | Pure claim checks against injected peer/policy/clock/replay state and injected test verifier. | Stage A test-only; real key loading, issuance and DB consumption prohibited. |
| Policy evaluator | Pure deterministic allow/deny for operation, synthetic capability, fixed policy and replay state. | Stage A returns decision only, never claims daemon outcome. |
| In-memory replay reducer | Pure state transition from prior in-memory state + request to new state/result. | Stage A only; no persistence, database or concurrent listener. Future durable journal is later Codex #1 design. |
| Docker request builder | Constructs fixed daemon request after external permission. | Design interface only in Stage A; no Docker SDK/config/socket discovery or daemon call. |
| Runtime object registry | Maps operation to daemon ID and protects reserved gateway identity. | Design interface only until authorized Stage B; no daemon inventory access in Stage A. |
| Response/audit serializer | Pure bounded structured classification and record generation. | Stage A no disk/log/network write; test returned values only. |
| Supervisor and independent containment | Lifecycle ownership described below. | Interface/state design only in Stage A; no process/service control. |

Stage A internal request types contain operation enums and typed fields only. They contain **no caller-controlled raw Docker method, path, query, header, arbitrary HTTP body, daemon ID, container name, or Docker API version**. Docker request reconstruction belongs to a later independently reviewed gateway implementation.

### Stage A pure unit-test matrix

These are offline unit tests over pure functions and synthetic in-memory fixtures. They do not open sockets, use HTTP framing, contact a daemon/database, or prove transport, kernel identity, Engine isolation or egress behavior. Any shell command later used to invoke the unit-test runner must run only the local pure test target and must not start services or inspect host Docker settings.

| Test | Input/property | Expected result |
|---|---|---|
| Strict schema/JSON | Valid v1 messages; missing, extra, wrong-type fields; invalid UTF-8; non-finite/float values. | Exact valid schema accepted; malformed/unknown fields rejected with stable code. |
| Duplicate keys | Duplicate top-level, nested operation, capability protected or claims key, including equal and conflicting values. | Reject before canonicalization/signature/hash evaluation. |
| Unknown fields/operations | Unknown operation, enum, future field, raw method/path/body, API version. | Unsupported or malformed; no policy allow. |
| Input limits | Pure decoder receives synthetic frame bytes at prefix/body boundary, oversize payload, excessive nesting/string/array lengths. | At/below approved caps parse; above caps fail bounded without allocation proportional to attacker-declared length. |
| Canonicalization | Key-order/whitespace variants, allowed string escaping, prohibited Unicode/number values. | Equivalent semantic input produces exact JCS bytes; forbidden values reject; golden vectors stable. |
| Deterministic request hash | Same semantic request with changed request ID/JSON formatting; changed operation ID or arguments. | Transport ID/format do not change semantic hash; semantic mutation does; domain/version separation tested. |
| Synthetic capability validation | Valid injected test capability; bad signature result, issuer/audience/subject/scope mismatch, expiry, generation, operation, digest, policy, restriction or request hash mismatch. | Only exact synthetic scope/identity/operation permits; all mismatches fail closed. |
| Identity substitution | Request attempts to supply subject/peer ID; injected peer does not match capability subject; UID role unknown. | Unknown fields reject; mismatch gives authorization failure. |
| Reserved gateway object | Run inputs include daemon ID, container name, reserved label/object ID or gateway identity. | Schema rejects such fields; policy cannot target control-plane object. |
| Policy denials | Wrong image/profile, secret/env/mount/network/resource request, prohibited operation or invalid lifecycle state. | Stable policy denial; no external side-effect claim. |
| Replay/idempotency | Same operation ID/hash repeated, same ID/different hash, pending/unknown/committed replay states, same capability JTI reused. | Deterministic reducer returns exact replay/reconcile class; no second permit for unresolved mutation. |
| Structured failure | Malformed, unsupported, authorization, policy, replay, unknown and internal cases. | Exact response fields and reason enum; <=size cap; no exception, token, key, raw payload or path leakage. |
| Runtime/milestone separation | Runtime capability substituted for milestone, milestone scope substituted for runtime, scope conversion attempt. | Both directions deny in pure validation; no shared authority. |

Only a separately authorized Stage A implementation may add these unit tests. Passing them establishes pure-function contract behavior only, not HTTP framing safety, peer authentication, live capability security, durable replay, Docker API enforcement, or any host boundary.

The proposed command shape is `<confirmed-project-test-runner> <pure-runtime-policy-test-target>` after the implementation language/build system is selected. That is a placeholder, not an existing executable command. The authorized command must invoke only pure unit tests and must be shown not to start services. No `docker`, `curl`, database, network, systemd, WSL, or privileged command belongs in Stage A.

### Stage B HTTP and Engine integration test matrix

All rows require separate owner authorization for the named disposable Linux VM and its guest-root/network privileges. Launcher-to-gateway UDS protocol remains length-prefixed JSON, not HTTP. These cases target transport hardening and the gateway's constructed HTTP/Engine boundary. Where caller bytes cannot reach the Engine HTTP layer by design, use a malicious framed-protocol client and a recording fake Engine to prove no such bytes are forwarded; use the real isolated Engine for route/result checks. Stage B results do not establish WSL or target-host behavior.

| Test | Setup/attack | Required evidence and failure condition |
|---|---|---|
| Duplicate Content-Length | Feed duplicate equal/conflicting length headers to any HTTP-facing test seam and inject header-like data through protocol fields. No public HTTP gateway listener is allowed. | Malformed at test seam; production gateway has no HTTP launcher listener; no duplicate or caller-controlled header emitted to fake/real Engine. |
| Content-Length + Transfer-Encoding | Test ambiguous headers against fake Engine boundary and protocol-injection strings. | Gateway never forwards raw bytes; if any test seam accepts ambiguity or daemon sees a second request, fail. |
| Invalid chunked framing | Truncated chunk, invalid size, extension, trailer, terminator and extra frame corpus. | Reject/close before mutation; canonical outgoing Engine request uses one fixed client encoding. |
| Request smuggling/parser disagreement | Differential client/fake Engine checks with split boundaries, pipelined bytes and smuggled second request. | One semantic operation maximum; no parser disagreement can create extra request; daemon object inventory unchanged on malformed input. |
| HTTP methods and versions | Attempt unsupported methods, protocol versions, keep-alive/pipelining, CONNECT/TRACE, alternate API version through every available ingress. | No launcher HTTP endpoint; gateway-generated API version/method fixed by implementation; unsupported input has no daemon effect. |
| Alternate URL/path encodings | Encoded slash, dot segments, double encoding, invalid escapes, Unicode, query injection and path confusion in test seam. | No caller-supplied path reaches Engine; fixed route only; all probes deny or are malformed. |
| Upgrades/streaming | WebSocket/Upgrade, hijack, attach, events, logs streaming, gRPC/`POST /grpc`. | Launcher protocol has no streaming/upgrades; only bounded polling/output operation exists; no persistent tunnel or unauthorized daemon side effect. |
| Docker API route restrictions | Enumerate known Engine route families via hostile typed requests and inspect gateway outbound requests. | Only explicit create/start/inspect/wait/bounded-output/stop/remove routes are emitted; plugins, images, networks, volumes, exec, events and daemon config denied. |
| Gateway-to-Engine parser disagreement | Recording fake Engine parses emitted requests with independent parser; then real Engine confirms operation shape. | No raw-byte forwarding, duplicate header, ambiguous body or alternate decoded method/path; only canonical constructed request. |
| Actual socket permissions | Inspect host/container mount and FD inventory for both Engines, launcher, worker and gateway. Attempt denied connect from each unauthorized role. | Runtime socket accessible only to gateway; Core socket inaccessible to Runtime/gateway/launcher; no application worker daemon access. |
| Daemon operation rejection | Under isolated test daemon, send every disallowed operation through approved ingress and authorized test-only adversarial socket client simulating gateway compromise. | Gateway path denies; external controls continue to constrain direct test-client attempts. Any forbidden host mount, network, port, privilege, secret, device or image operation is failure. |
| Active-run failure | Inject gateway/daemon loss at create/start/cancel/result boundaries with external watchdog armed. | No automatic relaunch; effect becomes unknown until reconciled; independent lifetime bound and termination evidence recorded. |

Stage B HTTP/Engine tests are not Stage A evidence. An AuthZ plugin does not replace raw socket exclusion, gateway request reconstruction, route testing, or outer egress/quota enforcement.

## Identity and socket ownership matrix

The names below are roles, not approved numeric UIDs. Every host/container UID/GID translation, socket mode and peer-credential value remains **UNPROVEN** until the approved VM and then target-specific WSL compatibility tests. No application worker obtains daemon authority.

| Endpoint | Creator / owner | Candidate permissions | Permitted caller and peer check | Namespace/credential handling | Reject and recovery behavior |
|---|---|---|---|---|---|
| API → Authorizer | Authorizer creates its private socket under an owner-controlled IPC directory; authorizer service identity owns it. | Candidate directory `0700`, socket `0600`; actual mapping unresolved. | API service identity only; verify kernel peer credentials plus Codex #1-approved message authentication and versioned schema. | Distinct service identity; non-secret per-service credential file or asymmetric identity to be decided by Codex #1. No Compose membership or caller ID alone. | Wrong peer, missing credential, schema, timeout or uncertain mutation fails closed. Restart uses idempotency key and durable reconciliation, never blind repeat. |
| Worker → Launcher | Launcher creates private control socket; launcher identity owns endpoint. | Candidate directory `0700`, socket `0600`; actual mapping unresolved. | Worker identity only; kernel peer credential + authenticated bounded message, operation/run/lease/generation check. | Worker and launcher distinct UIDs; caller UID as observed across mount/UID maps is unproven. No `workerId` field as authentication. | Reject wrong UID/generation/replay. Launcher restart reconciles durable run state before accepting work. |
| Launcher → Policy Gateway | Gateway or trusted supervisor creates policy UDS in a dedicated IPC mount; gateway owns listener. | Candidate directory `0700`, socket `0660` to a dedicated launcher group only if peer auth also proves service identity; exact mode unresolved. | Restricted launcher only; verify `SO_PEERCRED` or equivalent plus operation-scoped capability and protocol version. | Cross-Engine UDS mount and UID/GID translation are unproven. Credential delivery must not reveal issuer key or Docker authority. | Reject all unrecognized peers. If socket absent/replaced, stop launch; restart does not replay requests and requires journal reconciliation. |
| Policy Gateway → Runtime Engine | Runtime Engine creates rootless API UDS owned by dedicated Runtime daemon UID; gateway is the sole authorized client. | Candidate socket `0600`, directory `0700`; exact gateway access path and container-vs-host identity unresolved. | Gateway process only; access is enforced by host filesystem ownership and mount inventory. Daemon API itself has no launcher auth layer; socket access means full Engine authority. | No raw socket enters Core Engine or launcher. No TCP API listener. If gateway container needs socket bind, prove only gateway receives it and no API can re-mount/replace it. | Socket absence/unexpected owner/digest/endpoint stops all launches. Daemon restart forces exact run reconciliation; no automatic replay. |
| Core Engine separation | Core rootless daemon owns Core socket, data root and volumes under its own service identity. | Candidate `0600` socket / `0700` directory, dedicated rootless data path; exact values unresolved. | Core engine supervisor/admin only. No Runtime identity, launcher, worker or gateway caller. | Distinct account and disjoint subuid/subgid ranges; no shared socket or data volume. Cross-Engine path access must be denied. | Unknown owner/mode, shared IDs or accessible socket/data fails isolation gate; do not start Runtime Engine. |

No Docker socket or daemon credential is delivered through `env_file`, environment variables, image layers, build args, application volumes, or Core network. If any proposal requires exposing Runtime socket to the launcher/Core Engine, it is rejected. If an application worker can call Docker directly or indirectly outside the narrow launcher protocol, the candidate is blocked.

## Gateway lifecycle and independent supervision contract

The gateway is trusted code with full Runtime Engine authority. Lifecycle design does not make it self-protecting. A compromised gateway may ignore its own admission state, forge its local journal, and issue arbitrary Runtime Engine API calls. Only controls enforced outside the gateway process remain effective against that compromise.

| Lifecycle point | Required interface/state contract | Responsible component | Stage A versus later proof |
|---|---|---|---|
| Provisioning and identity | Owner-approved host operator provisions dedicated Runtime daemon UID/data root, gateway artifact/config, capability verification material, reserved control-object identity, policy digest and private socket ACL. Gateway receives no update authority. | Owner/host operator for provisioning and secret custody; Codex #3 packaging; Codex #1 trust contract. | Stage A records schema/state only. Stage B proves file owner/mode, artifact/config digest and socket inventory. |
| Policy/config integrity | At startup, compare measured gateway artifact, static policy, image digest, verifier-key set and protocol version with owner-approved manifest. Any mismatch denies admission. | Independent host supervisor/bootstrap, not launcher. | Interface and failure codes in Stage A; tamper/restart proof in Stage B. Measurement mechanism remains unresolved. |
| Startup with admission closed | Supervisor starts daemon and gateway in closed state. Gateway can parse/reconcile but cannot accept `launch` until integrity, peer identity, capability material and recovery checks pass. | Independent Runtime supervisor controls lifecycle; gateway enforces local closed flag while intact. | Pure state transition defined in Stage A. A compromised gateway can ignore its local flag; external containment remains necessary. |
| Recovery before admission opens | Compare durable run/operation journal with exact daemon inventory and authorization generation. Missing, extra, corrupt or ambiguous objects keep admission closed and mark affected operations unknown. | Codex #1 defines durable journal/authorization semantics; Codex #3 implements recovery coordinator after review. | Stage A defines reducer outcomes only; Stage B fault/restart evidence; Stage D verifies against real PostgreSQL/D5. |
| Credential/policy rotation | Versioned key/policy set with overlap and retirement windows; invalidate old key/scope; no launcher-driven policy or trust-root change. | Capability issuer/owner custody (Codex #1); host supervisor deploys reviewed policy (Codex #3). | Stage A tests synthetic key IDs/versions; later stages prove rotation and revocation in disposable environment. |
| Unauthorized update/configuration | Gateway API has no update, plugin, policy-write, image-write, or daemon-config operations. Host filesystem and supervisor configuration are not writable by launcher or gateway container. | Host operator and OS permissions. | Static check Stage A plan; Stage B write/provisioning probes. If daemon can replace gateway or policy through allowed calls, block. |
| Shutdown/restart | Supervisor stops admission, records shutdown intent, requests bounded graceful termination, then applies external kill at deadline. On restart, admission remains closed until reconciliation. | Independent Runtime supervisor, not gateway alone. | Stage A specifies state only; Stage B validates process and cgroup behavior. |
| Gateway failure during active run | External watchdog enforces a preauthorized maximum Runtime service/run budget regardless of gateway response. On expiry, it terminates the run cgroup if reliably identified; otherwise terminates the entire Runtime Engine service cgroup and requires full reconciliation. | Host supervisor/kernel outside gateway; exact mechanism must be selected and proven. | Candidate only. Rootless cgroup ownership and per-run mapping are **UNPROVEN**. No suitable independent kill path means architecture blocked. |
| Runtime Engine failure | Supervisor detects loss, closes admission, records affected active operations unknown, restarts only after policy/integrity verification. | Independent Runtime supervisor. | Stage B proves failure detection, bounded service restart and no daemon auto-start/replay; WSL later separately. |
| Orphan detection/cleanup | Inventory exact gateway-owned run IDs/generations; unknown/unowned objects stop admission. Cleanup only after durable terminal decision and by exact daemon ID. Never prune globally. | Recovery coordinator plus host operator oversight. | Stage A reducer only; Stage B stale-container tests; Stage D ties events/state to DB. |
| Recovery without replay | Operation ID and semantic hash remain stable; same key/same request queries/reconciles prior outcome; changed hash conflicts; unknown cannot be launched again. | Durable authorization/run store and recovery coordinator. | Stage A in-memory model only; later persistence and race proof needed. |

### Independent termination candidates and responsibility

Two candidates require explicit Codex #1 and owner choice before Stage B:

1. **Per-run external watchdog:** a host-controlled supervisor obtains an independently verifiable run lease before start, maps it to a kernel-enforced run cgroup, and arms an unmodifiable timer. At expiry it writes the kernel cgroup kill control for that exact run, without asking the gateway or Runtime Engine API. This gives narrower termination but requires the watchdog to authenticate lease, discover/own the correct cgroup, and avoid launcher-controlled timer extension. Rootless cgroup mapping/permissions are unproven.
2. **Whole Runtime service-scope kill:** for the disposable harness only, run one bounded test batch in a host-controlled service scope. An external timer kills the entire daemon/helper/gateway/container cgroup at a fixed deadline. This is coarse and disrupts all runs, but does not rely on the gateway to terminate itself. It is a test-containment candidate, not a production per-run supervision guarantee.

For either mechanism, evidence must prove every synthetic workload process and rootless helper remains in the externally controlled cgroup scope, and that the supervisor can terminate that scope while the gateway is hung or compromised. Rootless cgroup delegation may make this impossible; it is not assumed. If any container process can escape the scope, the kernel refuses the supervisor's kill, or a workload survives, Stage B is blocked. Gateway-local timers, Docker `stop` calls, labels, launcher cancellation, or a watchdog that asks the gateway to act do not count as independent termination.

Controls that can remain effective if gateway is compromised: host/kernel network deny and no-uplink boundary; Runtime service-account file permissions and absence of owner/Core data; parent CPU/memory/PID cgroup ceilings; fixed filesystem/inode quotas; and an external watchdog capable of killing the Runtime cgroup. Gateway allowlists, local admission flags, its operation journal, Docker AuthZ configurations writable via the Runtime API, and gateway self-cleanup do not provide containment against gateway compromise.

This plan does not claim Mission 9D's independent-supervision proof. The required release restriction remains **RELEASE BLOCKED — SUPERVISION GUARANTEE UNAVAILABLE**.

## Independent egress enforcement plan

**Candidate:** the Runtime Engine daemon and every RootlessKit/network helper/forwarder run inside a host-created network boundary. The host operator, not launcher or gateway policy, owns namespace attachment, routes, firewall and IPv4/IPv6 deny rules. A private host-only test segment connects the runtime boundary to dummy sinks; it has no Internet, LAN, Windows service, Core service or database uplink. The Runtime daemon has no TCP API listener. The policy UDS carries bounded control messages only.

### Non-vacuous positive/negative test pair

The test must prove that a denial comes from the independent external control rather than an absent route, inactive helper, broken test image, or gateway rejection.

1. **Boundary equivalence:** In one disposable Linux VM snapshot, fix the synthetic image, Runtime Engine daemon, RootlessKit/helper versions, container identity, addresses/routes, DNS target, firewall placement, and probe program. Connect only a private virtual segment whose peer is a dummy IPv4/IPv6/DNS sink. No physical/uplink bridge or public route exists. Record hashes and interface/routing state for both phases.
2. **Positive control:** Under separately authorized guest-root test control, temporarily remove only the specific external deny rule while leaving the same namespace, helper, route, dummy sink, image and probe unchanged. Use a test-only operator client with access to the disposable Runtime socket to exercise network modes that simulate a compromised gateway; this socket is never mounted into launcher/Core. The corresponding eligible IPv4, IPv6, DNS and port-path probes must reach the private sink, which records expected synthetic nonce/count. If the positive probe cannot reach its sink, that case is **INCONCLUSIVE**, not a denial pass.
3. **Negative case:** Reinstall the external deny rule at its host-controlled boundary without changing route, interface, helper, daemon, container image/config or sink. Repeat byte-for-byte probes with the same addresses and nonce format. Firewall drop counters must increase and the sink must record zero probes. Also verify no alternate route/listener appeared. A mismatch in setup invalidates the pair.
4. **Repeat by path/mode:** Run separate positive/negative pairs for rootless bridge/user-mode networking, IPv4, IPv6, DNS UDP/TCP and each relevant port-publish/alternate-network mode. If a mode cannot produce a positive control within the isolated private segment, its external-denial behavior is unproven; do not mark it covered. Test gateway-policy denial separately so it cannot be mistaken for firewall enforcement.

The temporary positive-control relaxation occurs only inside the separately authorized disposable VM, remains confined to the private test segment with dummy endpoints, and is restored before snapshot/evidence review. It never enables general Internet or LAN access. Static source inspection cannot substitute for this controlled pair.

| Mechanism | Enforcement owner and prerequisite | Bypass concern | Positive/negative evidence |
|---|---|---|---|
| Namespace around daemon and helper tree | Host operator/trusted kernel; include dockerd, RootlessKit, slirp4netns/pasta or equivalent, port helper and descendants. | A user-mode helper may NAT through a parent namespace; placing containers in `network=none` alone is insufficient. | Same helper/path reaches private sink with deny temporarily removed, then drop counter increments and sink sees zero with deny restored. Inspect process namespace membership. |
| External IPv4 and IPv6 deny | Host-controlled firewall at/above the namespace boundary, covering forwarding, established/new flows and loopback/host-gateway paths. | veth-only filtering misses helper NAT; IPv6, mapped addresses, link-local and firewall ordering can bypass an incomplete rule. | Paired probes for IPv4, IPv6, mapped IPv4, link-local and gateway addresses; record rules/counters and exact sink nonce counts. |
| DNS denial | Host boundary denies UDP/TCP 53 and DoH/DoT dummy endpoints; no resolver proxy is reachable by runtime. | RootlessKit may provide a host-side DNS proxy; injected env or `/etc/hosts` can alter resolution path. | Positive dummy DNS answer then same query dropped under external rule; try TCP fallback and synthetic DoH/DoT with paired evidence. |
| Host/Windows/Core denial | No host-gateway mapping, host mode, shared Core network or route; all targets are dummy canary addresses on the isolated segment, never real host/Core/Windows services. | WSL mirrored mode/localhost forwarding can expose host services absent an ordinary route. | Paired probes use dummy endpoints representing host/Core/Windows address classes. Positive reachability is only to the dummy sink on the private segment; negative rule drops the same path. Later WSL tests are separate and environment-specific. |
| Alternative Engine networks/create/connect | Gateway rejects create/connect/disconnect, but external control is tested independently with disposable-socket operator client. | Gateway denial alone does not prove egress control survives gateway compromise. | For each applicable bridge/host/container/user-defined/IPv6/DNS mode, pair positive sink reachability and externally denied repeat. If gateway rejects before network path, classify only as API-policy evidence. |
| Port publishing/forwarding | Host operator controls inbound and outbound filter; rootless port helper is inside tested boundary. | Rootless port helper can open host listeners outside container rules. | Paired port probes on private host-only peer; positive opens the test listener, negative drops and shows no host/Windows wildcard listener. |
| Policy integrity | Host-managed policy files/rules not writable via gateway or launcher API; supervisor verifies policy version/hash. | Host operator can change policy; daemon/gateway compromise can alter internal configuration. | Hash effective policy before/after; attempt all API policy/network changes; any unauthorized alteration or missing enforcement blocks. |

**Stop condition:** If a relevant positive control cannot establish a functioning path, mark that path **INCONCLUSIVE**. If the same path reaches the sink after external deny is active, if a route/helper/port path bypasses the rule, or if denial depends solely on launcher options/gateway allowlisting, mark Docker-only **BLOCKED**. Stage B results apply only to the tested VM/kernel/helper/firewall combination; they do not establish WSL2 or target-host acceptance.

## Aggregate resource and quota proof plan

| Resource | External enforcement candidate | Prerequisites and failure behavior | Proof required |
|---|---|---|---|
| CPU | Parent systemd/cgroup-v2 slice above Runtime Engine, gateway and descendants; fixed VM vCPU cap outside guest. | cgroup v2 and controller delegation must be effective. Parent quota cannot be raised by child. If absent/ignored, fail and do not use per-container flags as substitute. | Read cgroup tree/effective `cpu.max`, compare bounded load to parent budget, attempt API/resource changes; parent cap remains. |
| Memory | Parent `MemoryMax`/cgroup limit and fixed guest memory cap. | OOM behavior can kill daemon/gateway; memory exhaustion marks active operation unknown and blocks new launch pending reconciliation. | Bounded synthetic allocation; inspect effective ancestor limits and OOM events; verify no escape and no silent ignored limit. |
| Processes/PIDs | Parent `TasksMax`/pids controller with daemon/helper/container descendants included. | cgroup v2 and delegation; ensure helper processes are inside same parent. PID failure denies create and preserves control-plane recovery capacity. | Bounded fork pressure; read effective hierarchy; gateway/daemon recovery process remains schedulable; no child cgroup can raise ancestor cap. |
| Disk blocks/inodes | Dedicated fixed-size Runtime filesystem or hard project/user quota with block and inode caps, owned by host service. | Rootless storage driver must support selected filesystem. Growing WSL VHDX is not itself a quota. If hard quota unavailable, block candidate. | Fill disposable runtime image/layer/volume/scratch/log stores to bounded quota; writes stop at cap; Core/host free space unchanged within measurement tolerance. |
| Images/layers | Gateway operation allowlist plus filesystem quota and preloaded single digest. | API cannot pull/build/load/tag/import/delete pinned image. Store admin path is outside launcher. | Attempt all image routes; count/size remains fixed; disk cap independently stops malicious growth if policy bug. |
| Volumes/scratch/temp | Gateway-created per-run scratch only on quota filesystem; exact lifecycle registry; tmpfs charged to cgroup memory if used. | No bind volumes, host paths or arbitrary names. On quota exhaustion mark run constrained/unknown, deny new work. | Attempt named/anonymous/bind/volume plugin, copy, archive, temp and symlink escapes; only bounded run scratch exists. |
| Logs | Fixed daemon log driver/options and rotation config outside launcher; gateway caps returned output bytes. | No arbitrary log driver/options; storage included in same disk quota. | Flood deterministic synthetic output; retained bytes and API response stay within cap, rotation verified. |
| Stale containers | Durable run registry and exact run/generation reaper; no daemon-wide prune. | Unknown records stop admission; cleanup only after state reconciliation and authorization policy. | Crash/restart with stale/foreign/malformed labels; cleanup affects only exact owned IDs; no unrelated object deletion. |

Per-container resource flags are defense-in-depth only. Acceptance requires observing the effective ancestor cgroup and filesystem quota, not merely successful API responses. Every limit must be tested by attempting to exceed it from a compromised launcher request and by bounded synthetic pressure. Preserve enough CPU, memory, PID and disk headroom for gateway/daemon diagnosis and safe stop.

## Gateway failure, lifecycle and recovery matrix

The run/authorization state machine, durable journal and transaction owner require Codex #1 specification. The plan uses `unknown` as a conservative state when evidence cannot prove whether a mutation reached the daemon. **No uncertain operation is relaunched automatically.** Exact status names may be mapped to the approved backend vocabulary later.

| Failure point | Required durable state | Run classification and bounded action | Reconciliation, retry and cleanup | Evidence required |
|---|---|---|---|---|
| Before container creation | Operation ID and authorization decision/consumption state durable before forwarding, according to Codex #1 ordering. | No container may exist; return denied/interrupted only after proving no create was sent. If send status is ambiguous, `unknown`. | Query gateway journal and daemon by gateway-owned operation label. Retry same idempotency key only after proving no object and revalidating unconsumed/current authority under approved contract. | Fault injection before write, during write, after daemon receives bytes; DB/journal and daemon inventory agree. |
| After create, before start | Persist daemon ID and `created` state before start request, or mark unknown if commit/response uncertain. | Created but not started is `interrupted`/recoverable, not completed. Keep bounded cleanup deadline. | Reconcile exact ID and config digest. Do not start on restart without explicit approved resume policy; default is remove only after durable terminal decision. New launch is a distinct authorized operation. | Crash after create response and before journal commit; no duplicate; exact object recovered and handled. |
| After start, before response | Persist `starting` before request, then `running` only with authoritative daemon evidence. | If response lost, `unknown` until inspect proves running/exited; enforce hard wall-clock limit independently. | Reconcile exact ID/state. Never issue a second start. On expired execution bound, stop/kill exact ID and record outcome as interrupted/unknown. Retry requires fresh authorization and proof prior process terminated. | Drop response after daemon start; one process/container only; state is unknown until reconciled; no replay. |
| During cancellation | Persist cancellation intent and operation ID before signal/stop request. | `cancelling`, then `cancelled` only when daemon confirms stopped/removed; timeout is `unknown`. | Retry same cancellation idempotently against exact ID. Do not release lease or permit replacement execution while process may remain. Cleanup exact run after terminal proof. | Crash at each cancel boundary; no other run touched; lease remains fenced until state known. |
| During revocation | Authorization DB owns revocation and admission serialization; gateway cannot invent final order. | Revocation response ambiguity is unknown to caller; operation remains blocked from new start until DB re-read resolves. Existing runtime termination policy must be Codex #1-defined. | Reconcile durable revocation state and run state; do not infer grant live from timeout. Do not relaunch after revoke. | Revoke races with create/start/cancel; verify atomic ordering, audit and retry response. |
| Gateway fails while container runs | Durable operation/run ID, generation, authorization linkage and last confirmed state survive gateway process loss. | Container is bounded by external wall-clock supervisor/cgroup kill policy; absent independent watchdog, stop the harness as unsuitable. State becomes `unknown`/`interrupted` after deadline, never success by timeout. | Supervisor restarts gateway in recovery-only mode; inspect exact gateway-owned containers; no new launches until all records reconcile. Cleanup only exact object. | Kill gateway while long mock runs; confirm bound and exact stop; verify no run continues beyond bound or escapes cgroup. |
| Failure during result reporting | Runtime exit status/output and terminal event transaction status may disagree. | Keep run `unknown`/`report_pending` until durable write outcome is known. Do not return accepted result based only on local memory. | Retry idempotent result persistence by stable event/operation key; read back state/cursor. Never rerun synthetic command to regenerate a missing response. | Drop DB connection after commit and before response; retry returns original event/state, no duplicate event or execution. |
| Gateway restart; Runtime Engine alive | Durable journal is authoritative intent; daemon inventory is observed execution evidence. | Start in recovery-only mode. Mismatch or corrupt journal stops admission and remains unknown. | Reconcile exact operation labels, IDs and generation. Never recreate missing runtime objects automatically. Manual test reset only after evidence captured. | Restart gateway repeatedly at transition boundaries; same operation maps to <=1 container and stable state. |
| Runtime Engine restart with stale metadata | Durable operation journal and DB state retained; daemon may have removed, restarted or retained containers. | Any unexplained object/state is `unknown`; new starts blocked until inventory reconciles. | Verify daemon ID, image digest, labels, config hash, exit state and authorization generation. Stale unknown workloads are stopped/removed only by exact ID after approved terminal decision; no global prune. | Restart daemon with running/stale objects and journal snapshots; show no auto-start/relaunch and no foreign cleanup. |

If the gateway cannot persist an operation intent before side effect, if the journal/authorization commit boundary is undefined, if termination is not bounded independently of the gateway, or if stale objects can restart without authorization, implementation is blocked pending Codex #1 design. This harness must not be confused with Mission 9D deadline fencing or supervision guarantees.

## Separate Mission Lane D5 integration acceptance

The gateway compatibility harness tests daemon/API isolation. It cannot establish database transaction semantics using synthetic authorization fixtures or an in-memory gateway journal. Mission Lane D5 acceptance is a separate backend/database integration gate owned by Codex #1, with Codex #3 responsible only for packaging and disposable environment coordination.

Static source evidence at baseline includes migrations `0029_mission_lane_events.sql` and `0030_mission_lane_admission.sql`, append-only event/clock structures, admission/writer serialization, projection triggers, and run-store/database integration coverage. `packages/db/src/mission-lane-admission.test.ts` covers bounded local writer admission behavior; `tests/integration/legacy-upgrade.mjs`, `tests/integration/mock-run.mjs`, and backup/restore integration cover database lifecycle areas. These are inspected source references only; no test was executed for this plan. The P0-R2.1 design also records that a distinct Mission Lane SSE endpoint is absent; run-scoped SSE/replay is separate.

### Required D5 integrated evidence after implementation

| Invariant | Test specification / acceptance evidence |
|---|---|
| Atomic run state + authorization transition | Use real disposable PostgreSQL with approved roles, migrations and API/worker transaction path. Concurrently submit/consume authorization and transition run state; DB snapshots show one serialized winner and no state/authorization mismatch. |
| Transactional Mission Lane event creation | Inject failure before projection, during event insertion, during cursor update and before commit. Either the source mutation, state, event row and clock commit together, or none do. No partial projection or cursor advance on rollback. |
| Serialized event ordering | Concurrent writers under contention produce a total order consistent with committed mutations; verify writer/admission lock order and no deadlock or duplicate sequence. Preserve existing D5 contention and admission tests. |
| Monotonic cursor invariants | Global cursor increases strictly without reuse; event sequences are ordered and unique; cursor is never behind a committed event or ahead after rollback. Validate database invariants directly from read-only test queries after each scenario. |
| Duplicate/ambiguous request handling | Repeat identical idempotency key/payload after response loss before and after commit. Same operation returns original state/events. Same key with changed payload conflicts. No duplicate authorization consumption or Mission Lane event. |
| Idempotent retries | Retry bounded admission after lock contention/transaction abort; only one committed operation/event appears. Retry result corresponds to durable transaction, not process memory. |
| Restart and recovery | Restart API and worker around commit/response boundaries; restart PostgreSQL in disposable environment; verify committed rows and cursor recover, uncommitted work rolls back, and no synthetic run or event is replayed twice. |
| Runtime/milestone authorization separation | Present a runtime-scope capability to a milestone mutation and a milestone-scope capability to the Runtime gateway. Both reject; query DB role grants and before/after milestone rows/events to confirm no milestone mutation. No shared authority or implicit scope conversion. |
| Migration/backup compatibility | Apply migrations from supported pre-D5 baseline; verify role grants, triggers, cursor initialization and upgrade behavior. Backup/restore into fresh disposable DB preserves committed ordered event history and no uncommitted/partial projection. |

Acceptance requires existing D5 tests remain enabled and pass, plus new API/worker/PostgreSQL fault-injection evidence with exact database snapshot/query artifacts and transaction outcome. A gateway-only fake signer, mock DB, or synthetic ledger is insufficient. No separate Mission Lane SSE behavior is inferred from database event projection.

## Staged implementation and authorization plan

The command strings below are **proposed command shapes only** for a future reviewed repository implementation. They do not exist yet and were not run. Replace them with actual project commands after the implementation language/build system is selected. No shell provisioning commands, Docker commands, namespace commands, WSL commands or CI triggers are authorized in P0-R2.2.

| Stage | Prerequisites and work packages | Responsible owner | Proposed verification commands (future, not run) | Deliverables and acceptance | Rollback and required authorization |
|---|---|---|---|---|---|
| **A — Pure-function-only static interfaces** | Both reviewers approve this exact plan; Codex #1 approves version/framing/canonicalization/cryptographic contract, pure schemas, scope separation and state reducer. Owner separately authorizes source implementation. Implement only pure byte decode/parse, schema, canonicalizer/hash, synthetic capability validator, deterministic policy/replay reducer and structured result/audit values; unit tests use in-memory fixtures. | Codex #1: auth/crypto semantics. Codex #3: pure interfaces and package. Owner: separate Stage A source authorization. | Placeholder only: `<confirmed-project-test-runner> <pure-runtime-policy-test-target>`. Must be verified to invoke unit tests only. No listener, socket, service, process, Docker discovery, DB, network or host privilege. | Offline deterministic tests pass; no raw Docker method/path/body in internal types; no side effects or external dependencies; pure-stage review confirms no lifecycle/host I/O. | No source change under current assignment. Later Stage A requires separate owner authorization and code review. Any socket/process/service/daemon/credential/database/system modification is scope violation and stop. |
| **B — Disposable isolated Linux VM** | Stage A contracts approved; named disposable VM, snapshot, private host-only test network with no uplink, exact resource budget and cleanup owner approved. Host/hypervisor provisioning privilege approved separately. Implement policy gateway, fake capability issuer, durable test journal, API adversarial driver, outer egress/quota controls and synthetic fixed-image runtime. | Codex #3: harness/platform integration. Codex #1: review enforcement and test outcomes. Claude #1: independent bypass review. | Proposed after implementation: `compat-harness test gateway-api --profile p0r2.2-vm`; `compat-harness test egress --profile p0r2.2-vm`; `compat-harness test quotas --profile p0r2.2-vm`; `compat-harness test recovery --profile p0r2.2-vm`. | All API/parser bypass attempts deny before mutation; no packet reaches dummy sinks; observed CPU/memory/PID/disk/inode/log limits hold; fault matrix proves no duplicate launch and bounded cleanup. | Revert to clean VM snapshot; destroy exact VM and private network after evidence review. Stop on any raw-socket reachability, unexpected packet/listener, resource escape, untracked workload or host effect. Separate owner authorization required before provision and again before running privileged tests. |
| **C — Disposable WSL2 distribution** | Stage B passes; Windows/WSL versions captured; disposable distribution and test profile can be created without changing existing distro, rootful Docker, global `.wslconfig`, firewall, portproxy, projects or credentials. | Codex #3: compatibility. Codex #1: review deviations. Owner: WSL/Windows changes and cleanup. | Proposed after implementation: `compat-harness inspect-wsl --profile p0r2.2-wsl`; `compat-harness test rootless-engine --profile p0r2.2-wsl`; `compat-harness test local-ingress --profile p0r2.2-wsl`. | UID/GID mappings, user namespaces, two rootless engines, cgroups, storage, sockets, networking and lifecycle match approved contracts; local HTTPS works only on loopback; no LAN route/listener. WSL shares host kernel/resources and is not equivalent to Stage B. | Stop on need for global host setting, existing daemon access, LAN exposure or unexplained shared path. Export sanitized evidence; owner removes only named disposable distro/test profile after review. Separate authorization for importing distro, installing dependencies and each privileged compatibility suite. |
| **D — Integrated mock-only acceptance** | Gateway/VM and WSL gates pass; API/worker/authorization changes separately reviewed; Mission Lane D5 integration tests cover real disposable PostgreSQL; R1 frontend integration complete if required by product scope. | Codex #1: backend authorization/D5. Codex #3: compose/package/integration. Codex #2 and Claude #2: browser/frontend acceptance. Owner: environment and test data authorization. | Proposed after implementation: `npm run test:integration -- --suite mock-only-rootless`; `npm run test:integration -- --suite mission-lane-d5-recovery`; `npm run test:e2e -- --suite local-owner-session`. Exact project scripts must be confirmed before use. | End-to-end owner auth → project/task → durable authorization → worker → launcher → fixed mock → persisted run/events → run-scoped SSE/replay; cancellation, restart and recovery pass. D5 must pass against PostgreSQL, not synthetic fixture ledger. Include both directions of runtime/milestone capability substitution denial and prove no milestone row/event mutation. No real provider, fixture or release capability. | Separate owner signoff per environment. Destroy synthetic DB/data and VM/distro per retention plan. Stop on auth bypass, secret leak, provider/fixture access, duplicate operation/event, unknown state auto-replay, or any out-of-scope runtime behavior. |

### Stage B minimum environment specification

| Property | Proposed minimum / guard |
|---|---|
| Name and isolation | One named VM such as `omnis-p0r2-2-harness-<date>` with a dedicated guest kernel and disposable disk snapshot. Hypervisor and host are still trusted; no shared folders, clipboard, USB devices, host Docker socket, credentials or owner data. |
| Provisioning privilege | Guest root may install packages, create service UIDs/subuid ranges, configure cgroups, dedicated filesystem quotas and private namespaces. Host/hypervisor privilege may be needed to create the VM and private virtual network; separately owner-approved. Do not use `--privileged` containers. |
| Resource ceiling | Planning envelope: 4 vCPU, 8 GiB RAM, 40 GiB fixed disk; Runtime sub-budget and cgroup/quota caps set below guest ceiling. Values are estimates and must be confirmed against host capacity before approval. If host pressure occurs, stop. |
| Network | No bridge to LAN/Internet. Private host-only test segment only for synthetic canaries, behind outer deny; explicit route only to dummy sink addresses, no default route. No real DNS resolver, port forwarding, public registry or Windows service access. Import fixed image by digest through offline image artifact. |
| Synthetic canaries | Dummy Core API/DB/DNS/IPv4/IPv6 sinks, synthetic capability signing keys, canary files and fixed inert mock image. No real credentials, projects, provider keys, fixtures, or owner files. |
| Evidence | Version inventory; policy/config hashes; UID/socket/namespace/cgroup/mount inventories; firewall counters; dummy sink request counts; daemon object inventory; bounded audit IDs and transaction/state query results. Exclude packet payloads, secrets, canary contents and personal paths. Owner approves retention period/storage before execution. |
| Stop conditions | Any host/shared path access, direct Runtime socket reachability, Core access, egress packet, LAN/uplink interface, unbounded resource growth, privileged container requirement, policy fail-open, untracked workload, cleanup ambiguity or pressure outside VM budget. |
| Cleanup | Stop named VM, preserve sanitized evidence to approved location, inspect exact VM/network identifiers, then owner-authorized destroy of that VM, disk, private network and synthetic signing keys. Verify host listeners/routes/project files/rootful daemon unchanged. Roll back from snapshot after each failing suite; no broad cleanup commands. |
| Host-interference risks | Hypervisor networking, global firewall/virtual switch, host disk/memory pressure and shared clipboard/mount features can affect host. If required controls cannot be scoped to the named VM/private network, mark environment unsuitable and do not proceed. |

### Stage C WSL2 compatibility specification

Use an imported, separately named WSL2 distribution and disposable Windows test profile only after Stage B. Record Windows build, WSL version, distro release, kernel, systemd, cgroup mode/controllers, filesystem type, storage driver, networking mode, Hyper-V firewall state, and UID maps. Test each Engine under distinct service account/data root with disjoint subordinate IDs and socket path. Confirm owner/Windows automount and interop are disabled or inaccessible within the test distro without changing the current distro or global settings.

Compatibility checks: user namespace availability; `newuidmap`/`newgidmap`; subordinate UID/GID ranges; two concurrent rootless daemons; cgroup-v2 systemd delegation and effective parent limits; supported storage driver and fixed quota behavior; UDS mount permissions and peer credentials across container/host mappings; RootlessKit helper placement/no-uplink enforcement; IPv4/IPv6 and DNS denial; localhost HTTPS/Windows browser forwarding; safe daemon/distro shutdown and restart; no stale auto-start. WSL shares the WSL kernel, VM resource pool, Windows host and firewall/network layer. It cannot substitute for Stage B kernel/hostile-resource isolation. No pressure test beyond the separately approved shared-resource cap.

If any check needs global `.wslconfig`, current distro, rootful Docker, host firewall, portproxy, LAN access, Windows admin policy, owner project paths, or a new unapproved service, stop and request an explicit owner decision. Do not treat unsupported cgroups or ineffective quotas as pass.

## Implementation decision and authorization register

| ID | Decision | Candidate | Risk | Required proof | Owner | Status |
|---|---|---|---|---|---|---|
| D22-01 | Gateway trusted boundary and compromise impact | Separate minimal gateway; sole Runtime socket holder; not resistant to its own compromise | Gateway compromise is full Runtime Engine admin | Threat model, update/provisioning boundary, audit/integrity and launcher-compromise tests | Codex #1 + owner; Codex #3 package | **UNRESOLVED** |
| D22-02 | Core/Runtime rootless identities | Two distinct service accounts, disjoint subordinate IDs and data roots | UID-map overlap or shared data/socket collapses isolation | Host UID map, socket/volume/mount inventory, canary denials on VM and WSL | Codex #3; Codex #1 approves security semantics | **CANDIDATE — UNPROVEN** |
| D22-03 | Socket path/ownership and peer auth | Private UDS with kernel peer credentials plus protocol authentication | Cross-engine UID translation, FD inheritance, directory/path race | Exact host/container observed IDs/modes, wrong-peer/symlink/FD tests | Codex #1 identity; Codex #3 packaging | **UNRESOLVED** |
| D22-04 | Capability issuance, storage and rotation | Operation-scoped Ed25519 capability; issuer private key absent from gateway and launcher | Forgery, stale grant, replay, key compromise or ambiguous consume; issuer-key disclosure would let gateway mint | Issuer/audience/scope/expiry/revocation/generation contract, canonical signed bytes, key lifecycle and DB race/fault evidence | Codex #1 + owner custody | **UNRESOLVED** |
| D22-05 | Runtime Engine API enforcement | Gateway reconstructs narrow Docker calls; AuthZ optional defense-in-depth | Parser gap or gateway bypass gives broad daemon API | Complete API negative corpus, socket-holder proof, no gRPC/raw/upgrade path | Codex #1 + Claude #1; Codex #3 implements later | **CANDIDATE — UNPROVEN** |
| D22-06 | Independent egress denial | No-uplink namespace around daemon/helpers plus external v4/v6 deny | Rootless user-mode helper may bypass namespace/firewall assumptions; route absence can create a vacuous deny test | Paired same-path positive/negative dummy-sink tests per network mode and address family; process/network inventory and firewall counters | Codex #3; Codex #1/Claude #1 review; owner approves privileged test | **CANDIDATE — UNPROVEN** |
| D22-07 | Storage and aggregate quota | Parent cgroups plus quota-backed Runtime filesystem | Target cgroup/filesystem may silently ignore limits | Effective ancestor controller values and block/inode quota pressure tests | Codex #3; Codex #1 reviews fail state | **UNRESOLVED** |
| D22-08 | Gateway failure/active-run behavior | Durable operation journal; recovery-only restart; bounded external supervisor | Uncertain run may replay or execute indefinitely | Fault matrix with kill points, state/daemon reconciliation, timeout/termination proof | Codex #1 state contract; Codex #3 supervisor | **UNRESOLVED** |
| D22-09 | Cleanup and stale workload ownership | Exact ID/generation registry; no global prune | Foreign or uncertain workload removed/restarted | Stale/foreign object tests, no auto-replay, evidence before cleanup | Codex #1; Codex #3 | **UNRESOLVED** |
| D22-10 | Disposable Linux VM | Dedicated snapshot VM, private no-uplink test network | Host/hypervisor/network changes or resource pressure | Host change inventory, private route proof, tested cleanup and restore | Owner approves host/hypervisor privileges; Codex #3 | **OWNER AUTHORIZATION REQUIRED** |
| D22-11 | Disposable WSL2 privileges | Named imported distro and test Windows profile after VM pass | Shared kernel/resources; global setting spillover | Version inventory, per-distro-only changes, no current-distro/rootful-Docker effects | Owner authorizes import/install/root in test distro; Codex #3 | **OWNER AUTHORIZATION REQUIRED** |
| D22-12 | Evidence retention | Sanitized artifacts only in owner-approved location and period | Secret/canary/host metadata disclosure or excessive retention | Redaction review, evidence inventory, expiry/destruction record | Owner + Codex #1 | **UNRESOLVED** |
| D22-13 | Mission Lane D5 integrated gate | Separate real disposable PostgreSQL/API/worker acceptance | Fake fixtures mask transaction/order/rollback defect | Existing D5 suite plus fault-injected transaction, cursor, retry and restart evidence | Codex #1; Codex #3 provisions only after authorization | **REQUIRES SEPARATE APPROVAL** |
| D22-14 | Wire framing and canonicalization | One UDS stream connection, 4-byte big-endian length, one bounded UTF-8 JSON frame, JCS canonical bytes and domain-separated SHA-256 | Parser disagreement, duplicate-key ambiguity, changed semantics under same hash, UDS peer mapping | Golden byte/hash vectors; Codex #1 approval of transport, caps, JCS profile, signed bytes and signature algorithm before Stage A authorization | Codex #1; Codex #3 documents | **CANDIDATE — REVIEW REQUIRED** |
| D22-15 | Gateway lifecycle and independent termination | Host supervisor with per-run cgroup watchdog, or whole Runtime service-scope timeout for disposable tests | Rootless cgroup mapping may prevent per-run kill; gateway cannot safely terminate itself after compromise | Failure-injection and bounded-termination proof with gateway unavailable; external control effective and no automatic replay | Codex #1 + owner; Codex #3 platform | **UNRESOLVED — EXPERIMENT REQUIRED** |
| D22-16 | Runtime/milestone authorization separation | Disjoint scopes/audiences/resource types; preserve Authorizer-only DB permissions | Capability substitution could mutate milestones from runtime path or vice versa | Stage A substitution unit cases; Stage D negative integrated tests plus DB grant/row/event evidence | Codex #1; Codex #3 acceptance packaging | **REQUIRED INVARIANT — SOURCE UNCHANGED** |
| D22-17 | Non-vacuous egress evidence | Controlled temporary positive path to private dummy sinks, then same path under external deny | No route/helper failure could falsely appear as successful deny | Same VM/helper/container/image/address/config, positive sink nonce, denied-phase drop counters and zero sink hits per IPv4/IPv6/DNS/mode | Codex #3; owner authorizes guest-root firewall changes; Codex #1/Claude #1 review | **DESIGN SPECIFIED — UNPROVEN** |

## Finding-resolution matrix and security re-review handoff

Finding identifiers group the consolidated review themes supplied for this correction request; they do not claim access to reviewers' full comments beyond those findings.

| Review finding | Resolution in revised plan | Remaining review question |
|---|---|---|
| Codex #1 P0: Stage A listener/lifecycle ambiguity | Scope and hard boundaries plus Stage A implementation row restrict work to pure functions and in-memory values; wire section distinguishes future UDS specification from implementing a listener. | Confirm allowed pure functions/test target cannot cause I/O, service start, process spawn or host discovery. |
| Codex #1 P0: Wire framing, schema, hashes, capability and errors underspecified | Future wire contract defines UDS stream, length-prefixed UTF-8/JCS frame, exact request/response shapes, operation arguments, domain-separated request hash, signed claims, canonical signed bytes, response classes and audit bounds. | Approve or replace framing/caps/JCS/signature algorithm and key/credential semantics before Stage A authorization. |
| Claude #1: Parser disagreement / HTTP threat boundary unclear | Stage A matrix is pure bytes/JSON only. Stage B separates HTTP/Engine framing, smuggling, method/version/path, upgrades, route, fake-parser differential and real Engine tests. Internal protocol excludes raw Docker HTTP fields. | Confirm test seams prove no raw bytes reach Docker without adding an HTTP launcher listener or general proxy. |
| Codex #1 / Claude #1: Stage A and Stage B evidence were conflated | Separate pure-unit matrix from HTTP/Engine integration matrix; unit-test success explicitly proves no HTTP framing safety or live Engine isolation. | Confirm Stage A command can run only unit tests and cannot start a service or inspect host Docker state. |
| Codex #1 / Claude #1: Authorized operations could target the gateway control object | Request schema has no Docker IDs/names; gateway maps only internal run keys to registered IDs and excludes trusted reserved identities. Gateway compromise remains full Engine authority. | Confirm trusted provisioning keeps reserved identity out of launcher control. |
| Codex #1 / Claude #1: Gateway lifecycle and termination responsibilities unclear | Lifecycle matrix names provisioning, integrity, admission, recovery, rotation, restart, active-run bounds and cleanup owners; independent per-run and whole-service-scope kill candidates are explicit. | Select and prove a termination path effective while gateway is unavailable/compromised; otherwise block Stage B. |
| Codex #1: Runtime and milestone authorization scopes could be confused | Runtime capability scope/audience/resource and operation enum are disjoint; existing Authorizer-only DB permissions remain unchanged; Stage A and Stage D substitution denials are specified. | Codex #1 confirms authorization and DB grant semantics; Stage D supplies no-mutation evidence. |
| Claude #1: Egress denial might pass due to absent route | Same-path positive/negative tests use a private dummy sink, identical helper/route/image/config, and change only host-owned external deny. No positive route means inconclusive. | Review coverage for user-mode helpers, v4/v6, DNS and each alternative network mode. |

**For Codex #1 direct review:** review the exact final plan hash, especially the byte contract, capability claims/signature semantics, pure Stage A boundary, runtime/milestone separation, lifecycle state ownership and authorization gates.

**For Claude #1 independent review:** review the same exact final plan hash and challenge parser/canonicalization ambiguity, gateway-compromise containment claims, independent termination, runtime/milestone substitution, and positive/negative egress equivalence.

Both reviews must cite the same full SHA-256 recorded in the completion report. Any subsequent edit changes the target and requires both reviewers to review that new hash.

This is a local review handoff only; no external comment/message or repository publication was made. Both reviewers must approve this P0-R2.2 plan, not merely the P0-R2.1 design, before implementation planning is considered security-reviewed. The owner must then separately authorize Stage A implementation, the exact VM and privileges before Stage B provisioning/execution, the named WSL distro and changes before Stage C, and integrated mock-only/database acceptance before Stage D. Approval of one stage does not authorize the next.

The exact first implementation scope, after both reviews approve this revised plan and the owner separately authorizes Stage A, is **pure-function-only Stage A**: versioned schemas; byte framing/decoding; strict parsing and canonicalization; synthetic in-memory capability validation with injected test verifier; deterministic domain-separated request hashing; deterministic policy and replay/idempotency reducers; structured response/audit values; and offline unit tests. It creates no socket/listener/server/service, process, Docker client/config discovery, database connection, real credential or authorization operation, runtime launch path, network/namespace/firewall/daemon/WSL change, environment, or CI trigger. Before Stage B, the owner must explicitly approve the named disposable Linux VM, guest/host privileges, private network, resource envelope, synthetic fixtures, evidence location/retention, stop criteria, external termination design and destruction procedure.

## Final targeted protocol corrections (normative)

These refinements govern the preceding schemas without authorizing implementation or reopening accepted framing, size, hash or audit decisions.

### Numeric lexical contract

Every numeric token must match ASCII `(?:0|[1-9][0-9]*)` in its entirety. Before numeric conversion or JCS, a tokenizing JSON parser retains raw token spans, checks spelling and compares decimal magnitude against the field bound. Only then may it construct numeric values. Generic JSON parsing followed by integer checks is insufficient. Reject duplicate decoded member names at every depth, including escaped aliases, before map construction or canonicalization.

| Numeric field | Inclusive range |
|---|---|
| protocol_version, protected version, audit schema version | 1 only |
| Every generation | 1..2147483647 |
| not_before, expires_at | 0..9007199254740991; expires_at strictly greater than not_before |
| max_bytes | 1..8192 |
| max_runtime_ms | 1..300000 |
| max_output_bytes | 1..1048576 |
| Audit monotonic local sequence | 0..9007199254740991; exhaustion closes admission pending recovery |

Duration bucket is a fixed string enum, not an additional numeric input. Unknown numeric fields reject. Binary frame length remains uint32 with request 1..65536 and response 1..16384 bytes. Cross-language rule: no integer exceeds 2^53-1 or changes value during parsing, serialization or JCS; compare exact round-trip decimal value with the retained token. Rounding/coercion is forbidden.

Positive lexical vectors: `0`, `1`, `123`, `9007199254740991`. Reject `-0`, `-1`, `+1`, `01`, `00`, `1.0`, `1e3`, `1E+3`, `9007199254740992`, `9007199254740993`; the latter two exceed the precision ceiling. Syntactic validity does not override field range: generation `1`/`2147483647` pass, `0`/`2147483648` fail; max_bytes `8192` passes, `8193` fails; version `0` is lexically valid but unsupported. Future tests cover both endpoints and adjacent failures for every field and duplicate escaped keys before JCS.

### Identifier and authoritative binding contract

Comparisons are exact and case-sensitive, with no trimming, case folding, Unicode normalization, URL decoding or alias resolution. Wire IDs are decoded ASCII strings with no whitespace/control characters; JSON escapes decode before comparison and JCS. Unless tighter below, length is 1..128 bytes. No production database format is changed.

| Identifier | Canonical representation / authoritative rule |
|---|---|
| request_id, operation_id, run_id, jti, authorization_id | Exactly 36 lower-case ASCII bytes matching `[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`: RFC UUID version nibble 1..8 and RFC variant bits. This matches repository Zod `.uuid()` acceptance (including RFC variant validation), while the wire profile additionally requires lowercase canonical spelling. Correlation IDs confer no authority. |
| project_id | Exactly `prj_[0-9a-f]{32}` (36 bytes), matching ProjectIdSchema in packages/contracts/src/index.ts and connector contracts; exact authoritative project lookup. |
| task_id | Existing connector-broker.ts permits 1..128 characters excluding NUL rather than one UUID format. This wire profile accepts the ASCII non-whitespace subset, 1..128 bytes, only on exact authoritative task lookup. UUID, prefixed and legacy IDs are distinct values, never aliases. Stored IDs outside this subset are unsupported and denied rather than transformed. |
| lease_id | Opaque ASCII non-whitespace 1..128 bytes; exact authoritative run-lease record lookup, without inventing a production lease format. |
| iss, aud, sub | ASCII non-whitespace 1..128 bytes, exact trusted issuer/audience/principal registry entries; sub equals independently verified peer mapping. |
| kid | ASCII non-whitespace 1..64 bytes; exact issuer-bound trusted verification-key registry entry. |
| resource_profile | ASCII non-whitespace 1..64 bytes; exact reviewed fixed-policy registry entry. Other profiles/operations are literals already specified. |

Later integration resolves authorization to subject, task, project, lease, run, generation and operation/hash from authoritative Authorizer/run records, checking current task/project association and lease ownership. All claims and request references must agree; syntactic validity is insufficient. Unknown, stale, mismatched, substituted or unsupported identities fail authorization before dispatch. Lookup unavailability is pre-dispatch internal failure, never permission. Stage A injects synthetic in-memory records, peer mappings and substitution fixtures only, with no DB lookup or change.

### Complete exit_class and outcome semantics

exit_class occurs only in inspect results, nullable before terminal/unknown runtime outcome. It never encodes policy decisions. Complete non-null vocabulary:

| Exact enum | Meaning / occurrence | Category | Retry / authorization | Durable lookup |
|---|---|---|---|---|
| succeeded | Authoritatively confirmed successful runtime completion | Confirmed runtime result | No automatic rerun; original grant may be consumed | Required |
| failed | Authoritatively confirmed unsuccessful runtime completion | Operational failure | No automatic rerun; original grant may be consumed | Required |
| interrupted | Authoritatively confirmed cancellation or external termination | Interruption | No automatic rerun; original grant may be consumed | Required |
| unknown | Dispatch possible, outcome unestablished | Unknown execution outcome | Reconcile only; consumption may have occurred, never blindly reuse grant | Required |

Before dispatch, policy denial is POLICY_DENIAL/deny/not_attempted, null result, no exit class or consumption; no automatic unchanged retry. Proven pre-dispatch transport/internal failure is INTERNAL_FAILURE/not_attempted with null result and no consumption; retry only the same operation/hash after durable admission lookup. A lost transport may return no response and is not proof of non-execution to the caller. After possible dispatch, report OUTCOME_UNKNOWN/unknown, never definite non-execution; durable reconciliation is mandatory before further mutation. Confirmed results use PERMITTED/allow with authoritative effect state and bounded result; PERMITTED alone does not establish success. Pending state has null exit class. Dispatched operations may consume authorization even on failure; durable journal/consumption ordering still requires later approval. Stage A returns only not_attempted policy values and validates synthetic response fixtures, never actual runtime results.

### Stage B-only recording transport design

Only after separate authorization, substitute a byte-recording fake Engine at the gateway's Engine-facing connection. Hostile clients send actual length-prefixed bytes through the future UDS decoder/validator, proving that boundary rejects malformed input. An HTTP listener on launcher ingress is prohibited, including test ingress. Capture exact outbound bytes, dispatch count and approved operation-to-method/path/body sequence, including explicit zero dispatch evidence. An operation may expand only into its reviewed bounded sequence; caller input cannot select HTTP methods, paths, headers or API versions.

An independent parser checks recorded requests for fixed Content-Length, no duplicate Content-Length, no Transfer-Encoding/chunking, unambiguous framing, no upgrades or smuggled extra request. Inject CR/LF, header strings, chunk syntax, alternate URL encodings, duplicate JSON keys, malformed/unknown operations and extra frames through UDS fields/raw frames. Require rejection before dispatch for invalid inputs and prove accepted typed values cannot become HTTP control syntax. Duplicate Content-Length/Transfer-Encoding ambiguity and malformed chunk corpora exercise the fake parser in memory, not a launcher HTTP endpoint. Evidence identifies the exact reconstructed sequence or zero requests. Simulated recording evidence does not establish actual Docker isolation: separately authorized real isolated Engine integration must verify routes and effects. Do not create the transport or execute these tests now.

### Findings resolution and remaining authorization

| Finding | Resolution |
|---|---|
| Numeric token ambiguity | Raw grammar, field bounds, precision rule and positive/negative vectors |
| Signature ambiguity | Ed25519 only, exact 32/64-byte and 43/86-character encodings, fail-closed verification |
| Identity ambiguity | Existing repository formats plus exact authoritative lookup and cross-field binding |
| Outcome ambiguity | Closed exit enum and distinct pre-dispatch, uncertain and confirmed semantics |
| HTTP evidence seam | Stage B UDS-to-recording transport and independent parser design |
| Scope and isolation | Pure Stage A, planned supervision and separate PostgreSQL D5 acceptance retained |

UUIDs now require canonical lowercase RFC variant/version form matching repository Zod `.uuid()` acceptance. Every binary base64url field requires canonical decode/re-encode identity. Production Ed25519 verification has explicit strict encoding/key/signature requirements and remains unauthorized work.

Gateway lifecycle, recovery, admission closure and external termination remain planned interfaces only. An independent supervisor must prove bounded termination of active synthetic workloads while gateway control is unavailable. Any workload escaping or surviving that termination scope BLOCKS the relevant later integration stage. Stage A establishes no operational supervision guarantee. Runtime capabilities cannot authorize milestone mutations; Authorizer-only DB permissions remain unchanged. D5 atomicity, serialization, cursor ordering, rollback and durable idempotency remain separate integrated PostgreSQL acceptance requirements; Stage A cannot prove D5.

Remaining owner decisions: production issuer custody, secure rotation/revocation and clock trust; peer/UID mapping and authoritative lease integration; durable journal/consumption ordering; independent supervisor/termination scope; quotas/egress; exact VM/WSL privileges; evidence retention; separate PostgreSQL/D5 acceptance. Ed25519, framing and payload caps are fixed contract choices. Codex #1 and genuinely independent Claude #1 must approve the same revised full SHA-256, followed by separate owner Stage A authorization. GPT supporting evidence is not Claude approval. No Stage A implementation authorization is granted; B/C/D remain independently authorized. All three Mission 9D blocks below remain unchanged.

## Restrictions retained

**RELEASE BLOCKED — DEADLINE FENCE NOT ESTABLISHED**

**LIVE STAGE 1 INTEGRATION BLOCKED — LIVENESS ORDERING UNPROVEN**

**RELEASE BLOCKED — SUPERVISION GUARANTEE UNAVAILABLE**

No Phase A experiment, protected runtime activation, live provider inference, physical fixture execution, deployment, live Stage 1 integration, or release-capable implementation is authorized. The rootful Docker socket launcher design remains rejected. The host-managed launcher remains transitional and cannot satisfy Docker-only acceptance.

## Related design evidence

- [P0-R2.1 rootless compatibility harness design](./P0_R2_1_ROOTLESS_COMPATIBILITY_HARNESS_DESIGN.md)
- [P0-R2 Docker-only proof register](./P0_R2_DOCKER_ONLY_PROOF_REGISTER.md)
- [Phase 1 Docker-only platform readiness](./PHASE1_DOCKER_ONLY_PLATFORM_READINESS.md)

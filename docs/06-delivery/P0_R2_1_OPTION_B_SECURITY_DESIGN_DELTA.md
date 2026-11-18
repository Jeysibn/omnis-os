# P0-R2.1 Option B Security Design Delta

**Applies to:** `cc8e9b4ba1323c982a741c790fd0f7401130f2f6` and the owner decisions summarized in the [decision package](./P0_R2_1_OWNER_DECISION_PACKAGE.md).
**Status:** Conditional synthetic-only design direction. Not an implementation plan, security acceptance, or deployment authorization.

## Decision delta from the reviewed baseline

The earlier P0-R2.1 review recorded **CHANGES REQUIRED** for its exact reviewed commits. Its design comparisons and findings remain historical evidence. The owner has since conditionally selected Option B for further design, added a separate rootless Core Engine under OB-0 as design-only, selected whole-Runtime-service termination for M-4, preferred an independently administered managed conditional-append ledger for M-3, and selected API-to-Authorizer AF_UNIX as the design channel. These decisions do not close the prior findings or accept the current head.

The current repository's restricted Compose profile is a separate execution-disabled configuration. It is not the Option B topology and provides no evidence that the proposed Core/Runtime split or host control plane exists.

## Conditional trust and service boundaries

| Boundary | Design contract | Still unproven or undecided |
| --- | --- | --- |
| **Core** | Dedicated rootless Engine and operator for Core web/API/database. Core authority does not include Runtime socket, data, unit, or host control-service keys. | OB-0 identities, socket/data-root ownership, separation from Runtime, and actual process/service policy. No Core Engine may be created under this decision. |
| **Runtime** | Separate rootless Engine for fixed synthetic workloads. Runtime daemon/operator are trusted for workload integrity and placement under the selected threat model; they are not trusted to cooperate with stop requests. | Engine isolation, workload confinement, runtime account/socket custody, and process placement inside the fixed service scope. |
| **Host control** | Worker, Launcher, Authorizer, Runtime Policy Gateway, Registrar, Terminator, and scoped Actuator have distinct roles. Only the Runtime Engine operator holds its Engine endpoint. | Host identities, executable/unit integrity, IPC peer authentication, exact socket access, key custody, and least-privilege enforcement. No service is approved for installation. |
| **M-4 termination** | A stop targets the whole fixed Runtime service. All concurrent runs share its blast radius. An independent stop-only Actuator and separate Terminator verification are required; a lock-only lifecycle guard and manager-level gate must prevent start/restart/replacement until absence is proven. | Actuator privilege, fixed unit/cgroup binding, descendant/helper coverage, manager race handling, outage behavior, empty-scope proof, and restart fencing. M-4 remains blocked. |
| **M-3 rollback anchor** | Independently administered conditional-append ledger is the preferred candidate. Loss of freshness or anchor availability fails closed. | Custodian, administrative boundary, signer/key custody, monotonicity, append semantics, outage and recovery policy. No local database or journal substitutes for independent custody. M-3 remains blocked. |
| **API to Authorizer** | AF_UNIX is the selected design channel. The Authorizer owns authorization/revocation state and may request termination through the reviewed flow; API and Worker cannot access the Runtime Engine endpoint. | Authenticated API peer identity, owner intent, credential delivery, enrollment/recovery, request binding, replay handling, and tests. Channel selection alone does not establish identity. |
| **Ingress** | Windows-local access requires an enforcement point that distinguishes permitted local clients from LAN, WSL, and container paths. | Mechanism, IPv4/IPv6 behavior, RP ID, origin, TLS/cookie policy, and positive/negative evidence. Loopback or forwarded headers alone are not proof. |

## Required security invariants

- **No ambiguous cancellation:** `REVOKED` means authority was withdrawn; it does not mean work stopped. Only verified whole-service absence can establish termination. Missing acknowledgement, unknown scope, or surviving process/helper stays `UNKNOWN`, keeps admission fenced, and cannot trigger replay.
- **No service lifecycle race:** While stop state is pending or unknown, explicit/automatic start, restart, reload, and unit replacement must be blocked. Only the separately approved recovery authority may clear the fence after evidence review.
- **No cross-boundary endpoint:** API, Worker, Launcher, Core workloads, and Runtime workloads do not receive unintended Engine sockets, host control keys, or authority to update policy or units.
- **No implied locality:** Browser origin and WebAuthn establish web origin/authenticator properties, not Windows-local provenance. The ingress decision must be separately enforced and tested.
- **No rollback claim from local state:** Core database durability, a local journal, or a signed local record does not prove freshness against rollback. M-3 remains open until the independent custody and failure policy are evidenced.
- **No live Mission 9D authority:** Inert Stage 2A fixtures and synthetic tests do not establish provenance, deadline enforcement at the first application instruction, Stage 1 liveness ordering, or independent supervision.

## Review and acceptance boundary

All rows above are design contracts or evidence requirements. No source implementation, host inspection, WSL/Docker operation, Engine/service/socket/account/credential creation, P0 harness execution, provider access, or Stages 2–4 work is authorized. Obtain exact-head independent review of this documentation delta; resolve findings before presenting the package as review-ready. Operational evidence requires separate owner authorization for a bounded disposable environment.

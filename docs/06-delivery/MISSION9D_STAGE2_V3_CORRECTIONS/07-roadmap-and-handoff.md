# Owner decision register, findings and implementation gates

## Owner decisions

| Decision | Options | Recommendation | Implication / missing evidence | Gate |
|---|---|---|---|---|
| Service UIDs / privilege | shared UID; distinct service UIDs + narrowly scoped root helper | distinct UIDs, root helper with fixed operations | Need ownership, capability and systemd unit review; same UID defeats peer isolation | Blocks implementation |
| IPC trust anchor | UDS peer creds; inherited socketpair; loopback TLS | host UDS + kernel creds and trusted host PID/unit/executable mapping, conditional | Need target namespace credential mapping, FD denial and server pin proof | Blocks release channel |
| Release ledger | `/run`; local persistent filesystem; DB | private local persistent directory with verified fsync/lock semantics; `/run` only runtime latch | Need filesystem durability and authority ownership evidence | Blocks consume |
| Startup interlock | Docker socket proxy; manager unit ordering; runtime policy | root-owned admission broker plus boot ordering before Docker auto-start | Need prove no bypass, old containers cannot auto-run | Blocks supervisor |
| Windows metadata observation | raw pktmon/ETL; metadata streaming collector; host-side approved sensor | metadata-only streaming collector, no raw retention | Tool and exact filter/translation attribution absent | Blocks Phase A observation |
| Browser containment | existing browser; dedicated process/profile + Job Object | dedicated suspended launch/job | Need handle ownership, child inheritance, close-on-owner-death test | Blocks Windows attempt |
| Certificate handling | persistent CA trust; global bypass; fixture leaf/SPKI exception | fixture-scoped leaf/SPKI exception | Need browser mechanism, expiry and no trust-store mutation proof | Blocks browser attempt |
| Ingress provenance | localhost assumption; trusted auth only; enforceable host boundary | retain Windows→localhost preference, require independent host-enforced discriminator | Provenance is blocked in ADR-0012; no accepted predicate | Blocks protected ingress and Phase A |

No option is accepted on owner's behalf. Issuer/session authority and signing-key custody, atomic kernel deadline primitive, Stage 1 extension, and survival after manager failure are additional required design decisions.

## Six-finding closure matrix

| Finding / severity | Corrected sections | New invariant | Remaining dependency | Closure evidence / owner input |
|---|---|---|---|---|
| F1 High — owner authorization/revocation | 02,05,07 | issuer-authenticated exact-scope single-use auth; revocation and consume linearized | issuer/session interface, key custody, owner decisions | Contract now specifies ordering and failures; not closed pending control design and owner choice |
| F2 High — deadline-to-execution race | 00,02,03,04,06 | first application instruction must be kernel-linearized at `now < original deadline`; gate open is not execution | No credible WSL2/Docker first-instruction fence established | V3 specifies blocked state and D1-D6 negatives; **not closed** pending mechanism and target proof |
| F3 High — IPC trust anchors | 02,06,07 | mutual peer verification with host namespace, starttime, unit and executable identity; ambiguity disables channel | UID mapping, kernel credentials, FD and namespace behavior | Negative matrix H9; not closed pending target validation/owner UID choice |
| F4 High — Stage1 read boundary and liveness race | 01,02,03 | Stage1 alone reads under stable lock; controller death before Stage2 consume must deny | V2 snapshot releases lock before consume; no cross-store liveness linearization proven | V3 blocks live adapter; lease amendment proposed; **not closed** pending owner + Codex #1 + independent review |
| F5 High — supervision/startup fencing | 03,04,06,07 | only surviving independent finalizer plus persistent boot interlock permits release | systemd/manager failure, WSL boot order, Docker pre-exec placement | Explicit blocked state and tests; not closed until platform proof/owner gate |
| F6 Medium — per-test authorization | 06 | every target test gets its own scope, privilege, side effects and cleanup grant | Owner must authorize each named case | Complete matrix; tests remain unauthorized and unrun |

## Proposed implementation packages (not authorized)

- **2A non-releasing foundation only:** schemas, durable ledger mechanics, synthetic state-machine tests, fake authorization issuer, fake Stage 1 validation adapter, and disabled IPC adapter. No usable release endpoint, real issuer integration, live Stage 1 integration, executable bootstrap, Docker/systemd lifecycle, privileged WSL2 operation, or physical execution. Depends on owner authorization for this narrow implementation and direct/independent review. No release-capable implementation until F2/F4 contracts and platform gates are separately approved. Failure leaves adapters disabled; tombstones never reset.
- **2B Supervisor:** manager units, finalizer, cgroup/clock/fence helper. Depends on atomic deadline fence and startup interlock proof. Unit/integration design tests then separately scoped target tests. Dual review and explicit privileged test grant. If manager/fence unavailable, no release.
- **2C Recovery:** exact-ID reconciler, exposure ledger and quarantine states. Depends on 2A/2B. Test daemon outage/unknown identity with synthetic adapters; target outage only separate authorization. Cleanup execution separately authorized per operation. Unknown remains blocked.
- **2D Integration:** synthetic flow and platform evidence bundle, then Phase A readiness only. Depends on all A–E, 2A–2C and ingress provenance resolution. Dual review and separate owner execution authorization. Any missing evidence means inconclusive and no activation.

## Handoff

**Codex #1 — Direct Security Re-review:** review all eight files and exact checksums; focus on issuer/session trust, revocation linearization, deadline fence credibility, socket peer evidence, Stage1 lock boundary, manager/WSL failure and each H/M test authorization. Report finding ID, section, invariant, evidence and unresolved decision. Then request **Separate Independent Read-Only Security Reviewer** review the same package and hashes. Neither review authorizes implementation or tests. First implementation gate is owner approval of F1/F3/F4 architecture plus a demonstrated target feasibility design for F2/F5; if infeasible, remain blocked.


## V3 correction record

**Deadline defect:** V2 treated gate-open/thaw before expiry as sufficient while also forbidding app start after expiry. **New rule:** only first application instruction at `CLOCK_BOOTTIME now < deadline` counts; strict `>=` denies. **Assumptions:** kernel/runtime primitive atomically orders first instruction, expiry, and freeze and emits trusted evidence. **Proof still required:** none exists for target WSL2/Docker; F2 remains open. **Implementation impact:** release-capable code cannot be built/enabled; Stage2A remains non-releasing. **Fixture impact:** no fixture release until proof; blocked string retained.

**Stage1 race defect:** V2 liveness snapshot and Stage2 commit were separated; controller death could intervene. **New rule:** no live Stage1 integration under current contract; `LIVE STAGE 1 INTEGRATION BLOCKED — LIVENESS ORDERING UNPROVEN`. **Assumptions:** none accepted. **Proof/decision required:** owner and both security reviewers must approve an explicit Stage1 lease semantic amendment if chosen; pidfd, PID/starttime, and held lock alone are insufficient. **Implementation impact:** fake Stage1 adapter only in Stage2A; no live adapter. **Fixture impact:** release remains unavailable. Frozen contract unchanged.

# Stage 1A Owner Acceptance Exception

**Decision date: 2026-11-17.** Source reconciliation baseline: `e082d305e94f1a6b7e71547d7f17408217d2ce3d`. This records the owner's explicit decision in the current conversation; it is not a new execution grant.

| Finding                                 | Recorded disposition                                   |
| --------------------------------------- | ------------------------------------------------------ |
| Technical daemon-process identity       | **SUPPORTED**, bounded owner-mediated local provenance |
| Procedure compliance                    | **DEVIATION**                                          |
| Stage 1A                                | **ACCEPTED BY OWNER WITH EXCEPTION**                   |
| Installed systemd version applicability | **UNVERIFIED**                                         |
| Internal Docker daemon identity         | **NOT VERIFIED**                                       |
| Phase 1 R1                              | **BLOCKED / NOT ACCEPTED**                             |

## Owner decision and limits

The owner explicitly accepts existing R2.1 evidence as sufficient to close the bounded local Docker daemon-process provenance gate, acknowledging procedural deviations and the unverified applicability to the installed systemd version. The owner accepts docker.socket active/running as technically compatible with the observed socket-activated service relationship, based on independent review and corroborating process evidence. This is an **owner-approved evidence exception**, not a declaration of procedural compliance.

This decision authorizes no new inspection, Docker API request, workload operation, provider activity, provisioning, deployment or later stage. Stage 1B, Stage 1C and Stages 2–4 require separate approval. The original procedures are retained byte-for-byte as historical reviewed artifacts, not edited to claim compliance or reusable operational permission.

## Existing evidence assessed

Evidence is owner-operated output shared in-session on 2026-11-17; no new host check was performed for this decision. Configured target was Ubuntu WSL2/native Engine, operator jeysi, socket `/run/docker.sock`. Socket metadata was mode 0660, UID0/GID986, device61/inode182. Opening and closing listener output showed dockerd PID501/fd5 and systemd PID1/fd57 sharing kernel socket20538; both proc fd links reported that same socket. Socket ID, filesystem inode and PID are distinct.

PID501 reported root UID/GID, parent1 and executable `/usr/bin/dockerd`. Running executable SHA-256 matched the owner's package comparison baseline `6bffa5fc9b8922bfef287243f6d92677d30174e26e671d98afe8651dc7ef7d39`. Package provenance remains owner supplied, not independently authenticated by Codex. PID1 was root-owned systemd. Corresponding PID/mount/network/user namespaces matched; dockerd cgroup was `/system.slice/docker.service`, PID1 `/init.scope`. Both units reported loaded/active/running with native `/usr/lib/systemd/system/` fragment paths; docker.service MainPID was501. Beginning/end boot ID, PID501, start_ticks708 and PPID1 matched. All required command statuses were reported zero.

These observations support local socket-to-process provenance under a trusted kernel/admin model. They are sequential, not atomic, do not exclude every intervening exec or hostile-root manipulation, and do not establish the daemon's internal Docker ID, Windows-origin ingress enforcement or application runtime acceptance. No hidden proxy is evidenced by these results; absence of such evidence is not a cryptographic guarantee.

## Complete deviation record

1. Step1 used immediate `echo $?` instead of the exact printf helper; reported status0 remains supporting evidence.
2. Step2 omitted outer parentheses and set pipefail in the owner's current shell rather than the reviewed subshell. Pipeline failure propagation remained enabled, but the shell scope differed.
3. Final steps13–17 were pasted together with headings and explanatory text, violating individual execution/stop decisions.
4. The first `13: command not found` error occurred before required step13; the procedure's any-error STOP rule was bypassed. Later numbered headings and `Require` text also failed.
5. Step14 returned docker.socket `SubState=running`, contrary to the literal reviewed `listening` expectation; required continuation should have stopped, but steps15–17 ran.
6. Pasted sample text `socket ...` produced a command-not-found response suggesting installation. No installation was reported; the transcript does not prove all possible incidental effects absent. The suggestion granted no installation permission.

The required reads nevertheless returned complete successful outputs, including the closing stability checks. Procedural noncompliance is preserved, not cured retroactively. Codex's earlier formatting contributed to the accidental prose paste; the approval exception belongs to the owner, not Codex or the reviewer.

## Source interpretation and independent review

Upstream systemd [v255 socket.c](https://github.com/systemd/systemd/blob/v255/src/core/socket.c), [v257 socket.c](https://github.com/systemd/systemd/blob/v257/src/core/socket.c) and [v259 socket.c](https://github.com/systemd/systemd/blob/v259/src/core/socket.c) map SOCKET_RUNNING to UNIT_ACTIVE. In the Accept=no activation path, active/pending service or successful start-job queuing leads to SOCKET_RUNNING. [v259 unit-def.c](https://github.com/systemd/systemd/blob/v259/src/basic/unit-def.c) maps this state to the displayed string running. Thus active/running is compatible with the observed socket-triggered service; it is not itself a technical mismatch. Exact installed systemd version/source matching remains unverified and explicitly covered by the owner's exception.

Independent read-only security review `evidence_adjudication_review` in this session agreed: technical identity SUPPORTED; compliance DEVIATION; acceptance INCONCLUSIVE until explicit owner exception. It recommended acceptance of the existing bounded evidence as the shortest safe path, with no repeat inspection required solely to reproduce equivalent facts. The owner's subsequent explicit decision supplies that missing acceptance. No reviewer authorized operational progression.

Reviewed procedure fingerprints retained here:

- [Stage 1A](STAGE_1A_DAEMON_PROCESS_PROVENANCE_AUTHORIZATION.md): `393da47f177adb4f574d0fee83394af872782472509d372d9e7dca81918874f8`.
- [Native Engine handoff](STAGE_1A_NATIVE_ENGINE_OWNER_HANDOFF.md): `d89ba49486c03029dc38513c555a47ad1d4414a87a2c1774c0d0af7f2434b7a3`.
- [R1](STAGE_1A_R1_CANONICAL_SOCKET_AUTHORIZATION.md): `e137c9e121c0e665dedfc642f0ffb27ce0bab62962a5167a68936e26b5061b2b`.
- [R2](STAGE_1A_R2_PROCESS_IDENTITY_AUTHORIZATION.md): `eca467a9947c89311e602e427872ccc580fe7a375f1d11afe82c9dfff2acd0b3`.
- [R2.1](STAGE_1A_R2_1_OWNER_MEDIATED_AUTHORIZATION.md): `040d5f97f56436ac48e636a7bdc0f9a2b93068e5836027d82365be058fca3ce8`.

Next: review the [Stage 1B identity-query proposal](STAGE_1B_DOCKER_API_IDENTITY_AUTHORIZATION.md). No execution approval is inferred from source review or merge.

# Stage 1B Owner Acceptance Exception

| Record                     | Value                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| Decision date              | 2026-11-17                                                         |
| Repository baseline        | `0c88d714a768213461aa84536486aea121ebb6ba`                         |
| Reviewed procedure SHA-256 | `c12e2ac7a7fb47a7927f56a107f16d7c3f82b276b564bc1e3f23b0a55ff505f6` |

## Owner decision

The owner accepted the one owner-operated Stage 1B `/info` result with an exception for omission of the outer Bash subshell. The owner accepted it only as a bounded daemon-reported identity observation. This decision does not declare exact procedure compliance or independently authenticate the Docker ID.

| Finding                         | Disposition                                        |
| ------------------------------- | -------------------------------------------------- |
| Docker API identity observation | **SUPPORTED**, bounded to the one `/info` response |
| Procedure compliance            | **DEVIATION**                                      |
| Stage 1B                        | **ACCEPTED BY OWNER WITH EXCEPTION**               |
| Docker daemon ID                | **SELF-REPORTED; NOT INDEPENDENTLY MATCHED**       |
| Stage 1C and Stages 2–4         | **NOT AUTHORIZED**                                 |
| Phase 1 R1                      | **BLOCKED / NOT ACCEPTED**                         |

## Evidence and exact deviation

The reviewed procedure [`STAGE_1B_DOCKER_API_IDENTITY_AUTHORIZATION.md`](STAGE_1B_DOCKER_API_IDENTITY_AUTHORIZATION.md) specified a single `curl`/Python pipeline wrapped as `(set -o pipefail; …)`, followed immediately by the reviewed exit-status helper. Its SHA-256 is recorded above.

The owner supplied one successful response with parser validation and exit status 0. The reported fields were consistent with Stage 1A: Docker Engine `29.9.2`, Linux `x86_64`, Docker root `/var/lib/docker`, and security options `seccomp` with the built-in profile plus `cgroupns`. The daemon-reported name matched the owner's terminal prompt. The daemon ID was observed but is intentionally not copied into this repository; no independently known expected ID exists for comparison.

The executed command omitted only the outer parentheses. The `set -o pipefail` setting therefore persisted in that interactive shell rather than a subshell. The `curl` flags, Unix-socket endpoint `/run/docker.sock`, HTTP `GET /info`, parser, selected fields, and reported exit status were otherwise the reviewed ones. This shell-state difference is the exact procedural exception. The evidence remains owner-supplied and was not reproduced by Codex.

Independent read-only review of the exact proposal and reported command found the technical observation supported and the procedure noncompliant with its exact wrapper. The reviewer found no technical need to repeat the API request. The accepted result is a self-report from the daemon reached through the Stage 1A owner-accepted socket provenance; it is not cryptographic authentication, a match to a prior daemon ID, proof of Docker resource ownership, or permission to enumerate resources.

## Scope boundary

This exception closes only the bounded Stage 1B daemon-reported identity observation. It grants no Stage 1C inventory, Docker lifecycle operation, database access, provisioning, startup, mock or provider execution, cleanup, or deployment. Stage 1C requires a fresh, separate owner authorization. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

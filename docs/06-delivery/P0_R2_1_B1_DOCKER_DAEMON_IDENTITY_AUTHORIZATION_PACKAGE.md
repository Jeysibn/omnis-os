# P0-R2.1 B1 — Docker Daemon Identity Metadata Authorization Package

**Status:** Preparation only — NOT AUTHORIZED / NOT EXECUTED.  
**Target boundary:** Owner-designated Ubuntu WSL2; Docker-only topology.  
**Purpose:** One read-only Docker daemon identity/metadata request to establish the daemon candidate for a later, separately authorized B2 design. This package authorizes no resource discovery or workload inspection.

## Exact proposed operation

After owner completion and exact-revision review, execute this single command once from the approved interactive Bash session:

```bash
docker --host unix:///run/docker.sock info --format '{{.ID}}|{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}|{{.DockerRootDir}}'
```

Immediately run the single approved status reporter:

```bash
( rc=$?; if (( rc == 0 )); then printf 'command_exit_status=0\n'; else printf 'command_exit_status=%s\n' "$rc"; fi; exit "$rc" )
```

The first command pins the configured endpoint to the exact local Unix socket `/run/docker.sock`, overriding Docker CLI endpoint selection from context and environment. It calls the Docker `/info` API, whose full response is received by the local Docker CLI; the output template limits displayed and shareable evidence to the daemon-reported ID, server version, OS type, architecture, and daemon root directory, but does not limit fields returned by the API. The full response must remain transient in the private process/terminal and must never be captured into a transcript, log, screenshot, or durable file. The command source must remain frozen once its hash is recorded. No `docker inspect`, container/image/network/volume listing, context mutation, `ps`, logs, filesystem traversal, PostgreSQL query, or follow-up request is in scope. The daemon is the authority asserting these values; this is not cryptographic attestation against a compromised daemon.

## Expected identity — unresolved owner input

Before authorization, the owner must supply or explicitly accept the expected exact values and comparison rules for:

| Field | Required owner decision |
|---|---|
| Endpoint | Confirm exact local Unix socket endpoint and that it is the intended WSL2 daemon; remote/TCP/npipe endpoints are out of scope. |
| Daemon ID | Supply an independently known expected ID or explicitly authorize recording the first observed ID as a candidate only. The latter does not prove prior ownership and cannot authorize resource actions. |
| Server version | Exact value or approved version range and upgrade/change stop rule. |
| OS type / architecture | Exact expected values. |
| Docker root directory | Exact expected path class/value and change stop rule; path is metadata, not identity proof by itself. |
| Stability | Whether any external known baseline exists and how the owner will validate that the response belongs to the intended daemon. No second API call is included to test stability. |

Any omitted expectation is unresolved, not implicitly accepted. A remote endpoint, alternate socket path, or endpoint ambiguity is a stop; the pinned socket path must resolve to the intended local daemon under the separately approved target conditions. Field values are owner inputs and must not be fabricated from the Checkpoint A observations.

## Preconditions and bounded scope

The future exact grant must bind the SHA-256 of both this package and the frozen command source, command IDs, target distribution, operator, pinned endpoint `unix:///run/docker.sock`, validity window, authenticated decision reference, current source version, private evidence destination/access/retention for the five displayed fields only, redaction policy, recovery contact, and stop conditions. The owner must explicitly accept that the Docker CLI transiently receives the full `/info` response. The owner must confirm interactive Bash status preservation and trusted command resolution immediately before execution. Use ordinary privilege only. Preserve only the five-field formatted command output privately under owner control; do not retain the full `/info` response. Publish only approved redacted classifications and the exit status.

This request can identify a daemon candidate. It cannot establish that the daemon is uncompromised, owned by Omnis OS, or authorized to access any particular resource. It grants no B2 or Stage 1C permission.

## Stop conditions

Stop after the first unexpected, missing, malformed, or ambiguous result; nonzero status; endpoint/target mismatch; daemon value outside the owner-approved expectation; source hash mismatch; window expiry; loss of private evidence controls; or inability to preserve the immediately preceding status. Do not retry, switch endpoints, run another query, or inspect resources under this package. A failed or partial observation remains unresolved and requires a new reviewed grant for any further operation.

## Owner decisions still required

1. Complete all expected-value rows and choose whether a previously known daemon ID exists.
2. Decide exact scope: approve or reject this one `docker info` request and its five fields.
3. Approve operator, target, local endpoint, one-time validity window, and preconditions.
4. Approve private raw-evidence handling, redacted publication, retention, and recovery method.
5. Accept the daemon as a trusted reporting authority for this limited observation, with the residual rootful-daemon risk stated above.

## Independent review and next gates

A read-only platform/security reviewer must review the exact frozen command/package hashes before a future owner grant. After any authorized execution, reconcile the result and handling against the grant; the same reviewer or a distinct reviewer must review the exact reconciliation. B2 requires its own source, continuity controls, review, owner decision, and target-operation grant. B1 approval cannot authorize B2.

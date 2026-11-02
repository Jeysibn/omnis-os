# Omnis OS - Threat Model

## Trust zones

- **Human browser:** authenticated but untrusted input; no native runtime secrets.
- **Control plane:** policy authority over projects, tasks, identities, grants and approvals.
- **Execution worker:** holds limited authority to start runtimes; should be isolated from DB admin and host secrets.
- **Native agent runtime:** model/tool executor exposed to prompt injection and unexpected tool use.
- **MCP servers / external content:** lower-trust service endpoints, third-party code and tool output.
- **Knowledge vault:** reviewed docs plus unreviewed proposals, with project ACLs.
- **Providers:** external systems with their own authentication and entitlement/billing rules.

## Threats and controls

| ID | Threat | Impact | Control | Test |
|---|---|---|---|---|
| T-01 | Malicious prompt in README/MCP tool output orders secret upload | Credential theft | Deny host secrets to sandbox, tool allowlist, approval, egress controls, untrusted content separation | Inject hostile repo text; no secret/tool access |
| T-02 | Native CLI given developer host privileges can run `sudo` or access `$HOME` | Host compromise | Dedicated low-privilege user/container/VM, read-only mounts, no sudo, per-run root | Attempt forbidden file read/exec |
| T-03 | Custom Claude/Codex OAuth token relay breaches provider policy | Account restriction/billing | Native authorized login only, feature gate automation, documented policy review | Integration test confirms no token interception |
| T-04 | MCP server SSRF to metadata/private network or remote untrusted endpoint | Credential/network exposure | vetted endpoints, DNS/redirect validation, network isolation, allowlist | Register localhost/metadata URL denied unless trusted explicitly |
| T-05 | Agent edits skill package after approval | Remote code execution | Immutable version and hash verification, read-only materialization | Mutate contents, execution blocked |
| T-06 | Knowledge cross-project search leakage | Sensitive data exposure | ACL before search + at document read; scoped embeddings/index | Project A cannot read Project B |
| T-07 | Private Chat reuses agent session | Memory/operations contamination | distinct runtime session/workspace, no tools by default, separate store | Private chat cannot see or affect existing run |
| T-08 | Duplicate job after worker restart | Double deploy/post/charge | unique occurrence/idempotency, reconciliation before retry, external operation ID | crash/restart race simulation |
| T-09 | Overbroad approval reused for different args | Privilege escalation | action+argument digest, scope, expiry, single-use semantics | Modify args, deny |
| T-10 | Usage estimation reported as actual invoice | Financial misinformation | separate ledgers/labels, source quality flags | Verify dashboard totals and missing data |
| T-11 | Unauthenticated Hermes/MCP exposed on public interface | Arbitrary tool execution | loopback/private routing, bearer/secret rotation, private DNS/TLS, firewall | network scan / unauthorized request |
| T-12 | Uploaded archive path traversal or executable attachment | File overwrite / code execution | quarantine, content validation, safe extraction, no auto-exec | malicious zip-slip fixture |
| T-13 | 3D view shows sensitive logs to spectators | Data leak | read-model redaction and authorization, minimal HUD, optional privacy mode | run in unauthorized browser, no leaks |
| T-14 | Agent recursively delegates many subtasks | Cost spike / resource exhaustion | max depth, per-agent concurrency, task and cost caps, human approval | attempted recursive delegation blocked |
| T-15 | Provider quota unknown is treated as unlimited | Surprise expense / runaway jobs | disable paid fallbacks, hard local concurrency/usage guardrails | absent quota remains unknown and bounded |
| T-16 | Knowledge proposal automatically becomes policy | Prompt-induced instruction escalation | human review for policy/architectural knowledge, provenance, classification | adversarial proposal not published |
| T-17 | Sandbox workload escapes filesystem/network policy or outlives a failed worker | Host compromise, data access, resource exhaustion | Docker namespaces, read-only root, scoped workspace, no network, seccomp, dropped caps, cgroups, timeout, DB-lease orphan cleanup | Actual container probes deny host files, credentials, sockets, network and excess resources |

## Elevated risk operations

Treat the following as requiring separate approval or tightly pre-approved policy: production deploy/rollback, pushing or merging to protected branches, editing critical infrastructure, sending external messages, payments, deleting files/accounts, exporting data, downloading or executing unreviewed code, and adding persistent MCP secrets.

## Enforcement checklist

- [ ] No implicit administrative rights from a profile profession.
- [ ] No app credential exposed to browser, tool output, model prompt or source repository.
- [ ] Distinct service accounts/network permissions for API, worker and DB.
- [ ] Native runtime tool permissions verified at host/process level.
- [ ] Per-project data filtering in all reads, streams, embeddings and artifacts.
- [ ] Exact-argument authorization records and immutable audit.
- [ ] Upstream tool replies treated as untrusted data, never governance instructions.
- [ ] Security event logging excludes secrets and sensitive unredacted content.
- [ ] Privacy retention plan for run/chat transcripts and backup copies.
- [ ] Hardened recovery paths for runtime disconnect and stop uncertainty.

## Scope and residual risk

The R1-G2 mock sandbox controls were exercised locally; this is not a complete security audit. The rootful Docker daemon and launcher remain trusted host-level components, containers share the kernel, and AppArmor/rootless user namespaces were unavailable on the tested WSL host. Native coding assistants remain disabled. Keep arbitrary tool access and provider runtimes gated until separate policy and isolation reviews pass.

# Security Policies and Permission Model

## Default stance

One authenticated human director, self-hosted private environment. Default deny for all agent tool permissions, project knowledge access and paid model fallback. Agent profession/personality is never a grant.

## Permission scopes

`viewer`, `project.read`, `project.write`, `task.run`, `task.cancel`, `approval.decide`, `knowledge.read`, `knowledge.propose`, `knowledge.publish`, `skill.inspect`, `skill.install`, `mcp.connect`, `tool.execute.read`, `tool.execute.write`, `workspace.read`, `workspace.write`, `schedule.manage`, `budget.manage`, `billing.read`, `office.layout.edit`.

Grants have subject (director, agent, team, run or chat), resource (project ID, repo, path, server, tool), allowed actions, expiry, source and policy version. Effective access = human approval/policy AND assigned runtime capability AND project grant AND sandbox enforcement. Any failed prerequisite denies access.

## Approval policy

- Read-only tasks in explicitly allowed workspace may be auto-approved under documented policy.
- Writes to code/knowledge may be approved per narrow scope.
- Production changes, deletions, external sharing, spending and credential modifications default to manual approval.
- Approval request includes: agent/run, action, exact arguments digest, target project/resource, impact, reason, expiry, audit ID.
- Approval is single-use or narrowly bounded. Changed arguments invalidate it. Reject expired/uncertain approvals.

## Isolation matrix

| Operation | Private Chat | Operational Read-Only Run | Operational Write Run |
|---|---|---|---|
| Model inference | Yes, authenticated runtime | Yes | Yes |
| Read private agent memory | No by default | Only agent's own scoped memory | Only agent's own scoped memory |
| Read Second Brain | Opt-in scoped | Allowed when granted | Allowed when granted |
| Publish Second Brain | Proposal only | Proposal only | Reviewed/policy-gated |
| MCP native tools | None by default | Allowlisted read | Separate write grant + approval |
| Filesystem | Isolated attachments only | Project read-only | Workspace-limited write |
| Run/cancel other agents | No | No | No unless explicit director/delegation policy |
| Deploy / merge / delete | No | No | Explicit high-risk approval |

## Network and secrets

- API and runtime listener bind to loopback/private network. End-user access through HTTPS and private DNS.
- For private Docker Compose deployment on Linux, use a private trust CA on client devices when no domain/public certificate is available; test client certificate trust.
- Credential storage: native runtime secure store/keyring or protected host secret store; not database user fields. Root-level encrypted secret files with SOPS+age considered for deployment only.
- Do not mount all host `$HOME`, `.ssh`, cloud CLI credentials or native auth stores into unrestricted sandboxes.
- External MCP auth distinct from AI model auth.
- Restrict outbound network from tool containers to approved endpoints; protect localhost/metadata addresses from SSRF.

### R1-G2 mock sandbox

- The current worker sends only a fixed Node mock program and task-title JSON to an ephemeral container. API inputs cannot select an image or executable; the current executor accepts Node workloads only.
- Use a pinned image digest with `--pull=never`; run as the worker's non-root UID/GID. Drop all Linux capabilities, set `no-new-privileges`, retain Docker's built-in seccomp profile, and apply cgroup CPU, memory, PID, shared-memory, file-descriptor, and time limits.
- Mount only a mode-0700 run workspace read/write. Keep the container root read-only; `/tmp` is a bounded `noexec,nosuid,nodev` tmpfs. Do not mount the host home, credential stores, database sockets, or Docker socket. Do not pass worker environment variables into the container.
- Set `--network=none`. Do not permit alternate DNS, host networking, private routes, container bridges, PostgreSQL, or metadata access. Any later network exception requires a network-layer allowlist and a new policy review.
- Persist run transitions and output through the trusted worker to PostgreSQL. On lease reconciliation, remove scoped sandbox containers whose run IDs no longer have unexpired DB leases.
- Residual: the launcher uses the host's rootful Docker daemon; Docker group membership is root-equivalent. The tested WSL kernel has no AppArmor or rootless/user-namespace mode. These containers share the host kernel and do not authorize future model runtimes.

## Data and privacy

- Redact secret values, full shell environments, credentials, private keys, prompts containing restricted info from general metrics/SSE.
- Provide retention classes for raw chat/tool logs vs artifacts vs audit. Backups inherit access control and deletion/retention obligations.
- Share Second Brain only after review with project permission checks; agents cannot silently export raw histories.
- Browser uploads scanned/type checked and stored outside executable directories.

## Operational checkpoints

- `policy_version` and `profile_version` must be stored with each run.
- Review provider terms for a new native CLI/SDK version before enabling background tasks.
- User-visible cost/billing label must show source quality.
- Logging/audit is nonoptional for privileged tool actions and approvals.
- Changes to permissions trigger tests and may require human sign-off.

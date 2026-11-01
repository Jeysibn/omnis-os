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
- For self-hosted k3s, use private trust CA on devices if no domain/public certificate; test client certificate trust.
- Credential storage: native runtime secure store/keyring or protected host secret store; not database user fields. Root-level encrypted secret files with SOPS+age considered for deployment only.
- Do not mount all host `$HOME`, `.ssh`, cloud CLI credentials or native auth stores into unrestricted sandboxes.
- External MCP auth distinct from AI model auth.
- Restrict outbound network from tool containers to approved endpoints; protect localhost/metadata addresses from SSRF.

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

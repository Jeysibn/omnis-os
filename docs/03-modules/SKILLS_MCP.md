# Module - Skills & Integrations (Agent Skills + MCP)

## Product concept

One user-facing hub called **Skills & Integrations** with tabs `Skills`, `MCP Connections`, `Agent Access`, `Audit`. Two separate backend registries and policies.

## Skill Registry

Skills are folders containing `SKILL.md` and optionally scripts/references/assets. Import from local path/approved archive or pinned Git ref. Validate schema, source integrity, path traversal, script inventory, licenses, and suspicious prompt injection. Scanning is a risk reduction technique, **not a guarantee of safety**.

Lifecycle: `discovered -> quarantined -> inspected -> approved/pinned -> granted -> deprecated/revoked`.

- Immutable version with SHA-256 digest; approved version must not silently update when upstream repository changes.
- Assign at global/project/agent level; effective run grant = intersection of all constraints.
- For each run, materialize only approved Skills into a read-only sandbox snapshot.
- Skills are instructions and assets, not credentials or automatic permission grants.
- Store installation source/ref and review notes for provenance.

## MCP Connection Registry

- Supports **local stdio** and **remote Streamable HTTP** where tested by installed MCP client/server versions.
- The MCP spec had transport changes in the 2026-07-28 revision; do not assume any SDK/server supports every revision. Record negotiated version and test backward compatibility.
- Remote URL registration must be allowlisted and protected from SSRF: reject loopback/metadata/private hosts except explicit owner-approved local connections; validate redirects and DNS resolution at connection time.
- Local stdio commands selected from an approved executable catalog; never run arbitrary client-supplied shell strings.
- Credential references in protected secret store, no tokens in DB/UI/logs.
- Discover server tools/resources/prompts, keep tool schema digest and risk label; re-review changed schemas.
- Scope connections by user, project, agent and mode; deny all unassigned tools by default.
- High-risk tools (writes, deployments, deletes, posting, billing) require policy and usually an approval.

## MCP operation authorization

1. Runtime requests a tool with arguments.
2. Tool gateway validates runtime identity, run/project, schema, effective grant, resource target, budget and current approval.
3. Gateway performs action with scoped secret under isolated worker.
4. Record sanitized action+result and evidence with correlation ID.
5. Return only permitted output to the runtime.

Native runtime tools not mediated by our gateway must be denied/restricted at process/container boundary. A whitelist displayed in UI alone is insufficient.

## Connection types for early integrations

- **Second Brain MCP:** read/search; proposal writing is a separate privilege.
- **GitHub:** repository read first, branch/PR writes with explicit scope.
- **Filesystem:** approved project workspace only, no home directories.
- **Browser/Playwright:** isolated browser context; approved domains; no session cookie sharing.
- **Infrastructure/monitoring:** read-only metrics and logs initially; production cluster write access deferred.

## Profiles and isolated chat

- Operational run uses approved agent+project MCP grants.
- Private chat defaults to **zero MCP connections** and no Skills with scripts; user must explicitly add a chat-safe grant for the session.
- Shared Skills can be assigned across runtime types, but compatibility must be tested and displayed per runtime.

## Failure behavior

MCP offline -> capability marked unavailable, agent may respond without tool only when safe; cannot claim an operation was performed. Tool approval expired -> deny. Skill hash mismatch -> block and prompt re-review. Tool schema changed -> invalidate sensitive grants until reviewed.

## Acceptance

- Import a benign Skill and pin its hash; modifying source after approval does not alter published version.
- Agent without write grant cannot invoke `push_changes` even if its prompt asks.
- Second Brain read succeeds only for authorized project knowledge.
- Malicious MCP response cannot override system permissions or command code execution.
- Private chat cannot invoke operational tools without separate explicit session grant.

## References

[Agent Skills](https://agentskills.io), [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

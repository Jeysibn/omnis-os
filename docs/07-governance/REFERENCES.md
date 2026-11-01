# Technical Reference Inventory

**Initial research/check date:** 2026-11-02. Revalidate vendor docs before implementation; URLs/content may change. These are background sources, not automatic approval to clone code or reuse artwork.

## Provider and runtime rules

1. **Claude subscription and third-party software** - https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account - subscription OAuth intended for native applications; third-party routes may require API or usage credits. **Priority: high**.
2. **Claude Code legal/compliance** - https://code.claude.com/docs/en/legal-and-compliance - subscription vs API distinctions and developer usage rules. **Priority: high**.
3. **Codex sign in with ChatGPT** - https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan - native Codex sign-in availability and plan-related usage.
4. **Codex authentication/programmatic notes** - https://learn.chatgpt.com/docs/auth - distinguishes ChatGPT subscription login, API key, enterprise automation access-token modes; actual permitted use must be verified.
5. **Hermes programmatic integration** - https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration - supported transport and runs API.
6. **Hermes API server** - https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server - authenticated run/session/model capability endpoints, caveats and version changes.
7. **Hermes provider configuration** - https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/quickstart.md - model provider and account options; direct Anthropic OAuth may involve extra credits.

## Skill/MCP protocols

8. **Agent Skills** - https://agentskills.io - SKILL.md packaging and progressive disclosure.
9. **Model Context Protocol** - https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http - revised Streamable HTTP; negotiate version and client compatibility.
10. **MCP specification repository** - https://github.com/modelcontextprotocol/modelcontextprotocol - transport/authorization/security documentation and version history.

## Data, scheduling, 3D

11. **pg-boss schedules** - https://pgboss.io/api/scheduling - cron/RRULE, timezone, missed and singleton behavior; version-test rather than copying examples unverified.
12. **pgvector** - https://github.com/pgvector/pgvector - PostgreSQL vector indexes; use ACL-aware retrieval.
13. **React Three Fiber** - https://github.com/pmndrs/react-three-fiber - React/Three renderer with version compatibility caveat.
14. **AI Office inspiration** - https://github.com/Bogdusik/AI-Office - virtual office backed by real persisted task state; code and asset licenses must be checked individually.
15. **Hermes Office inspiration** - https://github.com/andrizpray/Hermes-office - simulated Hermes-integrated office concept.
16. **Langfuse** - https://github.com/langfuse/langfuse - optional LLM observability design reference, not required MVP dependency.

## Use of evidence

- Do not treat README statements as verified runtime entitlement, benchmark, or security guarantee.
- Before implementation or package reuse, inspect current tagged releases, license (including asset and dependency licenses), security advisories and protocol changes.
- Keep version/date attached to all policy findings and technical spike reports; the pack does not claim integrations were tested in the user's environment.

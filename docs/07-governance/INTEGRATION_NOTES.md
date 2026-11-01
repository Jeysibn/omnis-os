# Phase 0 integration evidence (redacted)

**Date:** 2026-11-02  
**Result:** Diagnostic evidence captured; no provider-backed integration proof. Real runtime execution stopped at policy/security gates.

## Safe local status transcript

```text
$ uname -a
Linux ... 6.6.87.2-microsoft-standard-WSL2 ... x86_64 GNU/Linux

$ node --version && npm --version
v24.22.1
11.19.1

$ docker --version && docker compose version
Docker version 29.9.2, build a82e528
Docker Compose version v5.6.1

$ docker info --format 'server={{.ServerVersion}}'
permission denied while trying to connect to the Docker API at unix:///var/run/docker.sock

$ codex --version
codex-cli 0.166.0
$ codex login status
Logged in using ChatGPT

$ claude --version
2.1.316 (Claude Code)
$ claude auth status  [only loggedIn/authMethod/subscriptionType/apiProvider retained]
{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","apiProvider":"firstParty"}

$ hermes --version
Hermes Agent v0.22.2 (2026.9.24) · stable · local
$ hermes status  [credentials and full details omitted]
Model: [configured model omitted]
Provider: Anthropic
Gateway: running
Platforms: none configured
Jobs: 0
```

No API keys, OAuth tokens, user identifiers, local configuration values, or account secrets are included. The local account status is recorded only to distinguish an installed/signed-in CLI from an Omnis OS-approved credential flow.

## Interface and policy evidence

- Hermes CLI help exposes a headless server command, but the dedicated `hermes serve` process is not running. Hermes' API server is not listening on its documented default port 8642.
- Hermes upstream API-server documentation describes required bearer auth, capability discovery, run status, SSE, and stop. It also warns that the API exposes Hermes' toolset, including terminal access. No restricted read-only profile was proven locally.
- Codex CLI help exposes `codex exec` and `codex app-server`. OpenAI's app-server guidance documents streamed message deltas, thread start/resume, and a Sign in with ChatGPT flow. That flow requires app-owned OAuth and token handling under user control; the existing CLI login was not reused.
- Claude Code help/docs expose non-interactive `-p` mode. Anthropic's docs distinguish Claude Code plan authentication from API/Console billing. The separate Agent SDK/background use review remains open, so no Claude process was started.

## Proof not performed

No inference request, provider tool call, external write, or cost-incurring probe was sent. No token was copied to an Omnis OS process. No runtime SSE or cancellation transcript exists because the only accessible Hermes interface did not establish a read-only capability boundary. This report is evidence of the gate result, not evidence that a real adapter works.

## Current vendor references

- [Hermes Agent API server guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md)
- [Codex app-server with Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
- [Claude Code getting started](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Anthropic legal center](https://www.anthropic.com/legal)

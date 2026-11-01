# Module - AI Chat Workspace (Isolated Personal AI)

## Objective

Provide a normal ChatGPT-like interface with selectable authenticated model/runtime and optional AI employee personality, while ensuring chats are independent from operational runs and other chats.

## Chat modes

1. **Private Chat (default):** independent thread and runtime session, neutral assistant or selected model, no tool/Second Brain/memory write.
2. **Profile Chat:** same as private, but includes a versioned *snapshot* of an employee's identity/personality; **not** attached to that employee's working session.
3. **Operational Agent Interaction:** explicit task-control surface that can assign work, approve actions or inspect logs under normal authorization; visibly different from personal chat.

## Features

Thread sidebar/search; new chat; profile picker; runtime/model picker limited to probed availability; input/output streaming; Markdown/code; safe attachments; regenerate response with new run ID; cancel reply; export transcript; per-thread usage details and limits.

## Isolation contract

- Separate chat thread, runtime session key, workspace path, environment, memory namespace, transcript, tool policy and event stream per conversation.
- Profile Chat pins `profile_version_id`; it must not mutate the live employee profile or read their work memory unless explicit scoped retrieval is requested and authorized.
- No Skills executing scripts, MCP tools or project knowledge by default. Optional chat-safe read-only capabilities are scoped to that chat only.
- Uploaded documents are quarantined/validated; never mounted into operational agent worker by default.
- Chat cannot send operational `steer` or cancel on existing project runs without switching to explicit Agent Workspace controls.
- `Convert to Task` opens a confirmation dialog prefilled with selected approved content; no execution until confirmed.
- `Propose to Second Brain` creates an untrusted draft with sources, not a published document.
- Shared OAuth subscription limits and host CPU/GPU remain shared despite session isolation; scheduler gives operational runs bounded priority and exposes contention.

## Model selection / fallback

- Picker shows only available models from permitted runtime connections; best-effort model catalog from installed version.
- Switching model inside one chat creates a documented per-turn record and may fork session if provider state semantics are incompatible; never silently change agent default model.
- Paid model/API fallback off by default; clearly label connection type and expected billing mode.

## Usage

Store per-message or per-turn measured token counts where surfaced by runtime, reference value, and source quality. Do not invent tokens for unknown telemetry. Aggregate per thread without double-counting resume/replay events.

## Acceptance

- Atlas operational run continues unaffected while a private Atlas Profile Chat starts and ends.
- Chat with no tools cannot read local filesystem through its runtime's native defaults; verify sandbox boundary.
- Two private chats on same model retain separate histories after restart.
- Converting chat to task requires explicit target project/assignee/policy approval.
- A chat using shared subscription quota can hit rate limits without falsely claiming independent capacity.

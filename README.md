# Omnis OS

Omnis OS is a single-owner command center for managing agents, projects, tasks, and observable runs. The first implementation gate is deliberately limited to a visibly labeled mock run lifecycle while runtime permissions and the real integration boundary are reviewed.

## Current status

The first functional gate is a local owner session, task queue, and synthetic run inspector with ordered SSE events, cancellation, and state reconstruction after browser reload. It is mock-only: no provider is connected, and synthetic output cannot be accepted as verified evidence. Hermes, Codex, and Claude did not pass a safe, isolated real-runtime probe. Docker access is denied in this WSL environment. See [the governance decision log](docs/07-governance/DECISIONS_RISKS.md), [Phase 0 integration notes](docs/07-governance/INTEGRATION_NOTES.md), and [mock run proof](docs/07-governance/evidence/MOCK_RUN_PROOF.md).

## Development

The workspace uses pnpm, with the version pinned in `package.json`. The current gate uses a React/Vite/Tailwind web app, a Fastify API, a loopback-only worker boundary, and a deterministic mock runtime. Package versions are pinned in manifests; the pnpm lockfile remains pending because this host could not reach the package registry.

```sh
pnpm install
pnpm configure:owner
pnpm dev
```

## Safety boundary

The API process does not launch native shell tools. Real provider execution stays disabled until the runtime, policy, token ownership, and worker isolation gates are documented and approved. Run and task records live in the local worker's memory in this gate and are lost if that process restarts.

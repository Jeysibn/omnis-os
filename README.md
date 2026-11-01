# Omnis OS

Omnis OS is a single-owner command center for managing agents, projects, tasks, and observable runs. The first implementation gate is deliberately limited to a visibly labeled mock run lifecycle while runtime permissions and the real integration boundary are reviewed.

## Current status

Phase 0 found that Hermes, Codex, and Claude are installed, but no real runtime passed the required safe, isolated, end-to-end probe. Docker access is denied in this WSL environment. See [the governance decision log](docs/07-governance/DECISIONS_RISKS.md) and [integration evidence](docs/07-governance/INTEGRATION_NOTES.md).

## Development

The workspace uses pnpm, with the version pinned in `package.json`. The first gate will provide a React/Vite/Tailwind web app, a Fastify API, a worker boundary, and a deterministic mock runtime. Mock runs are synthetic and must never be represented as connected provider activity.

```sh
pnpm install
pnpm dev
```

## Safety boundary

The API process will not launch native shell tools. Real provider execution stays disabled until the runtime, policy, token ownership, and worker isolation gates are documented and approved.

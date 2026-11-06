# Phase 1 credential custody options

**Status:** Design assessment only. No provider credential, authentication flow, deployment, or real inference is authorized. The target deployment environment has not been selected or inspected, so no option is approved for activation.

## Threat and required boundary

The current rootful Docker launcher has authority to control a root-running Docker daemon. Docker documents that its daemon requires root unless rootless mode is used, and that Docker group membership grants root-level privileges. A provider secret or authorizer signing key on that host is therefore exposed to a compromised rootful launcher or an actor with equivalent Docker authority. [Docker Engine security](https://docs.docker.com/engine/security/) · [Docker post-installation](https://docs.docker.com/engine/install/linux-postinstall/)

Any future custody design must protect both the provider credential and the authorizer signing key from the launcher. The trusted boundary must also own the approval decision or verify an owner decision that the launcher cannot forge. Moving only the provider key while leaving an approval-signing key or unrestricted credential-minting authority on the launcher host would not close the boundary.

## Options

| Option                                                                      | Security effect against the current launcher threat                                                                                                                                                                                                                                                                                                                                                                                                   | Cost and limits                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Separate protected host** for authorizer, broker, and provider credential | Strongest straightforward separation if it has an independent OS/hypervisor trust boundary, separate administrators, confidential and authenticated narrow IPC (for example, mutually authenticated TLS), and egress allowlisting. The application host can relay an approved bounded request but cannot read the remote key or secret.                                                                                                               | Requires a new host or managed service, confidential authenticated connectivity, monitoring, backup/rotation procedures, and target-host verification. A VM on the same host must not be treated as separate from host-root without evidence that its hypervisor protects guest memory and key material from that host.                                                                  |
| **Redesign the existing launcher** to remove root-equivalent authority      | Rootless Docker runs both daemon and containers without host root. It can remove the current Docker-daemon privilege path if the launcher runs as a dedicated unprivileged identity, the broker and authorizer use separate identities, the launcher cannot read their files or sockets, and no privileged fallback remains. [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)                                                | Host root remains trusted and can access ordinary host files. Rootless mode alone is not proof of secret isolation; verify UID/GID separation, socket access, mounts, service configuration, and actual authority on the intended host. Support also depends on host prerequisites and cgroup/systemd behavior.                                                                          |
| **Restricted model-only broker** on a separate protected service boundary   | Removes shell, filesystem, MCP, and arbitrary tool effects from the provider execution process. A narrow request/response API can enforce one provider/model, request limits, usage limits, and fixed egress.                                                                                                                                                                                                                                         | Reduces execution capability but does not by itself protect credentials. It still needs the separate-host or verified rootless/enclave custody boundary, trusted owner authorization, durable replay/revocation controls, and truthful usage.                                                                                                                                            |
| **Confidential-compute enclave**, where the deployment supports it          | A platform such as AWS Nitro Enclaves documents memory isolation from the parent instance, no persistent storage or external networking, and attestation that can gate KMS operations. This is specifically designed to protect enclave memory from parent root/admin. [AWS Nitro Enclaves](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html) · [Enclave security](https://docs.aws.amazon.com/enclaves/latest/user/security.html) | Specialized hardware/cloud dependency and substantial integration work. The enclave has no external network, so provider traffic needs a carefully designed authenticated relay while TLS terminates inside the enclave. Attestation policy, measured image release, KMS key policy, rotation, audit, and recovery need independent review. No AWS deployment is selected or authorized. |

## Provisional direction

Prefer a **separate protected host** for the first credential-bearing authorizer/broker boundary, with a model-only execution operation and no shell or tools. “Separate” means the current Docker-root-equivalent host cannot inspect the other host’s memory, files, process environment, sockets, or administrative credentials. A VM hosted by the same root-equivalent machine does not meet that requirement unless a confidential-compute design proves the stronger boundary.

If operating a separate host is unacceptable, evaluate rootless launcher redesign against the actual deployment threat model. It can reduce the launcher’s authority, but it does not protect ordinary files from host root. Do not store real provider credentials on the current host while the rootful launcher remains.

## Provider authentication policy finding (2026-11-07)

Current official OpenAI documentation makes **Sign in with ChatGPT (SIWC) for an
open-source app** a candidate OAuth-first integration, subject to the intended
host meeting the terms and the owner approving that account connection. The
documented Codex app-server flow passes an SIWC access token to the app-server,
which then calls the Responses API. SIWC also documents self-hosted VM usage and
a direct Responses API flow. The token-sharing terms require supported OAuth,
user authorization, and persistent token storage local to and under the user's
control; they prohibit storage in a remote or managed environment. For ChatGPT
Plan usage, requests must be for the authenticated user and connected app, a
remote runtime must be controlled by that user, and express consent is required
for background automation. These conditions mean a separately administered
host or managed Omnis service is not automatically eligible; confirm that the
specific self-hosted deployment meets the terms before implementing or storing
tokens.

The initial adapter candidate should call the Responses API directly through a
narrow model-only broker and omit the `tools` field. The Codex app-server is not
the preferred first boundary: its official preview limitations explicitly
state that it can run local shell and MCP tools and coordinate child agents.
Omitting provider-side tools in a direct Responses request still does not prove
host isolation; OS identity, credential custody, and fixed egress must be
enforced separately. Do not use or copy a Codex CLI login or app-server token.

OpenAI documents API-key authentication as standard usage-based API billing,
separate from ChatGPT Plan usage. Do not silently fall back to an API key if
SIWC is unavailable. Anthropic's current Claude Code legal documentation says
developers building applications should use API-key authentication and may not
intermediate Claude.ai subscription OAuth credentials for end users. Claude's
API-key route would require a separate owner decision about provider, billing,
credential custody, and terms; it is not the current OAuth-first candidate.

This is a provider-integration candidate assessment, not approval to implement
OAuth, retrieve or store tokens, choose a model, contact an endpoint, spend
credits, or execute inference. Current installed runtimes were observed as
Codex CLI 0.166.0 and Hermes Agent 0.22.2; installed sign-in state was not
inspected or reused.

Official sources checked on 2026-11-07:

- [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
- [Open-source SIWC registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Codex app-server with SIWC](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Self-hosted VMs with SIWC](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview)
- [Anthropic Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Anthropic API authentication](https://platform.claude.com/docs/en/manage-claude/authentication)

Systemd `IPAddressAllow=`/`IPAddressDeny=` applies IP filtering to sockets created by a unit and can implement an allowlist with `IPAddressDeny=any` plus explicit allows. Its presence in a unit file is not proof that the target host loaded and enforces the filter. The intended Linux/systemd/cgroup environment must be inspected, the active policy verified, and positive plus negative traffic tests run there. [systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)

## Required evidence before selecting an option

1. Owner identifies the intended host, hypervisor/cloud, administrator set, OS, and deployment boundary.
2. A threat model names whether host root, cloud host administrators, and the app/launcher are trusted or adversarial.
3. Broker and authorizer identities are separate from API, worker, launcher, and database identities. No provider secret, signing key, or secret-decryption authority is readable from the launcher boundary.
4. Provider credential storage has a named owner, rotation and revocation procedures, restricted retrieval, and auditable access. No CLI OAuth credential is copied or repurposed.
5. The trusted authorizer validates owner consent, exact request binding, audience, nonce, expiry, revocation, and usage limits before the broker can contact the provider.
6. Provider egress is fixed and denied by default. Verify actual policy activation on the chosen host, including denials for public internet, metadata, host/private services, alternate DNS, proxy paths, redirects, and alternate ports.
7. Negative tests prove that API, worker, launcher, unrelated service identities, and host processes outside the selected trusted boundary cannot read credentials, signing keys, or decrypted provider traffic.
8. Independent read-only security review evaluates the deployed configuration and test evidence. Disposable CI or WSL2 results are not substitutes for the intended target host.

## Current gate

The intended deployment target and independent credential owner are not yet specified. The rootful Docker launcher remains host-root-equivalent. Therefore credential custody is **not approved**, real-provider access remains **BLOCKED**, and production remains hard-wired to `SandboxedMockRuntimeAdapter`. This assessment does not resolve G4-3 or R1-G5 and does not authorize provisioning or spend.

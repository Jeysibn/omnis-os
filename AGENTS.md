# Omnis OS agent instructions

- Preserve the Omnis OS identity in docs, app chrome, and user-facing navigation.
- Follow the ordered Phase 0 and Phase 1 brief supplied for this repository. Stop real-runtime work on policy or security blockers; continue safe scaffold work only.
- Use strict TypeScript and runtime schema validation at input and event boundaries. Keep modules small and frameworks limited to the proposed web/API stack.
- Keep adapters swappable. A mock run must be conspicuously synthetic and cannot masquerade as real provider activity.
- Do not place native shell execution in the API process. Keep process privilege boundaries explicit.
- Never print, persist in logs, or commit provider credentials. Store only connection metadata outside the dedicated secret store.
- Do not enable background Claude execution until its current plan/Agent SDK policy is reviewed and approved by the owner.
- Do not create a third-party token tunnel.
- Every requested feature should have interface-level tests. Run verification requested by the brief and record its actual result; do not claim unperformed checks.

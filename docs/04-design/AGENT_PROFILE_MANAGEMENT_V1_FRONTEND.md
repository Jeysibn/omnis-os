# Agent Profile Management V1 — Phase 1 Supplement

**Status:** Implementation supplement for the Phase 1 owner management journey. The read-only screens remain governed by [Agents & Profiles V1 Frontend](AGENTS_PROFILES_V1_FRONTEND.md); this document defines the newly authorized mutations against the implemented [Agent Profile Lifecycle API](../03-modules/AGENT_PROFILE_LIFECYCLE_API.md).

## Scope

The owner can create a draft agent identity, edit its profile draft, publish the saved draft as an immutable version, and archive a published agent. Profile content is inert text. Identity and profile do not confer runtime or tool authority. This work does not execute agents or enable a real provider.

This is a bounded increment, not full AO-104 completion. The browser journey does not edit agent name/slug or assign a department at creation. Archiving is available only for published agents; it is irreversible, preserves profile and run history, prevents new assignments, and does not cancel existing runs. AO-110 still needs a complete execution journey.

## Mutation rules

- All reads and mutations use the existing owner session. Mutations carry the session CSRF token and a UUID idempotency key.
- Parse response bodies with the canonical contracts. Confirm request ID, operation, target identity, lifecycle, revision, and version before reporting success.
- Before sending, preserve the exact create body and idempotency key in tab-scoped `sessionStorage`. After an uncertain response, lock editing and offer only an explicit retry with the exact same request body and idempotency key, including after a browser refresh or session expiry. A 401 during same-key recovery preserves the pending request for after sign-in; an initial 401 is a definite refusal. Other definite 4xx refusals do not retry. A stale 409 refreshes current profile/history and never reports a publication.
- A successful publish refreshes the current profile and version history. Published profile versions are not edited in place.
- Archiving requires an explicit confirmation. A response with an unknown outcome is checked against the persisted profile; only an explicit retry may resend, using the same idempotency key.
- Never send connection credentials or provider secrets in profile fields. Text fields render as text; profile text does not grant authority.
- Demo/mocked execution labels remain distinct; this management flow makes no runtime or provider activity claim.

## Interface acceptance

1. Empty directory offers explicit owner-driven agent creation; successful creation opens the returned agent ID.
2. Creation is CSRF protected and idempotent. Unknown outcomes preserve the exact retry and cannot be dismissed into a second create.
3. A draft profile can be saved with its expected draft revision and current base version; invalid values do not submit.
4. A saved draft can be published as the next immutable version; profile and history show that version after reload.
5. Unknown save or publish outcomes offer same-key/same-body retry only. Conflicts refresh state and show an accurate non-success message.
6. Owner authorization failures, malformed receipts, loading/errors, and session expiry are visible and do not appear as successful mutations.
7. Keyboard operation, narrow viewport reflow, and accessibility checks pass for the mutation form.
8. Archiving a published agent requires confirmation, preserves history, reports only a verified archived state, and is hidden for draft or already archived agents.

The read-only spec's AP-18 assertion (“no non-GET request on any agents route”) and the no-create empty-state rule apply only to the earlier read-only scope. This supplement supersedes those two rules for the management operations listed above; all remaining read-view honesty, accessibility, navigation, and security rules continue to apply.

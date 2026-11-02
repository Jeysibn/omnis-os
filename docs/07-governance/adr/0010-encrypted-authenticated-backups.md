# ADR-0010: Encrypted, authenticated backups and safe key management

**Status:** Proposed; owner and independent security review required before implementation
**Date:** 2026-11-03

## Context

Omnis OS currently writes PostgreSQL custom-format archives and a private JSON manifest containing a SHA-256 digest, data fingerprints, and ACL metadata. File permissions and an unkeyed digest help protect against accidental exposure and corruption, but do not authenticate the archive or manifest. An actor able to replace both can create a matching digest and metadata. A custom-format archive can contain database definitions and SQL that `pg_restore` executes with the restore role's privileges.

The current restore verifier is a local recovery aid. It only accepts an operator-attested trusted archive, but that environment variable is an acknowledgement, not cryptographic verification. The restore target is disposable in CI; this does not establish safe ingestion of untrusted archives or production restore isolation.

## Decision

Do not implement cryptography or select a key-management vendor as part of this proposal. Before a separately authorized implementation, use the following design requirements:

1. Generate a unique data-encryption key (DEK) for each backup. Keep DEKs outside the repository and outside application, worker, pg-boss, and sandbox environments.
2. Separate backup-encryption permission from restore-decryption permission. Backup writers may encrypt but cannot decrypt historical archives by default; restore operators receive time-bounded, audited decryption permission. Keep key administration separate from both roles.
3. Wrap each DEK with an owner-approved KMS, HSM, or operating-system credential-store key. Keep key-encryption keys (KEKs) non-exportable where supported. Store only non-secret key identifiers and versions in the archive envelope. Define rotation, revocation, disaster recovery, and recovery after key loss before selecting a provider.
4. Use a reviewed streaming authenticated-encryption format suitable for large dumps. Encrypt sensitive manifest fields as well as the archive. Authenticate a canonical manifest that covers archive bytes, format/version, source identity, schema/migration version, ACL snapshot, sequence/data fingerprints, creation time, backup generation, freshness policy, algorithm identifiers, key identifiers, and an anti-rollback value.
5. Authenticate freshness and rollback protection against an independent trusted monotonic record or transparency ledger; timestamps inside an archive alone are not a rollback defense. Define retention, acceptable backup age, restore point selection, and owner-approved RPO/RTO before use.
6. Keep encryption keys and manifest-signing keys separate. Protect the signing key so a backup writer cannot silently authorize an altered manifest; pin trusted verification-key identities and versions outside the archive. Specify signature rotation, revocation, compromise response, and audit provenance.
7. Verify authenticity and integrity completely before exposing decrypted bytes to PostgreSQL. Decrypt into a private, owner-only staging area and atomically publish the verified plaintext only after the final authentication tag and manifest signature pass. Remove temporary plaintext and wrapped-key material on success and failure.
8. Before `pg_restore`, inspect the archive TOC and require a reviewed allowlist of schemas, object kinds, extensions, ownership/ACL items, and commands. Parse the TOC as hostile input and fail closed on unknown entries. Use a restricted restore identity that cannot create roles, change global role attributes, or access unrelated databases; a separate disposable restore environment must enforce those limits.
9. Fail closed for missing, unknown, revoked, or invalid keys, unsupported formats, tag/signature mismatch, stale or replayed backups, truncated streams, and manifest/archive disagreement. Do not silently fall back to plaintext or legacy unauthenticated restoration. Define a retirement date and migration plan for legacy formats without authenticated manifests.
10. Restore only authenticated archives, and still restore them first in a network-isolated recovery environment with disposable targets and least privilege. Keep real agent data out of the current local verifier until the isolated restore environment, authentication, key governance, TOC allowlist, and cleanup/failure-containment controls are independently reviewed. Authentication does not make a malicious but authorized archive safe to execute.

Until these requirements are implemented and independently reviewed, backups remain plaintext and unauthenticated. Restore commands are restricted to operator-vetted archives created within the trusted Omnis recovery process. Do not restore user-supplied, third-party, or otherwise untrusted archives, and do not use the current verifier for production restoration.

## Alternatives considered

### Encrypt with a long-lived repository or environment key

Rejected. A key stored beside code, in a committed file, or copied into application/worker environment is exposed to the same principals and backup lifecycle as the data. It also makes rotation and revocation difficult to prove.

### Use an unkeyed hash as archive authentication

Rejected. A digest detects accidental changes only when the expected digest is trusted independently. It does not protect against replacement of both archive and manifest.

### Restore first, inspect ACLs afterward

Rejected for untrusted input. `pg_restore` can execute archive definitions before post-restore policy checks. Post-restore ACL verification is defense in depth for trusted recovery archives, not an archive sandbox.

## Consequences

- No key-management dependency or secret is introduced by this ADR.
- Current restore tests use synthetic archives and explicitly attest them as trusted test fixtures. Restore targets begin with connections disabled; runtime access and the verified marker are committed atomically only after checks pass.
- Backup freshness/anti-rollback, encryption, confidential and authenticated manifests, key separation/lifecycle, archive TOC allowlisting, restricted restore identity, legacy-format retirement, and an isolated recovery environment remain requirements before accepting real agent data.
- The existing SHA-256 remains an integrity check, not a signature or proof of origin.

# ADR-0010: Encrypted, authenticated backups and safe key management

**Status:** Proposed; owner and independent security review required before implementation
**Date:** 2026-11-03

## Context

Omnis OS currently writes PostgreSQL custom-format archives and a private JSON manifest containing a SHA-256 digest, data fingerprints, and ACL metadata. File permissions and an unkeyed digest help protect against accidental exposure and corruption, but do not authenticate the archive or manifest. An actor able to replace both can create a matching digest and metadata. A custom-format archive can contain database definitions and SQL that `pg_restore` executes with the restore role's privileges.

The current restore verifier is a local recovery aid. It only accepts an operator-attested trusted archive, but that environment variable is an acknowledgement, not cryptographic verification. The restore target is disposable in CI; this does not establish safe ingestion of untrusted archives or production restore isolation.

## Decision

Do not implement cryptography or select a key-management vendor as part of this proposal. Before a separately authorized implementation, use the following design requirements:

1. Generate a unique data-encryption key (DEK) for each backup. Keep DEKs outside the repository and outside application, worker, pg-boss, and sandbox environments.
2. Wrap each DEK with an owner-approved KMS, HSM, or operating-system credential-store key. Keep key-encryption keys (KEKs) non-exportable where supported. Store only a non-secret key identifier and version in the archive envelope.
3. Use a reviewed streaming authenticated-encryption format suitable for large dumps. Bind a canonical manifest to the archive using authenticated associated data or a separately reviewed signature/MAC. Cover the archive bytes, format/version, database identity, schema/migration version, ACL snapshot, sequence and data fingerprints, algorithm identifiers, and key identifiers.
4. Verify authenticity and integrity completely before exposing decrypted bytes to PostgreSQL. Decrypt into a private, owner-only staging area and atomically publish the verified plaintext only after the final authentication tag/commitment passes. Remove temporary plaintext and wrapped-key material on success and failure.
5. Fail closed for missing, unknown, revoked, or invalid keys, unsupported formats, tag/signature mismatch, truncated streams, and manifest/archive disagreement. Do not silently fall back to plaintext or legacy unauthenticated restoration.
6. Separate backup creation, key administration, and restore authorization. Define key rotation, revocation, retention, recovery after key loss, audit logging, and access approval before selecting a provider or storage mechanism.
7. Restore only authenticated archives, and still restore them in a separately isolated recovery environment using least privilege, no unnecessary network access, and disposable targets. Authentication does not make a malicious but authorized archive safe to execute.

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
- Current restore tests use synthetic archives and explicitly attest them as trusted test fixtures.
- Backup encryption, manifest authentication, key lifecycle, and production restore isolation remain release blockers for any untrusted archive workflow.
- The existing SHA-256 remains an integrity check, not a signature or proof of origin.

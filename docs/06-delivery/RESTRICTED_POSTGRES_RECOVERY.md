# Omnis OS restricted PostgreSQL recovery

This runbook covers backup and an isolated restore rehearsal for the execution-disabled Compose profile. Run target-host operations only under the applicable restricted WSL2 grants. Stage 1C inventory alone grants no recovery access. See [the acceptance gates](./RESTRICTED_WSL2_ACCEPTANCE_GATES.md).

## Prepare

- Confirm the approved Docker context, explicit Unix endpoint, active daemon, exact running PostgreSQL container ID, project volume, and PostgreSQL system identifier. Use the same checkout path and three Compose files that created the container. Confirm the names and identities against the authorized resource manifest.
- Use the three privately managed restricted env files from the [Compose runbook](../../infra/compose/README.md). Under the applicable lifecycle grant, stop the four services using the restricted wrapper and start PostgreSQL alone on the same approved volume. Keep API, Worker, and Web stopped throughout recovery. Their containers may be absent, `created`, or `exited`. Recovery rejects paused, restarting, running, or ambiguous states and unexpected project containers, including orphans. Inventory is checked again before PostgreSQL commands. Do not start services or change the project during recovery. Quiesce other writers, consumers, and migration jobs for the duration. PostgreSQL sequences are not MVCC snapshots, so the backup compares their state before and after the dump. The tool rejects active client sessions and prepared transactions at its source boundary checks.
- Use an existing owner-owned `0700` archive directory outside the checkout, with storage for an archive plus a private staging copy. Choose a fresh `omnis_restore_…` database name on the same verified PostgreSQL cluster. The restore is a rehearsal, with no automatic application cutover.

## Commands

Set the following shell variables from the approved manifest. The env arguments are file paths. Store the backup's printed manifest SHA-256 in a separately trusted operator record. For restore, retrieve that previously recorded value rather than calculating a new digest from the received manifest.

```sh
node scripts/db-recovery/restricted-recovery.mjs backup \
  "$CTX" "$ENDPOINT" "$COMPOSE_ENV" "$API_ENV" "$WORKER_ENV" \
  "$PG_CONTAINER_ID" "$PG_SYSTEM_ID" "$BACKUP_ARCHIVE"

node scripts/db-recovery/restricted-recovery.mjs restore \
  "$CTX" "$ENDPOINT" "$COMPOSE_ENV" "$API_ENV" "$WORKER_ENV" \
  "$PG_CONTAINER_ID" "$PG_SYSTEM_ID" "$BACKUP_ARCHIVE" \
  "$FRESH_RESTORE_DB" "$RECORDED_MANIFEST_SHA256"
```

The CLI uses the restricted Compose wrapper for configuration and inventories all project containers through the verified Docker endpoint. It opens PostgreSQL sessions as the verified `omnis` superuser over the exact container's local Unix socket. It creates a private custom-format archive and adjacent manifest through an exported read-only snapshot, including approved role/ACL checks, settled history, migration fingerprints, and sequence values. Preserve the two files together and keep their directory private. These artifacts contain database data and are unencrypted. Use only archives made by this procedure under trusted operator custody. The external digest authenticates the manifest only to the extent that the separate record is trusted.

Restore checks the trusted manifest, the staged archive's bytes and checksum, and the exact cluster. It creates a fresh database with connections disabled and a zero connection limit. Only the verified superuser can connect during replay and verification. Archive owners and object ACLs are replayed, and approved database ACLs are reconstructed and compared. Both `omnis_authorizer` and `omnis_launcher` remain inert `NOLOGIN` principals. The verified target is closed again and marked `verified`. A failed created target stays in quarantine. Preserve the original archive, volume, target, and redacted failure stage. If closure could not be confirmed, stop operations and verify isolation against the exact target under a separate inspection grant. Cleanup and application promotion require separate authorization.

## Repeat on the intended WSL2 host

After Stage 1C and target startup grants, repeat the rehearsal with approved synthetic records and a fresh isolated target. Capture source and restore identities, manifest and archive checksums, matching history, sequences and ACLs, the inert roles, runtime connection denial, source and pre-existing target preservation, and the quarantine result of a controlled failure. Follow the separately authorized restart procedure and check the same volume and system identifier on return. Record measured backup and restore duration and data age against the owner-set numeric RPO and RTO. Disposable timings establish neither target recovery performance nor RPO/RTO acceptance.

import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { link, mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { aclSnapshotQuery, aclSnapshotsMatch, assertRuntimeAclPolicy } from './acl-integrity.mjs';
import { assertBackupSafe, metricsMatch, metricsQuery, parseMetrics } from './metrics.mjs';
import {
  assertRestrictedRestoreRoleSecurity,
  restoreRoleSecurityQuery,
} from './role-integrity.mjs';
import {
  archiveDigest,
  manifestDigest,
  privateArchivePath,
  readPrivateFile,
} from './restricted-archive.mjs';
import { project, restrictedTarget, sourceDatabase } from './restricted-target.mjs';
import { finishSnapshotExport, startSnapshotExport } from './snapshot.mjs';

const format = 'omnis-restricted-postgres-v1';
const adminDatabase = 'postgres';
const noOtherClients = `
  NOT EXISTS (SELECT 1 FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid())
  AND NOT EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database = current_database())`;
const sourceOwned = `(SELECT pg_get_userbyid(datdba) = 'omnis' FROM pg_database WHERE datname = current_database())`;
const migrationFingerprint = `
  SELECT md5(string_agg(md5(to_jsonb(m)::text), ':' ORDER BY id)) FROM omnis.schema_migrations m;`;
const sequenceState = `
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', schemaname, 'name', sequencename,
    'state', query_to_xml(format('SELECT last_value::text, is_called FROM %I.%I',
      schemaname, sequencename), false, true, '')::text
  ) ORDER BY schemaname, sequencename), '[]'::jsonb)
  FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog', 'information_schema');`;

let stage = 'arguments';
try {
  await main(process.argv.slice(2));
} catch {
  if (stage === 'arguments') {
    process.stderr.write(
      'Use backup|restore CONTEXT ENDPOINT COMPOSE_ENV API_ENV WORKER_ENV PG_CONTAINER_ID SYSTEM_ID /private/file.dump [omnis_restore_NAME MANIFEST_SHA256].\n',
    );
  }
  process.stderr.write(`Restricted recovery failed at ${stage}. Details withheld.\n`);
  process.exitCode = 1;
}

async function main(args) {
  const [action, ...options] = args;
  const [archiveArg, destination, expectedDigest] = options.slice(7);
  if (!(
    (action === 'backup' && options.length === 8) ||
    (action === 'restore' &&
      options.length === 10 &&
      /^omnis_restore_[a-z0-9_]{1,48}$/.test(destination) &&
      /^[a-f0-9]{64}$/.test(expectedDigest))
  )) {
    throw new Error('Invalid recovery arguments.');
  }
  stage = 'private archive path';
  const archive = await privateArchivePath(archiveArg);
  stage = 'restricted context, Compose configuration and PostgreSQL container';
  const db = restrictedTarget(options);
  stage = 'source database, cluster, connection role and quiescence';
  db.sql(sourceDatabase, 'SELECT 1', `(${sourceOwned}) AND (${noOtherClients})`);
  verifyRoles(db);
  const scratch = await mkdtemp(join(dirname(archive), '.omnis-recovery-'));
  const staged = join(scratch, 'archive.dump');
  const started = performance.now();
  try {
    if (action === 'backup') {
      await backup(db, archive, staged);
    } else {
      const manifest = await stageArchive(archive, staged, expectedDigest, db);
      await restore(db, staged, destination, manifest);
    }
    process.stdout.write(
      `Restricted ${action} completed in ${Math.round(performance.now() - started)} ms.\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function verifyRoles(db) {
  const roles = JSON.parse(
    db.sql(
      adminDatabase,
      restoreRoleSecurityQuery,
      `
    NOT EXISTS (
      SELECT 1 FROM pg_authid WHERE rolname IN ('omnis_authorizer','omnis_launcher')
        AND rolpassword IS NOT NULL
    )`,
    ),
  );
  assertRestrictedRestoreRoleSecurity(roles);
}

function capture(db, database, snapshot) {
  const importSnapshot = snapshot ? `SET TRANSACTION SNAPSHOT '${snapshot}';` : '';
  const result = db.sql(
    database,
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    ${importSnapshot}
    SET LOCAL TIME ZONE 'UTC';
    ${metricsQuery};
    ${aclSnapshotQuery};
    ${migrationFingerprint}
    ${sequenceState}
    COMMIT;`,
  );
  const [metricsText, aclText, migrations, sequencesText] = result.split('\n');
  if (!/^[a-f0-9]{32}$/.test(migrations)) throw new Error('Invalid migration fingerprint.');
  const metrics = parseMetrics(metricsText);
  const acl = JSON.parse(aclText);
  assertBackupSafe(metrics);
  assertRuntimeAclPolicy(acl);
  return { metrics, acl, migrations, sequences: JSON.parse(sequencesText) };
}

function matchingState(source, restored) {
  return (
    metricsMatch(source.metrics, restored.metrics) &&
    source.migrations === restored.migrations &&
    JSON.stringify(source.sequences) === JSON.stringify(restored.sequences) &&
    aclSnapshotsMatch(source.acl, restored.acl)
  );
}

async function backup(db, archive, staged) {
  stage = 'consistent read-only snapshot';
  const exporter = await startSnapshotExport(
    db.snapshot(),
    db.guard(sourceDatabase, `(${sourceOwned}) AND (${noOtherClients})`),
  );
  let source;
  try {
    source = capture(db, sourceDatabase, exporter.snapshot);
    stage = 'archive dump';
    const output = await open(staged, 'wx', 0o600);
    try {
      db.dump(exporter.snapshot, output.fd);
    } finally {
      await output.close();
    }
    stage = 'snapshot and sequence comparison';
    if (!matchingState(source, capture(db, sourceDatabase, exporter.snapshot))) {
      throw new Error('Snapshot or sequence state changed during backup.');
    }
  } finally {
    await finishSnapshotExport(exporter);
  }
  db.sql(sourceDatabase, 'SELECT 1', noOtherClients);

  stage = 'archive validation and publication';
  await readPrivateFile(staged, (file) => db.archiveList(file.fd));
  const info = await readPrivateFile(staged, (file, stat) => archiveDigest(file, stat.size));
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        format,
        project,
        sourceDatabase,
        systemId: db.systemId,
        sourceContainer: db.container,
        ...info,
        source,
      },
      null,
      2,
    )}\n`,
  );
  const temporaryManifest = `${staged}.manifest.json`;
  const file = await open(temporaryManifest, 'wx', 0o600);
  try {
    await file.writeFile(manifest);
  } finally {
    await file.close();
  }
  await link(staged, archive);
  try {
    await link(temporaryManifest, `${archive}.manifest.json`);
  } catch (error) {
    await unlink(archive);
    throw error;
  }
  process.stdout.write(`Restricted manifest SHA-256: ${manifestDigest(manifest)}\n`);
}

async function stageArchive(archive, staged, expectedDigest, db) {
  stage = 'trusted manifest and archive checksum';
  const manifest = await readPrivateFile(`${archive}.manifest.json`, async (file, stat) => {
    if (stat.size > 4 * 1024 * 1024) throw new Error('Manifest exceeds the supported size.');
    const bytes = await file.readFile();
    if (manifestDigest(bytes) !== expectedDigest) throw new Error('Untrusted manifest digest.');
    return JSON.parse(bytes.toString('utf8'));
  });
  if (
    manifest?.format !== format ||
    manifest.project !== project ||
    manifest.sourceDatabase !== sourceDatabase ||
    manifest.systemId !== db.systemId ||
    !/^[a-f0-9]{64}$/.test(manifest.sourceContainer) ||
    !Number.isSafeInteger(manifest.dumpBytes) ||
    manifest.dumpBytes <= 5 ||
    !/^[a-f0-9]{64}$/.test(manifest.dumpSha256) ||
    !/^[a-f0-9]{32}$/.test(manifest.source?.migrations) ||
    !Array.isArray(manifest.source?.sequences)
  ) {
    throw new Error('Manifest does not identify this restricted source cluster.');
  }
  assertBackupSafe(manifest.source?.metrics);
  assertRuntimeAclPolicy(manifest.source?.acl);
  databaseGrants(manifest.source.acl, 'omnis_restore_validated');
  await readPrivateFile(archive, async (file, stat) => {
    if (stat.size !== manifest.dumpBytes) throw new Error('Archive length differs from manifest.');
    const output = await open(staged, 'wx', 0o600);
    try {
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
  });
  const info = await readPrivateFile(staged, (file, stat) => archiveDigest(file, stat.size));
  if (info.dumpBytes !== manifest.dumpBytes || info.dumpSha256 !== manifest.dumpSha256) {
    throw new Error('Archive checksum mismatch.');
  }
  await readPrivateFile(staged, (file) => db.archiveList(file.fd));
  return manifest;
}

function databaseGrants(acl, database) {
  const grants = [
    `REVOKE ALL ON DATABASE "${database}" FROM PUBLIC, omnis_migrator, omnis_runtime, omnis_authorizer, omnis_launcher;`,
  ];
  const principals = [
    'PUBLIC',
    'omnis_migrator',
    'omnis_runtime',
    'omnis_authorizer',
    'omnis_launcher',
  ];
  for (const entry of acl.filter(
    (item) => item.objectType === 'database' && item.grantee !== 'omnis',
  )) {
    if (
      !principals.includes(entry.grantee) ||
      !['CONNECT', 'CREATE', 'TEMPORARY'].includes(entry.privilege) ||
      entry.grantable
    ) {
      throw new Error('Unsupported restricted database ACL.');
    }
    grants.push(`GRANT ${entry.privilege} ON DATABASE "${database}" TO ${entry.grantee};`);
  }
  return grants.join('\n');
}

async function restore(db, staged, database, manifest) {
  const marker = `omnis-restricted-restore:${randomBytes(16).toString('hex')}`;
  const name = `"${database}"`;
  const owned = `EXISTS (SELECT 1 FROM pg_database WHERE datname = '${database}'
    AND pg_get_userbyid(datdba) = 'omnis' AND datconnlimit = 0
    AND shobj_description(oid, 'pg_database') = '${marker}:quarantined')`;
  stage = 'restore target freshness';
  if (
    db.sql(
      adminDatabase,
      `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${database}');`,
    ) !== 'f'
  ) {
    throw new Error('Restore target already exists.');
  }
  stage = 'restore target creation';
  // In the gap before marking, an interrupted create is still closed to every client.
  db.sql(
    adminDatabase,
    `CREATE DATABASE ${name} TEMPLATE template0 ALLOW_CONNECTIONS false CONNECTION LIMIT 0;`,
  );
  try {
    stage = 'restore target quarantine marker';
    db.sql(
      adminDatabase,
      `BEGIN;
      COMMENT ON DATABASE ${name} IS '${marker}:quarantined';
      REVOKE ALL ON DATABASE ${name} FROM PUBLIC;
      ALTER DATABASE ${name} ALLOW_CONNECTIONS true;
      COMMIT;`,
      `EXISTS (SELECT 1 FROM pg_database WHERE datname = '${database}'
        AND pg_get_userbyid(datdba) = 'omnis' AND datconnlimit = 0 AND NOT datallowconn
        AND shobj_description(oid, 'pg_database') IS NULL)`,
    );

    stage = 'archive restore';
    db.sql(database, 'SELECT 1', owned);
    await readPrivateFile(staged, (file) => db.restore(database, file.fd));

    stage = 'restore verification';
    db.sql(database, databaseGrants(manifest.source.acl, database), owned);
    verifyRoles(db);
    if (!matchingState(manifest.source, capture(db, database))) {
      throw new Error('Restored history, sequence, migration, or ACL state differs.');
    }

    stage = 'verified isolated target';
    db.sql(
      adminDatabase,
      `BEGIN;
      ALTER DATABASE ${name} ALLOW_CONNECTIONS false;
      COMMENT ON DATABASE ${name} IS '${marker}:verified';
      COMMIT;`,
      owned,
    );
  } catch (error) {
    const failedStage = stage;
    try {
      db.sql(adminDatabase, `ALTER DATABASE ${name} ALLOW_CONNECTIONS false;`, owned);
      process.stderr.write(
        `Restore target ${database} retained in quarantine after ${failedStage}.\n`,
      );
    } catch {
      process.stderr.write(
        `Confirm the exact restore target ${database} remains isolated. Quarantine closure could not be confirmed.\n`,
      );
    }
    throw error;
  }
}

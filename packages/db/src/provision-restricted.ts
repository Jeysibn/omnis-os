import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoRestrictedBootstrapOverrides,
  loadRestrictedBootstrapConfig,
} from './restricted-bootstrap.ts';
import { createPool } from './database.ts';
import { provisionRestrictedDatabaseRoles } from './provision-roles.ts';

interface Arguments {
  command: 'preflight' | 'roles';
  bootstrapPath: string;
  workerPath: string;
}

export function parseRestrictedProvisionArguments(args: readonly string[]): Arguments {
  const [command, ...options] = args;
  if (command !== 'preflight' && command !== 'roles') {
    throw new Error(
      'Usage: provision-restricted.ts <preflight|roles> --bootstrap-env <path> --worker-env <path>',
    );
  }
  const parsed = new Map<string, string>();
  for (let index = 0; index < options.length; index += 1) {
    const flag = options[index];
    if (!['--bootstrap-env', '--worker-env'].includes(flag!) || parsed.has(flag!)) {
      throw new Error(
        'Usage: provision-restricted.ts <preflight|roles> --bootstrap-env <path> --worker-env <path>',
      );
    }
    const value = options[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error('Both restricted env-file paths are required.');
    parsed.set(flag!, value);
    index += 1;
  }
  const bootstrapPath = parsed.get('--bootstrap-env');
  const workerPath = parsed.get('--worker-env');
  if (!bootstrapPath || !workerPath || parsed.size !== 2) {
    throw new Error(
      'Usage: provision-restricted.ts <preflight|roles> --bootstrap-env <path> --worker-env <path>',
    );
  }
  return { command, bootstrapPath, workerPath };
}

async function main(): Promise<void> {
  let args: Arguments;
  let config: ReturnType<typeof loadRestrictedBootstrapConfig>;
  try {
    args = parseRestrictedProvisionArguments(process.argv.slice(2));
    assertNoRestrictedBootstrapOverrides(process.env);
    config = loadRestrictedBootstrapConfig(args.bootstrapPath, args.workerPath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Restricted bootstrap preflight failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.command === 'preflight') {
    process.stdout.write('Restricted bootstrap files and target configuration passed preflight.\n');
    return;
  }

  const pool = createPool({
    connectionString: config.adminUrl,
    max: 1,
    application_name: 'omnis-restricted-role-provisioner',
  });
  try {
    await provisionRestrictedDatabaseRoles(
      pool,
      {
        migration: config.migratorPassword,
        runtime: config.runtimePassword,
      },
      config.systemIdentifier,
    );
    process.stdout.write('Restricted runtime and migration roles were provisioned.\n');
  } catch {
    process.stderr.write(
      'Restricted role provisioning failed; details were withheld. Preserve the database and review its exact target.\n',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

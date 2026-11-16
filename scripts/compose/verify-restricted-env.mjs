import { readRestrictedEnvPair } from './restricted-env-policy.mjs';

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!['--compose-env', '--api-env', '--worker-env'].includes(option) || options.has(option)) {
      throw new Error(
        'Usage: verify-restricted-env.mjs --compose-env <path> ' +
          '--api-env <path> --worker-env <path>',
      );
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Both restricted env-file paths are required.');
    }
    options.set(option, value);
    index += 1;
  }
  const composePath = options.get('--compose-env');
  const apiPath = options.get('--api-env');
  const workerPath = options.get('--worker-env');
  if (!composePath || !apiPath || !workerPath || options.size !== 3) {
    throw new Error(
      'Usage: verify-restricted-env.mjs --compose-env <path> ' +
        '--api-env <path> --worker-env <path>',
    );
  }
  return { composePath, apiPath, workerPath };
}

try {
  const { composePath, apiPath, workerPath } = parseArgs(process.argv.slice(2));
  readRestrictedEnvPair(composePath, apiPath, workerPath);
  process.stdout.write('Restricted Compose, API, and Worker env files satisfy their allowlists.\n');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Restricted env-file validation failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { URL } from 'node:url';

export function readEnvFile(path) {
  const values = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (values.has(key)) throw new Error(`${key} is duplicated in the environment file.`);
    values.set(key, value);
  }
  return values;
}

export function validateSocketEndpoint(directory, socketPath, expectedGid) {
  const directoryStat = lstatSync(directory);
  const socketStat = lstatSync(socketPath);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o007) !== 0 ||
    directoryStat.gid !== expectedGid
  ) {
    throw new Error(
      `${directory} must be a non-world-accessible directory owned by its socket group.`,
    );
  }
  if (
    !socketStat.isSocket() ||
    socketStat.isSymbolicLink() ||
    socketStat.gid !== expectedGid ||
    (socketStat.mode & 0o020) === 0 ||
    (socketStat.mode & 0o007) !== 0
  ) {
    throw new Error(`${socketPath} must be a group-connectable Unix socket with no world access.`);
  }
}

export function validateSecretFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error(`${path} must be a regular file with owner-only permissions.`);
}

export function validateComposeEnvironment(api, worker) {
  const origin = api.get('OMNIS_ALLOWED_ORIGIN');
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error('OMNIS_ALLOWED_ORIGIN must be a private deployment HTTPS origin.');
  }
  if (
    parsedOrigin.protocol !== 'https:' ||
    parsedOrigin.origin !== origin ||
    api.get('OMNIS_SECURE_COOKIES') !== 'true'
  ) {
    throw new Error('Compose deployment requires an HTTPS origin and secure cookies.');
  }
  if (
    api.get('OMNIS_AUTHORIZER_SOCKET') !== '/run/omnis-authorizer/authorizer.sock' ||
    worker.get('OMNIS_SANDBOX_LAUNCHER_SOCKET') !== '/run/omnis-sandbox/launcher.sock'
  ) {
    throw new Error('Compose services must use the provisioned host service socket endpoints.');
  }
  for (const key of [
    'OMNIS_AUTHORIZER_DB_PASSWORD',
    'OMNIS_AUTHORIZER_DATABASE_URL',
    'OMNIS_API_AUTHORIZER_TOKEN',
    'OMNIS_LAUNCHER_DB_PASSWORD',
    'OMNIS_LAUNCHER_DATABASE_URL',
  ]) {
    if (worker.has(key))
      throw new Error('The worker environment includes control-plane authority.');
  }
  for (const key of ['OMNIS_RUNTIME_DB_PASSWORD', 'OMNIS_DATABASE_URL']) {
    if (api.has(key)) throw new Error('The API environment includes a direct database credential.');
  }
}

export function assertHostPrerequisites({
  platform = process.platform,
  uid = process.getuid?.(),
  groupIds,
  compose,
  api,
  worker,
  secretFiles = [],
  checkService = (service) =>
    execFileSync('systemctl', ['is-active', '--quiet', service], { stdio: 'ignore' }),
  checkInactiveService = (service) => {
    const result = spawnSync('systemctl', ['is-active', service], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 3 || result.stdout.trim() !== 'inactive')
      throw new Error(`${service} must be inactive because Compose owns that process.`);
  },
  checkSocket = validateSocketEndpoint,
} = {}) {
  if (platform !== 'linux' || uid !== 0)
    throw new Error('Run the private Compose host preflight as root on Linux.');
  for (const secretFile of secretFiles) validateSecretFile(secretFile);
  validateComposeEnvironment(api, worker);
  if (groupIds.authorizer !== Number(compose.get('OMNIS_AUTHORIZER_SOCKET_GID')))
    throw new Error('Authorizer socket group ID does not match the host service group.');
  if (groupIds.launcher !== Number(compose.get('OMNIS_LAUNCHER_SOCKET_GID')))
    throw new Error('Launcher socket group ID does not match the host service group.');
  checkSocket(
    '/run/omnis-authorizer',
    '/run/omnis-authorizer/authorizer.sock',
    groupIds.authorizer,
  );
  checkSocket('/run/omnis-sandbox', '/run/omnis-sandbox/launcher.sock', groupIds.launcher);
  checkService('omnis-authorizer.service');
  checkService('omnis-sandbox-launcher.service');
  checkInactiveService('omnis-api.service');
  checkInactiveService('omnis-worker.service');
}

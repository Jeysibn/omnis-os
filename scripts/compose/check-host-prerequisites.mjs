import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertHostPrerequisites, readEnvFile } from './host-prerequisites.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compose = readEnvFile(path.join(root, '.env.compose'));
const apiPath = compose.get('OMNIS_API_ENV_FILE') ?? '/etc/omnis/api.env';
const workerPath = compose.get('OMNIS_WORKER_ENV_FILE') ?? '/etc/omnis/worker.env';
const api = readEnvFile(apiPath);
const worker = readEnvFile(workerPath);
const groups = new Map(
  readFileSync('/etc/group', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.split(':'))
    .filter((parts) => parts.length >= 3)
    .map((parts) => [parts[0], Number(parts[2])]),
);
const dbAdminPath = path.join(root, '.env.db-admin');
assertHostPrerequisites({
  groupIds: {
    authorizer: groups.get('omnis-authorizer-socket'),
    launcher: groups.get('omnis-launcher-socket'),
  },
  compose,
  api,
  worker,
  secretFiles: [apiPath, workerPath, dbAdminPath],
});
process.stdout.write(
  'Private Compose host preflight passed. The existing systemd authorizer and restricted launcher are active; Compose may be started manually.\n',
);

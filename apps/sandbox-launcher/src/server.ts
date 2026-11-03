import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createPool } from '@omnis/db';
import { DockerSandboxExecutor } from './docker-sandbox.ts';
import { createSandboxLauncherApp } from './service.ts';

const socketPath = process.env.OMNIS_SANDBOX_LAUNCHER_SOCKET ?? '/run/omnis-sandbox/launcher.sock';
const connectionString = process.env.OMNIS_LAUNCHER_DATABASE_URL ?? launcherDatabaseUrl();
if (!path.isAbsolute(socketPath)) throw new Error('Launcher socket path must be absolute.');
if (new URL(connectionString).username !== 'omnis_launcher') {
  throw new Error('Sandbox launcher requires the restricted omnis_launcher database role.');
}

const scopeId = createHash('sha256')
  .update(new URL(connectionString).pathname)
  .digest('hex')
  .slice(0, 24);
const pool = createPool({ connectionString, max: 2, application_name: 'omnis-sandbox-launcher' });
const executor = new DockerSandboxExecutor({
  scopeId,
  ...(process.env.OMNIS_SANDBOX_WORKSPACE_ROOT
    ? { workspaceRoot: process.env.OMNIS_SANDBOX_WORKSPACE_ROOT }
    : {}),
});

await executor.cleanupOrphanedContainers(async (candidateRunIds) => {
  if (candidateRunIds.length === 0) return [];
  const result = await pool.query<{ run_id: string }>(
    'SELECT run_id FROM omnis.list_authorized_active_mock_runs($1::text[])',
    [candidateRunIds],
  );
  return result.rows.map(({ run_id }) => run_id);
});

const app = createSandboxLauncherApp({
  executor,
  authorize: async (runId, workerId, generation) => {
    const result = await pool.query<{ task_title: string }>(
      'SELECT task_title FROM omnis.authorize_mock_sandbox_launch($1, $2, $3)',
      [runId, workerId, generation],
    );
    return result.rows[0]?.task_title;
  },
  checkDatabase: async () => {
    await pool.query('SELECT 1');
  },
});
app.addHook('onClose', async () => {
  await pool.end();
  await rm(socketPath, { force: true });
});

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
const existingSocket = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
if (existingSocket) {
  if (!existingSocket.isSocket() || existingSocket.uid !== (process.getuid?.() ?? -1)) {
    throw new Error('Refusing to replace an unowned or non-socket launcher path.');
  }
  await rm(socketPath);
}
await app.listen({ path: socketPath });
const socketMode = Number.parseInt(process.env.OMNIS_SANDBOX_LAUNCHER_SOCKET_MODE ?? '600', 8);
if (![0o600, 0o660].includes(socketMode))
  throw new Error('Launcher socket mode must be 600 or 660.');
await chmod(socketPath, socketMode);
app.log.info('Omnis OS sandbox launcher ready on its Unix socket.');

const shutdown = () => void app.close();
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

function launcherDatabaseUrl(): string {
  const password = process.env.OMNIS_LAUNCHER_DB_PASSWORD;
  if (!password || password.length < 32) throw new Error('Launcher database password is missing.');
  return `postgresql://omnis_launcher:${encodeURIComponent(password)}@${process.env.OMNIS_DB_HOST ?? '127.0.0.1'}:${process.env.OMNIS_DB_PORT ?? '5432'}/${process.env.OMNIS_DB_NAME ?? 'omnis'}`;
}

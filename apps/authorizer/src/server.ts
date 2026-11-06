import {
  createPool,
  PostgresAuthorizationStore,
  PostgresProjectManagementStore,
  PostgresProjectMilestoneStore,
  PostgresProjectEpicStore,
  PostgresMissionEventStore,
} from '@omnis/db';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createAuthorizerApp } from './app.ts';
import { env } from './env.ts';
import { PostgresAgentLifecycleStore } from '@omnis/db';

const pool = createPool({
  connectionString: env.databaseUrl,
  max: 4,
  application_name: 'omnis-authorizer-service',
});
const store = new PostgresAuthorizationStore(pool, pool, {
  agentLifecycle: new PostgresAgentLifecycleStore(
    pool,
    env.agentIdempotencyKey,
    env.agentIdempotencyKeyVersion,
  ),
  projectManagement: new PostgresProjectManagementStore(
    pool,
    env.agentIdempotencyKey,
    env.agentIdempotencyKeyVersion,
  ),
  projectMilestones: new PostgresProjectMilestoneStore(
    pool,
    env.agentIdempotencyKey,
    env.agentIdempotencyKeyVersion,
  ),
  projectEpics: new PostgresProjectEpicStore(
    pool,
    env.agentIdempotencyKey,
    env.agentIdempotencyKeyVersion,
  ),
});
await store.recordExpiredAuthorizations();

const missionEventStore = new PostgresMissionEventStore(pool, env.agentIdempotencyKey);
const app = createAuthorizerApp({
  store,
  missionEvents: missionEventStore,
  serviceToken: env.serviceToken,
  checkDatabase: async () => {
    await pool.query('SELECT 1');
  },
});
const expiryTimer = setInterval(() => {
  void store.recordExpiredAuthorizations().catch((error: unknown) => {
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Authorization expiry audit failed.',
    );
  });
}, 60_000);
expiryTimer.unref();

app.addHook('onClose', async () => {
  clearInterval(expiryTimer);
  await missionEventStore.close();
  await pool.end();
  await rm(env.socketPath, { force: true });
});

await mkdir(path.dirname(env.socketPath), { recursive: true, mode: 0o750 });
const existingSocket = await lstat(env.socketPath).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
if (existingSocket) {
  if (!existingSocket.isSocket() || existingSocket.uid !== (process.getuid?.() ?? -1)) {
    throw new Error('Refusing to replace an unowned or non-socket authorizer path.');
  }
  await rm(env.socketPath);
}
await app.listen({ path: env.socketPath });
const socketMode = Number.parseInt(process.env.OMNIS_AUTHORIZER_SOCKET_MODE ?? '600', 8);
if (![0o600, 0o660].includes(socketMode))
  throw new Error('Authorizer socket mode must be 600 or 660.');
await chmod(env.socketPath, socketMode);
app.log.info('Omnis OS authorizer ready on its Unix socket');

let shutdownStarted = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  app.log.info({ signal }, 'Closing the Omnis OS authorizer.');
  void app.close().catch((error: unknown) => {
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'The authorizer did not close cleanly.',
    );
    process.exitCode = 1;
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

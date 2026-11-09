import {
  createPool,
  PostgresAuthorizationStore,
  PostgresProjectManagementStore,
  PostgresProjectMilestoneStore,
  PostgresProjectEpicStore,
  PostgresConnectorAuthorizationStore,
} from '@omnis/db';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createAuthorizerApp } from './app.ts';
import { createBrokerAuthorizerIpcApp } from './broker-ipc-app.ts';
import {
  createAuthorizerDecisionSigner,
  loadAuthorizerDecisionSigningKey,
} from './decision-signing-key.ts';
import { env } from './env.ts';
import { PostgresAgentLifecycleStore } from '@omnis/db';

const pool = createPool({
  connectionString: env.databaseUrl,
  max: 4,
  application_name: 'omnis-authorizer-service',
});
const missionLaneWriterPool = createPool({
  connectionString: env.databaseUrl,
  max: 4,
  application_name: 'omnis-authorizer-mission-lane-writer',
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
    missionLaneWriterPool,
  ),
});
const signingKey = env.decisionSigningKeyFile
  ? await loadAuthorizerDecisionSigningKey({
      filePath: env.decisionSigningKeyFile,
      keyId: env.decisionSigningKeyId!,
      notBefore: env.decisionSigningKeyNotBefore!,
      notAfter: env.decisionSigningKeyNotAfter!,
    })
  : undefined;
const connectorStore = new PostgresConnectorAuthorizationStore(
  pool,
  signingKey ? { signDecision: createAuthorizerDecisionSigner(signingKey) } : {},
);
await store.recordExpiredAuthorizations();

const app = createAuthorizerApp({
  store,
  connectorStore,
  serviceToken: env.serviceToken,
  checkDatabase: async () => {
    await pool.query('SELECT 1');
  },
});
const brokerApp = env.brokerSocketPath
  ? createBrokerAuthorizerIpcApp({
      store: connectorStore,
      brokerServiceToken: env.brokerServiceToken!,
      apiServiceToken: env.serviceToken,
    })
  : undefined;
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
  await missionLaneWriterPool.end();
  await pool.end();
  await rm(env.socketPath, { force: true });
});

if (brokerApp && env.brokerSocketPath) {
  brokerApp.addHook('onClose', async () => {
    await rm(env.brokerSocketPath!, { force: true });
  });
}

const socketMode = Number.parseInt(process.env.OMNIS_AUTHORIZER_SOCKET_MODE ?? '600', 8);
if (![0o600, 0o660].includes(socketMode))
  throw new Error('Authorizer socket mode must be 600 or 660.');
await listenOnOwnedSocket(app, env.socketPath, socketMode);
app.log.info('Omnis OS authorizer ready on its Unix socket');
if (brokerApp && env.brokerSocketPath) {
  await listenOnOwnedSocket(brokerApp, env.brokerSocketPath, env.brokerSocketMode);
  app.log.info('Omnis OS synthetic broker authorizer IPC ready on its separate Unix socket');
}

let shutdownStarted = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  app.log.info({ signal }, 'Closing the Omnis OS authorizer.');
  void (async () => {
    await brokerApp?.close();
    await app.close();
  })().catch((error: unknown) => {
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'The authorizer did not close cleanly.',
    );
    process.exitCode = 1;
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

async function listenOnOwnedSocket(
  target: typeof app,
  socketPath: string,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
  const existingSocket = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existingSocket) {
    if (!existingSocket.isSocket() || existingSocket.uid !== (process.getuid?.() ?? -1)) {
      throw new Error('Refusing to replace an unowned or non-socket authorizer path.');
    }
    await rm(socketPath);
  }
  await target.listen({ path: socketPath });
  await chmod(socketPath, mode);
}

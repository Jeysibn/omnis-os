import { createPool, PostgresAuthorizationStore } from '@omnis/db';
import { createAuthorizerApp } from './app.ts';
import { env } from './env.ts';

const pool = createPool({
  connectionString: env.databaseUrl,
  max: 4,
  application_name: 'omnis-authorizer-service',
});
const store = new PostgresAuthorizationStore(pool, pool);
await store.recordExpiredAuthorizations();

const app = createAuthorizerApp({
  store,
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
  await pool.end();
});

await app.listen({ host: env.host, port: env.port });
app.log.info({ host: env.host, port: env.port }, 'Omnis OS authorizer ready on loopback');

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

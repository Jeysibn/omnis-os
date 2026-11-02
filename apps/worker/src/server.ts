import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { PgBoss } from 'pg-boss';
import { createPool, migrate, PostgresRunStore, StoreError } from '@omnis/db';
import { CreateRunSchema, CreateTaskSchema } from '@omnis/contracts';
import { CoordinatorError, queueName, RunCoordinator } from './run-coordinator.ts';

const host = process.env.OMNIS_WORKER_HOST ?? '127.0.0.1';
const port = Number(process.env.OMNIS_WORKER_PORT ?? 4101);
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('The initial Omnis OS worker must bind to loopback.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('OMNIS_WORKER_PORT must be a valid TCP port.');
}
const internalToken = process.env.OMNIS_INTERNAL_TOKEN;
if (!internalToken || internalToken.length < 64) {
  throw new Error('OMNIS_INTERNAL_TOKEN must be generated with `pnpm configure:owner`.');
}
const connectionString = getDatabaseUrl();
const pool = createPool({ connectionString, max: 8, application_name: 'omnis-worker' });
await migrate(pool);

const boss = new PgBoss({
  connectionString,
  schema: 'pgboss',
  application_name: 'omnis-worker-queue',
  max: 8,
  supervise: true,
});
const app = Fastify({ logger: { redact: ['req.headers.x-omnis-internal-token'] } });
boss.on('error', (error) => {
  app.log.error({ errorType: error.name }, 'Durable queue reported an error.');
});
await boss.start({ attempts: 5 });
await boss.createQueue(queueName, { retryLimit: 0, retryDelay: 0 });

const store = new PostgresRunStore(pool);
const coordinator = new RunCoordinator(store, boss);
await coordinator.reconcileExpiredRuns();
await boss.work(queueName, { batchSize: 1, localConcurrency: 1 }, async ([job]) => {
  if (job) await coordinator.handleQueueJob(job.data, job.signal);
});

const recoveryTimer = setInterval(() => {
  void coordinator.reconcileExpiredRuns().catch((error: unknown) => {
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Run lease reconciliation failed.',
    );
  });
}, 5_000);
recoveryTimer.unref();

app.addHook('preHandler', async (request, reply) => {
  const supplied = request.headers['x-omnis-internal-token'];
  const candidate = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
  const expected = Buffer.from(internalToken);
  const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
  if (!matches)
    return reply
      .code(401)
      .send({ error: { code: 'unauthorized', message: 'Internal worker authentication failed.' } });
});

app.get('/internal/v1/health', async () => ({
  status: 'ok',
  product: 'Omnis OS',
  runtimeKind: 'mock',
  synthetic: true,
  persistence: 'postgresql',
  queue: 'pg-boss',
  queueName,
}));
app.get('/internal/v1/tasks', async () => coordinator.listTasks());
app.post('/internal/v1/tasks', async (request, reply) => {
  const parsed = await parseTaskInput(request.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: { code: 'invalid_input', message: 'Task input is invalid.' } });
  return reply.code(201).send(await coordinator.createTask(parsed.data));
});
app.get('/internal/v1/runs', async () => coordinator.listRuns());
app.post('/internal/v1/runs', async (request, reply) => {
  const parsed = await parseRunInput(request.body);
  const idempotencyKey = request.headers['idempotency-key'];
  if (
    !parsed.success ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 16 ||
    idempotencyKey.length > 128
  ) {
    return reply.code(400).send({
      error: { code: 'invalid_input', message: 'Run input or Idempotency-Key is invalid.' },
    });
  }
  try {
    const result = await coordinator.startRun(parsed.data.taskId, idempotencyKey);
    return reply.code(result.created ? 201 : 200).send(result.run);
  } catch (error) {
    if (error instanceof CoordinatorError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    throw error;
  }
});
app.get<{ Params: { runId: string } }>('/internal/v1/runs/:runId', async (request, reply) => {
  const run = await coordinator.getRun(request.params.runId);
  return run
    ? run
    : reply.code(404).send({ error: { code: 'not_found', message: 'Run was not found.' } });
});
app.get<{ Params: { runId: string }; Querystring: { after?: string } }>(
  '/internal/v1/runs/:runId/events',
  async (request, reply) => {
    const headerCursor = request.headers['last-event-id'];
    const after =
      headerCursor === undefined
        ? request.query.after === undefined
          ? 0
          : Number(request.query.after)
        : Number(headerCursor);
    if (!Number.isSafeInteger(after) || after < 0) {
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Event cursor must be a non-negative integer.' },
      });
    }
    try {
      if (!(await coordinator.getRun(request.params.runId))) {
        throw new CoordinatorError('not_found', 'Run was not found.', 404);
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let lastSequence = after;
      const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
      let unsubscribe = () => {};
      const send = (event: {
        id: string;
        sequence: number;
        type: string;
        [key: string]: unknown;
      }) => {
        if (event.sequence <= lastSequence) return;
        lastSequence = event.sequence;
        reply.raw.write(
          `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        if (
          ['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(event.type)
        ) {
          clearInterval(heartbeat);
          unsubscribe();
          reply.raw.end();
        }
      };
      unsubscribe = coordinator.subscribe(request.params.runId, send);
      reply.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      (await coordinator.getEvents(request.params.runId, after)).forEach(send);
    } catch (error) {
      if (error instanceof CoordinatorError || error instanceof StoreError) {
        if (!reply.sent) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        }
        reply.raw.end();
        return;
      }
      throw error;
    }
  },
);
app.post<{ Params: { runId: string } }>('/internal/v1/runs/:runId/stop', async (request, reply) => {
  try {
    return await coordinator.stopRun(request.params.runId);
  } catch (error) {
    if (error instanceof CoordinatorError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    throw error;
  }
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(
    { errorType: error instanceof Error ? error.name : 'unknown' },
    'The local mock worker request failed.',
  );
  return reply.code(500).send({
    error: { code: 'internal_error', message: 'The mock worker encountered an internal error.' },
  });
});

app.addHook('onClose', async () => {
  clearInterval(recoveryTimer);
  await coordinator.shutdown();
  await boss.stop();
  await pool.end();
});

await app.listen({ host, port });
app.log.info(
  { host, port, runtimeKind: 'mock', persistence: 'postgresql' },
  'Omnis OS worker ready on loopback',
);

let shutdownStarted = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  app.log.info({ signal }, 'Closing the local mock worker.');
  void app.close().catch((error: unknown) => {
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'The worker did not close cleanly.',
    );
    process.exitCode = 1;
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

function parseTaskInput(body: unknown) {
  return CreateTaskSchema.safeParse(body);
}

function parseRunInput(body: unknown) {
  return CreateRunSchema.safeParse(body);
}

function getDatabaseUrl(): string {
  const configured = process.env.OMNIS_DATABASE_URL;
  if (configured) {
    const parsed = new URL(configured);
    if (!['127.0.0.1', '::1', 'localhost', 'postgres'].includes(parsed.hostname)) {
      throw new Error(
        'The initial worker database must be reachable through approved local Compose networking.',
      );
    }
    return configured;
  }
  const password = process.env.OMNIS_DB_PASSWORD;
  if (!password) throw new Error('OMNIS_DATABASE_URL or OMNIS_DB_PASSWORD must be configured.');
  return `postgresql://omnis:${encodeURIComponent(password)}@127.0.0.1:5432/omnis`;
}

import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';
import {
  AgentDirectoryQuerySchema,
  AgentIdSchema,
  AgentVersionQuerySchema,
  AgentVersionRouteParamSchema,
  ProjectIdSchema,
  ProjectWorkspaceQuerySchema,
  SetTaskProjectSchema,
  TaskIdSchema,
} from '@omnis/contracts';
import { syntheticTaskRunTestMode } from '@omnis/contracts/synthetic-task-run';
import { PgBoss } from 'pg-boss';
import {
  createPool,
  PostgresRuntimeAuthorizationReader,
  PostgresRunStore,
  AgentProfileStoreError,
  PostgresAgentProfileStore,
  StoreError,
} from '@omnis/db';
import { CreateRunSchema, CreateTaskSchema } from '@omnis/contracts';
import { CoordinatorError, queueName, RunCoordinator } from './run-coordinator.ts';
import { SandboxedMockRuntimeAdapter } from './sandboxed-mock-runtime.ts';
import { UnixMockSandboxLauncherClient } from './sandbox-launcher-client.ts';
import { streamPersistedRunEvents } from './reliable-event-stream.ts';
import { SyntheticBrokerClient } from './synthetic-broker-client.ts';
import { registerSyntheticTaskRunRoute } from './synthetic-task-run-routes.ts';

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
for (const forbiddenSecret of [
  'OMNIS_AUTHORIZER_DB_PASSWORD',
  'OMNIS_AUTHORIZER_DATABASE_URL',
  'OMNIS_API_AUTHORIZER_TOKEN',
  'OMNIS_LAUNCHER_DATABASE_URL',
  'OMNIS_LAUNCHER_DB_PASSWORD',
]) {
  if (process.env[forbiddenSecret]) {
    throw new Error(
      'The execution worker must not receive authorizer credentials or service tokens.',
    );
  }
}
const connectionString = getDatabaseUrl();
const pool = createPool({ connectionString, max: 8, application_name: 'omnis-worker' });

const boss = new PgBoss({
  connectionString,
  schema: 'pgboss',
  application_name: 'omnis-worker-queue',
  max: 8,
  supervise: true,
  migrate: false,
  createSchema: false,
});
const app = Fastify({ logger: { redact: ['req.headers.x-omnis-internal-token'] } });
const syntheticBrokerTestMode = syntheticTaskRunTestMode(process.env);
boss.on('error', (error) => {
  app.log.error({ errorType: error.name }, 'Durable queue reported an error.');
});
await boss.start({ attempts: 5 });
await boss.createQueue(queueName, { retryLimit: 0, retryDelay: 0 });

const store = new PostgresRunStore(pool, internalToken);
const agentProfiles = new PostgresAgentProfileStore(pool, internalToken);
const launcherSocket = process.env.OMNIS_SANDBOX_LAUNCHER_SOCKET;
if (!launcherSocket || !launcherSocket.startsWith('/')) {
  throw new Error('OMNIS_SANDBOX_LAUNCHER_SOCKET must point to the provisioned private socket.');
}
const runtime = new SandboxedMockRuntimeAdapter(new UnixMockSandboxLauncherClient(launcherSocket));
const authorizationStore = new PostgresRuntimeAuthorizationReader(pool);
const coordinator = new RunCoordinator(store, boss, runtime, authorizationStore);
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

function sendAgentProfileStoreError(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof AgentProfileStoreError)) return false;
  reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  return true;
}

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

if (syntheticBrokerTestMode) {
  const brokerSocket = process.env.OMNIS_SYNTHETIC_BROKER_SOCKET;
  const brokerToken = process.env.OMNIS_SYNTHETIC_BROKER_TEST_TOKEN;
  if (!brokerSocket || !brokerToken) {
    throw new Error('Synthetic broker test IPC requires its socket and disposable test token.');
  }
  registerSyntheticTaskRunRoute(app, {
    authenticate: async () => {},
    enabled: true,
    store,
    broker: new SyntheticBrokerClient(brokerSocket, brokerToken),
  });
}

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
app.get<{ Params: { projectId: string }; Querystring: { cursor?: string; limit?: string } }>(
  '/internal/v1/projects/:projectId/tasks',
  async (request, reply) => {
    const projectId = ProjectIdSchema.safeParse(request.params.projectId);
    const query = ProjectWorkspaceQuerySchema.safeParse(request.query);
    if (!projectId.success || !query.success)
      return reply.code(422).send({
        error: { code: 'invalid_input', message: 'Project workspace query is invalid.' },
      });
    try {
      return await coordinator.listProjectWorkspaceTasks(projectId.data, query.data);
    } catch (error) {
      if (error instanceof CoordinatorError)
        return reply.code(error.statusCode).send({
          error: { code: error.code, message: error.message },
        });
      throw error;
    }
  },
);
app.get('/internal/v1/agents', async (request, reply) => {
  if (!AgentDirectoryQuerySchema.safeParse(request.query).success) {
    return reply.code(422).send({
      error: { code: 'invalid_input', message: 'Agent directory query parameters are invalid.' },
    });
  }
  try {
    return await agentProfiles.listAgents();
  } catch (error) {
    if (sendAgentProfileStoreError(error, reply)) return;
    throw error;
  }
});
app.get<{ Params: { agentId: string } }>('/internal/v1/agents/:agentId', async (request, reply) => {
  const agentId = AgentIdSchema.safeParse(request.params.agentId);
  const query = AgentDirectoryQuerySchema.safeParse(request.query);
  if (!agentId.success || !query.success)
    return reply.code(422).send({
      error: { code: 'invalid_input', message: 'Agent identifier is invalid.' },
    });
  try {
    const profile = await agentProfiles.getAgent(agentId.data);
    return (
      profile ??
      reply.code(404).send({
        error: { code: 'not_found', message: 'Agent or profile version was not found.' },
      })
    );
  } catch (error) {
    if (sendAgentProfileStoreError(error, reply)) return;
    throw error;
  }
});
app.get<{ Params: { agentId: string }; Querystring: { cursor?: string; limit?: string } }>(
  '/internal/v1/agents/:agentId/versions',
  async (request, reply) => {
    const agentId = AgentIdSchema.safeParse(request.params.agentId);
    const query = AgentVersionQuerySchema.safeParse(request.query);
    if (!agentId.success || !query.success)
      return reply.code(422).send({
        error: { code: 'invalid_input', message: 'Agent version history query is invalid.' },
      });
    try {
      const result = await agentProfiles.listVersions(agentId.data, {
        ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
      });
      return (
        result ??
        reply.code(404).send({
          error: { code: 'not_found', message: 'Agent or profile version was not found.' },
        })
      );
    } catch (error) {
      if (sendAgentProfileStoreError(error, reply)) return;
      throw error;
    }
  },
);
app.get<{ Params: { agentId: string; version: string } }>(
  '/internal/v1/agents/:agentId/versions/:version',
  async (request, reply) => {
    const agentId = AgentIdSchema.safeParse(request.params.agentId);
    const version = AgentVersionRouteParamSchema.safeParse(request.params.version);
    const query = AgentDirectoryQuerySchema.safeParse(request.query);
    if (!agentId.success || !version.success || !query.success)
      return reply.code(422).send({
        error: { code: 'invalid_input', message: 'Agent profile version identifier is invalid.' },
      });
    try {
      const result = await agentProfiles.getVersion(agentId.data, version.data);
      return (
        result ??
        reply.code(404).send({
          error: { code: 'not_found', message: 'Agent or profile version was not found.' },
        })
      );
    } catch (error) {
      if (sendAgentProfileStoreError(error, reply)) return;
      throw error;
    }
  },
);
app.post('/internal/v1/tasks', async (request, reply) => {
  const parsed = await parseTaskInput(request.body);
  const requestId = taskIdempotencyKey(request.headers['idempotency-key']);
  const keyWasSupplied = request.headers['idempotency-key'] !== undefined;
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: { code: 'invalid_input', message: 'Task input is invalid.' } });
  if ((keyWasSupplied && !requestId) || (parsed.data.projectId != null && !requestId))
    return reply.code(400).send({
      error: {
        code: 'invalid_input',
        message: 'Project task creation requires a valid Idempotency-Key.',
      },
    });
  try {
    return reply.code(201).send(await coordinator.createTask(parsed.data, requestId));
  } catch (error) {
    if (error instanceof CoordinatorError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    throw error;
  }
});
app.put<{ Params: { taskId: string } }>(
  '/internal/v1/tasks/:taskId/project',
  async (request, reply) => {
    const taskId = TaskIdSchema.safeParse(request.params.taskId);
    const body = SetTaskProjectSchema.safeParse(request.body);
    const requestId = taskIdempotencyKey(request.headers['idempotency-key']);
    if (!taskId.success || !body.success || !requestId)
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Task project input is invalid.' },
      });
    try {
      return await coordinator.setTaskProject(taskId.data, body.data, requestId);
    } catch (error) {
      if (error instanceof CoordinatorError)
        return reply
          .code(error.statusCode)
          .send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  },
);
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
    if (!parsed.data.authorizationId)
      return reply.code(403).send({
        error: {
          code: 'authorization_denied',
          message: 'A persisted owner-approved authorization is required.',
        },
      });
    const result = await coordinator.startRun(
      parsed.data.taskId,
      idempotencyKey,
      parsed.data.authorizationId,
    );
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
      const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
      let stopStream = () => {};
      const close = () => {
        clearInterval(heartbeat);
        stopStream();
        if (!reply.raw.writableEnded) reply.raw.end();
      };
      reply.raw.on('close', close);
      stopStream = streamPersistedRunEvents({
        source: {
          subscribe: (runId, listener) => coordinator.subscribe(runId, () => listener()),
          getEvents: (runId, cursor) => coordinator.getEvents(runId, cursor),
        },
        runId: request.params.runId,
        afterSequence: after,
        send: (event) => {
          reply.raw.write(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        },
        end: close,
        fail: (error) => {
          app.log.error(
            { errorType: error instanceof Error ? error.name : 'unknown' },
            'Persisted event stream failed.',
          );
          close();
        },
      });
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

function taskIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    return undefined;
  }
  return value;
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
    if (parsed.username !== 'omnis_runtime') {
      throw new Error('The worker database connection must use the restricted omnis_runtime role.');
    }
    return configured;
  }
  const password = process.env.OMNIS_RUNTIME_DB_PASSWORD;
  if (!password)
    throw new Error('OMNIS_DATABASE_URL or OMNIS_RUNTIME_DB_PASSWORD must be configured.');
  return `postgresql://omnis_runtime:${encodeURIComponent(password)}@127.0.0.1:5432/omnis`;
}

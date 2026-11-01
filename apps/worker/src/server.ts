import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { CreateRunSchema, CreateTaskSchema } from '@omnis/contracts';
import { CoordinatorError, RunCoordinator } from './run-coordinator.ts';

const host = process.env.OMNIS_WORKER_HOST ?? '127.0.0.1';
const port = Number(process.env.OMNIS_WORKER_PORT ?? 4101);
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('The initial Omnis OS worker must bind to loopback.');
}
const internalToken = process.env.OMNIS_INTERNAL_TOKEN;
if (!internalToken || internalToken.length < 64) {
  throw new Error('OMNIS_INTERNAL_TOKEN must be generated with `pnpm configure:owner`.');
}

const app = Fastify({ logger: { redact: ['req.headers.x-omnis-internal-token'] } });
const coordinator = new RunCoordinator();

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
  runtimeKind: 'mock',
  synthetic: true,
}));
app.get('/internal/v1/tasks', async () => coordinator.listTasks());
app.post('/internal/v1/tasks', async (request, reply) => {
  const parsed = CreateTaskSchema.safeParse(request.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: { code: 'invalid_input', message: 'Task input is invalid.' } });
  return reply.code(201).send(coordinator.createTask(parsed.data));
});
app.get('/internal/v1/runs', async () => coordinator.listRuns());
app.post('/internal/v1/runs', async (request, reply) => {
  const parsed = CreateRunSchema.safeParse(request.body);
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
    const result = coordinator.startRun(parsed.data.taskId, idempotencyKey);
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
  const run = coordinator.getRun(request.params.runId);
  return run
    ? run
    : reply.code(404).send({ error: { code: 'not_found', message: 'Run was not found.' } });
});
app.get<{ Params: { runId: string }; Querystring: { after?: string } }>(
  '/internal/v1/runs/:runId/events',
  async (request, reply) => {
    const after = request.query.after === undefined ? 0 : Number(request.query.after);
    if (!Number.isSafeInteger(after) || after < 0) {
      return reply.code(400).send({
        error: { code: 'invalid_input', message: 'Event cursor must be a non-negative integer.' },
      });
    }
    try {
      if (!coordinator.getRun(request.params.runId)) {
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
      const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15000);
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
        if (['run.completed', 'run.cancelled', 'run.failed'].includes(event.type)) {
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
      coordinator.getEvents(request.params.runId, after).forEach(send);
    } catch (error) {
      if (error instanceof CoordinatorError) {
        return reply
          .code(error.statusCode)
          .send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  },
);
app.post<{ Params: { runId: string } }>('/internal/v1/runs/:runId/stop', async (request, reply) => {
  try {
    return coordinator.stopRun(request.params.runId);
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
  app.log.error(error);
  return reply.code(500).send({
    error: { code: 'internal_error', message: 'The mock worker encountered an internal error.' },
  });
});

await app.listen({ host, port });
app.log.info({ host, port }, 'Omnis OS mock worker listening on loopback');

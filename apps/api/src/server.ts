import Fastify from 'fastify';
import { CreateRunSchema, CreateTaskSchema, RunEventSchema } from '@omnis/contracts';
import {
  isOwnerPasswordValid,
  requireMutationProtection,
  requireOwner,
  verifyOrigin,
  verifyCsrf,
} from './auth.ts';
import { env } from './env.ts';
import { LocalSessionStore } from './session-store.ts';
import {
  parseRun,
  parseRunList,
  parseTask,
  parseTaskList,
  workerEventStream,
  workerRequest,
  WorkerRequestError,
} from './worker-client.ts';

const app = Fastify({
  logger: { redact: ['req.headers.cookie', 'res.headers.set-cookie', 'req.headers.x-omnis-csrf'] },
});
// Memory-backed sessions are limited to this single-owner local mock gate. Durable session storage is a later gate.
const sessions = new LocalSessionStore(env.sessionSecret, env.secureCookies);
app.decorateRequest('omnisSession', undefined);
app.addHook('onRequest', async (request, reply) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
  reply.header('cache-control', 'no-store');
  if (request.url === '/api/v1/health') return;
  const resolved = sessions.resolve(request.headers.cookie);
  request.omnisSession = resolved.session;
  if (resolved.setCookie) reply.header('set-cookie', sessions.cookie(resolved.session));
});

app.get('/api/v1/health', async () => ({
  status: 'ok',
  product: 'Omnis OS',
  runtimeMode: 'mock-only',
}));
app.get('/api/v1/auth/csrf', async (request) => {
  return { csrfToken: request.omnisSession?.csrfToken ?? '' };
});
app.post('/api/v1/auth/login', async (request, reply) => {
  if (!verifyOrigin(request) || !verifyCsrf(request)) {
    return reply
      .code(403)
      .send({ error: { code: 'csrf_rejected', message: 'Refresh the page and retry sign in.' } });
  }
  const body: unknown = request.body;
  const password =
    typeof body === 'object' && body !== null && 'password' in body
      ? (body as { password?: unknown }).password
      : undefined;
  if (!(await isOwnerPasswordValid(password))) {
    return reply.code(401).send({
      error: { code: 'invalid_credentials', message: 'The owner password is incorrect.' },
    });
  }
  const rotated = sessions.rotate(request.omnisSession?.id ?? '');
  request.omnisSession = rotated;
  reply.header('set-cookie', sessions.cookie(rotated));
  return { authenticated: true };
});
app.post(
  '/api/v1/auth/logout',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request, reply) => {
    if (request.omnisSession) sessions.destroy(request.omnisSession.id);
    reply.header('set-cookie', sessions.clearCookie());
    return reply.code(204).send();
  },
);

app.get('/api/v1/me', { preHandler: requireOwner }, async () => ({
  id: 'owner',
  displayName: 'Director',
  product: 'Omnis OS',
  authMode: 'local-owner-session',
}));

app.get('/api/v1/tasks', { preHandler: requireOwner }, async () =>
  workerRequest('/internal/v1/tasks', {}, parseTaskList),
);
app.post(
  '/api/v1/tasks',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'invalid_input', message: 'Enter a title and task detail.' } });
    const task = await workerRequest(
      '/internal/v1/tasks',
      { method: 'POST', body: JSON.stringify(parsed.data) },
      parseTask,
    );
    return reply.code(201).send(task);
  },
);
app.get('/api/v1/runs', { preHandler: requireOwner }, async () =>
  workerRequest('/internal/v1/runs', {}, parseRunList),
);
app.post(
  '/api/v1/runs',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request, reply) => {
    const parsed = CreateRunSchema.safeParse(request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (
      !parsed.success ||
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 16 ||
      idempotencyKey.length > 128
    ) {
      return reply.code(400).send({
        error: {
          code: 'invalid_input',
          message: 'A task and valid Idempotency-Key are required.',
        },
      });
    }
    const run = await workerRequest(
      '/internal/v1/runs',
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(parsed.data),
      },
      parseRun,
    );
    return reply.code(run.status === 'queued' ? 201 : 200).send(run);
  },
);
app.get<{ Params: { runId: string } }>(
  '/api/v1/runs/:runId',
  { preHandler: requireOwner },
  async (request) =>
    workerRequest(`/internal/v1/runs/${encodeURIComponent(request.params.runId)}`, {}, parseRun),
);
app.post<{ Params: { runId: string } }>(
  '/api/v1/runs/:runId/stop',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request) =>
    workerRequest(
      `/internal/v1/runs/${encodeURIComponent(request.params.runId)}/stop`,
      { method: 'POST' },
      parseRun,
    ),
);
app.get<{ Params: { runId: string } }>(
  '/api/v1/runs/:runId/events',
  { preHandler: requireOwner },
  async (request, reply) => {
    const lastEventId = request.headers['last-event-id'];
    const after = lastEventId === undefined ? 0 : Number(lastEventId);
    if (!Number.isSafeInteger(after) || after < 0) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_cursor', message: 'Event cursor is invalid.' } });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.on('close', abort);
    try {
      const stream = await workerEventStream(request.params.runId, after, controller.signal);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastSequence = after;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary < 0) break;
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (block.startsWith(':')) {
              reply.raw.write(': keep-alive\n\n');
              continue;
            }
            const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            const payload: unknown = JSON.parse(dataLine.slice(6));
            const event = RunEventSchema.parse(payload);
            if (event.runId !== request.params.runId || event.sequence <= lastSequence) {
              throw new Error('Worker event stream violated run identity or sequence ordering.');
            }
            lastSequence = event.sequence;
            reply.raw.write(
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          }
        }
      } finally {
        reader.releaseLock();
        reply.raw.end();
      }
    } catch (error) {
      if (error instanceof WorkerRequestError && !reply.sent) {
        return reply.code(error.statusCode).send(error.body);
      }
      if (!controller.signal.aborted) app.log.error(error);
    } finally {
      reply.raw.off('close', abort);
    }
  },
);

app.setErrorHandler((error, request, reply) => {
  if (error instanceof WorkerRequestError) return reply.code(error.statusCode).send(error.body);
  app.log.error({ err: error, requestId: request.id }, 'API request failed');
  return reply.code(500).send({
    error: {
      code: 'internal_error',
      message: 'The request could not be completed.',
      requestId: request.id,
    },
  });
});

await app.listen({ host: env.host, port: env.port });
app.log.info({ host: env.host, port: env.port }, 'Omnis OS API listening on loopback');

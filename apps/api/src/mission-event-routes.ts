import {
  MissionEventBatchSchema,
  MissionEventFilterSchema,
  MissionEventPageSchema,
  MissionEventQuerySchema,
} from '@omnis/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { AuthorizerRequestError, authorizerRequest } from './authorizer-client.ts';
import { requireOwner } from './auth.ts';
import type { MissionEventStreamRegistry } from './mission-event-stream-registry.ts';
import type { LocalSessionStore } from './session-store.ts';

type Request = typeof authorizerRequest;
const sseWriteTimeoutMs = 1_000;

export function registerMissionEventRoutes(
  app: FastifyInstance,
  sessions: LocalSessionStore,
  streams: MissionEventStreamRegistry,
  request: Request = authorizerRequest,
): void {
  app.get('/api/v1/mission-events', { preHandler: requireOwner }, async (incoming, reply) => {
    const query = MissionEventQuerySchema.safeParse(incoming.query);
    if (!query.success)
      return reply.code(422).send({
        error: { code: 'invalid_input', message: 'Mission event query is invalid.' },
      });
    const parsed = MissionEventPageSchema;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query.data))
      if (value !== undefined) params.set(key, String(value));
    return request(`/internal/v1/mission-events?${params.toString()}`, {}, (value) =>
      parsed.parse(value),
    );
  });

  app.get(
    '/api/v1/mission-events/stream',
    { preHandler: requireOwner },
    async (incoming, reply) => {
      const query = z
        .object({
          projectId: z.string().optional(),
          taskId: z.string().optional(),
          runId: z.string().optional(),
          after: z.string().min(1).max(2048).optional(),
        })
        .strict()
        .safeParse(incoming.query);
      const session = incoming.omnisSession;
      if (!query.success || !session?.owner)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Mission event stream query is invalid.' },
        });
      const filters = MissionEventFilterSchema.safeParse({
        projectId: query.data.projectId,
        taskId: query.data.taskId,
        runId: query.data.runId,
      });
      if (!filters.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Mission event stream filters are invalid.' },
        });
      const lastEventId = incoming.headers['last-event-id'];
      const after = typeof lastEventId === 'string' ? lastEventId : query.data.after;
      if (!after)
        return reply.code(422).send({
          error: { code: 'invalid_cursor', message: 'Mission event stream cursor is required.' },
        });
      const controller = new AbortController();
      const release = streams.acquire(session.id, controller);
      if (!release) {
        reply.header('retry-after', '5');
        return reply.code(429).send({
          error: { code: 'stream_limit', message: 'Mission event stream capacity is full.' },
        });
      }
      const close = () => controller.abort();
      reply.raw.on('close', close);
      let streamStarted = false;
      let sessionExpired = false;
      try {
        const params = streamParams(filters.data, after);
        let batch = await request(
          `/internal/v1/mission-events/after?${params.toString()}`,
          { signal: controller.signal },
          (value) => MissionEventBatchSchema.parse(value),
        );
        reply.hijack();
        streamStarted = true;
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        let cursor = after;
        let heartbeatAt = Date.now();
        while (!controller.signal.aborted) {
          if (!sessions.isActiveOwner(session.id)) {
            const written = await writeSse(
              reply.raw,
              'event: auth.expired\ndata: {"code":"session_expired"}\n\n',
              controller.signal,
            );
            if (!written) controller.abort();
            sessionExpired = true;
            break;
          }
          for (let index = 0; index < batch.events.length; index += 1) {
            const event = batch.events[index]!;
            cursor = batch.eventCursors[index]!;
            if (!sessions.isActiveOwner(session.id)) {
              const written = await writeSse(
                reply.raw,
                'event: auth.expired\ndata: {"code":"session_expired"}\n\n',
                controller.signal,
              );
              if (!written) controller.abort();
              sessionExpired = true;
              break;
            }
            const written = await writeSse(
              reply.raw,
              `id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              controller.signal,
            );
            if (!written) {
              controller.abort();
              break;
            }
          }
          if (controller.signal.aborted || sessionExpired) break;
          if (batch.events.length > 0) {
            const next = streamParams(filters.data, batch.nextCursor);
            batch = await request(
              `/internal/v1/mission-events/after?${next.toString()}`,
              { signal: controller.signal },
              (value) => MissionEventBatchSchema.parse(value),
            );
            continue;
          }
          cursor = batch.nextCursor;
          const now = Date.now();
          if (now - heartbeatAt >= 15_000) {
            const written = await writeSse(reply.raw, ': keep-alive\n\n', controller.signal);
            if (!written) controller.abort();
            heartbeatAt = now;
          }
          const next = streamParams(filters.data, cursor);
          next.set('waitMs', '1000');
          batch = await request(
            `/internal/v1/mission-events/after?${next.toString()}`,
            { signal: controller.signal },
            (value) => MissionEventBatchSchema.parse(value),
          );
        }
      } catch (error) {
        if (controller.signal.aborted && !streamStarted && !reply.raw.destroyed) {
          return reply.code(401).send({
            error: { code: 'session_expired', message: 'The owner session is no longer active.' },
          });
        }
        if (!controller.signal.aborted) {
          app.log.error(
            { errorType: error instanceof Error ? error.name : 'unknown' },
            'Mission event stream ended.',
          );
          if (!streamStarted) {
            if (error instanceof AuthorizerRequestError) {
              return reply.code(error.statusCode).send(error.body);
            }
            return reply.code(503).send({
              error: {
                code: 'mission_event_unavailable',
                message: 'Mission event history is temporarily unavailable.',
              },
            });
          }
        }
      } finally {
        reply.raw.off('close', close);
        release();
        if (streamStarted) finalizeSseResponse(reply.raw, controller.signal.aborted);
      }
    },
  );
}

function streamParams(
  filters: {
    projectId?: string | undefined;
    taskId?: string | undefined;
    runId?: string | undefined;
  },
  after: string,
): URLSearchParams {
  const params = new URLSearchParams({ after });
  if (filters.projectId) params.set('projectId', filters.projectId);
  if (filters.taskId) params.set('taskId', filters.taskId);
  if (filters.runId) params.set('runId', filters.runId);
  return params;
}

export async function writeSse(
  response: ServerResponse,
  data: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed) return false;
  if (response.write(data)) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off('drain', onDrain);
      response.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), sseWriteTimeoutMs);
    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function finalizeSseResponse(response: ServerResponse, aborted: boolean): void {
  if (response.destroyed) return;
  if (aborted) response.destroy();
  else response.end();
}

import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RunEventSchema } from '@omnis/contracts';
import type { RunEventStreamRegistry } from './run-event-stream-registry.ts';
import type { LocalSessionStore } from './session-store.ts';
import { WorkerRequestError } from './worker-request-error.ts';

const maxBufferedEventBytes = 64 * 1024;

export function registerRunEventsRoute(
  app: FastifyInstance,
  input: {
    sessions: LocalSessionStore;
    streams: RunEventStreamRegistry;
    requireOwner: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
    workerEventStream: (
      runId: string,
      afterSequence: number,
      signal: AbortSignal,
    ) => Promise<ReadableStream<Uint8Array>>;
  },
): void {
  app.get<{ Params: { runId: string } }>(
    '/api/v1/runs/:runId/events',
    { preHandler: input.requireOwner },
    async (request, reply) => {
      const lastEventId = request.headers['last-event-id'];
      const after = lastEventId === undefined ? 0 : Number(lastEventId);
      if (!Number.isSafeInteger(after) || after < 0) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_cursor', message: 'Event cursor is invalid.' } });
      }

      const session = request.omnisSession;
      if (!session || !input.sessions.isOwnerActive(session.id)) {
        return reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
      }

      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let streamStarted = false;
      let clientDisconnected = false;
      let sessionInvalidated = false;
      let terminated = false;
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        controller.abort();
        if (reader) void reader.cancel().catch(() => undefined);
        if (streamStarted && !reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
      };
      const registration = input.streams.acquire(session, () => {
        sessionInvalidated = true;
        terminate();
      });
      if (!registration.acquired) {
        const statusCode = registration.reason === 'stream_limit' ? 429 : 401;
        const code = registration.reason === 'stream_limit' ? 'stream_limit' : 'unauthorized';
        const message =
          registration.reason === 'stream_limit'
            ? 'The active Run event stream limit was reached.'
            : 'Sign in to continue.';
        return reply.code(statusCode).send({ error: { code, message } });
      }
      const onClose = () => {
        clientDisconnected = !reply.raw.writableEnded;
        terminate();
        registration.release();
      };
      reply.raw.once('close', onClose);

      try {
        const stream = await input.workerEventStream(
          request.params.runId,
          after,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          !input.sessions.isOwnerActive(session.id) ||
          reply.raw.destroyed
        ) {
          if (sessionInvalidated && !clientDisconnected && !reply.sent) {
            return reply
              .code(401)
              .send({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
          }
          return;
        }

        reply.hijack();
        streamStarted = true;
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        reply.raw.flushHeaders();
        reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastSequence = after;
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;
          buffer += decoder.decode(value, { stream: true });
          if (Buffer.byteLength(buffer) > maxBufferedEventBytes)
            throw new Error('Worker event stream exceeded its buffer limit.');
          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary < 0) break;
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (block.startsWith(':')) {
              if (!(await writeSseChunk(reply.raw, ': keep-alive\n\n', controller.signal))) break;
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
            if (!input.sessions.isOwnerActive(session.id)) {
              sessionInvalidated = true;
              terminate();
              break;
            }
            const frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
            if (!(await writeSseChunk(reply.raw, frame, controller.signal))) break;
          }
        }
      } catch (error) {
        if (sessionInvalidated && !clientDisconnected && !reply.sent) {
          return reply
            .code(401)
            .send({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
        }
        if (!controller.signal.aborted && !(error instanceof WorkerRequestError))
          app.log.error(error);
        if (!reply.sent && !clientDisconnected) {
          if (error instanceof WorkerRequestError)
            return reply.code(error.statusCode).send(error.body);
          return reply.code(503).send({
            error: {
              code: 'worker_stream_error',
              message: 'The Run event stream is unavailable.',
            },
          });
        }
      } finally {
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (!reply.raw.writableEnded && !reply.raw.destroyed && streamStarted) reply.raw.end();
        reply.raw.off('close', onClose);
        registration.release();
      }
    },
  );
}

async function writeSseChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  return new Promise((resolve) => {
    const finish = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted && !response.destroyed && !response.writableEnded);
    };
    const onDrain = () => finish();
    const onClose = () => finish();
    const onAbort = () => finish();
    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) finish();
  });
}

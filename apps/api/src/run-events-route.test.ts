import assert from 'node:assert/strict';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, it } from 'node:test';
import type { RunEvent } from '@omnis/contracts';
import { RunEventStreamRegistry } from './run-event-stream-registry.ts';
import { registerRunEventsRoute } from './run-events-route.ts';
import { LocalSessionStore } from './session-store.ts';
import { WorkerRequestError } from './worker-request-error.ts';

const runId = '11111111-1111-4111-8111-111111111111';
const ownerSecret = 'run-event-session-secret-'.padEnd(64, 's');

function event(sequence: number): RunEvent {
  return {
    id: `event-${sequence}`,
    runId,
    sequence,
    at: '2026-11-09T00:00:00.000Z',
    type: sequence === 1 ? 'run.started' : 'run.output',
    source: 'mock',
    synthetic: true,
    message: `event ${sequence}`,
  };
}

function controlledStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push(value: RunEvent) {
      if (cancelled || !controller) return false;
      try {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
        return true;
      } catch {
        return false;
      }
    },
    finish() {
      if (cancelled || !controller) return;
      controller.close();
    },
  };
}

function createFixture(
  options: {
    now?: () => number;
    scheduleExpiry?: (delayMs: number, expire: () => void) => () => void;
    globalLimit?: number;
    sessionLimit?: number;
    workerEventStream?: (
      runId: string,
      afterSequence: number,
      signal: AbortSignal,
    ) => Promise<ReadableStream<Uint8Array>>;
  } = {},
) {
  const now = options.now ?? Date.now;
  const sessions = new LocalSessionStore(ownerSecret, false, 32, now);
  const anonymous = sessions.resolve(undefined).session!;
  const owner = sessions.rotate(anonymous.id)!;
  const streams = new RunEventStreamRegistry({
    sessions,
    now,
    ...(options.scheduleExpiry ? { scheduleExpiry: options.scheduleExpiry } : {}),
    ...(options.globalLimit ? { globalLimit: options.globalLimit } : {}),
    ...(options.sessionLimit ? { sessionLimit: options.sessionLimit } : {}),
  });
  const app = Fastify({ logger: false });
  const opened: Array<{ runId: string; after: number; signal: AbortSignal }> = [];
  const sources: ReturnType<typeof controlledStream>[] = [];
  app.decorateRequest('omnisSession', undefined);
  app.addHook('onRequest', async (request) => {
    const resolved = sessions.resolve(request.headers.cookie, false);
    if (resolved.session) request.omnisSession = resolved.session;
  });
  const requireOwner = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.omnisSession?.owner !== true)
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'Sign in.' } });
  };
  const defaultWorkerEventStream = async (
    requestedRunId: string,
    after: number,
    signal: AbortSignal,
  ) => {
    opened.push({ runId: requestedRunId, after, signal });
    const source = controlledStream();
    sources.push(source);
    return source.stream;
  };
  app.post('/api/v1/auth/logout', { preHandler: requireOwner }, async (request, reply) => {
    if (request.omnisSession) sessions.destroy(request.omnisSession.id);
    return reply.code(204).send();
  });
  registerRunEventsRoute(app, {
    sessions,
    streams,
    requireOwner,
    workerEventStream: options.workerEventStream ?? defaultWorkerEventStream,
  });

  return {
    app,
    sessions,
    streams,
    owner,
    cookie: sessions.cookie(owner).split(';', 1)[0]!,
    opened,
    sources,
    async start() {
      return app.listen({ host: '127.0.0.1', port: 0 });
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true, 'expected asynchronous stream cleanup to complete');
}

describe('owner-authorized Run SSE session lifecycle', () => {
  it('replays only events after the authorized cursor in strict order', async (t) => {
    const fixture = createFixture();
    t.after(async () => fixture.app.close());
    const origin = await fixture.start();
    const response = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie, 'last-event-id': '1' },
    });
    assert.equal(response.status, 200);
    assert.equal(fixture.opened[0]?.after, 1);
    fixture.sources[0]!.push(event(2));
    fixture.sources[0]!.push(event(3));
    fixture.sources[0]!.finish();

    const body = await response.text();
    assert.equal(body.includes('id: 1\n'), false);
    assert.ok(body.indexOf('id: 2\n') < body.indexOf('id: 3\n'));
    assert.equal(fixture.streams.size, 0);
  });

  it('closes active Run streams on logout and sends no later event', async (t) => {
    const fixture = createFixture();
    t.after(async () => fixture.app.close());
    const origin = await fixture.start();
    const response = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    const secondResponse = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
    });
    assert.equal(secondResponse.status, 200);
    const secondReader = secondResponse.body!.getReader();
    const secondPendingRead = secondReader.read();
    const logout = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { cookie: fixture.cookie },
    });
    assert.equal(logout.status, 204);
    assert.equal((await pendingRead).done, true);
    assert.equal((await secondPendingRead).done, true);
    assert.equal(fixture.opened[0]?.signal.aborted, true);
    assert.equal(fixture.opened[1]?.signal.aborted, true);
    assert.equal(fixture.sources[0]!.push(event(1)), false);
    assert.equal(fixture.sources[1]!.push(event(1)), false);
    assert.equal(fixture.streams.size, 0);
    await reader.cancel();
    await secondReader.cancel();
  });

  it('closes an idle stream at session expiry without waiting for another request', async (t) => {
    let now = 50_000;
    const expirations: Array<() => void> = [];
    const fixture = createFixture({
      now: () => now,
      scheduleExpiry: (_delay, expire) => {
        expirations.push(expire);
        return () => {};
      },
    });
    t.after(async () => fixture.app.close());
    const origin = await fixture.start();
    const response = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const pendingRead = reader.read();

    now = fixture.owner.expiresAt;
    expirations[0]!();

    assert.equal((await pendingRead).done, true);
    assert.equal(fixture.opened[0]?.signal.aborted, true);
    assert.equal(fixture.streams.size, 0);
    await reader.cancel();
  });

  it('closes a rotated session stream and rejects reconnection with its old cookie', async (t) => {
    const fixture = createFixture();
    t.after(async () => fixture.app.close());
    const origin = await fixture.start();
    const active = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
    });
    assert.equal(active.status, 200);
    const activeReader = active.body!.getReader();
    const pendingRead = activeReader.read();

    const replacement = fixture.sessions.rotate(fixture.owner.id)!;
    assert.equal((await pendingRead).done, true);
    const denied = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
    });
    assert.equal(denied.status, 401);

    const replay = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: {
        cookie: fixture.sessions.cookie(replacement).split(';', 1)[0]!,
        'last-event-id': '1',
      },
    });
    assert.equal(replay.status, 200);
    fixture.sources[1]!.push(event(2));
    fixture.sources[1]!.finish();
    assert.match(await replay.text(), /id: 2\n/);
    assert.equal(fixture.opened.length, 2);
    assert.equal(fixture.streams.size, 0);
    await activeReader.cancel();
  });

  it('denies unauthenticated and unknown Run access before exposing event data', async (t) => {
    let workerCalls = 0;
    const fixture = createFixture({
      workerEventStream: async () => {
        workerCalls++;
        throw new WorkerRequestError(404, {
          error: { code: 'not_found', message: 'Run was not found.' },
        });
      },
    });
    t.after(async () => fixture.app.close());
    const origin = await fixture.start();
    const unauthenticated = await fetch(`${origin}/api/v1/runs/${runId}/events`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(workerCalls, 0);

    const missingRun = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
    });
    assert.equal(missingRun.status, 404);
    assert.deepEqual(await missingRun.json(), {
      error: { code: 'not_found', message: 'Run was not found.' },
    });
    assert.equal(workerCalls, 1);
    assert.equal(fixture.streams.size, 0);
  });

  it('cleans up an aborted client connection and enforces the configured stream cap', async (t) => {
    const fixture = createFixture({ globalLimit: 1, sessionLimit: 1 });
    t.after(async () => fixture.app.close());
    const origin = await fixture.start();
    const abort = new AbortController();
    const response = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const limited = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
    });
    assert.equal(limited.status, 429);

    abort.abort();
    await waitFor(() => fixture.streams.size === 0);
    const reopened = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie },
    });
    assert.equal(reopened.status, 200);
    await reopened.body?.cancel();
    await waitFor(() => fixture.streams.size === 0);
  });

  it('fails closed on invalid cursors without opening an upstream stream', async (t) => {
    const fixture = createFixture();
    t.after(async () => fixture.app.close());
    const origin = await fixture.start();
    const response = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
      headers: { cookie: fixture.cookie, 'last-event-id': '-1' },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: 'invalid_cursor', message: 'Event cursor is invalid.' },
    });
    assert.equal(fixture.opened.length, 0);
  });
});

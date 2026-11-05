import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { ServerResponse } from 'node:http';
import Fastify from 'fastify';

process.env.OMNIS_SESSION_SECRET ??= 'mission-event-session-test-secret-'.padEnd(64, 'x');
process.env.OMNIS_OWNER_PASSWORD_HASH ??= `${'a'.repeat(32)}:${'b'.repeat(128)}`;
process.env.OMNIS_INTERNAL_TOKEN ??= 'mission-event-worker-test-token-'.padEnd(64, 'x');
process.env.OMNIS_API_AUTHORIZER_TOKEN ??= 'mission-event-authorizer-test-token-'.padEnd(64, 'x');
process.env.OMNIS_AUTHORIZER_SOCKET ??= '/run/omnis-authorizer/authorizer.sock';
process.env.OMNIS_ALLOWED_ORIGIN ??= 'http://127.0.0.1:5173';

const { finalizeSseResponse, registerMissionEventRoutes, writeSse } =
  await import('./mission-event-routes.ts');
const { MissionEventStreamRegistry } = await import('./mission-event-stream-registry.ts');
const { LocalSessionStore } = await import('./session-store.ts');
const { AuthorizerRequestError } = await import('./authorizer-client.ts');

class StalledResponse extends EventEmitter {
  destroyed = false;
  buffered = '';
  ended = false;

  write(value: string): boolean {
    this.buffered += value;
    return false;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(): this {
    this.buffered = '';
    this.destroyed = true;
    return this;
  }
}

const projectId = `prj_${'1'.repeat(32)}`;
const page = {
  events: [],
  page: {
    olderCursor: null,
    hasOlder: false,
    streamCursor: 'cursor.after',
    observedThroughSeq: '0',
    historyStartedAt: '2026-11-06T00:00:00.000Z',
    historyStartSeq: '1',
    preCutoverHistoryAvailable: false,
    truncated: false,
  },
};

function createApp(owner: boolean, calls: string[]) {
  const app = Fastify();
  app.decorateRequest('omnisSession', undefined);
  app.addHook('onRequest', async (request) => {
    if (owner)
      request.omnisSession = {
        id: 'session-1',
        owner: true,
        csrfToken: 'csrf-token',
        expiresAt: Date.now() + 60_000,
      };
  });
  const sessions = new LocalSessionStore('session'.padEnd(64, 'x'), false);
  const resolved = sessions.resolve(undefined).session!;
  const registry = new MissionEventStreamRegistry();
  registerMissionEventRoutes(
    app,
    sessions,
    registry,
    async <T>(path: string, _init: RequestInit | undefined, parse: (value: unknown) => T) => {
      calls.push(path);
      return parse(page);
    },
  );
  // The test route session ID is the active local store session ID.
  if (owner) {
    sessions.destroy(resolved.id);
    sessions.rotate('');
  }
  return app;
}

describe('owner Mission Lane API routes', () => {
  it('bounds stalled SSE backpressure so session checks and cleanup cannot hang', async () => {
    const response = new StalledResponse();
    const startedAt = Date.now();
    const controller = new AbortController();
    const written = await writeSse(
      response as unknown as ServerResponse,
      'event: task.created\ndata: {}\n\n',
      controller.signal,
    );
    assert.equal(written, false);
    assert.ok(Date.now() - startedAt < 1_500);
    assert.equal(response.listenerCount('drain'), 0);
    assert.equal(response.listenerCount('close'), 0);
    if (!written) controller.abort();
    finalizeSseResponse(response as unknown as ServerResponse, controller.signal.aborted);
    assert.equal(response.destroyed, true);
    assert.equal(response.ended, false);
    assert.equal(response.buffered, '');
  });

  it('requires owner auth and validates global/project history filters before querying', async () => {
    const calls: string[] = [];
    const anonymous = createApp(false, calls);
    try {
      const rejected = await anonymous.inject({ method: 'GET', url: '/api/v1/mission-events' });
      assert.equal(rejected.statusCode, 401);
      assert.deepEqual(calls, []);
    } finally {
      await anonymous.close();
    }
  });

  it('returns the canonical owner history response and rejects malformed filter combinations', async () => {
    const calls: string[] = [];
    const app = Fastify();
    app.decorateRequest('omnisSession', undefined);
    app.addHook('onRequest', async (request) => {
      request.omnisSession = {
        id: 'session-1',
        owner: true,
        csrfToken: 'csrf-token',
        expiresAt: Date.now() + 60_000,
      };
    });
    const sessions = new LocalSessionStore('session'.padEnd(64, 'x'), false);
    const session = sessions.rotate('')!;
    // Route checks the session registry on the stream, while history only uses owner auth.
    app.addHook('onRequest', async (request) => {
      request.omnisSession = { ...request.omnisSession!, id: session.id };
    });
    registerMissionEventRoutes(
      app,
      sessions,
      new MissionEventStreamRegistry(),
      async <T>(path: string, _init: RequestInit | undefined, parse: (value: unknown) => T) => {
        calls.push(path);
        return parse(page);
      },
    );
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/mission-events?projectId=${projectId}&limit=40`,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().page.preCutoverHistoryAvailable, false);
      assert.deepEqual(calls, [`/internal/v1/mission-events?projectId=${projectId}&limit=40`]);
      const bad = await app.inject({
        method: 'GET',
        url: '/api/v1/mission-events?runId=run-1',
      });
      assert.equal(bad.statusCode, 422);
      assert.equal(calls.length, 1);
    } finally {
      await app.close();
    }
  });

  it('requires an authoritative history cursor before opening an SSE response', async () => {
    const calls: string[] = [];
    const app = Fastify();
    app.decorateRequest('omnisSession', undefined);
    const sessions = new LocalSessionStore('session'.padEnd(64, 'x'), false);
    const session = sessions.rotate('')!;
    app.addHook('onRequest', async (request) => {
      request.omnisSession = {
        id: session.id,
        owner: true,
        csrfToken: 'csrf-token',
        expiresAt: session.expiresAt,
      };
    });
    registerMissionEventRoutes(
      app,
      sessions,
      new MissionEventStreamRegistry(),
      async <T>(path: string, _init: RequestInit | undefined, parse: (value: unknown) => T) => {
        calls.push(path);
        return parse({
          events: [],
          eventCursors: [],
          nextCursor: 'after',
          observedThroughSeq: '0',
        });
      },
    );
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/mission-events/stream' });
      assert.equal(response.statusCode, 422);
      assert.deepEqual(calls, []);
      assert.equal(sessions.isActiveOwner(session.id), true);
    } finally {
      await app.close();
    }
  });

  it('ends an active stream with an auth-expired frame when the owner session expires', async () => {
    let now = Date.now();
    const sessions = new LocalSessionStore('session'.padEnd(64, 'x'), false, 16, () => now);
    const session = sessions.rotate('')!;
    const app = Fastify();
    app.decorateRequest('omnisSession', undefined);
    app.addHook('onRequest', async (request) => {
      request.omnisSession = session;
    });
    let requestCount = 0;
    let requestedAfter = '';
    registerMissionEventRoutes(
      app,
      sessions,
      new MissionEventStreamRegistry(),
      async <T>(path: string, init: RequestInit | undefined, parse: (value: unknown) => T) => {
        assert.equal(init?.signal?.aborted, false);
        requestedAfter = new URL(path, 'http://localhost').searchParams.get('after') ?? '';
        requestCount += 1;
        now = session.expiresAt;
        return parse({
          events: [],
          eventCursors: [],
          nextCursor: 'cursor.after',
          observedThroughSeq: '0',
        });
      },
    );
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/mission-events/stream?after=cursor.query',
        headers: { 'last-event-id': 'cursor.from-header' },
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /event: auth\.expired/);
      assert.equal(requestCount, 1);
      assert.equal(requestedAfter, 'cursor.from-header');
      assert.equal(sessions.isActiveOwner(session.id), false);
    } finally {
      await app.close();
    }
  });

  it('preserves safe authorizer errors before opening the SSE response', async () => {
    const app = Fastify();
    app.decorateRequest('omnisSession', undefined);
    const sessions = new LocalSessionStore('session'.padEnd(64, 'x'), false);
    const session = sessions.rotate('')!;
    app.addHook('onRequest', async (request) => {
      request.omnisSession = session;
    });
    registerMissionEventRoutes(app, sessions, new MissionEventStreamRegistry(), async () => {
      throw new AuthorizerRequestError(422, {
        error: { code: 'invalid_cursor', message: 'Mission event cursor is invalid.' },
      });
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/mission-events/stream?after=forged.cursor',
      });
      assert.equal(response.statusCode, 422);
      assert.deepEqual(response.json(), {
        error: { code: 'invalid_cursor', message: 'Mission event cursor is invalid.' },
      });
      assert.equal(sessions.isActiveOwner(session.id), true);
    } finally {
      await app.close();
    }
  });

  it('closes startup when logout revokes the session during the initial history request', async () => {
    const app = Fastify();
    app.decorateRequest('omnisSession', undefined);
    const sessions = new LocalSessionStore('session'.padEnd(64, 'x'), false);
    const session = sessions.rotate('')!;
    app.addHook('onRequest', async (request) => {
      request.omnisSession = session;
    });
    const streams = new MissionEventStreamRegistry();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    registerMissionEventRoutes(
      app,
      sessions,
      streams,
      async (_path: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          markStarted();
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Request was aborted.', 'AbortError')),
            { once: true },
          );
        }),
    );
    try {
      const responsePromise = app.inject({
        method: 'GET',
        url: '/api/v1/mission-events/stream?after=cursor.start',
      });
      await started;
      streams.revokeSession(session.id);
      const response = await responsePromise;
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'session_expired');
      assert.equal(streams.activeCount, 0);
    } finally {
      await app.close();
    }
  });

  it('streams validated persisted events in sequence and advances by event cursor', async () => {
    let now = Date.now();
    const sessions = new LocalSessionStore('session'.padEnd(64, 'x'), false, 16, () => now);
    const session = sessions.rotate('')!;
    const app = Fastify();
    app.decorateRequest('omnisSession', undefined);
    app.addHook('onRequest', async (request) => {
      request.omnisSession = session;
    });
    const requestedCursors: string[] = [];
    let drain = 0;
    registerMissionEventRoutes(
      app,
      sessions,
      new MissionEventStreamRegistry(),
      async <T>(path: string, _init: RequestInit | undefined, parse: (value: unknown) => T) => {
        const params = new URL(path, 'http://localhost').searchParams;
        requestedCursors.push(params.get('after') ?? '');
        drain += 1;
        if (drain === 1) {
          return parse({
            events: [
              {
                id: `mev_${'a'.repeat(32)}`,
                seq: '1',
                type: 'task.created',
                occurredAt: '2026-11-06T00:00:00.000Z',
                taskId: 'task-lane-1',
                projectId: null,
                runId: null,
                actor: 'owner',
                origin: { kind: 'task_state', synthetic: false },
                payload: {},
              },
            ],
            eventCursors: ['cursor.after-event'],
            nextCursor: 'cursor.after-event',
            observedThroughSeq: '1',
          });
        }
        now = session.expiresAt;
        return parse({
          events: [],
          eventCursors: [],
          nextCursor: 'cursor.after-event',
          observedThroughSeq: '1',
        });
      },
    );
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/mission-events/stream?after=cursor.start',
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /id: cursor\.after-event\nevent: task\.created/);
      assert.equal((response.body.match(/event: task\.created/g) ?? []).length, 1);
      assert.deepEqual(requestedCursors, ['cursor.start', 'cursor.after-event']);
    } finally {
      await app.close();
    }
  });
});

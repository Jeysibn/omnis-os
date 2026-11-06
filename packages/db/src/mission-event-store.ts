import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import {
  MissionEventFilterSchema,
  MissionEventPageSchema,
  MissionEventQuerySchema,
  MissionEventSchema,
  type MissionEvent,
  type MissionEventFilter,
  type MissionEventPage,
} from '@omnis/contracts';
import type { Pool, PoolClient } from 'pg';

const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

type Cursor = {
  version: 1;
  purpose: 'before' | 'after';
  seq: string;
  feedEpoch: string;
  filters: { projectId: string | null; taskId: string | null; runId: string | null };
};
type DbPage = {
  events: unknown[];
  observedThroughSeq: string;
  feedEpoch: string;
  historyStartedAt: string;
  historyStartSeq: string;
  hasOlder: boolean;
  resourceExists: boolean;
  oldestSeq: string | null;
};
type DbAfterPage = {
  events: unknown[];
  observedThroughSeq: string;
  feedEpoch: string;
  resourceExists: boolean;
};

export type MissionEventStoreErrorCode =
  'invalid_input' | 'invalid_cursor' | 'history_truncated' | 'not_found';

export class MissionEventStoreError extends Error {
  readonly code: MissionEventStoreErrorCode;
  readonly statusCode: 404 | 410 | 422;

  constructor(code: MissionEventStoreErrorCode) {
    const statusCode = code === 'not_found' ? 404 : code === 'history_truncated' ? 410 : 422;
    const messages: Record<MissionEventStoreErrorCode, string> = {
      invalid_input: 'Mission event query is invalid.',
      invalid_cursor: 'Mission event cursor is invalid.',
      history_truncated: 'Requested mission event history is no longer available.',
      not_found: 'The requested project, task, or run was not found.',
    };
    super(messages[code]);
    this.name = 'MissionEventStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function deriveKey(key: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      key,
      Buffer.from('omnis-os/mission-lane-v2/cursor/v1', 'utf8'),
      Buffer.from('mission-event-filter-bound-cursor', 'utf8'),
      32,
    ),
  );
}

function normalizedFilters(filter: MissionEventFilter): Cursor['filters'] {
  return {
    projectId: filter.projectId ?? null,
    taskId: filter.taskId ?? null,
    runId: filter.runId ?? null,
  };
}

function sign(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update('omnis-mission-lane-cursor-v1:').update(payload).digest();
}

function encodeCursor(cursor: Cursor, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${sign(payload, key).toString('base64url')}`;
}

function decodeCursor(
  encoded: string,
  purpose: Cursor['purpose'],
  filters: Cursor['filters'],
  key: Buffer,
): Cursor {
  try {
    if (encoded.length > 2048) throw new Error('too large');
    const [payload, signature, extra] = encoded.split('.');
    if (!payload || !signature || extra !== undefined) throw new Error('shape');
    const supplied = Buffer.from(signature, 'base64url');
    const expected = sign(payload, key);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      supplied.toString('base64url') !== signature ||
      Buffer.from(payload, 'base64url').toString('base64url') !== payload
    )
      throw new Error('signature');
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value && value.version === 1) ||
      !('purpose' in value && value.purpose === purpose) ||
      !(
        'seq' in value &&
        typeof value.seq === 'string' &&
        /^(0|[1-9][0-9]{0,18})$/.test(value.seq) &&
        BigInt(value.seq) <= PG_BIGINT_MAX &&
        (purpose === 'after' || value.seq !== '0')
      ) ||
      !(
        'feedEpoch' in value &&
        typeof value.feedEpoch === 'string' &&
        /^[0-9a-f-]{36}$/i.test(value.feedEpoch)
      ) ||
      !('filters' in value && JSON.stringify(value.filters) === JSON.stringify(filters))
    )
      throw new Error('payload');
    return value as Cursor;
  } catch {
    throw new MissionEventStoreError('invalid_cursor');
  }
}

export class PostgresMissionEventStore {
  private readonly pool: Pool;
  private readonly cursorKey: Buffer;
  private listener: PoolClient | undefined;
  private connecting: Promise<void> | undefined;
  private readonly wakeWaiters = new Set<() => void>();

  constructor(pool: Pool, key: Buffer) {
    if (key.length !== 32) throw new Error('Mission event cursor key must be 32 bytes.');
    this.pool = pool;
    this.cursorKey = deriveKey(key);
  }

  async history(queryValue: unknown): Promise<MissionEventPage> {
    const query = MissionEventQuerySchema.safeParse(queryValue);
    if (!query.success) throw new MissionEventStoreError('invalid_input');
    const filters = normalizedFilters(query.data);
    const before = query.data.before
      ? decodeCursor(query.data.before, 'before', filters, this.cursorKey)
      : undefined;
    try {
      const result = await this.pool.query<{ result: DbPage }>(
        'SELECT omnis.list_mission_events($1,$2,$3,$4,$5) AS result',
        [filters.projectId, filters.taskId, filters.runId, before?.seq ?? null, query.data.limit],
      );
      const value = result.rows[0]?.result;
      if (!value || !Array.isArray(value.events) || value.resourceExists !== true)
        throw new MissionEventStoreError('not_found');
      if (before && before.feedEpoch !== value.feedEpoch)
        throw new MissionEventStoreError('history_truncated');
      if (before && BigInt(before.seq) > BigInt(value.observedThroughSeq))
        throw new MissionEventStoreError('history_truncated');
      const events = value.events.map((event) => MissionEventSchema.parse(event));
      const oldest = value.oldestSeq;
      return MissionEventPageSchema.parse({
        events,
        page: {
          olderCursor:
            value.hasOlder && oldest
              ? encodeCursor(
                  {
                    version: 1,
                    purpose: 'before',
                    seq: oldest,
                    feedEpoch: value.feedEpoch,
                    filters,
                  },
                  this.cursorKey,
                )
              : null,
          hasOlder: value.hasOlder,
          streamCursor: before
            ? null
            : encodeCursor(
                {
                  version: 1,
                  purpose: 'after',
                  seq: value.observedThroughSeq,
                  feedEpoch: value.feedEpoch,
                  filters,
                },
                this.cursorKey,
              ),
          observedThroughSeq: value.observedThroughSeq,
          historyStartedAt: value.historyStartedAt,
          historyStartSeq: value.historyStartSeq,
          preCutoverHistoryAvailable: false,
          truncated: false,
        },
      });
    } catch (error) {
      if (error instanceof MissionEventStoreError) throw error;
      if ((error as { code?: string })?.code === '22023')
        throw new MissionEventStoreError('invalid_input');
      throw error;
    }
  }

  async eventsAfter(
    filterValue: unknown,
    cursorValue: string,
    limit = 100,
  ): Promise<{
    events: MissionEvent[];
    eventCursors: string[];
    nextCursor: string;
    observedThroughSeq: string;
  }> {
    const filter = MissionEventFilterSchema.safeParse(filterValue);
    if (!filter.success || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new MissionEventStoreError('invalid_input');
    const filters = normalizedFilters(filter.data);
    const cursor = decodeCursor(cursorValue, 'after', filters, this.cursorKey);
    const result = await this.pool.query<{ result: DbAfterPage }>(
      'SELECT omnis.list_mission_events_after($1,$2,$3,$4,$5) AS result',
      [filters.projectId, filters.taskId, filters.runId, cursor.seq, limit],
    );
    const value = result.rows[0]?.result;
    if (!value || !Array.isArray(value.events)) throw new Error('Mission event page is invalid.');
    if (!value.resourceExists) throw new MissionEventStoreError('not_found');
    if (cursor.feedEpoch !== value.feedEpoch) throw new MissionEventStoreError('history_truncated');
    if (BigInt(cursor.seq) > BigInt(value.observedThroughSeq))
      throw new MissionEventStoreError('history_truncated');
    const events = value.events.map((event) => MissionEventSchema.parse(event));
    const eventCursors = events.map((event) =>
      encodeCursor(
        {
          version: 1,
          purpose: 'after',
          seq: event.seq,
          feedEpoch: value.feedEpoch,
          filters,
        },
        this.cursorKey,
      ),
    );
    const last = events.at(-1);
    const nextCursor = encodeCursor(
      {
        version: 1,
        purpose: 'after',
        seq: last?.seq ?? value.observedThroughSeq,
        feedEpoch: value.feedEpoch,
        filters,
      },
      this.cursorKey,
    );
    return { events, eventCursors, nextCursor, observedThroughSeq: value.observedThroughSeq };
  }

  async storageMetrics(): Promise<{ rows: string; bytes: string; clockSeq: string }> {
    const result = await this.pool.query<{
      result: { rows: string; bytes: string; clockSeq: string };
    }>('SELECT omnis.mission_event_storage_metrics() AS result');
    const metrics = result.rows[0]?.result;
    if (
      !metrics ||
      !/^\d+$/.test(metrics.rows) ||
      !/^\d+$/.test(metrics.bytes) ||
      !/^\d+$/.test(metrics.clockSeq)
    )
      throw new Error('Mission event metrics are invalid.');
    return metrics;
  }

  async waitAfter(
    filter: unknown,
    cursor: string,
    limit = 100,
    waitMs = 1000,
    signal?: AbortSignal,
  ): ReturnType<PostgresMissionEventStore['eventsAfter']> {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 15_000)
      throw new MissionEventStoreError('invalid_input');
    await this.ensureListener();
    let wake!: () => void;
    const notified = new Promise<void>((resolve) => {
      wake = resolve;
      this.wakeWaiters.add(resolve);
    });
    try {
      // Registering the shared LISTEN waiter before this persisted drain closes the
      // subscribe/drain race. Database rows remain authoritative; NOTIFY only wakes us.
      const initial = await this.eventsAfter(filter, cursor, limit);
      if (initial.events.length > 0 || waitMs === 0 || signal?.aborted) return initial;
      await waitForNotificationOrTimeout(notified, waitMs, signal);
      if (signal?.aborted) return initial;
      return await this.eventsAfter(filter, initial.nextCursor, limit);
    } finally {
      this.wakeWaiters.delete(wake);
    }
  }

  async close(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    if (!listener) return;
    await listener.query('UNLISTEN omnis_mission_events').catch(() => undefined);
    listener.release();
  }

  private async ensureListener(): Promise<void> {
    if (this.listener) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const listener = await this.pool.connect();
      try {
        listener.on('notification', (message) => {
          if (message.channel !== 'omnis_mission_events') return;
          for (const wake of this.wakeWaiters) wake();
        });
        listener.on('error', () => {
          if (this.listener === listener) this.listener = undefined;
          listener.release(true);
          for (const wake of this.wakeWaiters) wake();
        });
        await listener.query('LISTEN omnis_mission_events');
        this.listener = listener;
      } catch (error) {
        listener.release(true);
        throw error;
      }
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
}

function waitForNotificationOrTimeout(
  notified: Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
    void notified.then(done);
  });
}

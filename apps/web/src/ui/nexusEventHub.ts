import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunEvent } from '@omnis/contracts';

const TERMINAL = new Set<RunEvent['type']>([
  'run.completed',
  'run.cancelled',
  'run.failed',
  'run.interrupted',
]);

export type StreamRequest = { runId: string; lastEventId: string | undefined };

/**
 * A real SSE server that behaves like the Omnis API's per-run endpoint: it replays persisted
 * history after the `Last-Event-ID` cursor, keeps the connection open for unfinished runs,
 * pushes new events live, and ends the stream after a terminal event. Tests can drop
 * connections, make it fail, or make it replay from the start to exercise reconnect handling.
 * Fixtures built on it prove the web client's behavior, not the live backend's.
 */
export class EventHub {
  readonly requests: StreamRequest[] = [];
  readonly history = new Map<string, RunEvent[]>();
  /** Ignore the cursor and replay everything, as a lossy server might. */
  replayAll = false;
  url = '';
  private readonly open = new Map<string, Set<ServerResponse>>();
  private readonly failing = new Map<string, number>();
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const runId = decodeURIComponent((req.url ?? '').split('?')[0]!.slice(1));
      const header = req.headers['last-event-id'];
      const lastEventId = Array.isArray(header) ? header[0] : header;
      this.requests.push({ runId, lastEventId });
      const base = { 'access-control-allow-origin': '*' };
      const status = this.failing.get(runId);
      if (status) {
        res.writeHead(status, base);
        res.end();
        return;
      }
      res.writeHead(200, {
        ...base,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write('retry: 100\n\n');
      const after = this.replayAll || !lastEventId ? 0 : Number(lastEventId);
      const all = this.history.get(runId) ?? [];
      for (const event of all.filter((e) => e.sequence > after)) res.write(this.frame(event));
      if (all.some((e) => TERMINAL.has(e.type))) {
        res.end();
        return;
      }
      const set = this.open.get(runId) ?? new Set<ServerResponse>();
      set.add(res);
      this.open.set(runId, set);
      res.on('close', () => set.delete(res));
    });
  }

  private frame(e: RunEvent) {
    return `id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }

  /** Persist an event and push it to every connection following the run. */
  publish(runId: string, event: RunEvent) {
    this.history.set(runId, [...(this.history.get(runId) ?? []), event]);
    for (const res of this.open.get(runId) ?? []) {
      res.write(this.frame(event));
      if (TERMINAL.has(event.type)) res.end();
    }
  }

  /** Cut every open connection for a run; the browser should reconnect on its own. */
  drop(runId: string) {
    for (const res of this.open.get(runId) ?? []) res.destroy();
    this.open.delete(runId);
  }

  /** Answer new connections for a run with an HTTP error (null restores service). */
  failWith(runId: string, status: number | null) {
    if (status === null) this.failing.delete(runId);
    else this.failing.set(runId, status);
  }

  connections(runId: string) {
    return this.open.get(runId)?.size ?? 0;
  }
}

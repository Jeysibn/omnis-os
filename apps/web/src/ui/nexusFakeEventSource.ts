import type { Page } from '@playwright/test';
import type { RunEvent } from '@omnis/contracts';

export type FakeStats = {
  created: number;
  closed: number;
  open: number;
  /** Last-Event-ID each browser-managed reconnect would have sent, per run. */
  reconnectIds: Record<string, string[]>;
  /** Number of instances ever created per run (re-creations show up here). */
  instances: Record<string, number>;
  errors: Record<string, number>;
};

export type FakeServer = {
  setHistory(runId: string, events: RunEvent[]): void;
  publish(runId: string, event: RunEvent): void;
  /** Transport drop on every open stream of a run: readyState becomes CONNECTING. */
  drop(runId: string): void;
  /** While down, every connection attempt fails and the "browser" keeps retrying. */
  setDown(runId: string, down: boolean): void;
  /** While closing, failures end in CLOSED (like a non-200 response) instead of CONNECTING. */
  setHardFail(runId: string, hard: boolean): void;
  /** While hanging, connection attempts neither open nor error (a stuck CONNECTING). */
  setHang(runId: string, hang: boolean): void;
  stats(): FakeStats;
};

declare global {
  interface Window {
    __fakeEs: FakeServer;
  }
}

/**
 * Replaces EventSource with a controllable implementation that reproduces what a browser does:
 * a dropped transport moves the stream to CONNECTING, fires `error`, and retries by itself with
 * the last event id; a refused connection ends in CLOSED. Retries repeat every `retryMs` until
 * the test brings the "server" back, so repeated native failures are reproducible without
 * wall-clock sleeps in the assertions. It emulates the transport only; it does not prove the
 * live backend.
 */
export async function installFakeEventSource(
  page: Page,
  histories: Record<string, RunEvent[]> = {},
  retryMs = 20,
) {
  await page.addInitScript(
    ([retry, initial]: [number, Record<string, RunEvent[]>]) => {
      type Evt = { sequence: number; type: string; runId: string };
      const history = new Map<string, Evt[]>(
        Object.entries(initial) as unknown as [string, Evt[]][],
      );
      const down = new Set<string>();
      const hard = new Set<string>();
      const hang = new Set<string>();
      const live = new Map<string, Set<Fake>>();
      const stats: FakeStats = {
        created: 0,
        closed: 0,
        open: 0,
        reconnectIds: {},
        instances: {},
        errors: {},
      };
      const runOf = (url: string) => decodeURIComponent(url.split('/')[4] ?? '');
      const frame = (instance: Fake, event: Evt) => {
        instance.lastEventId = String(event.sequence);
        instance.dispatchEvent(
          new MessageEvent(event.type, {
            data: JSON.stringify(event),
            lastEventId: String(event.sequence),
          }),
        );
      };

      class Fake extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;
        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readonly CLOSED = 2;
        readyState = 0;
        withCredentials = false;
        onopen: ((e: Event) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        lastEventId = '';
        private timer: ReturnType<typeof setTimeout> | null = null;
        readonly runId: string;
        constructor(readonly url: string) {
          super();
          this.runId = runOf(url);
          stats.created++;
          stats.open++;
          stats.instances[this.runId] = (stats.instances[this.runId] ?? 0) + 1;
          this.timer = setTimeout(() => this.attempt(), 0);
        }
        private fail() {
          stats.errors[this.runId] = (stats.errors[this.runId] ?? 0) + 1;
          if (hard.has(this.runId)) {
            // refused: the browser does not retry
            if (this.readyState !== 2) {
              stats.closed++;
              stats.open--;
            }
            this.readyState = 2;
            this.release();
          } else {
            this.readyState = 0;
            this.timer = setTimeout(() => this.attempt(true), retry);
          }
          this.onerror?.(new Event('error'));
        }
        private release() {
          live.get(this.runId)?.delete(this);
        }
        attempt(reconnect = false) {
          if (this.readyState === 2) return;
          if (reconnect) {
            (stats.reconnectIds[this.runId] ??= []).push(this.lastEventId);
          }
          if (hang.has(this.runId)) return;
          if (down.has(this.runId)) return this.fail();
          this.readyState = 1;
          let set = live.get(this.runId);
          if (!set) live.set(this.runId, (set = new Set()));
          set.add(this);
          this.onopen?.(new Event('open'));
          const after = this.lastEventId ? Number(this.lastEventId) : 0;
          for (const event of history.get(this.runId) ?? [])
            if (event.sequence > after) frame(this, event);
        }
        dropTransport() {
          if (this.readyState !== 1) return;
          this.release();
          this.fail();
        }
        close() {
          if (this.readyState !== 2) {
            this.readyState = 2;
            stats.closed++;
            stats.open--;
          }
          if (this.timer) clearTimeout(this.timer);
          this.release();
        }
      }
      window.EventSource = Fake as unknown as typeof EventSource;
      window.__fakeEs = {
        setHistory(runId, events) {
          history.set(runId, events as unknown as Evt[]);
        },
        publish(runId, event) {
          const list = history.get(runId) ?? [];
          history.set(runId, [...list, event as unknown as Evt]);
          for (const instance of live.get(runId) ?? []) frame(instance, event as unknown as Evt);
        },
        drop(runId) {
          for (const instance of [...(live.get(runId) ?? [])]) instance.dropTransport();
        },
        setDown(runId, value) {
          if (value) down.add(runId);
          else down.delete(runId);
        },
        setHang(runId, value) {
          if (value) hang.add(runId);
          else hang.delete(runId);
        },
        setHardFail(runId, value) {
          if (value) hard.add(runId);
          else hard.delete(runId);
        },
        stats: () => JSON.parse(JSON.stringify(stats)) as FakeStats,
      };
    },
    [retryMs, histories] as [number, Record<string, RunEvent[]>],
  );
}

export const fake = {
  setHistory: (page: Page, runId: string, events: RunEvent[]) =>
    page.evaluate(([id, list]) => window.__fakeEs.setHistory(id as string, list as RunEvent[]), [
      runId,
      events,
    ] as const),
  publish: (page: Page, runId: string, event: RunEvent) =>
    page.evaluate(([id, e]) => window.__fakeEs.publish(id as string, e as RunEvent), [
      runId,
      event,
    ] as const),
  drop: (page: Page, runId: string) => page.evaluate((id) => window.__fakeEs.drop(id), runId),
  setDown: (page: Page, runId: string, down: boolean) =>
    page.evaluate(([id, v]) => window.__fakeEs.setDown(id as string, v as boolean), [
      runId,
      down,
    ] as const),
  setHardFail: (page: Page, runId: string, hard: boolean) =>
    page.evaluate(([id, v]) => window.__fakeEs.setHardFail(id as string, v as boolean), [
      runId,
      hard,
    ] as const),
  setHang: (page: Page, runId: string, hang: boolean) =>
    page.evaluate(([id, v]) => window.__fakeEs.setHang(id as string, v as boolean), [
      runId,
      hang,
    ] as const),
  stats: (page: Page) => page.evaluate(() => window.__fakeEs.stats()),
};

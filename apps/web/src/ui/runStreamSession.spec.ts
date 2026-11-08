import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { RunEventSchema, RunSchema, type RunEvent } from '@omnis/contracts';
import { MAX_STREAM_FAILURES } from './runStreamRecovery.js';

/**
 * Run event stream versus owner session (PR #87 ends streams when a session is revoked).
 * A REAL local HTTP server answers the stream so native EventSource semantics apply: a network drop
 * or clean end is retried by the browser (readyState CONNECTING), while a non-200 reply closes the
 * stream for good (readyState CLOSED) without exposing the status to the page. Everything is
 * synthetic fixture data; no provider is contacted.
 */

const now = '2026-11-03T10:00:00.000Z';
const run = RunSchema.parse({
  id: 'run-live',
  taskId: 'task-live',
  taskTitle: 'Review launch checklist',
  status: 'running',
  runtimeKind: 'mock',
  synthetic: true,
  usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
  createdAt: now,
  updatedAt: now,
});
const makeEvent = (sequence: number, type: RunEvent['type']): RunEvent =>
  RunEventSchema.parse({
    id: `event-run-live-${sequence}`,
    runId: run.id,
    sequence,
    at: new Date(Date.parse(now) + sequence * 1000).toISOString(),
    type,
    source: 'mock',
    synthetic: true,
    message: `Synthetic ${type.replace('run.', '')} event ${sequence}.`,
  });
const queued = makeEvent(1, 'run.queued');
const started = makeEvent(2, 'run.started');
const frame = (event: RunEvent) =>
  `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

type StreamHandler = (
  response: ServerResponse,
  request: IncomingMessage,
  connection: number,
) => void;
type StreamServer = {
  url: string;
  cursors: string[];
  close: () => Promise<void>;
};

async function startStreamServer(handler: StreamHandler): Promise<StreamServer> {
  const cursors: string[] = [];
  const server: Server = createServer((request, response) => {
    const header = request.headers['last-event-id'];
    cursors.push(Array.isArray(header) ? header.join(',') : (header ?? ''));
    handler(response, request, cursors.length);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/events`,
    cursors,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const sse = (response: ServerResponse) =>
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
const refuse = (response: ServerResponse, status: number, code: string, message: string) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code, message, requestId: 'fixture-request' } }));
};

type RunDetail = 'valid' | 'unauthorized' | 'forbidden' | 'network' | 'unavailable';

function mockApi(page: Page, streamUrl: () => string) {
  const state = {
    sessionActive: true,
    runDetail: 'valid' as RunDetail,
    runGets: 0,
    /** When set, the next Run read waits for it and then answers 401 (an OLD session's cookie). */
    holdNextProbe: null as Promise<void> | null,
  };
  const unexpected: string[] = [];
  const fail = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, json: { error: { code, message, requestId: 'fixture-request' } } });
  void page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/v1/auth/csrf' && method === 'GET')
      return route.fulfill({ json: { csrfToken: 'csrf-stream-fixture-token' } });
    if (path === '/api/v1/auth/login' && method === 'POST') {
      state.sessionActive = true; // a new session replaces the old one
      return route.fulfill({ json: { authenticated: true } });
    }
    if (path === '/api/v1/auth/logout' && method === 'POST') {
      state.sessionActive = false;
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/api/v1/me' && method === 'GET')
      return state.sessionActive
        ? route.fulfill({ json: { id: 'owner', displayName: 'Director' } })
        : fail(route, 401, 'unauthorized', 'Sign in to continue.');
    if (path === '/api/v1/tasks' && method === 'GET')
      return state.sessionActive
        ? route.fulfill({ json: [] })
        : fail(route, 401, 'unauthorized', 'Sign in to continue.');
    if (path === '/api/v1/runs' && method === 'GET')
      return state.sessionActive
        ? route.fulfill({ json: [run] })
        : fail(route, 401, 'unauthorized', 'Sign in to continue.');
    if (path === `/api/v1/runs/${run.id}/events` && method === 'GET')
      return route.continue({ url: streamUrl() });
    if (path === `/api/v1/runs/${run.id}` && method === 'GET') {
      state.runGets += 1;
      const held = state.holdNextProbe;
      if (held) {
        state.holdNextProbe = null;
        await held;
        // The browser may already have cancelled this request; answering it is then impossible.
        await fail(route, 401, 'unauthorized', 'Sign in to continue.').catch(() => undefined);
        return;
      }
      if (!state.sessionActive || state.runDetail === 'unauthorized')
        return fail(route, 401, 'unauthorized', 'Sign in to continue.');
      if (state.runDetail === 'forbidden')
        return fail(route, 403, 'forbidden', 'Run access is not permitted.');
      if (state.runDetail === 'network') return route.abort('connectionreset');
      if (state.runDetail === 'unavailable')
        return fail(route, 503, 'run_unavailable', 'Run is temporarily unavailable.');
      return route.fulfill({ json: run });
    }
    unexpected.push(`${method} ${path}`);
    return fail(route, 500, 'fixture_contract_violation', `Unexpected API request: ${path}`);
  });
  return { state, unexpected };
}

async function openRun(page: Page) {
  await page.goto('/#runs/run-live');
  await expect(page.locator('#main-content')).toBeVisible();
}

const signedOut = (page: Page) => page.getByRole('button', { name: 'Sign in' });
const rows = (page: Page) => page.locator('.event-row');

let server: StreamServer | null = null;
test.afterEach(async () => {
  await server?.close();
  server = null;
});

test('a healthy stream stays connected and never asks the API about the session', async ({
  page,
}) => {
  server = await startStreamServer((response) => {
    sse(response);
    response.write(`${frame(queued)}${frame(started)}`); // held open
  });
  const api = mockApi(page, () => server!.url);
  await openRun(page);
  await expect(page.locator('.stream-badge')).toContainText('Live stream');
  await expect(rows(page)).toHaveCount(2);
  await page.waitForTimeout(1_000);
  expect(api.state.runGets).toBe(0);
  expect(api.unexpected).toEqual([]);
});

test('a dropped connection is retried natively, stays signed in, and replays without duplicates', async ({
  page,
}) => {
  test.setTimeout(20_000);
  server = await startStreamServer((response, _request, connection) => {
    sse(response);
    if (connection === 1) return void response.end(`retry: 100\n\n${frame(queued)}`);
    response.write(`${frame(queued)}${frame(started)}`); // reconnect: replay + new event, held open
  });
  const api = mockApi(page, () => server!.url);
  await openRun(page);
  await expect(page.locator('.stream-badge')).toContainText('Live stream');
  await expect(rows(page)).toHaveCount(2);
  await expect(signedOut(page)).toHaveCount(0);
  expect(server.cursors.slice(0, 2)).toEqual(['', '1']);
  // The error was checked through the authenticated API exactly as a session probe, not guessed.
  expect(api.state.runGets).toBeGreaterThanOrEqual(1);
  expect(api.state.runGets).toBeLessThanOrEqual(2);
  expect(api.unexpected).toEqual([]);
});

test('backend stream closure after session expiry signs the owner out and clears the run', async ({
  page,
}) => {
  test.setTimeout(20_000);
  const api = mockApi(page, () => server!.url);
  server = await startStreamServer((response) => {
    if (!api.state.sessionActive)
      return refuse(response, 401, 'unauthorized', 'Sign in to continue.');
    sse(response);
    api.state.sessionActive = false; // the server invalidates the session and ends the stream
    response.end(`retry: 100\n\n${frame(queued)}`);
  });
  await openRun(page);
  await expect(signedOut(page)).toBeVisible();
  await expect(page.getByText('Review launch checklist')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
  const settled = server.cursors.length;
  await page.waitForTimeout(1_500);
  expect(server.cursors.length).toBe(settled); // no further stream attempts after sign-out
  expect(api.unexpected).toEqual([]);
});

test('a reconnect rejected with 401 (CLOSED) is confirmed through the API and signs out', async ({
  page,
}) => {
  test.setTimeout(20_000);
  const api = mockApi(page, () => server!.url);
  server = await startStreamServer((response, _request, connection) => {
    if (connection === 1) {
      sse(response);
      return void response.end(`retry: 100\n\n${frame(queued)}`);
    }
    api.state.sessionActive = false;
    refuse(response, 401, 'unauthorized', 'Sign in to continue.');
  });
  await openRun(page);
  await expect(signedOut(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  expect(server.cursors.slice(0, 2)).toEqual(['', '1']);
  expect(api.unexpected).toEqual([]);
});

test('a 403 is shown as a refusal and does not sign the owner out', async ({ page }) => {
  test.setTimeout(20_000);
  server = await startStreamServer((response, _request, connection) => {
    if (connection === 1) {
      sse(response);
      return void response.end(`retry: 100\n\n${frame(queued)}`);
    }
    refuse(response, 403, 'forbidden', 'Run access is not permitted.');
  });
  const api = mockApi(page, () => server!.url);
  api.state.runDetail = 'forbidden';
  await openRun(page);
  await expect(page.getByRole('alert')).toContainText('Run access is not permitted.');
  await expect(signedOut(page)).toHaveCount(0);
  // A refusal ends automatic recovery; the owner decides whether to try again.
  await expect(page.locator('.stream-badge')).toContainText('Updates paused');
  await expect(page.getByRole('button', { name: 'Retry live updates' })).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test('network failure of the session check never signs out and is retried only a bounded number of times', async ({
  page,
}) => {
  test.setTimeout(40_000);
  server = await startStreamServer((response, _request, connection) => {
    if (connection === 1) {
      sse(response);
      return void response.end(`retry: 100\n\n${frame(queued)}`);
    }
    refuse(response, 503, 'unavailable', 'Temporarily unavailable.'); // CLOSED, session unknowable
  });
  const api = mockApi(page, () => server!.url);
  api.state.runDetail = 'network';
  await openRun(page);
  // 1 initial probe + 3 backoff retries (1 s, 2 s, 4 s), then it stops and offers a retry.
  await expect.poll(() => api.state.runGets, { timeout: 15_000 }).toBe(4);
  await expect(page.locator('.stream-badge')).toContainText('Updates paused');
  await expect(page.getByRole('button', { name: 'Retry live updates' })).toBeVisible();
  await page.waitForTimeout(2_500);
  expect(api.state.runGets).toBe(4);
  await expect(signedOut(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1); // history stays visible while disconnected
  expect(api.unexpected).toEqual([]);
});

test('a transient session-check failure recovers without a sign-out', async ({ page }) => {
  test.setTimeout(30_000);
  server = await startStreamServer((response, _request, connection) => {
    if (connection === 1) {
      sse(response);
      return void response.end(`retry: 100\n\n${frame(queued)}`);
    }
    if (connection === 2) return refuse(response, 503, 'unavailable', 'Temporarily unavailable.');
    sse(response);
    response.write(`${frame(queued)}${frame(started)}`);
  });
  const api = mockApi(page, () => server!.url);
  api.state.runDetail = 'unavailable';
  await openRun(page);
  await expect.poll(() => api.state.runGets, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  api.state.runDetail = 'valid';
  await expect(page.locator('.stream-badge')).toContainText('Live stream', { timeout: 15_000 });
  await expect(rows(page)).toHaveCount(2);
  await expect(signedOut(page)).toHaveCount(0);
  expect(api.unexpected).toEqual([]);
});

test('a rejected reconnect with a still-valid refreshed session recreates the stream without duplicates', async ({
  page,
}) => {
  test.setTimeout(20_000);
  server = await startStreamServer((response, _request, connection) => {
    if (connection === 1) {
      sse(response);
      return void response.end(`retry: 100\n\n${frame(queued)}`);
    }
    if (connection === 2) return refuse(response, 401, 'unauthorized', 'Sign in to continue.');
    sse(response); // connection 3: the app's own new EventSource, so no Last-Event-ID
    response.write(`${frame(queued)}${frame(started)}`);
  });
  // The rotated session is valid for the API even though the old stream's cookie was rejected.
  const api = mockApi(page, () => server!.url);
  await openRun(page);
  await expect(page.locator('.stream-badge')).toContainText('Live stream', { timeout: 10_000 });
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.event-row', { hasText: 'Synthetic queued event 1.' })).toHaveCount(1);
  await expect(signedOut(page)).toHaveCount(0);
  expect(server.cursors.slice(0, 3)).toEqual(['', '1', '']);
  expect(api.unexpected).toEqual([]);
});

test('leaving the run cancels pending session-check retries and stream attempts', async ({
  page,
}) => {
  test.setTimeout(30_000);
  server = await startStreamServer((response, _request, connection) => {
    if (connection === 1) {
      sse(response);
      return void response.end(`retry: 100\n\n${frame(queued)}`);
    }
    refuse(response, 503, 'unavailable', 'Temporarily unavailable.');
  });
  const api = mockApi(page, () => server!.url);
  api.state.runDetail = 'network';
  await openRun(page);
  await expect.poll(() => api.state.runGets, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
  const probes = api.state.runGets;
  const attempts = server.cursors.length;
  await page.waitForTimeout(5_000); // longer than the whole backoff schedule
  expect(api.state.runGets).toBe(probes);
  expect(server.cursors.length).toBe(attempts);
  expect(api.unexpected).toEqual([]);
});

const eventN = (sequence: number) =>
  makeEvent(sequence, sequence === 1 ? 'run.queued' : 'run.output');
const retryButton = (page: Page) => page.getByRole('button', { name: 'Retry live updates' });
// The budget plays out over the real backoff schedule (recreate delays, stable-open window), so
// this waits for that schedule rather than a fixed short timeout; it asserts the final state only.
const paused = (page: Page) =>
  expect(page.locator('.stream-badge')).toContainText('Updates paused', { timeout: 25_000 });

test.describe('retry budget', () => {
  test('repeated closures cannot exceed the budget even while every session check succeeds', async ({
    page,
  }) => {
    test.setTimeout(40_000);
    let healthy = false;
    server = await startStreamServer((response, _request, connection) => {
      if (healthy) {
        sse(response);
        return void response.write(`${frame(queued)}${frame(started)}`);
      }
      if (connection === 1) {
        sse(response);
        return void response.end(`retry: 100\n\n${frame(queued)}`);
      }
      refuse(response, 503, 'unavailable', 'Temporarily unavailable.'); // CLOSED, session fine
    });
    const api = mockApi(page, () => server!.url);
    await openRun(page);
    await paused(page);
    // The budget survives every recreation: initial stream + native retry + three recreated ones.
    expect(server.cursors).toHaveLength(MAX_STREAM_FAILURES);
    await expect(retryButton(page)).toBeVisible();
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
      [],
    );
    await expect(
      page.getByRole('status').filter({ hasText: 'Live updates paused after repeated connection' }),
    ).toHaveCount(1); // announced to assistive technology, not only shown
    await expect(rows(page)).toHaveCount(1); // history stays visible
    await page.waitForTimeout(4_000);
    expect(server.cursors).toHaveLength(MAX_STREAM_FAILURES); // nothing keeps reconnecting
    await expect(signedOut(page)).toHaveCount(0);

    // A deliberate owner retry replenishes the budget and keeps the history without duplicates.
    healthy = true;
    await retryButton(page).focus();
    await page.keyboard.press('Enter'); // keyboard activation
    await expect(page.getByRole('heading', { name: 'Run inspector' })).toBeFocused();
    await expect(page.locator('.stream-badge')).toContainText('Live stream');
    await expect(rows(page)).toHaveCount(2);
    await expect(retryButton(page)).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test('a native reconnect loop in CONNECTING is closed once the budget is spent', async ({
    page,
  }) => {
    test.setTimeout(30_000);
    server = await startStreamServer((response, request, connection) => {
      if (connection === 1) {
        sse(response);
        return void response.end(`retry: 50\n\n${frame(queued)}`);
      }
      request.socket.destroy(); // a network drop: the browser keeps the stream CONNECTING
    });
    const api = mockApi(page, () => server!.url);
    await openRun(page);
    await paused(page);
    await expect(retryButton(page)).toBeVisible();
    // Chromium silently retries a reset keep-alive request once without an error event, so server
    // connections can exceed the error budget; they must still be bounded and must stop.
    expect(server.cursors.length).toBeLessThanOrEqual(2 * MAX_STREAM_FAILURES);
    const attempts = server.cursors.length;
    await page.waitForTimeout(2_000); // ~40 native retry intervals
    expect(server.cursors).toHaveLength(attempts); // the EventSource was really closed
    await expect(signedOut(page)).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test('opening and replaying known history is not progress', async ({ page }) => {
    test.setTimeout(30_000);
    server = await startStreamServer((response) => {
      sse(response);
      response.end(`retry: 50\n\n${frame(queued)}`); // opens, replays event 1, ends: every time
    });
    const api = mockApi(page, () => server!.url);
    await openRun(page);
    await paused(page);
    expect(server.cursors).toHaveLength(MAX_STREAM_FAILURES);
    await page.waitForTimeout(1_500);
    expect(server.cursors).toHaveLength(MAX_STREAM_FAILURES);
    await expect(rows(page)).toHaveCount(1);
    expect(api.unexpected).toEqual([]);
  });

  test('only events not seen before replenish the budget', async ({ page }) => {
    test.setTimeout(30_000);
    const total = MAX_STREAM_FAILURES + 4; // far more reconnects than the budget allows
    server = await startStreamServer((response, _request, connection) => {
      sse(response);
      const events = Array.from({ length: Math.min(connection, total) }, (_, i) => eventN(i + 1));
      const body = events.map(frame).join('');
      if (connection < total) return void response.end(`retry: 50\n\n${body}`);
      response.write(body); // the last connection stays open
    });
    const api = mockApi(page, () => server!.url);
    await openRun(page);
    await expect(page.locator('.stream-badge')).toContainText('Live stream', { timeout: 15_000 });
    await expect(rows(page)).toHaveCount(total);
    expect(server.cursors.length).toBeGreaterThanOrEqual(total);
    await expect(retryButton(page)).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test('a connection that stays open long enough replenishes the budget', async ({ page }) => {
    test.setTimeout(45_000);
    server = await startStreamServer((response, _request, connection) => {
      sse(response);
      if (connection === 2) {
        // Open and stable for longer than STABLE_OPEN_MS, delivering nothing new.
        response.write(`retry: 50\n\n${frame(queued)}`);
        setTimeout(() => response.end(), 10_800);
        return;
      }
      response.end(`retry: 50\n\n${frame(queued)}`); // replay only: never progress
    });
    const api = mockApi(page, () => server!.url);
    await openRun(page);
    await paused(page);
    // Without the stable-open reset the budget would be spent one connection earlier.
    expect(server.cursors).toHaveLength(MAX_STREAM_FAILURES + 1);
    expect(api.unexpected).toEqual([]);
  });

  test('leaving and returning to a paused run does not reopen the stream', async ({ page }) => {
    test.setTimeout(30_000);
    server = await startStreamServer((response, request, connection) => {
      if (connection === 1) {
        sse(response);
        return void response.end(`retry: 50\n\n${frame(queued)}`);
      }
      request.socket.destroy();
    });
    const api = mockApi(page, () => server!.url);
    await openRun(page);
    await paused(page);
    const attempts = server.cursors.length;
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(page.getByRole('heading', { name: 'Task list' })).toBeVisible();
    await page.getByRole('link', { name: 'Runs' }).click();
    await page.getByRole('button', { name: /Review launch checklist/ }).click();
    await expect(page.locator('.stream-badge')).toContainText('Updates paused');
    await expect(retryButton(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(server.cursors).toHaveLength(attempts); // the budget outlives the effect
    expect(api.unexpected).toEqual([]);
  });
});

test('a delayed 401 for an old session cannot sign out the session that replaced it', async ({
  page,
}) => {
  test.setTimeout(30_000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  server = await startStreamServer((response, _request, connection) => {
    sse(response);
    if (connection === 1) return void response.end(`retry: 30000\n\n${frame(queued)}`);
    response.write(`${frame(queued)}${frame(started)}`); // the new session's stream, held open
  });
  const api = mockApi(page, () => server!.url);
  api.state.holdNextProbe = gate; // the old session's probe is still in flight...
  await openRun(page);
  await expect.poll(() => api.state.runGets).toBe(1);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(signedOut(page)).toBeVisible();
  await page.getByLabel('Owner password').fill('fixture-owner-password');
  await signedOut(page).click(); // ...and a brand-new session is established
  await expect(page.locator('.stream-badge')).toContainText('Live stream');
  await expect(rows(page)).toHaveCount(2);

  release(); // the old probe finally answers 401 for the old cookie
  await page.waitForTimeout(1_000);
  await expect(signedOut(page)).toHaveCount(0);
  await expect(page.getByText('Review launch checklist').first()).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.stream-badge')).toContainText('Live stream');
  expect(api.unexpected).toEqual([]);
});

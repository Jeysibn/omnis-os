import { expect, test } from '@playwright/test';
import type { ApiRequestError } from './api.js';
import { request } from './api.js';

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const identity = (v: unknown) => v;
/** A fetch that never settles on its own, but honours the abort signal like a real one. */
const stalled = (): typeof fetch => (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiRequestError;
  }
  throw new Error('expected failure');
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test.describe('request deadlines', () => {
  test('a stalled read times out as request_timeout', async () => {
    globalThis.fetch = stalled();
    const e = await fail(request('/x', {}, identity, { timeoutMs: 20 }));
    expect(e.code).toBe('request_timeout');
    expect(e.outcome).toBe('uncertain');
  });

  test('a stalled mutation is mutation_timeout, uncertain, and says it may have been applied', async () => {
    globalThis.fetch = stalled();
    const e = await fail(
      request('/x', { method: 'POST', body: '{}' }, identity, { timeoutMs: 20 }),
    );
    expect(e.code).toBe('mutation_timeout');
    expect(e.outcome).not.toBe('rejected');
    expect(e.message).toContain('may or may not have been applied');
  });

  test('a stalled body after headers also times out', async () => {
    globalThis.fetch = (_i, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_r, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      } as unknown as Response);
    const e = await fail(request('/x', { method: 'PUT', body: '{}' }, identity, { timeoutMs: 20 }));
    expect(e.code).toBe('mutation_timeout');
  });

  test('a mutation is never retried: fetch is called once', async () => {
    let calls = 0;
    globalThis.fetch = (...args) => {
      calls += 1;
      return stalled()(...args);
    };
    await fail(request('/x', { method: 'POST', body: '{}' }, identity, { timeoutMs: 20 }));
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
  });

  test('a caller abort is not reported as a timeout', async () => {
    globalThis.fetch = stalled();
    const controller = new AbortController();
    const pending = fail(
      request('/x', { signal: controller.signal }, identity, { timeoutMs: 5_000 }),
    );
    controller.abort();
    expect((await pending).code).toBe('network_error');
  });

  test('a late response after the deadline is ignored and does not throw twice', async () => {
    globalThis.fetch = (_i, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(() => resolve(json({ ok: true })), 80);
      });
    const e = await fail(request('/x', {}, identity, { timeoutMs: 20 }));
    expect(e.code).toBe('request_timeout');
    await new Promise((r) => setTimeout(r, 120));
  });

  test('network failure stays network_error and a fast success resolves', async () => {
    globalThis.fetch = () => Promise.reject(new TypeError('offline'));
    expect((await fail(request('/x', {}, identity, { timeoutMs: 50 }))).code).toBe('network_error');
    globalThis.fetch = () => Promise.resolve(json({ a: 1 }));
    expect(await request('/x', {}, identity, { timeoutMs: 50 })).toEqual({ a: 1 });
  });

  test('recovery: a retry after a timeout can succeed; 4xx stays rejected', async () => {
    globalThis.fetch = stalled();
    await fail(request('/x', {}, identity, { timeoutMs: 20 }));
    globalThis.fetch = () => Promise.resolve(json({ a: 2 }));
    expect(await request('/x', {}, identity)).toEqual({ a: 2 });
    globalThis.fetch = () => Promise.resolve(json({}, 409));
    expect((await fail(request('/x', { method: 'POST', body: '{}' }, identity))).outcome).toBe(
      'rejected',
    );
  });
});

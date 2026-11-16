import { expect, test } from '@playwright/test';
import {
  StaleSessionError,
  bindExpiryToSession,
  bindToSession,
  captureSession,
  isStaleSession,
} from './sessionScope.js';

test('a captured session is live until the generation rotates, synchronously', () => {
  const generation = { current: 3 };
  const live = captureSession(generation);
  expect(live()).toBe(true);
  generation.current += 1; // rotateSession bumps the ref; no render or effect in between
  expect(live()).toBe(false);
  expect(captureSession(generation)()).toBe(true);
});

test('an expiry handler bound to an old session is inert and reports handled', () => {
  const generation = { current: 1 };
  const calls: unknown[] = [];
  const expire = (cause: unknown) => {
    calls.push(cause);
    return true;
  };
  const bound = bindExpiryToSession(generation, expire);
  expect(bound('current 401')).toBe(true);
  expect(calls).toEqual(['current 401']);
  generation.current += 1; // sign-out then sign-in replaced the session
  expect(bound('stale 401')).toBe(true);
  expect(calls).toEqual(['current 401']); // the stale 401 caused no expiry side effect
  // A handler bound to the replacement session still reaches the real handler.
  expect(bindExpiryToSession(generation, expire)('new 401')).toBe(true);
  expect(calls).toEqual(['current 401', 'new 401']);
});

test('a current handler passes through the real handler result, including "not a 401"', () => {
  const generation = { current: 1 };
  const bound = bindExpiryToSession(generation, () => false);
  expect(bound(new Error('503'))).toBe(false);
});

test('a parent callback bound to an old session is dropped, the current one is delivered', () => {
  const generation = { current: 1 };
  const received: string[] = [];
  const bound = bindToSession(generation, (value: string) => received.push(value));
  bound('session 1');
  generation.current += 1;
  bound('late session 1 result'); // arrives after the session was replaced
  expect(received).toEqual(['session 1']);
  bindToSession(generation, (value: string) => received.push(value))('session 2');
  expect(received).toEqual(['session 1', 'session 2']);
});

test('StaleSessionError is recognised and distinct from ordinary errors', () => {
  expect(isStaleSession(new StaleSessionError())).toBe(true);
  expect(isStaleSession(new Error('network'))).toBe(false);
  expect(isStaleSession('stale')).toBe(false);
});

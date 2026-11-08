import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalSessionStore } from './session-store.ts';

describe('local owner sessions', () => {
  it('uses an HttpOnly, SameSite cookie and keeps anonymous sessions unprivileged', () => {
    const store = new LocalSessionStore('a'.repeat(64), true);
    const { session, setCookie } = store.resolve(undefined);
    assert.ok(session);
    const cookie = store.cookie(session);
    assert.equal(setCookie, true);
    assert.equal(session.owner, false);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
  });

  it('rejects a tampered cookie and rotates the session identifier after sign-in', () => {
    const store = new LocalSessionStore('b'.repeat(64), false);
    const first = store.resolve(undefined).session!;
    const cookie = store.cookie(first).split(';')[0]!;
    assert.notEqual(store.resolve(cookie.replace(/.$/, 'x')).session!.id, first.id);

    const ownerSession = store.rotate(first.id)!;
    assert.equal(ownerSession.owner, true);
    assert.notEqual(ownerSession.id, first.id);
    assert.equal(store.resolve(cookie).session!.owner, false);
  });

  it('notifies active stream listeners when a session is destroyed or rotated', () => {
    const store = new LocalSessionStore('e'.repeat(64), false);
    const anonymous = store.resolve(undefined).session!;
    const owner = store.rotate(anonymous.id)!;
    const oldSessionInvalidations: string[] = [];
    const newSessionInvalidations: string[] = [];
    store.onInvalidated(anonymous.id, () => oldSessionInvalidations.push('anonymous'));
    store.onInvalidated(owner.id, () => oldSessionInvalidations.push('owner'));

    const replacement = store.rotate(owner.id)!;
    store.onInvalidated(replacement.id, () => newSessionInvalidations.push('replacement'));
    store.destroy(replacement.id);

    assert.deepEqual(oldSessionInvalidations, ['anonymous', 'owner']);
    assert.deepEqual(newSessionInvalidations, ['replacement']);
    assert.equal(store.isOwnerActive(owner.id), false);
    assert.equal(store.isOwnerActive(replacement.id), false);
  });

  it('invalidates and notifies expired sessions using the injected clock', () => {
    let now = 10_000;
    const store = new LocalSessionStore('f'.repeat(64), false, 4, () => now);
    const anonymous = store.resolve(undefined).session!;
    const owner = store.rotate(anonymous.id)!;
    const invalidated: string[] = [];
    store.onInvalidated(owner.id, () => invalidated.push(owner.id));

    now = owner.expiresAt;
    assert.equal(store.isOwnerActive(owner.id), false);
    assert.deepEqual(invalidated, [owner.id]);
    assert.equal(store.resolve(store.cookie(owner), false).session, undefined);
  });

  it('releases invalidation listeners when their subscriber disconnects', () => {
    const store = new LocalSessionStore('g'.repeat(64), false);
    const anonymous = store.resolve(undefined).session!;
    const session = store.rotate(anonymous.id)!;
    let invalidations = 0;
    const unsubscribe = store.onInvalidated(session.id, () => invalidations++);

    unsubscribe();
    store.destroy(session.id);

    assert.equal(invalidations, 0);
  });
});

describe('bounded anonymous session storage', () => {
  it('caps session growth, avoids sessions on unrelated routes, and removes expired entries', () => {
    let now = 1_000;
    const store = new LocalSessionStore('c'.repeat(64), false, 2, () => now);
    assert.equal(store.resolve(undefined, false).session, undefined);
    const first = store.resolve(undefined).session!;
    const second = store.resolve(undefined).session!;
    const third = store.resolve(undefined).session!;
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.id, third.id);
    assert.equal(store.size, 2);

    now += 8 * 60 * 60 * 1000 + 1;
    store.resolve(undefined, false);
    assert.equal(store.size, 0);
  });

  it('does not evict an authenticated owner session to make room for anonymous sessions', () => {
    const store = new LocalSessionStore('d'.repeat(64), false, 2);
    const first = store.resolve(undefined).session!;
    store.resolve(undefined);
    const owner = store.rotate(first.id)!;
    const ownerCookie = store.cookie(owner).split(';')[0]!;
    store.resolve(undefined);
    assert.equal(store.resolve(ownerCookie).session?.owner, true);
    assert.equal(store.size, 2);
  });
});

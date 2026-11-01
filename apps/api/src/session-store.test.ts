import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalSessionStore } from './session-store.ts';

describe('local owner sessions', () => {
  it('uses an HttpOnly, SameSite cookie and keeps anonymous sessions unprivileged', () => {
    const store = new LocalSessionStore('a'.repeat(64), true);
    const { session, setCookie } = store.resolve(undefined);
    const cookie = store.cookie(session);
    assert.equal(setCookie, true);
    assert.equal(session.owner, false);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
  });

  it('rejects a tampered cookie and rotates the session identifier after sign-in', () => {
    const store = new LocalSessionStore('b'.repeat(64), false);
    const first = store.resolve(undefined).session;
    const cookie = store.cookie(first).split(';')[0]!;
    assert.notEqual(store.resolve(cookie.replace(/.$/, 'x')).session.id, first.id);

    const ownerSession = store.rotate(first.id);
    assert.equal(ownerSession.owner, true);
    assert.notEqual(ownerSession.id, first.id);
    assert.equal(store.resolve(cookie).session.owner, false);
  });
});

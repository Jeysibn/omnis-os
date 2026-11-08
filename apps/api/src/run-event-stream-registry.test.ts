import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalSessionStore } from './session-store.ts';
import { RunEventStreamRegistry } from './run-event-stream-registry.ts';

describe('Run EventSource connection registry', () => {
  it('closes every session stream when logout, rotation, or revocation invalidates it', () => {
    const sessions = new LocalSessionStore('h'.repeat(64), false);
    const anonymous = sessions.resolve(undefined).session!;
    const owner = sessions.rotate(anonymous.id)!;
    const registry = new RunEventStreamRegistry({ sessions });
    const closed: string[] = [];

    const first = registry.acquire(owner, () => closed.push('first'));
    const second = registry.acquire(owner, () => closed.push('second'));
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, true);
    assert.equal(registry.size, 2);

    const replacement = sessions.rotate(owner.id)!;

    assert.deepEqual(closed, ['first', 'second']);
    assert.equal(registry.size, 0);
    assert.equal(sessions.isOwnerActive(owner.id), false);
    assert.equal(sessions.isOwnerActive(replacement.id), true);
  });

  it('expires idle streams at session expiry using deterministic scheduled callbacks', () => {
    let now = 20_000;
    const sessions = new LocalSessionStore('i'.repeat(64), false, 4, () => now);
    const owner = sessions.rotate(sessions.resolve(undefined).session!.id)!;
    const expirations: Array<() => void> = [];
    const registry = new RunEventStreamRegistry({
      sessions,
      now: () => now,
      scheduleExpiry: (_delay, expire) => {
        expirations.push(expire);
        return () => {};
      },
    });
    let closed = 0;
    const stream = registry.acquire(owner, () => closed++);
    assert.equal(stream.acquired, true);

    now = owner.expiresAt;
    expirations[0]!();

    assert.equal(closed, 1);
    assert.equal(registry.size, 0);
    assert.equal(sessions.isOwnerActive(owner.id), false);
  });

  it('enforces per-session and global stream bounds and releases capacity on disconnect', () => {
    const sessions = new LocalSessionStore('j'.repeat(64), false);
    const anonymous = sessions.resolve(undefined).session!;
    const owner = sessions.rotate(anonymous.id)!;
    const otherOwner = sessions.rotate(sessions.resolve(undefined).session!.id)!;
    const registry = new RunEventStreamRegistry({
      sessions,
      globalLimit: 3,
      sessionLimit: 2,
      scheduleExpiry: () => () => {},
    });
    const first = registry.acquire(owner, () => {});
    const second = registry.acquire(owner, () => {});
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, true);
    assert.deepEqual(
      registry.acquire(owner, () => {}),
      {
        acquired: false,
        reason: 'stream_limit',
      },
    );

    const third = registry.acquire(otherOwner, () => {});
    assert.equal(third.acquired, true);
    assert.equal(registry.size, 3);
    if (first.acquired) first.release();
    assert.equal(registry.size, 2);
    assert.equal(registry.acquire(owner, () => {}).acquired, true);
  });

  it('rejects invalid sessions and disconnect cleanup prevents later revocation callbacks', () => {
    const sessions = new LocalSessionStore('k'.repeat(64), false);
    const anonymous = sessions.resolve(undefined).session!;
    const owner = sessions.rotate(anonymous.id)!;
    const registry = new RunEventStreamRegistry({
      sessions,
      scheduleExpiry: () => () => {},
    });
    let closed = 0;
    const stream = registry.acquire(owner, () => closed++);
    assert.equal(stream.acquired, true);
    if (stream.acquired) stream.release();
    sessions.destroy(owner.id);

    assert.equal(closed, 0);
    assert.deepEqual(
      registry.acquire(owner, () => {}),
      {
        acquired: false,
        reason: 'session_invalid',
      },
    );
    assert.equal(registry.size, 0);
  });
});

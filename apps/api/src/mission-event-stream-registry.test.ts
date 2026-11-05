import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MissionEventStreamRegistry } from './mission-event-stream-registry.ts';

describe('MissionEventStreamRegistry', () => {
  it('enforces per-session and process caps and releases revoked streams', () => {
    const registry = new MissionEventStreamRegistry(4, 5);
    const controllers: AbortController[] = [];
    const releases: Array<() => void> = [];
    for (let index = 0; index < 4; index += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const release = registry.acquire('session-a', controller);
      assert.ok(release);
      releases.push(release);
    }
    assert.equal(registry.acquire('session-a', new AbortController()), undefined);
    const fifth = registry.acquire('session-b', new AbortController());
    assert.ok(fifth);
    assert.equal(registry.acquire('session-c', new AbortController()), undefined);
    registry.revokeSession('session-a');
    assert.ok(controllers.every((controller) => controller.signal.aborted));
    releases[0]!();
    releases[0]!();
    assert.equal(registry.activeCount, 4);
    fifth();
    for (const release of releases.slice(1)) release();
    assert.equal(registry.activeCount, 0);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import {
  createMissionLaneDeadline,
  MissionLaneOverloadedError,
  missionLaneDeadlineMs,
  requireMissionLaneRemainingMs,
  withLocalMissionLaneAdmission,
} from './mission-lane-admission.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Mission Lane local writer bound', () => {
  it('uses one monotonic deadline and reports expiry without resetting it', () => {
    let now = 10;
    const deadline = createMissionLaneDeadline(now, () => now);
    assert.equal(deadline.remainingMilliseconds(), missionLaneDeadlineMs);
    now += 1_250;
    assert.equal(deadline.remainingMilliseconds(), 1_750);
    now += 1_750;
    assert.equal(deadline.remainingMilliseconds(), 0);
    assert.throws(() => requireMissionLaneRemainingMs(deadline), MissionLaneOverloadedError);
  });

  it('rejects overflow before action and releases capacity on every exit', async () => {
    const pool = {} as Pool;
    const releaseActions = deferred();
    let started = 0;
    const inFlight: Promise<void>[] = [];
    for (let i = 0; i < 7; i += 1) {
      inFlight.push(
        withLocalMissionLaneAdmission(pool, 'normal', async () => {
          started += 1;
          await releaseActions.promise;
        }),
      );
    }
    inFlight.push(
      withLocalMissionLaneAdmission(pool, 'critical', async () => {
        started += 1;
        await releaseActions.promise;
      }),
    );
    await Promise.resolve();
    assert.equal(started, 8);
    await assert.rejects(
      withLocalMissionLaneAdmission(pool, 'normal', async () => {
        started += 1;
      }),
      MissionLaneOverloadedError,
    );
    assert.equal(started, 8, 'overflow must be rejected before a writer action starts');

    releaseActions.resolve();
    await Promise.all(inFlight);
    await assert.doesNotReject(
      withLocalMissionLaneAdmission(pool, 'normal', async () => undefined),
    );
  });

  it('returns bounded capacity after an operation throws', async () => {
    const pool = {} as Pool;
    await assert.rejects(
      withLocalMissionLaneAdmission(pool, 'critical', async () => {
        throw new Error('fixture failure');
      }),
      /fixture failure/,
    );
    await assert.doesNotReject(
      withLocalMissionLaneAdmission(pool, 'normal', async () => undefined),
    );
  });
});

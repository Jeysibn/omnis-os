import type { Pool, PoolClient } from 'pg';

export type MissionLaneAdmissionPriority = 'normal' | 'critical';
export type MissionLaneDeadline = { remainingMilliseconds(): number };
export const missionLaneDeadlineMs = 3_000;

type Gate = { inFlight: number; normalInFlight: number };

const gates = new WeakMap<Pool, Gate>();

export class MissionLaneOverloadedError extends Error {
  readonly code = 'PML02';

  constructor() {
    super('Mission Lane writer capacity is full; retry the request.');
    this.name = 'MissionLaneOverloadedError';
  }
}

export function createMissionLaneDeadline(
  startedAt = performance.now(),
  now: () => number = () => performance.now(),
): MissionLaneDeadline {
  const expiresAt = startedAt + missionLaneDeadlineMs;
  return {
    remainingMilliseconds: () => Math.max(0, Math.ceil(expiresAt - now())),
  };
}

export function requireMissionLaneRemainingMs(deadline: MissionLaneDeadline): number {
  const remainingMs = deadline.remainingMilliseconds();
  if (remainingMs < 1) throw new MissionLaneOverloadedError();
  return remainingMs;
}

function gateFor(pool: Pool): Gate {
  let gate = gates.get(pool);
  if (!gate) {
    gate = { inFlight: 0, normalInFlight: 0 };
    gates.set(pool, gate);
  }
  return gate;
}

function acquireLocal(pool: Pool, priority: MissionLaneAdmissionPriority): () => void {
  const gate = gateFor(pool);
  // Cap local in-flight writer requests to the dedicated pool size, reserving
  // one client for critical work when the pool has at least eight clients. These
  // bounded requests can reach PostgreSQL, where
  // the cross-process advisory coordinator decides whether they are active or
  // pending globally. They never wait in node-postgres' unbounded checkout queue.
  const totalLimit = pool.options?.max ?? 8;
  const normalLimit = totalLimit >= 8 ? totalLimit - 1 : totalLimit;
  if (
    gate.inFlight >= totalLimit ||
    (priority === 'normal' && gate.normalInFlight >= normalLimit)
  ) {
    throw new MissionLaneOverloadedError();
  }
  gate.inFlight += 1;
  if (priority === 'normal') gate.normalInFlight += 1;
  return () => {
    gate.inFlight -= 1;
    if (priority === 'normal') gate.normalInFlight -= 1;
  };
}

export async function withLocalMissionLaneAdmission<T>(
  pool: Pool,
  priority: MissionLaneAdmissionPriority,
  action: (deadline: MissionLaneDeadline) => Promise<T>,
): Promise<T> {
  const deadline = createMissionLaneDeadline();
  const release = acquireLocal(pool, priority);
  try {
    return await action(deadline);
  } catch (error) {
    if (error instanceof Error && error.message === 'timeout exceeded when trying to connect') {
      throw new MissionLaneOverloadedError();
    }
    throw error;
  } finally {
    release();
  }
}

export async function acquireMissionLaneAdmission(
  client: PoolClient,
  priority: MissionLaneAdmissionPriority = 'normal',
  deadline: MissionLaneDeadline = createMissionLaneDeadline(),
): Promise<void> {
  await client.query('SELECT omnis.acquire_mission_lane_admission($1,$2)', [
    priority === 'critical',
    requireMissionLaneRemainingMs(deadline),
  ]);
}

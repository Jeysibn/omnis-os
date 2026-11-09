import type { Pool, PoolClient } from 'pg';

export type MissionLaneAdmissionPriority = 'normal' | 'critical';

type Gate = { inFlight: number; normalInFlight: number };

const gates = new WeakMap<Pool, Gate>();

export class MissionLaneOverloadedError extends Error {
  readonly code = 'PML02';

  constructor() {
    super('Mission Lane writer capacity is full; retry the request.');
    this.name = 'MissionLaneOverloadedError';
  }
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
  action: () => Promise<T>,
): Promise<T> {
  const release = acquireLocal(pool, priority);
  try {
    return await action();
  } finally {
    release();
  }
}

export async function acquireMissionLaneAdmission(
  client: PoolClient,
  priority: MissionLaneAdmissionPriority = 'normal',
): Promise<void> {
  await client.query('SELECT omnis.acquire_mission_lane_admission($1)', [priority === 'critical']);
}

import type { Run } from '@omnis/contracts';

export type MissionEvent = {
  id: string;
  runId: string;
  at: string;
  status: Run['status'];
  label: string;
  taskTitle: string;
};

const title = (value: string) =>
  value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

/**
 * Chronological nodes derived only from persisted run records: when each run was queued and,
 * if it has moved on, when its record last changed. Per-event history is not fabricated here;
 * the run inspector remains the source for replayed events.
 */
export function buildMissionEvents(runs: Run[]): MissionEvent[] {
  const events = new Map<string, MissionEvent>();
  for (const run of runs) {
    events.set(`${run.id}:queued`, {
      id: `${run.id}:queued`,
      runId: run.id,
      at: run.createdAt,
      status: 'queued',
      label: 'Queued',
      taskTitle: run.taskTitle,
    });
    if (run.status !== 'queued') {
      events.set(`${run.id}:state`, {
        id: `${run.id}:state`,
        runId: run.id,
        at: run.updatedAt,
        status: run.status,
        label: title(run.status),
        taskTitle: run.taskTitle,
      });
    }
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
